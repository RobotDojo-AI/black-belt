/**
 * Vercel Edge Middleware — routes app requests to the user's local Mac.
 *
 * st_63b59bda: the apex no longer PROXIES to the subdomain. It REDIRECTS the
 * browser straight to `{slug}.robotdojo.ai{path}`, which talks directly to the
 * blind relay. Vercel Edge is removed from the plaintext path entirely — it
 * never opens a TLS connection to the subdomain, never reads a response body,
 * never rewrites a cookie. This is the deliberate trade the owner approved
 * ("optiona A, peserve privacy always"): the apex gives up session-check-
 * before-serve, auto-retry on a flaky Mac, and cookie-domain rewriting, in
 * exchange for the hosting platform being structurally unable to read connect
 * traffic. Session continuity across the apex↔subdomain hop rides on the
 * `.robotdojo.ai`-scoped session cookie, which the browser sends to the
 * subdomain automatically after the redirect.
 *
 * /me/{slug}/* paths: redirect to https://{slug}.robotdojo.ai{subpath}
 *   (backward compat for bookmarks — slug in URL overrides session slug).
 * Bare app paths (/chat, /api/*, etc.) with an rd_server routing cookie:
 *   redirect to the device subdomain. The Mac validates the real rdj_session.
 * No routing cookie: redirect to /connect.
 * PUBLIC_AUTH_PATHS on /me/{slug}/: redirect to the subdomain (magic-link verify
 *   runs on the Mac).
 */
export const config = {
  matcher: [
    '/me', '/me/:path*',
    '/api/:path*', '/auth/:path*',
    '/version',
    '/chat', '/chat/:path*',
    '/apps/chat', '/apps/chat/:path*',
    '/apps/account', '/apps/account/:path*',
    '/apps/network', '/apps/network/:path*',
    '/apps/health', '/apps/health/:path*',
    '/apps/fitness', '/apps/fitness/:path*',
    '/apps/podcast', '/apps/podcast/:path*',
    '/apps/viewer', '/apps/viewer/:path*',
    '/account', '/account/:path*',
    '/accounts', '/accounts/:path*',
    '/network', '/network/:path*',
    '/pulse', '/pulse/:path*',
    '/health', '/health/:path*',
    '/fitness', '/fitness/:path*',
    '/podcast', '/podcast/:path*',
    '/setup', '/setup/:path*',
    '/viewer', '/viewer/:path*',
    '/topics', '/topics/:path*',
    '/transcripts', '/transcripts/:path*',
    '/docs', '/docs/:path*',
    '/agents', '/agents/:path*',
    '/user', '/user/:path*',
    '/people', '/people/:path*',
    '/companies', '/companies/:path*',
    '/places', '/places/:path*',
    '/entities', '/entities/:path*',
    '/workbenches', '/workbenches/:path*',
    '/work', '/work/:path*',
    '/personal', '/personal/:path*',
    '/family', '/family/:path*',
    '/networking', '/networking/:path*',
    '/education', '/education/:path*',
    '/newsletters', '/newsletters/:path*',
    '/static/shared/:path*',
    '/static/fonts/:path*',
    '/static/vendor/:path*',
  ],
};

const ROUTING_COOKIE_NAME = 'rd_server';
const SESSION_COOKIE_NAME = 'rdj_session';

// Body cap mirrors api/public-chat.js MAX_BODY_BYTES and routes/public-chat.js.
// Enforced HERE, in middleware, because the internal apex->function rewrite
// (/api/public-chat/stream -> /api/public-chat) strips content-length before the
// Edge function sees it, and a full read of an oversize body inside the function
// intermittently kills the isolate instead of returning a clean 413. Middleware
// runs on the ORIGINAL pre-rewrite request, where the client's content-length is
// still present, so the cap is deterministic for any client that sends one.
const MAX_BODY_BYTES = 1024 * 1024;
const BODY_CAPPED_ROUTES = new Set([
  '/api/public-chat/stream',
  '/api/public-chat/onboarding-share',
]);

const PUBLIC_AUTH_PATHS = [
  '/api/auth/request-code',
  '/api/auth/verify-code',
  '/api/auth/request-link',
  '/api/auth/verify',
  '/api/auth/probe',
];

