// Shell core — dark mode, waffle menu, sidebar, topbar
// Loaded after api.js. Notifications: shell-notifications.js | Search: shell-search.js

// ===== Theme (light / dark / system) =====
let themeMode = 'system'; // 'light' | 'dark' | 'system'
function initDarkMode() {
  // Legacy-key migration: older installs wrote `miyagi_theme` /
  // `miyagi_dark_mode`. Prefer the new `robotdojo_theme` key; fall back to
  // the legacy key so users don't get reset to system on first load.
  const legacyTheme = localStorage.getItem('miyagi_theme');
  if (legacyTheme && !localStorage.getItem('robotdojo_theme')) {
    localStorage.setItem('robotdojo_theme', legacyTheme);
    localStorage.removeItem('miyagi_theme');
  }
  const stored = localStorage.getItem('robotdojo_theme');
  if (stored && ['light', 'dark', 'system'].includes(stored)) {
    themeMode = stored;
  } else {
    // Migrate from old boolean key
    const oldVal = localStorage.getItem('miyagi_dark_mode');
    if (oldVal === 'true') themeMode = 'dark';
    else if (oldVal === 'false') themeMode = 'light';
    else themeMode = 'system';
    localStorage.setItem('robotdojo_theme', themeMode);
    localStorage.removeItem('miyagi_dark_mode');
  }
  applyThemeMode();
  // Live-update when OS preference changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode === 'system') applyThemeMode();
  });
}
function setThemeMode(mode) {
  themeMode = mode;
  localStorage.setItem('robotdojo_theme', mode);
  applyThemeMode();
  // Update appearance section radio if visible
  const radios = document.querySelectorAll('input[name="theme"]');
  radios.forEach(r => {
    r.checked = r.value === mode;
    r.closest('.appearance-option')?.classList.toggle('active', r.value === mode);
  });
}

// st_d9fc573b AC 4 — global theme toggle (sun/moon) cycles light/dark/system.
function cycleThemeMode() {
  const next = themeMode === 'light' ? 'dark' : themeMode === 'dark' ? 'system' : 'light';
  setThemeMode(next);
}
function applyThemeMode() {
  const isDark = themeMode === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : themeMode === 'dark';
  document.body.classList.toggle('dark', isDark);
  const icon = $('#themeIconGlobal');
  if (icon) icon.textContent = isDark ? 'light_mode' : 'dark_mode';
  // Swap highlight.js theme
  const hljsLight = $('#hljs-light'), hljsDark = $('#hljs-dark');
  if (hljsLight) hljsLight.disabled = isDark;
  if (hljsDark) hljsDark.disabled = !isDark;
}

// ===== App Registry =====
// Apps shown in waffle menu come from shared/app-registry.js. Product apps are
// committed there; topic descriptors are provided by /api/apps.
const APP_REGISTRY = window.RobotDojoAppRegistry;
let ALL_APPS = (APP_REGISTRY?.listWaffleApps?.() || [
  { slug: 'chat', name: 'Chat', icon: 'chat', path: '/chat', belt: 'white', locked_on_white: false },
]).map(app => APP_REGISTRY?.sanitizeDescriptor?.(app) || app);
// WHY default to 'white' not 'black': fresh-install users are White Belt.
// Defaulting to black caused locked apps (Network, Health) to flash unlocked
// before /api/whoami resolved. White is the correct conservative default —
// /api/whoami upgrades to black only when the user is paid. st_42799dbe AC 12.
let _currentBelt = 'white'; // default until whoami loads
window._currentBelt = _currentBelt; // expose to ES modules
const ROBOTDOJO_APPS = ALL_APPS; // alias for backward compat — filtered at render time
const IS_PUBLIC_ASK = location.pathname === '/ask';
const MOBILE_SHELL_MAX_WIDTH = 768;

function isChatAppShell() {
  return !IS_PUBLIC_ASK
    && document.body?.dataset?.app === 'chat'
    && location.pathname.startsWith('/chat');
}

function isMobileShellViewport() {
  if (typeof isMobile === 'function') return isMobile();
  return window.innerWidth <= MOBILE_SHELL_MAX_WIDTH;
}

function normalizeChatViewForViewport(view) {
  if (isChatAppShell() && (view === 'split' || view === 'dual' || view === 'list')) {
    return 'focus';
  }
  return view;
}

