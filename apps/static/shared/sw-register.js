// apps/static/shared/sw-register.js — global app-shell warmup.
//
// st_feff0f53 — register the service worker after first paint and ask it to
// cache every product app's static shell, not just the app the user opened.
// Route lists are split public/private for registry coverage, but HTML
// navigations stay network-owned. Instant switching comes from cached app
// shell assets plus authenticated first-paint data warmed by shell.js.

(function () {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  const APP_SHELL_ASSETS = [
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
    // st_85ca4f3c — public /faq app is a self-contained duplicate of the
    // chat app's public mode. Precached so the page boots instantly on
    // repeat visits without re-hitting the network.
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
    '/podcast/style.css?v=2026-06-29-1',
    '/podcast/app.js?v=2026-06-29-1',
  ];

  const PUBLIC_ROUTES = ['/', '/login', '/connect', '/faq', '/ask', '/privacy', '/terms', '/licensing', '/install-success', '/auth-google-guidance'];
  const AUTHED_ROUTES = ['/chat', '/podcast', '/health', '/fitness', '/account', '/account/how-to', '/account/setup', '/account/general', '/account/integrations', '/account/agents', '/account/skills', '/account/you', '/account/imports'];
  const warmedRoutes = new Set();
  const CHAT_APP_PATH = location.pathname.startsWith('/chat') && location.pathname !== '/ask';
  const CHAT_CRITICAL_ASSETS = APP_SHELL_ASSETS.filter((url) => {
    try {
      const path = new URL(url, location.origin).pathname;
      return path.startsWith('/static/')
        || path.startsWith('/chat/')
        || path.startsWith('/faq/');
    } catch {
      return false;
    }
  });

  function warmRoutes(routes) {
    for (const route of routes || []) {
      try {
        warmedRoutes.add(new URL(route, location.origin).pathname);
      } catch {
        // Best-effort route inventory only; no navigation fetch here.
      }
    }
  }

  function askWorkerToWarm(registration) {
    const worker = registration?.active || navigator.serviceWorker.controller;
    if (!worker) return;
    try {
      worker.postMessage({ type: 'APP_PRECACHE', urls: CHAT_APP_PATH ? CHAT_CRITICAL_ASSETS : APP_SHELL_ASSETS });
    } catch {
      // Worker warmup is an optimization; never user-visible.
    }
  }

  function warmPublicShell() {
    warmRoutes(PUBLIC_ROUTES);
  }

  function warmAuthedShell() {
    if (CHAT_APP_PATH) return;
    warmRoutes(AUTHED_ROUTES);
  }

  async function register() {
    try {
      warmPublicShell();
      const registration = await navigator.serviceWorker.register('/sw.js');
      registration.update?.().catch(() => {});
      askWorkerToWarm(registration);
      navigator.serviceWorker.ready.then(askWorkerToWarm).catch(() => {});
    } catch {
      // Same — must never throw at boot.
    }
  }

  function afterFirstPaint(fn) {
    const idle = window.requestIdleCallback || ((callback) => setTimeout(callback, 250));
    const run = () => idle(fn, { timeout: 2000 });
    if (document.readyState === 'complete') {
      setTimeout(run, 0);
    } else {
      window.addEventListener('load', run, { once: true });
    }
  }

  afterFirstPaint(register);

  window.RobotDojoPrecache = {
    assets: APP_SHELL_ASSETS.slice(),
    publicRoutes: PUBLIC_ROUTES.slice(),
    authedRoutes: AUTHED_ROUTES.slice(),
    warmRoutes,
    warmAuthedShell,
  };

  window._beltReady?.then?.(warmAuthedShell).catch(() => {});
  document.addEventListener('robotdojo:belt-ready', warmAuthedShell, { once: true });
})();
