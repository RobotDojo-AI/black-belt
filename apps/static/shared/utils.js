// Shared utility functions — loaded after icons.js
const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => (p || document).querySelectorAll(s);
const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
const isMobile = () => window.innerWidth <= 768;
function isNearBottom(el, threshold = 80) { return el.scrollHeight - el.scrollTop - el.clientHeight < threshold; }
function scrollToBottom(el) { el.scrollTop = el.scrollHeight; }

function showToast(msg) { const t = document.createElement('div'); t.textContent = msg; t.className = 'toast'; document.body.appendChild(t); setTimeout(() => t.remove(), 2000); }

// Redirect to /login carrying the current path forward so verify can return
// users here. Debounced: repeated 401s on the same page fire one redirect.
let _redirectingToLogin = false;
function _redirectToLogin(reason) {
  if (_redirectingToLogin) return;
  _redirectingToLogin = true;
  if (reason) { try { sessionStorage.setItem('robotdojo_login_flash', reason); } catch {} }
  const here = location.pathname + location.search + location.hash;
  const url = '/login?redirect=' + encodeURIComponent(here);
  setTimeout(() => { location.href = url; }, 50);
}

// Network offline banner — rendered at top of body on offline, cleared on online.
function _ensureOfflineBanner() {
  if (document.getElementById('netOfflineBanner')) return;
  const bar = document.createElement('div');
  bar.id = 'netOfflineBanner';
  bar.setAttribute('role', 'alert');
  bar.textContent = 'You\u2019re offline. Connection lost \u2014 some features are unavailable.';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;padding:8px 16px;text-align:center;background:#fef2f2;color:#b91c1c;font-size:13px;border-bottom:1px solid #fecaca;font-family:var(--font,inherit)';
  document.body.prepend(bar);
}
function _clearOfflineBanner() {
  const bar = document.getElementById('netOfflineBanner');
  if (bar) bar.remove();
}
if (typeof window !== 'undefined') {
  window.addEventListener('offline', _ensureOfflineBanner);
  window.addEventListener('online', _clearOfflineBanner);
  // Initial state
  if (!navigator.onLine) _ensureOfflineBanner();
}

async function fetchJSON(url, opts = {}) {
  const maxRetries = 2;
  const timeout = 30000;
  // Skip auth-redirect for explicitly optional calls (e.g. pre-session probes).
  const silent401 = opts.silent401 === true;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      // If caller provided a signal, abort our controller when theirs fires
      const callerSignal = opts.signal;
      const onCallerAbort = callerSignal ? () => controller.abort() : null;
      if (onCallerAbort) callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      const { signal: _, silent401: __, ...fetchOpts } = opts; // strip caller signal + our flag
      const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
      clearTimeout(timeoutId);
      if (onCallerAbort) callerSignal.removeEventListener('abort', onCallerAbort);
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 200 * Math.pow(2, attempt)));
          continue;
        }
        // Auth expired / missing — send the user through the magic-link flow
        // rather than showing an opaque toast.
        if (res.status === 401 && !silent401) {
          _redirectToLogin('Sign in to continue');
          return null;
        }
        // Access gate — keep launch copy clear while billing is hidden.
        if (res.status === 402 || res.status === 403) {
          let body = null;
          try { body = await res.clone().json(); } catch {}
          const reason = body?.reason || body?.error;
          if (reason === 'belt_required' || reason === 'black_belt_required') {
            showToast('Black Belt only. Check your Account status or issued beta key.');
          } else if (res.status === 403) {
            showToast('Not allowed. Check your account permissions.');
          } else {
            showToast('Upgrade required to use this feature.');
          }
          return null;
        }
        if (res.status === 429) {
          const ra = res.headers.get('retry-after');
          const sec = ra ? parseInt(ra, 10) : 60;
          showToast(`Whoa, you\u2019re fast. Try again in ${Number.isFinite(sec) ? sec : 60}s.`);
          return null;
        }
        if (res.status === 404) {
          // 404 is usually a caller issue; keep generic so callers can still null-check.
          return null;
        }
        if (res.status >= 500) {
          showToast('Something went wrong on our end. Please try again.');
          return null;
        }
        // Surface a server-provided human message (e.g. an unsupported-file
        // explanation) instead of an opaque status code, when one is present.
        let errBody = null;
        try { errBody = await res.clone().json(); } catch {}
        showToast(errBody?.message || `Error ${res.status}`);
        return null;
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) return res.json();
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && !opts.signal?.aborted) {
        await new Promise(r => setTimeout(r, 200 * Math.pow(2, attempt)));
        continue;
      }
    }
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    _ensureOfflineBanner();
    showToast('You\u2019re offline \u2014 changes will sync when you\u2019re back.');
  } else {
    showToast('Network error \u2014 please try again.');
  }
  console.error('[fetchJSON]', url, lastErr?.message);
  return null;
}