function renderAccountTopbarLink() {
  if (isMobileShellViewport()) return '';
  return `<a class="topbar-icon-btn topbar-account-link" href="/account" title="Settings" aria-label="Settings">
        <span class="material-symbols-outlined">settings</span>
      </a>`;
}

// Fetch belt level on load and re-render waffle menu
window._beltReady = (async () => {
  if (IS_PUBLIC_ASK) return;
  try {
    const res = await fetch('/api/whoami');
    if (res.ok) {
      const data = await res.json();
      _currentBelt = data.belt || 'black';
      window._currentBelt = _currentBelt;
      if (data.founder_apps) {
        try {
          const appsRes = await fetch('/api/apps');
          if (appsRes.ok) {
            const apps = await appsRes.json();
            const waffle = Array.isArray(apps.waffle_apps) ? apps.waffle_apps : [];
            if (waffle.length) {
              ALL_APPS = waffle.map(app => APP_REGISTRY?.sanitizeDescriptor?.(app) || app);
            }
          }
        } catch { /* keep launch waffle */ }
      }
      buildWaffleMenu();
    }
  } catch {}
})().finally(() => {
  if (IS_PUBLIC_ASK) return;
  try {
    if (!isChatAppShell()) window.RobotDojoPrecache?.warmAuthedShell?.();
    document.dispatchEvent(new CustomEvent('robotdojo:belt-ready', { detail: { belt: _currentBelt } }));
  } catch { /* */ }
});

// st_feff0f53 — shared-boot shell warming. Fires once per authed app load,
// immediately after /api/whoami succeeds. It warms app descriptors and static
// app shells only. Product data APIs are owned by the app being opened; cross-app
// private-data warmers can tie up the local Mac and make the relay look down.
// All errors are silently swallowed — warming is best-effort and never blocks
// the rest of the boot.
//
// Cache keys are deliberately stable across versions:
//   rd_warm_apps
function warmClientCache() {
  if (IS_PUBLIC_ASK) return;
  const currentPath = location.pathname;
  const isChatPath = currentPath.startsWith('/chat');

  // Chat is the foreground product. Even descriptor warming waits for another
  // app so chat boot/turns never share the relay hot path with background work.
  if (isChatPath) return;
  const WARM_CACHE_CONCURRENCY = 2;
  const WARM_CACHE_TTL_MS = 10 * 60 * 1000;
  const WARM_LOCK_TTL_MS = 30 * 1000;
  const WARM_FETCH_TIMEOUT_MS = 2500;
  const warmQueue = [];
  let activeWarmers = 0;
  const warmTabId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pumpWarmQueue = () => {
    while (activeWarmers < WARM_CACHE_CONCURRENCY && warmQueue.length) {
      const task = warmQueue.shift();
      activeWarmers += 1;
      task().finally(() => {
        activeWarmers -= 1;
        setTimeout(pumpWarmQueue, 250);
      });
    }
  };
  const enqueueWarm = (task, delay = 1500) => {
    setTimeout(() => {
      warmQueue.push(task);
      pumpWarmQueue();
    }, delay);
  };
  const writeCache = (key, payload) => {
    try {
      localStorage.setItem(key, JSON.stringify({ payload, ts: Date.now() }));
    } catch { /* quota / disabled */ }
  };
  const acctWrite = (key, payload) => writeCache('rd_acct_cache_' + key, payload);
  const storageKeyForWarm = (key, writer) => writer === acctWrite ? 'rd_acct_cache_' + key : key;
  const hasFreshWarmCache = (storageKey, ttlMs = WARM_CACHE_TTL_MS) => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return Number.isFinite(parsed?.ts) && Date.now() - parsed.ts < ttlMs;
    } catch {
      return false;
    }
  };
  const claimWarmSlot = (storageKey, ttlMs = WARM_CACHE_TTL_MS) => {
    if (hasFreshWarmCache(storageKey, ttlMs)) return false;
    const lockKey = 'rd_warm_inflight_' + storageKey;
    const now = Date.now();
    try {
      const current = JSON.parse(localStorage.getItem(lockKey) || 'null');
      if (current?.until && current.until > now) return false;
      localStorage.setItem(lockKey, JSON.stringify({ owner: warmTabId, until: now + WARM_LOCK_TTL_MS }));
      return true;
    } catch {
      return true;
    }
  };
  const releaseWarmSlot = (storageKey) => {
    const lockKey = 'rd_warm_inflight_' + storageKey;
    try {
      const current = JSON.parse(localStorage.getItem(lockKey) || 'null');
      if (!current || current.owner === warmTabId) localStorage.removeItem(lockKey);
    } catch { /* */ }
  };
  const fetchWarmJSON = async (url, options = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || WARM_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
      if (!res.ok) return null;
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  };
  const warmJson = (key, url, writer = writeCache, options = {}) => {
    if (typeof writer !== 'function') {
      options = writer || {};
      writer = writeCache;
    }
    enqueueWarm(async () => {
      const storageKey = options.storageKey || storageKeyForWarm(key, writer);
      if (!claimWarmSlot(storageKey, options.cacheTtlMs)) return;
      try {
        const data = await fetchWarmJSON(url, options);
        if (data != null) writer(key, data);
      } catch { /* */ }
      finally {
        releaseWarmSlot(storageKey);
      }
    }, options.delay);
  };
  const warmAggregate = (key, entries, writer = writeCache, options = {}) => {
    if (typeof writer !== 'function') {
      options = writer || {};
      writer = writeCache;
    }
    enqueueWarm(async () => {
      const storageKey = options.storageKey || storageKeyForWarm(key, writer);
      if (!claimWarmSlot(storageKey, options.cacheTtlMs)) return;
      try {
        const out = {};
        let hasAny = false;
        for (const [name, url] of entries) {
          try {
            const payload = await fetchWarmJSON(url, options);
            out[name] = payload;
            if (payload != null) hasAny = true;
          } catch { /* */ }
        }
        if (hasAny) writer(key, out);
      } catch { /* */ }
      finally {
        releaseWarmSlot(storageKey);
      }
    }, options.delay);
  };
  const warmAppRegistry = (options = {}) => {
    enqueueWarm(async () => {
      const storageKey = 'rd_warm_apps';
      if (!claimWarmSlot(storageKey, options.cacheTtlMs)) return;
      try {
        const data = await fetchWarmJSON('/api/apps', options);
        if (!data) return;
        writeCache('rd_warm_apps', data);
        const paths = [...(data.product_apps || []), ...(data.workbench_apps || [])]
          .map((app) => app?.path)
          .filter((path) => typeof path === 'string' && path.startsWith('/'));
        if (paths.length) window.RobotDojoPrecache?.warmRoutes?.(paths, true);
      } catch { /* */ }
      finally {
        releaseWarmSlot(storageKey);
      }
    }, options.delay);
  };

  // Registry/topic descriptors.
  warmAppRegistry({ delay: 1200 });
}

