// apps/static/sw.js — versioned app-shell precache.
//
// st_feff0f53 — cache the reusable app framework bytes so product apps can
// switch instantly after the first boot. HTML navigations and private API
// responses stay network-owned; the worker only serves same-origin static
// assets and keeps them versioned so deploys can evict stale shells.

const APP_SHELL_CACHE_VERSION = '2026-09-13-1';
const APP_SHELL_CACHE = `robotdojo-app-shell-v${APP_SHELL_CACHE_VERSION}`;
const APP_SHELL_CACHE_PREFIX = 'robotdojo-app-shell-v';

const PRECACHE_URLS = [
  '/static/shared/theme.css',
  '/static/shared/shell.css',
  '/static/shared/app-layout.css',
  '/static/shared/app-registry.js',
  '/static/shared/app-components.js',
  '/static/shared/app-state.js',
  '/static/shared/layout-manager.js',
  '/static/shared/right-pane.js',
  '/static/shared/pane-renderers.js',
  '/static/shared/llm.js',
  '/static/shared/utils.js',
  '/static/shared/api.js',
  '/static/shared/icons.js',
  '/static/shared/shell.js',
  '/static/shared/shell-notifications.js',
  '/static/shared/shell-search.js',
  '/static/shared/shortcuts.js',
  '/static/shared/entity-types.js',
  '/static/shared/marketing.css',
  '/static/shared/marketing.js',
  '/static/shared/sw-register.js',
  '/static/vendor/fonts.css',
  '/static/vendor/split.min.js',
  '/static/vendor/marked.min.js',
  '/static/vendor/purify.min.js',
  '/static/vendor/sortable.min.js',
  '/static/vendor/highlight.min.js',
  '/static/vendor/hljs-github.min.css',
  '/static/vendor/hljs-github-dark.min.css',
  '/static/vendor/chart.umd.min.js',
  '/static/vendor/chartjs-adapter-date-fns.min.js',
  '/static/vendor/chartjs-plugin-annotation.min.js',
  '/static/fonts/inter-latin.woff2',
  '/static/fonts/material-symbols-outlined-400.ttf',
  '/static/favicon.svg',
  '/static/manifest.json',
  '/static/icon-180.png',
  '/static/icon-192.png',
  '/static/icon-192.svg',
  '/static/icon-512.png',
  '/static/img/logo.svg',
  '/static/img/robotdojo-logo-120.png',
  '/static/img/belt-white.svg',
  '/static/img/belt-black.svg',
  '/static/faq-data.json',
  '/static/faq/core.json',
  '/static/faq/faq-context.json',
  '/static/faq/faq-how-it-works.json',
  '/static/faq/faq-open-source.json',
  '/static/faq/faq-pricing.json',
  '/static/faq/faq-privacy.json',
  '/static/faq/faq-your-data.json',
  '/static/faq/install-guide.json',
  '/static/faq/setup-guide.json',
  '/static/js/public-chat-core.js',
  '/chat/style.css',
  '/chat/app.js',
  '/chat/public-app.js',
  '/chat/modules/chat.js',
  '/chat/modules/topic-nav.js',
  '/chat/modules/topic-store.js',
  '/chat/modules/error-ui.js',
  '/chat/modules/indicator.js',
  '/chat/modules/input.js',
  '/chat/modules/inline-recognition.js',
  '/chat/modules/state.js',
  '/chat/modules/stream-client.js',
  '/chat/modules/stream-parser.js',
  '/chat/components/drop-events.js',
  '/chat/components/secure-input-overlay.js',
  // st_85ca4f3c — public /faq surface (faithful duplicate of chat in
  // public-only mode). Precached so /faq boots instantly on repeat visits.
  '/faq/style.css',
  '/faq/app.js',
  '/faq/public-app.js',
  '/faq/modules/stream-client.js',
  '/faq/modules/stream-parser.js',
  '/account/style.css',
  '/account/app-config.js',
  '/account/app.js',
  '/account/usage.js',
  '/account/components/task-tiles.js',
  '/health/style.css?v=2026-09-07-4',
  '/health/chart.js?v=2026-09-07-4',
  '/health/app.js?v=2026-09-07-4',
  '/fitness/style.css?v=2026-09-05-2',
  '/fitness/app.js?v=2026-09-05-2',
  '/podcast/style.css?v=2026-06-29-4',
  '/podcast/app.js?v=2026-06-29-4',
];