// Routes that must pass through to Vercel without a routing slug. These serve
// the marketing site (public chat, health, config) and must remain accessible
// without a routing cookie.
const PASS_THROUGH_ROUTES = new Set([
  '/google6102e1268ece5472',
  '/api/public-chat/stream',
  '/api/public-chat/onboarding-share',
  '/api/public-chat/health',
  '/api/billing/stripe/webhook',
  // Public feedback intake (error reports + feature requests) — st_d9fc573b.
  '/api/feedback',
  // Neon edge auth endpoints — handle their own auth, no session required
  '/api/auth/send-code',
  '/api/auth/verify-code',
  '/api/auth/sign-out',
  // Apex login proxy — st_fc3856d6. Receives {server, token} at apex, forwards
  // token validation to {server}.robotdojo.ai/api/auth/token via outbound HTTPS,
  // and re-emits the Mac's Set-Cookie. Public by design: the apex deployment has
  // no session yet — that's what this endpoint creates.
  '/api/auth/token',
  // Pre-OAuth guidance interstitial — public by design (user isn't authed yet).
  '/auth/google/guidance',
  // Cohort-key revocation endpoint — every install polls this hourly. Public by
  // design (response is signed; client verifies against its embedded public key).
  '/api/bb-revocation.json',
]);
const PASS_THROUGH_PREFIXES = [
  '/api/public/',
  '/static/fonts/',
  // Public /ask reuses the real chat app modules and stylesheet. The page is
  // public, but /chat itself remains authenticated below.
  '/chat/modules/',
  '/chat/components/',
];
const PASS_THROUGH_STATIC_ASSETS = new Set([
  '/chat/app.js',
  '/chat/public-app.js',
  '/chat/style.css',
]);

const VIEWER_STATIC_PATHS = new Set([
  '/viewer',
  '/viewer/index.html',
  '/viewer/app.js',
  '/viewer/style.css',
]);

const ACCOUNT_STATIC_PATHS = new Set([
  '/account/index.html',
  '/account/style.css',
  '/account/app-config.js',
  '/account/app.js',
  '/account/usage.js',
  '/account/components/task-tiles.js',
]);

const HEALTH_STATIC_PATHS = new Set([
  '/health/index.html',
  '/health/style.css',
  '/health/app.js',
  '/health/chart.js',
]);

const FITNESS_STATIC_PATHS = new Set([
  '/fitness/index.html',
  '/fitness/style.css',
  '/fitness/app.js',
]);

const RELAY_APP_FRAMEWORK_PREFIXES = [
  '/static/shared/',
  '/static/vendor/',
];

// Stylesheets the PUBLIC marketing pages load. Identical bytes on Vercel and on
// the Mac, so there is nothing to gain by relaying them — and everything to lose,
// since the marketing CSP allows style-src 'self' only.
// Every /static/shared/ and /static/vendor/ asset referenced by a PUBLIC page
// (index, privacy, terms, licensing, install-success, auth-google-guidance,
// connect, faq, ask). Authenticated app pages are themselves served from
// {slug}.robotdojo.ai and resolve their assets against that origin, so they
// never reach this middleware — an apex-origin request for one of these is
// always a public page, and relaying it only trips the public CSP
// (style-src/script-src 'self') and leaves the page unstyled.
//
// Regenerate with:
//   grep -o '/static/\(shared\|vendor\)/[a-zA-Z0-9._-]*' apps/index.html \
//     apps/privacy.html apps/terms.html apps/licensing.html \
//     apps/install-success.html apps/auth-google-guidance.html \
//     apps/connect/index.html apps/faq/index.html apps/ask.html | sort -u
const PUBLIC_MARKETING_ASSETS = new Set([
  '/static/shared/app-layout.css',
  '/static/shared/app-registry.js',
  '/static/shared/marketing.css',
  '/static/shared/shell.css',
  '/static/shared/sw-register.js',
  '/static/shared/theme.css',
  '/static/vendor/fonts.css',
  '/static/vendor/hljs-github.min.css',
]);