// Fire warming after the authed boot completes. If _beltReady resolves
// before this script reaches here, the .then runs immediately.
window._beltReady?.then?.(warmClientCache).catch(() => { /* */ });

// ===== Belt Toggle (admin-only) =====
// Shell fetches its own admin status independently so the belt toggle is
// available in every app without each app needing to pass isAdmin in config.
let _shellAdminStatus = null; // { is_admin: bool, belt_override: string|null }

async function _fetchShellAdminStatus() {
  if (IS_PUBLIC_ASK) return;
  try {
    const res = await fetch('/api/admin/status');
    if (res.ok) _shellAdminStatus = await res.json();
  } catch { /* non-fatal — non-admin users will 403 silently */ }
}

/**
 * Toggle the session's belt override between 'white' and 'black', then reload.
 * Only callable by admins — the button is hidden for everyone else.
 */
async function toggleBelt() {
  // null override = White Belt; toggle is always a direct binary flip
  const effectiveBelt = _shellAdminStatus?.belt_override || 'white';
  const next = effectiveBelt === 'white' ? 'black' : 'white';
  try {
    const res = await fetch('/api/admin/belt-override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ belt: next }),
    });
    if (res.ok) {
      const data = await res.json();
      if (_shellAdminStatus) _shellAdminStatus.belt_override = data.belt_override;
      location.reload();
    }
  } catch { /* ignore */ }
}

function _renderBeltToggle() {
  if (!_shellAdminStatus?.is_admin) return '';
  // null override = White Belt — no ambiguous "real" state
  const effectiveBelt = _shellAdminStatus.belt_override || 'white';
  const label = effectiveBelt === 'white' ? 'White Belt' : 'Black Belt';
  return `<button class="belt-toggle-btn topbar-icon-btn" data-belt="${effectiveBelt}" onclick="toggleBelt()" title="${label}">
    <img src="/static/img/belt-${effectiveBelt}.svg" width="20" height="20" alt="${label}">
  </button>`;
}