const PRECACHE_SET = new Set(PRECACHE_URLS);
const BOOT_PRECACHE_URLS = PRECACHE_URLS.filter((url) => {
  try {
    const path = new URL(url, self.location.origin).pathname;
    return path.startsWith('/static/')
      || path.startsWith('/chat/')
      || path.startsWith('/faq/');
  } catch {
    return false;
  }
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isBlockedPrivatePath(pathname) {
  return pathname.startsWith('/api/') || pathname.startsWith('/auth/');
}

// Stylesheets the PUBLIC marketing pages depend on. The fetch handler below is
// stale-while-revalidate, which is right for the installed app shell but wrong
// for a public marketing site: a returning visitor would be served the previous
// stylesheet and see the OLD layout for one more load after every deploy. These
// ship with `cache-control: max-age=0, must-revalidate`, so going to network
// costs a conditional request and guarantees the public site is never stale.
const NEVER_CACHE_PATHS = new Set([
  '/static/shared/marketing.css',
  '/static/vendor/fonts.css',
]);

function isCacheableAssetPath(pathname) {
  if (NEVER_CACHE_PATHS.has(pathname)) return false;
  if (PRECACHE_SET.has(pathname)) return true;
  if (isBlockedPrivatePath(pathname)) return false;
  const underStaticAppRoot = pathname.startsWith('/static/')
    || pathname.startsWith('/chat/')
    || pathname.startsWith('/account/')
    || pathname.startsWith('/health/')
    || pathname.startsWith('/podcast/');
  if (!underStaticAppRoot) return false;
  return /\.(?:css|js|mjs|json|woff2?|ttf|svg|png|jpe?g|webp|ico)$/i.test(pathname);
}

async function cacheAsset(url) {
  try {
    const request = new Request(url, { cache: 'reload' });
    const response = await fetch(request);
    if (!response || !response.ok) return false;
    const cache = await caches.open(APP_SHELL_CACHE);
    await cache.put(url, response);
    return true;
  } catch {
    return false;
  }
}

async function warmAssets(urls) {
  const normalized = Array.from(new Set(urls || []))
    .map((url) => {
      try { return new URL(url, self.location.origin); } catch { return null; }
    })
    .filter((url) => url && isSameOrigin(url) && isCacheableAssetPath(url.pathname))
    .map((url) => url.pathname + url.search);
  const queue = normalized.slice();
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      if (url) await cacheAsset(url);
    }
  });
  await Promise.allSettled(workers);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await warmAssets(BOOT_PRECACHE_URLS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(APP_SHELL_CACHE_PREFIX) && name !== APP_SHELL_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'APP_PRECACHE') {
    event.waitUntil(warmAssets(data.urls || []));
  } else if (data.type === 'GET_PRECACHE_VERSION') {
    event.source?.postMessage?.({
      type: 'APP_PRECACHE_VERSION',
      version: APP_SHELL_CACHE_VERSION,
      cache: APP_SHELL_CACHE,
    });
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') return;
  if (request.headers.has('Authorization')) return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!isSameOrigin(url)) return;
  if (!isCacheableAssetPath(url.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(APP_SHELL_CACHE);
    const versioned = url.search.length > 1;
    // Versioned URLs are cache-bust tokens. Network-first so a refresh after
    // a default-model or nav change cannot keep serving Haiku-era JS.
    if (versioned) {
      try {
        const fresh = await fetch(request);
        if (fresh?.ok) {
          event.waitUntil(cache.put(request, fresh.clone()));
          return fresh;
        }
      } catch { /* fall through to cache */ }
      const cachedVersioned = await cache.match(request, { ignoreSearch: false });
      if (cachedVersioned) return cachedVersioned;
    }
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) {
      event.waitUntil(fetch(request).then((fresh) => {
        if (fresh?.ok) return cache.put(request, fresh.clone());
        return null;
      }).catch(() => null));
      return cached;
    }
    const fresh = await fetch(request);
    if (fresh?.ok) event.waitUntil(cache.put(request, fresh.clone()));
    return fresh;
  })());
});