export default async function middleware(req) {
  const incoming = new URL(req.url);
  const match = incoming.pathname.match(/^\/me\/([^/]+)(\/.*)?$/);
  const urlSlug = match ? match[1] : null;
  const subpath = match ? (match[2] || '/') : incoming.pathname;

  // Auth-bootstrap: slug in URL + public auth path → redirect to the subdomain
  // without a routing-cookie check (magic-link verify runs on the Mac).
  if (urlSlug && PUBLIC_AUTH_PATHS.some((p) => subpath === p || subpath.startsWith(p + '?'))) {
    return redirectToSubdomain(urlSlug, subpath, incoming);
  }

  // Public marketing assets are never relay-redirected. They live under
  // /static/shared/ and /static/vendor/, so the app-framework rule below would
  // otherwise send them to {slug}.robotdojo.ai for anyone holding a device
  // routing cookie. The public pages ship a CSP of style-src 'self', so that
  // cross-origin hop is blocked and every public page renders unstyled — the
  // homepage's belt icons rendered at full container width. A device cookie must
  // not change how the public site looks.
  if (PUBLIC_MARKETING_ASSETS.has(incoming.pathname)) return;

  // App framework assets travel through the same relay target as the app page
  // once the browser has a device-routing cookie. Anonymous public pages keep
  // using Vercel assets.
  if (isRelayAppFrameworkAsset(incoming.pathname)) {
    const slug = urlSlug || readCookie(req, ROUTING_COOKIE_NAME);
    if (slug && isValidRelaySlug(slug)) {
      return redirectToSubdomain(slug, subpath, incoming);
    }
    return;
  }

  // Public routes on the marketing domain: pass through to Vercel, no slug needed.
  if (PASS_THROUGH_ROUTES.has(incoming.pathname) ||
      PASS_THROUGH_STATIC_ASSETS.has(incoming.pathname) ||
      isViewerStaticAsset(incoming.pathname) ||
      isAccountStaticAsset(incoming.pathname) ||
      isHealthStaticAsset(incoming.pathname) ||
      isFitnessStaticAsset(incoming.pathname) ||
      PASS_THROUGH_PREFIXES.some(p => incoming.pathname.startsWith(p))) {
    if (req.method === 'POST' && BODY_CAPPED_ROUTES.has(incoming.pathname)) {
      const len = Number(req.headers.get('content-length') || 0);
      if (len > MAX_BODY_BYTES) {
        return new Response(JSON.stringify({ error: 'request_too_large' }), {
          status: 413,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return; // undefined → Vercel continues to the next handler (the Hono app)
  }

  // All other paths need a routing slug. The Mac owns app-session validation, so
  // Vercel never needs a per-install SESSION_SECRET.
  const cookieSlug = readCookie(req, ROUTING_COOKIE_NAME);
  const slug = urlSlug || cookieSlug;
  if (!slug || !isValidRelaySlug(slug)) {
    return redirectToLogin(req, incoming, 'server_required', Boolean(cookieSlug));
  }

  // Redirect straight to the user's subdomain. The Mac (through the blind relay)
  // serves both the app shell and its data — Vercel Edge never reads it.
  return redirectToSubdomain(slug, subpath, incoming);
}

function isRelayAppFrameworkAsset(pathname) {
  return RELAY_APP_FRAMEWORK_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function isViewerStaticAsset(pathname) {
  return VIEWER_STATIC_PATHS.has(pathname);
}

function isAccountStaticAsset(pathname) {
  return ACCOUNT_STATIC_PATHS.has(pathname);
}

function isHealthStaticAsset(pathname) {
  return HEALTH_STATIC_PATHS.has(pathname);
}

function isFitnessStaticAsset(pathname) {
  return FITNESS_STATIC_PATHS.has(pathname);
}

function isValidRelaySlug(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(slug);
}

/**
 * Redirect the browser to the user's subdomain. A 307 preserves the method and
 * body so a bookmarked API POST still reaches the Mac, and the browser — not
 * Vercel Edge — opens the TLS connection, so the hosting platform never sees the
 * plaintext. Session continuity rides on the `.robotdojo.ai`-scoped cookie the
 * browser sends to the subdomain automatically.
 */
function redirectToSubdomain(slug, subpath, incoming) {
  const target = new URL(`https://${slug}.robotdojo.ai`);
  target.pathname = subpath;
  target.search = incoming.search;
  return new Response(null, {
    status: 307,
    headers: {
      location: target.toString(),
      'cache-control': 'no-store',
    },
  });
}

function redirectToLogin(req, incoming, reason, clearCookies = false) {
  // st_85ca4f3c — public-facing CTA copy reads "Connect", so the address bar
  // also reads /connect when the middleware bounces an anonymous visitor.
  const url = new URL('/connect', req.url);
  url.searchParams.set('redirect', incoming.pathname + incoming.search);
  url.searchParams.set('reason', reason);
  const slugHint = readCookie(req, ROUTING_COOKIE_NAME);
  const preserveRoutingSlug = (
    reason === 'session_expired'
    || reason === 'server_unreachable'
  ) && slugHint && isValidRelaySlug(slugHint);
  if (preserveRoutingSlug) {
    url.searchParams.set('server', slugHint);
  }
  const res = new Response(null, {
    status: 302,
    headers: { location: url.toString() },
  });
  if (clearCookies) {
    // The routing slug (rd_server) is NOT a credential — it only records which
    // Mac to relay to. We wipe the slug only when it is missing, malformed, or
    // otherwise not a usable routing hint.
    clearAuthCookies(res.headers, preserveRoutingSlug ? 'session' : 'all');
  }
  return res;
}

function clearAuthCookies(headers, scope = 'all') {
  const opts = 'Max-Age=0; Path=/; SameSite=Lax; Secure';
  // The session credential is always cleared.
  headers.append('set-cookie', `${SESSION_COOKIE_NAME}=; Domain=.robotdojo.ai; HttpOnly; ${opts}`);
  headers.append('set-cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; ${opts}`);
  // The routing slug is cleared only when the slug itself is suspect.
  if (scope === 'all') {
    headers.append('set-cookie', `${ROUTING_COOKIE_NAME}=; Domain=.robotdojo.ai; ${opts}`);
    headers.append('set-cookie', `${ROUTING_COOKIE_NAME}=; ${opts}`);
  }
}

/**
 * Standard cookie-header parse. Returns the raw value of the named cookie or null.
 */
function readCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) !== name) continue;
    const raw = part.slice(eq + 1);
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return null;
}