// ===== Global Topbar (rendered by shell, not hardcoded per app) =====
function buildGlobalTopbar(config = {}) {
  const el = $('#globalTopbar');
  if (!el) return;
  const searchPlaceholder = config.searchPlaceholder || 'Search...';
  const searchHandler = config.onSearch || 'doPersistentSearch(this.value)';
  const clearHandler = config.onClear || 'clearPersistentSearch()';
  const extraButtons = config.extraButtons || '';
  // Search is off in every app unless an app explicitly passes hideSearch: false.
  const hideSearch = config.hideSearch !== false;
  const mobileShell = isMobileShellViewport();
  const inputSearchPlaceholder = mobileShell ? 'Search' : searchPlaceholder;
  const viewToggleMarkup = '';

  if (IS_PUBLIC_ASK) {
    el.innerHTML = `
      <a class="topbar-brand" href="/chat"><img src="/static/favicon.svg" alt="Robot Dojo" style="height:1.2em;vertical-align:-0.2em"> <span class="brand-text">Robot Dojo</span></a>
      <div class="topbar-search-wrapper">
        <div class="persistent-search public-ask-title">
          <span class="material-symbols-outlined search-icon icon-sm">forum</span>
          <span>${searchPlaceholder}</span>
        </div>
      </div>
      <div class="topbar-actions">
        <a class="topbar-icon-btn" href="/" title="Home">
          <span class="material-symbols-outlined">home</span>
        </a>
      </div>`;
    return;
  }

  const searchMarkup = hideSearch ? '' : `
    <div class="topbar-search-wrapper">
      <div class="persistent-search" id="persistentSearch">
        <span class="material-symbols-outlined search-icon icon-sm">search</span>
        <input type="text" id="persistentSearchInput" placeholder="${inputSearchPlaceholder}" autocomplete="off">
        <button class="persistent-search-clear" id="persistentSearchClear" onclick="${clearHandler}">
          <span class="material-symbols-outlined icon-sm">close</span>
        </button>
      </div>
    </div>`;

  el.innerHTML = `
    <button class="topbar-hamburger" id="globalHamburger" onclick="toggleSidebar()" title="Toggle sidebar">
      <span class="material-symbols-outlined">menu</span>
    </button>
    <a class="topbar-brand" href="/chat"><img src="/static/favicon.svg" alt="Robot Dojo" style="height:1.2em;vertical-align:-0.2em"> <span class="brand-text">Robot Dojo</span></a>
    ${searchMarkup}
    <div class="topbar-actions">
      ${extraButtons}
      ${viewToggleMarkup}
      <!-- AC2 (st_4e7e3aaf) — global notifications bell removed.
       * shell-notifications.js stays loaded so closeNotifPanel() remains
       * defined (shell-search.js calls it on outside-click), but the
       * dropdown block is gone. -->
      <!-- st_d9fc573b AC 4 — global theme toggle sits left of the waffle -->
      <button class="topbar-icon-btn" id="themeToggleGlobal" data-nav-item="theme-toggle" data-between="waffle" onclick="cycleThemeMode()" title="Toggle theme">
        <span class="material-symbols-outlined" id="themeIconGlobal">dark_mode</span>
      </button>
      <div class="waffle-menu" id="waffleMenu">
        <button class="topbar-icon-btn" onclick="toggleWaffleMenu()" title="Apps">
          <span class="material-symbols-outlined">apps</span>
        </button>
        <div class="waffle-dropdown" id="waffleDropdown"></div>
      </div>
      ${renderAccountTopbarLink()}
    </div>`;
  buildWaffleMenu();
  if (typeof initNotifications === 'function') initNotifications();
}

// Apps that require Black Belt — shown with a lock badge on White/Demo.
const LOCKED_APPS = new Set(ALL_APPS.filter(app => app.locked_on_white).map(app => app.slug));