function autoGrowTextarea(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  el.addEventListener('input', () => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px'; });
}

function renderProseMarkdown(text, options = {}) {
  const raw = String(text || '');
  try {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return esc(raw).replace(/\n/g, '<br>');
    const parsed = marked.parse(raw, { mangle: false, headerIds: false });
    const clean = DOMPurify.sanitize(parsed, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style'],
    });
    const template = document.createElement('template');
    template.innerHTML = clean;
    template.content.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href') || '';
      const isHash = href.startsWith('#');
      const isLocal = href.startsWith('/') || href.startsWith(location.origin);
      if (!isHash && !isLocal) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
    });
    template.content.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('rd-table-scroll')) return;
      const wrap = document.createElement('div');
      wrap.className = 'rd-table-scroll';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
    if (options.highlight !== false && typeof hljs !== 'undefined') {
      template.content.querySelectorAll('pre code').forEach((block) => {
        try { hljs.highlightElement(block); } catch {}
      });
    }
    return template.innerHTML;
  } catch (e) {
    console.error('[renderProseMarkdown] Parse error:', e.message);
    return esc(raw).replace(/\n/g, '<br>');
  }
}
function renderMarkdown(text) { return renderProseMarkdown(text); }
function addCopyButtons() {
  // Syntax highlighting
  $$('.message pre code, .coach-msg pre code').forEach(block => { if (!block.dataset.highlighted) hljs.highlightElement(block); });
  // Copy buttons — wrap pre in .code-block-wrapper if needed, inject .copy-code-btn
  $$('.message pre, .coach-msg pre').forEach(pre => {
    if ($('.copy-code-btn', pre)) return; // already done
    const code = $('code', pre);
    if (!code) return;
    // Wrap pre in a position:relative container if not already
    if (!pre.parentElement?.classList.contains('code-block-wrapper')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
    }
    const btn = document.createElement('button');
    btn.className = 'copy-code-btn';
    btn.textContent = 'Copy';
    btn.onclick = () => {
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    };
    pre.appendChild(btn);
  });
}

/**
 * Create a context menu from an array of items.
 * Each item: { label, icon?, action, danger? } or 'divider' for a separator.
 * Returns the menu DOM element (caller positions and appends it).
 */
function createContextMenu(items, onAction) {
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  for (const item of items) {
    if (item === 'divider') {
      const div = document.createElement('div');
      div.className = 'context-menu-divider';
      menu.appendChild(div);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'context-menu-item' + (item.danger ? ' danger' : '');
    el.dataset.action = item.action;
    el.innerHTML = (item.icon ? `<span class="material-symbols-outlined ctx-icon">${esc(item.icon)}</span> ` : '') + esc(item.label);
    el.onclick = () => onAction(item.action);
    menu.appendChild(el);
  }
  return menu;
}

/**
 * Shared confirm modal — dynamically created, self-removing.
 * @param {string} title
 * @param {string} message
 * @param {string} confirmLabel - text for the confirm button
 * @param {function} onConfirm - callback on confirm
 * @param {boolean} [isDanger=true] - whether confirm button is danger-styled
 */
function showConfirmModal(title, message, confirmLabel, onConfirm, isDanger) {
  if (isDanger === undefined) isDanger = true;
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  const btnClass = isDanger ? 'danger-btn' : 'confirm-btn';
  overlay.innerHTML = `<div class="confirm-modal"><h3>${esc(title)}</h3><p>${esc(message)}</p><div class="confirm-actions"><button class="cancel-btn">Cancel</button><button class="${btnClass}">${esc(confirmLabel)}</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.cancel-btn').onclick = () => overlay.remove();
  overlay.querySelector('.' + btnClass).onclick = () => { overlay.remove(); onConfirm(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

/**
 * Shared prompt modal — dynamically created, self-removing, with input field.
 * @param {string} title
 * @param {string} message
 * @param {string} confirmLabel
 * @param {function} onConfirm - receives input value
 * @param {string} [placeholder='']
 * @param {string} [defaultValue='']
 */
function showPromptModal(title, message, confirmLabel, onConfirm, placeholder, defaultValue) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `<div class="confirm-modal"><h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}<input type="text" class="prompt-input" placeholder="${esc(placeholder || '')}" value="${esc(defaultValue || '')}"><div class="confirm-actions"><button class="cancel-btn">Cancel</button><button class="confirm-btn">${esc(confirmLabel)}</button></div></div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('.prompt-input');
  setTimeout(() => { input.focus(); input.select(); }, 50);
  overlay.querySelector('.cancel-btn').onclick = () => overlay.remove();
  overlay.querySelector('.confirm-btn').onclick = () => { const val = input.value; overlay.remove(); onConfirm(val); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { const val = input.value; overlay.remove(); onConfirm(val); } if (e.key === 'Escape') overlay.remove(); });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}