function sameOriginAppPath(path) {
  try {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

function openWafflePathInNewTab(path) {
  const appPath = sameOriginAppPath(path);
  if (!appPath) return;
  // Same-origin new tabs keep the login cookie and robotdojo_token localStorage.
  window.open(appPath, '_blank', 'noopener');
}

function setLockedWaffleIntent(slug) {
  try {
    localStorage.setItem('rd_upgrade_banner', slug);
  } catch {
    try { sessionStorage.setItem('rd_upgrade_banner', slug); } catch {}
  }
}

function readLockedWaffleIntent() {
  let slug = '';
  try { slug = sessionStorage.getItem('rd_upgrade_banner') || ''; } catch {}
  if (!slug) {
    try { slug = localStorage.getItem('rd_upgrade_banner') || ''; } catch {}
  }
  try { sessionStorage.removeItem('rd_upgrade_banner'); } catch {}
  try { localStorage.removeItem('rd_upgrade_banner'); } catch {}
  return slug;
}

function buildWaffleMenu() {
  const dd = $('#waffleDropdown');
  if (!dd) return;
  const currentPath = window.location.pathname;
  const isLimitedBelt = (_currentBelt === 'white' || _currentBelt === 'demo');

  dd.innerHTML = ALL_APPS.map(app => {
    const active = currentPath.startsWith(app.path) ? ' active' : '';
    const locked = isLimitedBelt && LOCKED_APPS.has(app.slug);
    const lockBadge = locked
      ? '<span class="material-symbols-outlined waffle-lock-icon">lock</span>'
      : '';
    // For locked apps: use a button so we can inject the upgrade banner intent.
    if (locked) {
      return `<button class="waffle-item${active} waffle-item--locked" data-locked-app="${app.slug}" type="button">
        <span class="material-symbols-outlined">${app.icon}</span>
        <span>${app.name}</span>
        ${lockBadge}
      </button>`;
    }
    return `<a class="waffle-item${active}" href="${app.path}" target="_blank" rel="noopener" data-waffle-app-path="${app.path}">
      <span class="material-symbols-outlined">${app.icon}</span>
      <span>${app.name}</span>
    </a>`;
  }).join('');

  // Wire locked-app clicks: open a logged-in new tab and inject upgrade banner on load.
  dd.querySelectorAll('[data-locked-app]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset.lockedApp;
      const appDef = ALL_APPS.find(a => a.slug === slug);
      if (!appDef) return;
      closeWaffleMenu();
      // The destination tab reads this shared same-origin intent and paints the
      // banner on its own DOMContentLoaded. Server data remains teaser-limited.
      setLockedWaffleIntent(slug);
      openWafflePathInNewTab(appDef.path);
    });
  });
}

/**
 * Call this from app-level DOMContentLoaded (Network, Pulse) to paint the
 * upgrade banner if the user arrived via a locked waffle-menu click.
 * Clears the shared intent flag so it doesn't persist across real navigations.
 */
function maybeShowUpgradeBanner() {
  const slug = readLockedWaffleIntent();
  if (!slug) return;
  const currentSlug = window.location.pathname.replace(/^\//, '').split('/')[0];
  if (slug !== currentSlug) return;
  _injectUpgradeBanner(slug);
}

function _injectUpgradeBanner(slug) {
  if (document.getElementById('rdUpgradeBanner')) return; // already present
  const appName = ALL_APPS.find(app => app.slug === slug)?.name || slug;
  const banner = document.createElement('div');
  banner.id = 'rdUpgradeBanner';
  banner.className = 'rd-upgrade-banner';
  banner.innerHTML = `
    <span class="material-symbols-outlined rd-upgrade-banner-icon">lock</span>
    <span class="rd-upgrade-banner-text">
      <strong>Black Belt</strong> unlocks full ${appName}. Private beta access uses an issued key.
    </span>
    <a class="rd-upgrade-banner-cta" href="/account/admin">Account →</a>
    <button class="rd-upgrade-banner-close" type="button" title="Dismiss"
            onclick="this.closest('#rdUpgradeBanner').remove()">
      <span class="material-symbols-outlined">close</span>
    </button>`;
  // Insert after global topbar or at body start.
  const topbar = document.getElementById('globalTopbar');
  if (topbar && topbar.nextSibling) {
    topbar.parentNode.insertBefore(banner, topbar.nextSibling);
  } else {
    document.body.prepend(banner);
  }
}

// View toggle: list | split | dual. One always active.
function setAppView(view) {
  if (!isChatAppShell()) {
    updateViewToggle();
    return;
  }
  view = normalizeChatViewForViewport(view);
  const mainArea = document.querySelector('#mainArea');
  if (!mainArea) return;
  // Single source of truth: data-view attribute. CSS handles visibility.
  mainArea.dataset.view = view;
  localStorage.setItem('layout-view', view);
  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  // Split.js needs to init/destroy when entering/leaving split
  if (view === 'split' && typeof createInnerSplit === 'function') createInnerSplit();
  if (view !== 'split' && typeof destroyInnerSplit === 'function') destroyInnerSplit();
  // Sidebar: collapse in focus mode, restore when leaving
  const sidebar = document.querySelector('#sidebar');
  if (sidebar) {
    if (view === 'focus') {
      sidebar._wasCollapsed = sidebar._wasCollapsed ?? sidebar.classList.contains('collapsed');
      sidebar.classList.add('collapsed');
    } else if (sidebar._wasCollapsed === false) {
      sidebar.classList.remove('collapsed');
      sidebar._wasCollapsed = undefined;
    }
  }
  document.dispatchEvent(new CustomEvent('layout-view-changed', { detail: { view } }));
}

function updateViewToggle() {
  const state = typeof getLayoutState === 'function' ? getLayoutState() : {};
  const enabled = isChatAppShell() && !isMobileShellViewport();
  const activeView = normalizeChatViewForViewport(state.view);
  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.disabled = !enabled;
    btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    btn.classList.toggle('active', enabled && btn.dataset.view === activeView);
  });
  document.querySelectorAll('.view-toggle-group').forEach(group => {
    group.classList.toggle('view-toggle-group-disabled', !enabled);
    group.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  });
}

function enforceMobileChatFocus() {
  if (!isChatAppShell() || !isMobileShellViewport()) return;
  const mainArea = document.querySelector('#mainArea');
  if (mainArea && mainArea.dataset.view !== 'focus') {
    setAppView('focus');
    return;
  }
  try { localStorage.setItem('layout-view', 'focus'); } catch {}
  if (typeof destroyInnerSplit === 'function') destroyInnerSplit();
}

function isAccountAppShell() {
  return !IS_PUBLIC_ASK && document.body?.dataset?.app === 'account';
}

// The account app has no mobile shell — its section navigation assumes desktop
// chrome. On a phone, send the user to /chat (the one responsive surface) rather
// than render a broken account layout. Returns true when it redirected so the
// caller can abort the rest of shell init.
function enforceMobileAccountRedirect() {
  if (!isAccountAppShell() || !isMobileShellViewport()) return false;
  location.replace('/chat');
  return true;
}

function toggleWaffleMenu() {
  const dd = $('#waffleDropdown');
  if (dd) dd.classList.toggle('open');
}
function closeWaffleMenu() {
  const dd = $('#waffleDropdown');
  if (dd) dd.classList.remove('open');
}

// ===== Server Restart =====
async function restartServer() {
  const btn = document.querySelector('[onclick="restartServer()"]');
  if (btn) btn.querySelector('.material-symbols-outlined').classList.add('spin-once');
  showToast('Restarting server...');
  try {
    await fetchJSON('/api/admin/restart', { method: 'POST' });
  } catch (err) { /* server dies before response — expected */ }
  // Poll until server comes back
  const poll = setInterval(async () => {
    try {
      const res = await fetch('/version', { cache: 'no-store' });
      if (res.ok) {
        clearInterval(poll);
        showToast('Server restarted');
        setTimeout(() => location.reload(), 500);
      }
    } catch (err) { /* still restarting */ }
  }, 1500);
  // Give up after 30s
  setTimeout(() => clearInterval(poll), 30000);
}

// ===== File Drop Zone (global) =====
// Any app can listen for 'shell-file-drop' on document to handle dropped files.
function initDropZone() {
  const body = document.body;
  let dragCounter = 0;
  body.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); dragCounter++; body.classList.add('drop-active');
  });
  body.addEventListener('dragover', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  });
  body.addEventListener('dragleave', () => {
    dragCounter--; if (dragCounter <= 0) { dragCounter = 0; body.classList.remove('drop-active'); }
  });
  body.addEventListener('drop', e => {
    dragCounter = 0; body.classList.remove('drop-active');
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    document.dispatchEvent(new CustomEvent('shell-file-drop', { detail: { files: e.dataTransfer.files } }));
  });
}

// ===== Shell Init =====
// Apps call: initShell({ searchPlaceholder: '...', extraButtons: '...' })
let _mobileViewportGuardBound = false;
function initShell(config = {}) {
  if (enforceMobileAccountRedirect()) return false;
  buildGlobalTopbar(config);
  initMobileSidebarState();
  initMobileViewportGuards(config);
  enforceMobileChatFocus();
  initDarkMode();
  if (!IS_PUBLIC_ASK && typeof initPersistentSearch === 'function') initPersistentSearch(config);
  initDropZone();
  injectSidebarFooter(config.sidebarFooter);
  initErrorLog();
  injectReportIssueButton();
}

function initMobileSidebarState() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('overlay');
  if (!sb) return;
  if (typeof isMobile !== 'function' || !isMobile()) {
    sb.classList.remove('hidden');
    ov?.classList.remove('show');
    return;
  }
  sb.classList.add('hidden');
  sb.classList.add('collapsed');
  ov?.classList.remove('show');
}

function initMobileViewportGuards(config) {
  if (_mobileViewportGuardBound || !window.matchMedia) return;
  _mobileViewportGuardBound = true;
  const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_SHELL_MAX_WIDTH}px)`);
  const onViewportChange = () => {
    buildGlobalTopbar(config);
    initMobileSidebarState();
    enforceMobileChatFocus();
    updateViewToggle();
  };
  if (typeof mobileQuery.addEventListener === 'function') {
    mobileQuery.addEventListener('change', onViewportChange);
  } else if (typeof mobileQuery.addListener === 'function') {
    mobileQuery.addListener(onViewportChange);
  }
}

// st_d9fc573b AC 5 — ring buffer (max 20) of window errors for the report-issue modal.
function initErrorLog() {
  if (!window.__rdjErrorLog) window.__rdjErrorLog = [];
  const push = (entry) => {
    try {
      window.__rdjErrorLog.push(entry);
      if (window.__rdjErrorLog.length > 20) window.__rdjErrorLog.shift();
    } catch { /* never throw from error handlers */ }
  };
  window.addEventListener('error', (e) => {
    push({ message: e?.message || 'unknown', filename: e?.filename || '', lineno: e?.lineno || 0, ts: Date.now() });
  });
  window.addEventListener('unhandledrejection', (e) => {
    push({ message: 'unhandledrejection: ' + (e?.reason?.message || String(e?.reason)).slice(0, 200), filename: '', lineno: 0, ts: Date.now() });
  });
}

// st_d9fc573b AC 5 — fixed-position bottom-right "Report issue" button visible on every page.
// Clicking opens a modal with a textarea, optional email, and submit posting to the
// production Vercel /api/feedback endpoint.
function injectReportIssueButton() {
  if (document.getElementById('report-issue-button')) return;
  const btn = document.createElement('button');
  btn.id = 'report-issue-button';
  btn.className = 'fixed-bottom-right report-issue-fab';
  btn.type = 'button';
  btn.title = 'Report an issue';
  btn.setAttribute('aria-label', 'Report an issue');
  btn.innerHTML = '<span class="material-symbols-outlined">flag</span>';
  btn.onclick = openReportIssueModal;
  document.body.appendChild(btn);
}

function collectRecentChatHistory() {
  const nodes = Array.from(document.querySelectorAll('.message, .chat-message, [data-role="user"], [data-role="assistant"]')).slice(-8);
  return nodes
    .map((node) => node.innerText || node.textContent || '')
    .filter(Boolean)
    .map((text) => redactReportText(text).slice(0, 1200));
}

function redactReportText(value) {
  let text = String(value || '');
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]');
  text = text.replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[redacted phone]');
  text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted ssn]');
  text = text.replace(/\b(?:\d[ -]*?){13,19}\b/g, '[redacted number]');
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{16,}|rd_[A-Za-z0-9_-]{16,})\b/g, '[redacted secret]');
  text = text.replace(/\b([A-Za-z0-9_]*(?:api|auth|access|refresh|secret|token|key)[A-Za-z0-9_]*\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]');
  return text;
}

function openReportIssueModal() {
  if (document.getElementById('report-issue-modal-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'report-issue-modal-overlay';
  overlay.className = 'report-issue-overlay';
  overlay.innerHTML = `
    <div class="report-issue-modal" role="dialog" aria-label="Report issue">
      <h3>Report an issue</h3>
      <p class="report-issue-hint">Creates a support task with your description. Robot Dojo scrubs PII and secrets before sending. No files, API keys, tokens, or private data dumps are sent.</p>
      <textarea id="report-issue-description" rows="5" placeholder="What happened?" required></textarea>
      <input type="email" id="report-issue-email" placeholder="Your email">
      <label class="report-issue-check"><input type="checkbox" id="report-issue-telemetry" checked> Include browser URL, browser info, and recent JavaScript errors</label>
      <label class="report-issue-check"><input type="checkbox" id="report-issue-chat"> Include recent visible chat text after redaction</label>
      <div class="report-issue-actions">
        <button type="button" class="report-issue-cancel" onclick="closeReportIssueModal()">Cancel</button>
        <button type="button" class="report-issue-submit" onclick="submitReportIssue()">Send</button>
      </div>
      <div id="report-issue-status" class="report-issue-status" style="display:none"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeReportIssueModal(); });
  setTimeout(() => { document.getElementById('report-issue-description')?.focus(); }, 50);
}

function closeReportIssueModal() {
  const ov = document.getElementById('report-issue-modal-overlay');
  if (ov) ov.remove();
}

async function submitReportIssue() {
  const desc = document.getElementById('report-issue-description')?.value?.trim() || '';
  const email = document.getElementById('report-issue-email')?.value?.trim() || '';
  const includeTelemetry = !!document.getElementById('report-issue-telemetry')?.checked;
  const includeChatHistory = !!document.getElementById('report-issue-chat')?.checked;
  const status = document.getElementById('report-issue-status');
  if (!desc) {
    if (status) { status.textContent = 'Please describe the issue.'; status.style.display = ''; }
    return;
  }
  const payload = {
    kind: 'error_report',
    description: redactReportText(desc),
    email: email || undefined,
    url: includeTelemetry ? location.href : undefined,
    userAgent: includeTelemetry ? navigator.userAgent : undefined,
    recentErrors: includeTelemetry
      ? (window.__rdjErrorLog || []).slice(-20).map((err) => ({ ...err, message: redactReportText(err.message) }))
      : undefined,
    includeTelemetry,
    includeChatHistory,
    chatHistory: includeChatHistory ? collectRecentChatHistory() : undefined,
  };
  if (status) { status.textContent = 'Sending…'; status.style.display = ''; }
  try {
    const res = await fetch('https://robotdojo.ai/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 202 || res.ok) {
      if (status) status.textContent = 'Thanks — we got it.';
      setTimeout(closeReportIssueModal, 1200);
    } else {
      if (status) status.textContent = `Failed (${res.status}). Please try again.`;
    }
  } catch (err) {
    if (status) status.textContent = 'Network error. Please try again.';
  }
}

function injectSidebarFooter(config = undefined) {
  if (!config || config === false) return;
  const sidebar = document.querySelector('.app-sidebar');
  if (!sidebar || sidebar.querySelector('.sidebar-footer')) return;
  const footerConfig = config && typeof config === 'object' ? config : {};
  const href = footerConfig.href || '/account/how-to';
  const icon = footerConfig.icon || 'lightbulb';
  const label = footerConfig.label || 'How To Robot';
  const footer = document.createElement('div');
  footer.className = 'sidebar-footer';
  footer.innerHTML = `<a class="sidebar-footer-link" href="${esc(href)}" title="${esc(label)}">
    <span class="material-symbols-outlined">${esc(icon)}</span>
    <span class="sidebar-footer-label">${esc(label)}</span>
  </a>`;
  sidebar.appendChild(footer);
}

// ===== Sidebar New Item (no-op fallback — apps override via Object.assign(window, ...)) =====
function sidebarNewItem() {}
function sidebarBottomAction() {}

// ===== Sidebar Toggle =====
function toggleSidebar(force) {
  const sb = $('#sidebar'), ov = $('#overlay');
  if (!sb) return;
  const mobile = typeof isMobile === 'function' ? isMobile() : window.innerWidth <= 768;
  if (mobile) {
    const closed = sb.classList.contains('hidden') || sb.classList.contains('collapsed');
    const hide = force === false ? true : force === true ? false : !closed;
    sb.classList.toggle('hidden', hide);
    sb.classList.toggle('collapsed', hide);
    ov?.classList.toggle('show', !hide);
  } else {
    const collapse = force === false ? true : force === true ? false : !sb.classList.contains('collapsed');
    sb.classList.toggle('collapsed', collapse);
  }
}
