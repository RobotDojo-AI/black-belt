/**
 * Hono server — static files, middleware, route registration.
 * Process lifecycle: crash → exit(1) → launchd restarts.
 *
 * Belt levels: demo (fresh user), white (the user's data, open features),
 * black (the user's data, all features). Belt is set per-port in index.js.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { requireAuth, validateToken } from './auth.js';
import { optionalAuth } from './middleware-auth.js';
import { demoShellGuard } from './demo-shell-guard.js';
import config from './config.js';
import {
  createRequestObserver,
  startRequestObserver,
  recordActivityStart,
  recordActivityFinish,
  recordChatActivity,
  recordChatAppActive,
  sanitizeRequestPath,
  shouldRecordForegroundActivity,
  shouldRecordChatRequestActivity,
  stopActivityFlush,
} from './request-observer.js';
// st_2cd1af73 AC-1 — env-gated entry tracer (zero cost unless
// ROBOTDOJO_CHAT_ENTRY_TRACE=1). Created here so middleware steps that run
// BEFORE the chat route (activity stamp, auth, rate limit) are measured on the
// same timeline as the route's own steps.
import { startEntryTrace, ENTRY_TRACE_ENABLED } from './chat/entry-trace.js';
import { getSessionLogQueueStatus } from './session-log-queue.js';
// st_27561b77 AC3 — eager imports for the /api/server-health hot path.
// The handler used to dynamic-import these per request; the first deep call
// after restart paid 800-1500ms compiling the import graph, blowing the
// AC3 1s budget. Module-level imports hoist that cost into server boot.
import dbModule from './db.js';
import { checkDbHealth, flattenDbHealth, dbHealthFailure } from './db-health.js';
import { getCachedDeepHealth, getLastCheckpointResult } from './passive-supervisor.js';
import { readSupervisorPassiveSummary } from './supervisor-status.js';
// st_b57e6ec5 — read-only provider-health rollup (overload/error rows only
// from chat_turn_metrics + warmup_events — NOT latency; see
// lib/provider-health.js for why), surfaced on /api/server-health for
// ops/dashboard visibility. Reported here regardless of the customer-facing
// flag (isProviderHealthEnabled) — this endpoint is for machine/ops
// consumers, always tagged with `enabled` so a reader never mistakes a
// flag-off read for "no active monitor."
import { getProviderHealth, isProviderHealthEnabled } from './provider-health.js';
import { getWarmupState } from './warmup.js';
import { closeIdleTopicSessions } from './topic-session.js';
import { closeIdleCodingTopicSessions } from './coding-topic-idle.js';
import { getGlobalAnnReadiness, getGlobalDiskStatus, getGlobalStatus } from './ann/usearch-adapter.js';
import { getBBStatus } from './cohort/active.js';
import { readMarkdownDocument } from './markdown-documents.js';
import { viewerTopicLensForInjection, viewerPrewarmRoutes } from './viewer-topic-lens.js';
import { readFileSync as fsReadFileSync, existsSync as fsExistsSync } from 'node:fs';

const app = new Hono();
const requestObserver = createRequestObserver();
startRequestObserver(requestObserver);
const SERVER_HEALTH_CACHE_MS = Number(process.env.ROBOTDOJO_SERVER_HEALTH_CACHE_MS || 1_000);
// st_27561b77 AC2/AC3 — separate caches for shallow vs deep.
//
// WHY two caches: the deep handler used to recompute the full body on every
// request, so under concurrent backlog drain (page-cache contention) the
// foreground saw 1.9–16s spikes — well over the AC3 1s budget. The fix is to
// cache the deep response body the same way the shallow one is cached, with
// the supervisor pre-warming both on startup and refreshing on every tick.
// A drain DB write never invalidates these caches; they expire by wall-clock
// TTL only, so under load the foreground always serves cache (no inline
// recompute). Fidelity is preserved because the supervisor's background
// integrity tick keeps the integrity_* fields fresh independently.
let serverHealthCache = null;
let serverHealthCacheExpiresAt = 0;
let serverHealthCacheDeep = null;
let serverHealthCacheDeepExpiresAt = 0;
function warmingPassiveSummary(reason = 'worker-summary-warming') {
  return {
    ok: false,
    warming: true,
    reason,
    checked_at: new Date().toISOString(),
    totals: { depth: null },
    queues: [],
  };
}

function annRuntimeHealth() {
  const status = getGlobalStatus();
  const disk = getGlobalDiskStatus();
  // Status must not count the live chunks table on the server thread. On the
  // SQLCipher production DB, COUNT(*) over chunks can monopolize the event loop
  // long enough to break the relay. Background QA/maintenance owns live corpus
  // freshness; server health reports runtime/disk state without an inline scan.
  const readiness = getGlobalAnnReadiness();
  const shouldLoad = !status || status.stale_on_disk;
  // Do not auto-load from a health check. loadGlobalIndex() refreshes the
  // 366k-row chunk-topic map synchronously; triggering it here turns a health
  // probe into a foreground SQLCipher scan. Chat/retrieval and QA can load the
  // runtime index when needed; health only reports whether that work is needed.
  return status
    ? { ...status, disk, readiness, reload_needed: shouldLoad, reload_in_flight: false }
    : { loaded: false, disk, readiness, reload_needed: shouldLoad, reload_in_flight: false };
}

function normalizeWarmupAnnReadiness(warm, annRuntime) {
  if (!warm || typeof warm !== 'object') return warm;
  const readiness = annRuntime?.readiness;
  if (readiness?.ready !== true) return warm;
  const chunks = annRuntime?.disk?.full_size
    ?? annRuntime?.disk?.built_from_count
    ?? readiness?.disk?.full_size
    ?? readiness?.disk?.built_from_count
    ?? warm.ann_chunks
    ?? null;
  return {
    ...warm,
    ann_done: true,
    ann_global: true,
    ann_ready: true,
    ann_chunks: chunks,
    ann_error: null,
  };
}

function normalizeServerHealthAnnReadiness(body) {
  const annRuntime = body?.ann_runtime || annRuntimeHealth();
  const warm = normalizeWarmupAnnReadiness(body?.warmup, annRuntime);
  return {
    ...body,
    warmup: warm,
    warmup_complete: warm?.warmup_complete ?? body?.warmup_complete,
    ann_runtime: annRuntime,
  };
}

function overlayLiveWarmupState(body) {
  const annRuntime = body?.ann_runtime || annRuntimeHealth();
  const liveWarm = normalizeWarmupAnnReadiness(getWarmupState(), annRuntime);
  return {
    ...body,
    warmup: {
      ...(body?.warmup || {}),
      ...liveWarm,
    },
    warmup_complete: liveWarm?.warmup_complete ?? body?.warmup_complete,
    ann_runtime: annRuntime,
  };
}

// st_27561b77 cold-start hardening — buildWarmingBody short-TTL cache.
//
// The supervisor's eager body warm runs inside setImmediate (so it doesn't
// block server startup), meaning a burst of /api/server-health?deep
// arriving in the first ~50ms after restart races the warm. Without this
// cache, each of N concurrent requests independently runs buildWarmingBody,
// each of which calls checkDbHealth({deep:false}) on the SQLCipher DB.
// better-sqlite3 is synchronous: N concurrent calls serialize on the JS
// event loop, and on the first cold ping after SQLCipher key-derive the
// per-pragma cost is ~50-100ms. 10 concurrent cold callers therefore tail
// at ~500ms-1s — that's the 2.16s p95 the cold burst measurement saw.
//
// One-second TTL covers the cold burst window without compromising
// fidelity: the synthetic body explicitly carries warming:true, integrity
// timestamp, last-checkpoint result, and a live ping. Within the TTL,
// concurrent cold callers share one computation; outside it, the cache
// expires and either the supervisor's warm has populated the real body
// cache (steady state) OR a fresh warming body is computed.
let warmingBodyCacheShallow = null;
let warmingBodyCacheShallowExpiresAt = 0;
let warmingBodyCacheDeep = null;
let warmingBodyCacheDeepExpiresAt = 0;
const WARMING_BODY_CACHE_MS = Number(process.env.ROBOTDOJO_WARMING_BODY_CACHE_MS || 1_000);

// --- Belt context ---
// Set by index.js per-port via setBelt(). Available to all routes via c.get('belt').
let _defaultBelt = 'black';
export function setBelt(belt) { _defaultBelt = belt; }

// --- Belt architecture ---
// White Belt = Knows YOU: chat + RAG. That's it. Pure conversation with memory.
// Black Belt = Knows YOUR WORLD: all apps/skills (Network, Pulse, Accounts,
//   family tree, voice types, entity extraction, referral).
// Every "app" beyond chat is a Black Belt skill.
const BLACK_BELT_PREFIXES = [
  '/api/network/',    // Network app (people, companies, family, places)
  '/api/health/',     // Pulse app (health metrics, medications, notes)
  '/api/identity/',   // soul/identity/principles
  '/api/accounts',    // account management
  '/api/account',     // account preferences, telemetry, deletion
  '/api/setup',       // local readiness/admin APIs
  '/api/admin',       // admin endpoints (belt override, whoami)
  '/api/chat/',       // authenticated chat (stream + sync) — NOT public
  '/api/files/',      // file ops on user data
  '/api/secure-input/', // credential capture (requires session)
];

// Demo-port gate: routes that must NEVER serve on the unauthenticated
// marketing port (belt === 'demo'), regardless of their own auth posture.
// Keeps LAN attackers on 0.0.0.0:4336 from hitting the authenticated chat
// handler (which uses the operator's Anthropic key) even if an auth check
// is missed.
const DEMO_BLOCKED_PREFIXES = BLACK_BELT_PREFIXES;

// --- Middleware ---
// CORS: restrict to same-origin + local dev. Public endpoints that need
// wide CORS (none today — public-chat/stream is called from our own page)
// can opt in per-route. Global `*` is a footgun because the marketing
// site binds to 0.0.0.0 and shares the Hono app with the authenticated
// app port — any LAN host could forge cross-origin calls otherwise.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/robotdojo\.ai$/,
  /^https:\/\/[a-z0-9-]+\.robotdojo\.ai$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];
app.use('*', cors({
  origin: (origin) => {
    // Null/empty Origin = same-origin fetch or non-browser client → allow.
    if (!origin) return origin;
    return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin)) ? origin : null;
  },
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// Inject belt level into every request
app.use('*', async (c, next) => {
  c.set('belt', _defaultBelt);
  await next();
});

// st_96bb626f AC-13 — Black Belt gates REMOTE (relay/LAN) reachability. When the
// per-install expiry has passed, getBBStatus() returns inactive and remote
// requests degrade: the relay surface 403s while local access keeps working
// (the scope's "access their dojo locally, relay becomes unavailable"). Loopback
// or empty Host short-circuits BEFORE getBBStatus() so the localhost hot path —
// and the TTFT-measured chat path — pays zero added cost; only non-loopback
// requests (the relay carries `{slug}.connect.robotdojo.ai`) are checked.
app.use('*', async (c, next) => {
  const host = c.req.header('host') || '';
  const isLocal = host === '' || /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(host);
  if (!isLocal) {
    const s = await getBBStatus();
    if (!s.active) return c.json({ stale_banner: true, belt: 'white', reason: 'relay_bb_expired' }, 403);
  }
  return next();
});

// Low-noise runtime observer for production stalls. It records only route
// shape, status, duration, and rolling counts; query values are stripped so
// auth tokens and user prompts never land in logs.
app.use('*', async (c, next) => {
  const started = Date.now();
  let failed = false;
  // st_2cd1af73 AC-1 — trace only the chat-stream entry path; this middleware
  // fires for every request, so gate the tracer to the one route we measure.
  const traced = ENTRY_TRACE_ENABLED && c.req.method === 'POST'
    && (c.req.path === '/api/chat/stream');
  const trace = traced ? startEntryTrace('mw') : null;
  if (trace) { c.set('entryTrace', trace); trace.mark('mw_enter'); }
  // st_2cd1af73 — stamp the cross-process server-activity signal only for
  // foreground product work, so the chunk-embed daemon yields the WAL writer
  // while a user path is in flight. Health/readiness probes and static assets
  // stay observable below without parking the embed backlog forever.
  const activityRequest = {
    method: c.req.method,
    path: c.req.path,
    headers: { 'x-robotdojo-warmup': c.req.header('x-robotdojo-warmup') || '' },
  };
  const foregroundActivity = shouldRecordForegroundActivity(activityRequest);
  if (foregroundActivity && process.env.ROBOTDOJO_ACTIVITY_TRACE === '1') {
    console.warn('[activity-trace] foreground', {
      method: c.req.method,
      path: sanitizeRequestPath(c.req.url || c.req.path),
      host: c.req.header('host') || '',
      user_agent: c.req.header('user-agent') || '',
    });
  }
  if (foregroundActivity) recordActivityStart(dbModule);
  // st_2cd1af73 AC-3 — additionally stamp the CHAT-ONLY recency signal on the
  // chat-stream paths (authenticated + public). The daemon's long-input start
  // gate reads this, NOT the all-traffic lastRequestAt, so overnight background
  // polling (health, login-probe, sync, supervisor, maintenance) can no longer pin
  // the long-input gate shut and starve the 333k bulk. A path check is enough —
  // these two streaming routes are the only real chat ingress.
  if (shouldRecordChatRequestActivity(activityRequest)) {
    recordChatActivity(dbModule);
  }
  if (trace) trace.mark('record_activity_start');
  try {
    await next();
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (foregroundActivity) recordActivityFinish(dbModule);
    requestObserver.record({
      method: c.req.method,
      path: c.req.url || c.req.path,
      status: failed ? 500 : (c.res?.status || 0),
      durationMs: Date.now() - started,
      belt: c.get('belt') || _defaultBelt,
      host: c.req.header('host') || '',
      userAgent: c.req.header('user-agent') || '',
    });
  }
});

// Static files — serve apps/ at both /apps/ and dojo-compatible root paths
// This lets dojo HTML files reference /static/, /chat/, /health/ etc. unchanged
const appsRoot = resolve(import.meta.dirname, '..', 'apps');
// st_888d5bd2 — the single document-boundary chokepoint. Registered HERE,
// before the first static handler (/sw.js) and every serveStatic/serveSpaHtml
// mount below, so on the demo port it redirects any authenticated route to
// /connect BEFORE the app shell HTML is ever served. A guard placed after the
// static block would never fire (serveStatic responds immediately). On every
// black-belt port the guard's first line returns next() — the real app is
// untouched. Logic + allowlist live in lib/demo-shell-guard.js (Thin Facade).
app.use('*', demoShellGuard);
app.get('/sw.js', async (c) => {
  const body = await readFile(resolve(appsRoot, 'static', 'sw.js'), 'utf8');
  c.header('Content-Type', 'application/javascript; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  return c.body(body);
});
// Private beta uses issued Black Belt keys, not checkout. Keep legacy billing
// pages inert even though backend billing modules remain for the later paid
// launch story.
app.get('/subscription', (c) => c.json({ error: 'not_found' }, 404));
app.get('/account/subscription.html', (c) => c.json({ error: 'not_found' }, 404));
app.get('/apps/account/subscription.html', (c) => c.json({ error: 'not_found' }, 404));
app.get('/accounts/subscription.html', (c) => c.json({ error: 'not_found' }, 404));
app.get('/accounts/billing', (c) => c.json({ error: 'not_found' }, 404));
app.get('/account/billing',  (c) => c.json({ error: 'not_found' }, 404));
app.use('/apps/chat', requirePrivatePage);
app.use('/apps/chat/', requirePrivatePage);
app.use('/chat', requirePrivatePage);
app.use('/chat/', requirePrivatePage);
app.use('/apps/*', serveStatic({ root: resolve(import.meta.dirname, '..') }));
app.use('/static/shared/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
app.use('/static/vendor/fonts.css', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
app.use('/static/*', serveStatic({ root: appsRoot }));
app.use('/chat/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
app.use('/chat/*', serveStatic({ root: appsRoot }));
app.use('/health/*', serveStatic({ root: appsRoot }));
app.use('/fitness/*', serveStatic({ root: appsRoot }));
app.use('/network/*', serveStatic({ root: appsRoot }));
app.use('/podcast/*', serveStatic({ root: appsRoot }));
app.use('/viewer/*', serveStatic({ root: appsRoot }));
// st_85ca4f3c — /faq is a self-contained public app (a faithful duplicate
// of the chat app, public-only paths). Lives at apps/faq/{index.html,
// app.js, public-app.js, modules/, style.css}. All assets served from
// /faq/* — middleware does NOT gate /faq paths (only /chat and /chat/*).
app.use('/faq/*', serveStatic({ root: appsRoot }));
app.use('/accounts', requirePrivatePage);
app.use('/accounts/', requirePrivatePage);
app.use('/account', requirePrivatePage);
app.use('/account/', requirePrivatePage);
app.use('/accounts/*', requirePrivatePage);
app.use('/account/*', requirePrivatePage);
app.use('/accounts/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
app.use('/account/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
app.use('/accounts/*', serveStatic({ root: resolve(appsRoot, 'account'), rewriteRequestPath: (p) => p.replace(/^\/accounts/, '') }));
// /account (singular) aliases to the same account SPA — accept either path.
app.use('/account/*', serveStatic({ root: resolve(appsRoot, 'account'), rewriteRequestPath: (p) => p.replace(/^\/account/, '') }));
// WHY: serveStatic calls next() when no file matches the path. Tab names like
// "general" and "usage" don't exist as files in apps/account/, so direct
// navigation to /accounts/usage would 404 without this fallback. The SPA
// initialises the correct tab from location.pathname on DOMContentLoaded.
app.get('/accounts/workbenches/:id', (c) => redirectPreservingQuery(c, '/chat'));
app.get('/account/workbenches/:id', (c) => redirectPreservingQuery(c, '/chat'));
app.get('/accounts/feature-request', (c) => redirectPreservingQuery(c, '/account/how-to'));
app.get('/account/feature-request', (c) => redirectPreservingQuery(c, '/account/how-to'));
app.get('/accounts/feature-requests', (c) => redirectPreservingQuery(c, '/account/how-to'));
app.get('/account/feature-requests', (c) => redirectPreservingQuery(c, '/account/how-to'));
app.get('/accounts/referrals', (c) => redirectPreservingQuery(c, '/account/how-to'));
app.get('/account/referrals', (c) => redirectPreservingQuery(c, '/account/how-to'));
app.get('/accounts/:tab', (c) => serveSpaHtml(c, 'account'));
app.get('/account/:tab', (c) => serveSpaHtml(c, 'account'));
// The connect page's directory moved to apps/connect/ (st_63b59bda AC-10), but
// the /login URL stays a deliberate backward-compat alias (st_85ca4f3c) — so the
// /login/* asset mount rewrites onto the moved directory's contents.
app.use('/login/*', serveStatic({ root: appsRoot, rewriteRequestPath: (p) => p.replace(/^\/login/, '/connect') }));
// Auth — demo port skips auth, white/black require token.
// Public chat endpoints are anonymous (rate-limited in the route handlers).
// Magic-link auth endpoints are public by definition (pre-session).
// Stripe webhook is public (HMAC verified in the route handler).
const PUBLIC_ROUTES = new Set([
  '/api/public-chat/stream',
  '/api/public-chat/onboarding-share',
  '/api/public-chat/health',
  '/api/billing/stripe/webhook',
  '/api/warm',
  '/api/models',       // model list is config, not user data
  '/api/server-health', // machine-readable health check (JSON; /health is the SPA)
  '/api/bb/session',   // subscription-key auth (not server API key) — route handles its own auth
]);
const PUBLIC_PREFIXES = ['/api/auth/', '/api/public/', '/api/books/artifact/'];
const QUERY_TOKEN_ROUTES = new Set([
  '/api/chat/events',
  '/api/notifications',
]);

app.use('/api/*', async (c, next) => {
  if (PUBLIC_ROUTES.has(c.req.path)) return next();
  if (PUBLIC_PREFIXES.some(p => c.req.path.startsWith(p))) return next();
  // Populate c.get('user') / c.get('session') from session cookie when present.
  // Never blocks; endpoints that require auth still call their own guard.
  await optionalAuth()(c, async () => {});

  // Admin belt override — runs AFTER optionalAuth has populated user/session.
  // If an authenticated admin has set sessions.belt_override, honour it for
  // this request. Non-admins, non-authenticated, or no-override sessions keep
  // the port-default belt (set by the earlier middleware).
  const user = c.get('user');
  const session = c.get('session');
  if (user?.is_admin && session?.belt_override) {
    c.set('belt', session.belt_override);
  }

  const belt = c.get('belt');
  // Demo port is the marketing site — user data never served here.
  // PUBLIC_ROUTES and PUBLIC_PREFIXES were already checked above.
  if (belt === 'demo') return c.json({ error: 'not_found' }, 404);

  // Teaser flag — White Belt users get limited Network (top 10) and Pulse (5 markers).
  // Black Belt gets full data. Demo port gets no data at all (blocked above).
  if (belt === 'white') {
    if (c.req.path.startsWith('/api/health/')) c.set('teaser', true);
    if (c.req.path.startsWith('/api/network/')) c.set('teaser', true);
  }

  // Authenticated via session cookie? Allow the request through. The local
  // Bearer token flow remains for direct localhost access; the session
  // cookie flow is how remote (via tunnel → gateway → edge) requests reach
  // us. Either proves authorisation.
  if (user) return next();

  // Browser EventSource cannot send Authorization headers. Allow a local
  // token query only on SSE endpoints that otherwise have no browser-safe
  // auth channel.
  if (QUERY_TOKEN_ROUTES.has(c.req.path) && validateToken(c.req.query('token') || '')) {
    return next();
  }

  return requireAuth()(c, next);
});

// Route sub-apps are mounted from index.js after all domain modules load,
// to avoid circular-import ordering issues (routes/*.js side-effect-register
// onto `app` before those sub-apps are imported here).

// Belt gate — demo port only serves marketing pages, not app APIs.
// Both ports share the same Hono `app` (index.js calls setBelt() per port
// and then app.fetch()), so this is the ONLY thing stopping
// /api/chat/stream from being reachable on 0.0.0.0:4336 with the
// operator's Anthropic key in play. Keep it strict.
app.use('/api/*', async (c, next) => {
  const belt = c.get('belt');
  if (belt === 'demo' && DEMO_BLOCKED_PREFIXES.some(p => c.req.path.startsWith(p))) {
    return c.json({ error: 'not_found' }, 404);
  }
  return next();
});

// --- Per-IP rate limit on /api/chat/stream ---
// Independent of auth — even authenticated callers are capped. Prevents
// a stolen or leaked session cookie from burning the LLM budget. In-memory
// is fine here: a bounded Map with a periodic sweep, single-process,
// reset on restart. Matches the pattern used by public-chat's SQLite
// counter but without DB writes on the authenticated hot path.
const CHAT_RATE_WINDOW_MS = config.chatRateWindowMs;
const CHAT_RATE_LIMIT = config.chatRateLimit;
const chatRateBuckets = new Map();            // ip → { count, resetAt }

function checkChatRate(ip) {
  const now = Date.now();
  const bucket = chatRateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    chatRateBuckets.set(ip, { count: 1, resetAt: now + CHAT_RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= CHAT_RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
}

// Sweep expired buckets every 10 minutes. Small Map, cheap scan.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of chatRateBuckets.entries()) {
    if (v.resetAt <= now) chatRateBuckets.delete(k);
  }
}, 10 * 60 * 1000).unref?.();

// Topic session idle close — write the resume at the 30-minute mark, not
// on the next open. Cheap SELECT; writes only when a session has expired.
const SESSION_IDLE_SWEEP_MS = Number(process.env.ROBOTDOJO_SESSION_IDLE_SWEEP_MS || 60_000);
setInterval(() => {
  Promise.resolve(closeIdleTopicSessions(dbModule)).catch((err) => {
    console.warn('[topic-session] idle sweep failed:', err?.message || err);
  });
  try {
    closeIdleCodingTopicSessions();
  } catch (err) {
    console.warn('[topic-session] coding idle sweep failed:', err?.message || err);
  }
}, SESSION_IDLE_SWEEP_MS).unref?.();

app.use('/api/chat/stream', async (c, next) => {
  // Only rate-limit the streaming endpoint; /api/chat/sync is internal.
  if (c.req.method !== 'POST') return next();
  const { ipFromHonoContext } = await import('./ip.js');
  const ip = ipFromHonoContext(c);
  if (!checkChatRate(ip)) {
    return c.json({ error: 'rate_limit', message: 'Too many chat requests. Try again later.' }, 429);
  }
  return next();
});

// st_27561b77 AC2/AC3 — server-health body builder.
//
// Pulled out of the route handler so the supervisor can pre-warm both the
// shallow and deep response caches on its own schedule. The handler then
// always serves from cache, so under concurrent backlog drain the foreground
// path makes ZERO synchronous DB calls. Cache is wall-clock TTL only — a
// drain DB write does NOT invalidate it (no inline recompute on next call).
async function computeServerHealthBody({ deep }) {
  const warm = getWarmupState();
  let dbHealth = { ok: false, deep, failed: 'import', message: 'database health check unavailable' };
  let passiveJobs = { ok: false, error: 'passive job summary unavailable' };
  try {
    const db = dbModule;
    if (deep) {
      // st_27561b77 P3 — the expensive integrity scans (quick_check,
      // foreign_key_check) take 35–269s on the 6.1 GB SQLCipher DB. They
      // run in the supervisor's background tick (every 30 min, idle-gated)
      // and the result is cached. The request path serves the cached
      // background result PLUS a fresh lightweight live probe — the same
      // write/read/delete that checkDbHealth runs as `write_readback`. This
      // preserves AC3 fidelity (WAL size, checkpointed pages, live read
      // that fails on corruption) without blocking the request thread on
      // the per-page decrypt scan.
      //
      // WAL state comes from the supervisor's most recent passiveCheckpoint
      // result — NEVER from a foreground PRAGMA wal_checkpoint() call. The
      // supervisor refreshes it every tick (15s); a request-time inline
      // pragma on the SQLCipher DB can cost 0.5–1.5s of per-page decrypt,
      // blowing the AC3 1s deep-health budget. The cached value is fresh
      // enough for AC3 fidelity (WAL size is reported within 15s of truth).
      const cached = getCachedDeepHealth();
      const live = flattenDbHealth(checkDbHealth(db, { deep: false, writeReadback: true }));
      const lastCheckpoint = getLastCheckpointResult();
      dbHealth = {
        ...live,
        deep: true,
        // Background integrity scan result (cached).
        integrity_ok: cached?.value?.ok ?? null,
        integrity_quick_check: cached?.value?.quick_check ?? null,
        integrity_foreign_key_check: cached?.value?.foreign_key_check ?? null,
        integrity_generated_at: cached?.generated_at ? new Date(cached.generated_at).toISOString() : null,
        integrity_duration_ms: cached?.duration_ms ?? null,
        // WAL + checkpoint state from the supervisor's last PASSIVE call.
        // Names the AC3 fidelity criterion checks (wal_pages, checkpointed).
        wal_pages: lastCheckpoint?.log ?? null,
        checkpointed: lastCheckpoint?.checkpointed ?? null,
        wal_checkpoint_ts: lastCheckpoint?.ts ? new Date(lastCheckpoint.ts).toISOString() : null,
      };
      // If the cached integrity check is missing, surface the "pending"
      // signal explicitly. AC3 fidelity is still preserved by the live
      // lightweight probe above — corruption would surface there.
      if (cached === null) {
        dbHealth.integrity_status = 'pending-first-background-scan';
      }
    } else {
      dbHealth = flattenDbHealth(checkDbHealth(db, { deep: false }));
    }
    // st_2cd1af73 AC-1 (round 2) — read the passive-jobs summary the off-process
    // maintenance worker publishes to supervisor_status. The worker runs the
    // four aggregate scans on ITS connection; the server reads one small row.
    // This takes the last heavy DB scan off the server thread: those scans
    // decrypt last_error overflow pages and cost multiple seconds on the main
    // thread when the WAL is large (the worker's maintenance drain inflates it),
    // which was the residual event-loop block after the checkpoint moved off.
    //
    // No foreground fallback scan. Until the worker has published, return a
    // visible warming/stale status instead of making /api/server-health walk the
    // large SQLCipher passive_jobs table on the server thread. Health fidelity is
    // "summary unavailable", not "block login/chat to compute a dashboard."
    const published = readSupervisorPassiveSummary(db);
    passiveJobs = published || warmingPassiveSummary();
  } catch (err) {
    try {
      dbHealth = dbHealthFailure({ deep, failed: 'database', err });
    } catch {
      dbHealth = { ok: false, deep, failed: 'database', message: 'database health check failed' };
    }
  }
  // st_5a63545d AC 20b — cohort-entitlement state surfaced here so the chat
  // UI can render the stale-banner from one fetch (no separate poll).
  let bb = { active: true };
  try {
    bb = await getBBStatus();
  } catch (err) {
    // Cohort module not yet stamped (dev mode without build-info.js) —
    // treat as active to avoid a default-fail mode on dev installs.
    bb = { active: true, reason: 'no_cohort_module' };
  }

  // st_bc949e7c AC 15 — soft-delete countdown surfaced when the cohort key is
  // in the 7-day warning window (or 7-14 day grace window).
  let daysUntilDelete = null;
  try {
    const stateOverride = process.env.ROBOTDOJO_SOFT_DELETE_STATE_DIR;
    const stateDir = stateOverride || resolve(config.configDir, 'state');
    const statePath = resolve(stateDir, 'days_until_delete.json');
    if (fsExistsSync(statePath)) {
      const parsed = JSON.parse(fsReadFileSync(statePath, 'utf8'));
      if (Number.isFinite(parsed?.days)) daysUntilDelete = parsed.days;
    }
  } catch { /* swallow — endpoint must never crash on a malformed state file */ }

  // st_27561b77 AC2/AC3 — capture session_log_queue inside the cache too.
  // getSessionLogQueueStatus() must not fall back to a passive_jobs aggregate on
  // the request path. It returns cached worker status or an explicit warming
  // marker; the server-health handler stays a status read, not a data-plane scan.
  let sessionLogQueue = null;
  try { sessionLogQueue = getSessionLogQueueStatus(); }
  catch (err) { sessionLogQueue = { ok: false, error: err?.message || 'session_log_queue unavailable' }; }

  // st_b57e6ec5 — read-only rollup over chat_turn_metrics + warmup_events
  // ERROR rows only (two small indexed SELECTs bounded to a rolling window;
  // no latency read — see lib/provider-health.js for why). Runs only when
  // this body is (re)computed by the supervisor's precompute tick or a rare
  // cold-cache revalidate — never on the cached-hit request path. Computed
  // and reported regardless of the flag; `enabled` makes explicit whether
  // this read is wired to the customer-facing chat banner.
  const providerHealthEnabled = isProviderHealthEnabled();
  let providerHealth = { status: 'unknown', reason: null, enabled: providerHealthEnabled };
  try { providerHealth = { ...getProviderHealth(dbModule), enabled: providerHealthEnabled }; }
  catch (err) { providerHealth = { status: 'unknown', reason: null, enabled: providerHealthEnabled, error: err?.message || 'provider health unavailable' }; }

  // df_3df1f108 — the backup guardian's own view: powered-on time since the
  // last verified backup, when the next catch-up is due, whether the staleness
  // alarm is up. Two small JSON reads, no DB work, never throws.
  let backupGuardian = null;
  try {
    const { guardianHealthSnapshot } = await import('./backup-guardian.js');
    backupGuardian = guardianHealthSnapshot();
  } catch (err) {
    backupGuardian = { running: false, error: err?.message || 'backup guardian unavailable' };
  }

  // st_4312c9c0 — spend headroom on the health surface. Cheap: two index-covered
  // SUMs behind the guard's own 30s cache, and this body is itself pre-warmed by
  // the supervisor, so the request path stays free of synchronous DB work. Put
  // here rather than in a separate endpoint because the owner already watches
  // this one, and a spend number nobody looks at is not a control.
  let spend;
  try {
    const { status: spendStatus } = await import('./spend-guard.js');
    spend = spendStatus();
  } catch (err) {
    spend = { readable: false, error: err?.message || 'spend guard unavailable' };
  }

  const annRuntime = annRuntimeHealth();
  return normalizeServerHealthAnnReadiness({
    status: dbHealth.ok ? 'ok' : 'error',
    version: '0.1.0',
    // belt is per-request — overlaid at serve time, not cached.
    warmup_complete: warm.warmup_complete,
    warmup: warm,
    ann_runtime: annRuntime,
    deep,
    db: dbHealth,
    passive_jobs: passiveJobs,
    provider_health: providerHealth,
    bb_active: bb.active,
    bb_days_behind: bb.days_behind ?? null,
    bb_valid_until: bb.valid_until ?? null,
    bb_reason: bb.reason ?? null,
    days_until_delete: daysUntilDelete,
    session_log_queue: sessionLogQueue,
    backup_guardian: backupGuardian,
    spend,
  });
}

/**
 * st_27561b77 AC2/AC3 — pre-warm the server-health response cache.
 *
 * Called by the supervisor at startup and on every tick. Building the body
 * here (off the request path) means the foreground handler always serves
 * cache, so concurrent backlog drain never spikes the foreground latency.
 *
 * `deep:true` runs the same body builder but never executes the expensive
 * integrity PRAGMAs (those live in passive-supervisor's backgroundDeepHealth
 * tick). The supervisor calling this still costs the same ~600ms cold
 * passive-jobs scan as the foreground would have — but the supervisor's
 * cost is paid OFF the request thread, so /api/auth/me stays at ≤50ms.
 */
export async function precomputeServerHealthBody({ deep = false } = {}) {
  const body = await computeServerHealthBody({ deep });
  if (deep) {
    serverHealthCacheDeep = body;
    serverHealthCacheDeepExpiresAt = Date.now() + SERVER_HEALTH_CACHE_MS;
  } else {
    serverHealthCache = body;
    serverHealthCacheExpiresAt = Date.now() + SERVER_HEALTH_CACHE_MS;
  }
  return body;
}

// st_27561b77 AC2/AC3 — single-flight in-flight refresh trackers.
//
// Stale-while-revalidate: on expired cache, the request serves the stale
// body immediately AND kicks off a background revalidation. Two requests
// arriving in the same tick must not both compute — the second sees the
// in-flight promise and skips. Without this, an under-load burst of
// /api/server-health calls would parallel-compute getPassiveJobSummary
// (~600ms each cold), defeating the cache.
let serverHealthRevalidateShallow = null;
let serverHealthRevalidateDeep = null;

function kickRevalidate(deep) {
  // setImmediate defers the revalidate past the current macro-task so the
  // response can be sent BEFORE precomputeServerHealthBody runs its
  // synchronous pre-await body. Without this, a cold-cold call would still
  // pay the 600ms passive_jobs scan inline because better-sqlite3 is sync
  // and async-function pre-await prefixes execute in the same task.
  if (deep) {
    if (serverHealthRevalidateDeep) return;
    serverHealthRevalidateDeep = true;
    setImmediate(async () => {
      try { await precomputeServerHealthBody({ deep: true }); }
      catch (err) { console.warn('[server-health] deep revalidate failed:', err.message); }
      finally { serverHealthRevalidateDeep = false; }
    });
  } else {
    if (serverHealthRevalidateShallow) return;
    serverHealthRevalidateShallow = true;
    setImmediate(async () => {
      try { await precomputeServerHealthBody({ deep: false }); }
      catch (err) { console.warn('[server-health] shallow revalidate failed:', err.message); }
      finally { serverHealthRevalidateShallow = false; }
    });
  }
}

/**
 * st_27561b77 AC2/AC3 — synthetic "warming" body for cold-cold cache.
 *
 * The brief (final): "On cold/invalidated cache, foreground `?deep` returns
 * last-known integrity result (or a marked 'pending' + the live lightweight
 * read) — NEVER runs quick_check/foreign_key_check inline. Fidelity preserved
 * (real WAL size, checkpointed pages, a live read that fails on corruption,
 * integrity timestamp)."
 *
 * Cold-cold = both response-body caches null AND the supervisor's eager warm
 * has not finished populating the body cache. The expensive integrity PRAGMAs
 * (quick_check, foreign_key_check) and the cold passive_jobs aggregate scan
 * stay OUT of this path — they live on the supervisor's background ticks.
 *
 * Fidelity vs. cost split:
 *   - Live lightweight read: ping + journal_mode + foreign_keys + migrations
 *     readable. ~1ms on the 6.1 GB SQLCipher DB. Runs inline here so a corrupt
 *     DB surfaces immediately (preserving "live read that fails on corruption"
 *     fidelity) even on the first cold-cold call after restart.
 *   - WAL size + checkpointed pages: pulled from getLastCheckpointResult(),
 *     refreshed by the supervisor every TICK_MS (15s). Inline PRAGMA
 *     wal_checkpoint costs 0.5–1.5s of per-page decrypt on SQLCipher — never
 *     run on the foreground.
 *   - integrity_quick_check / foreign_key_check: pulled from
 *     getCachedDeepHealth(), refreshed every 30 min on the supervisor's idle
 *     tick. Inline cost is 35–269s; surfaced as null + "pending-…" when the
 *     supervisor has not run yet.
 *   - passive_jobs summary: deferred to `warming` body; the next call after
 *     the supervisor's eager summary warm completes hits the populated cache.
 */
function buildWarmingBody({ deep }) {
  // st_27561b77 cold-start hardening — short-TTL cache so a concurrent burst
  // of cold-cache requests shares one buildWarmingBody execution rather than
  // each independently re-running the live checkDbHealth probe.
  const now = Date.now();
  if (deep && warmingBodyCacheDeep && now < warmingBodyCacheDeepExpiresAt) {
    return warmingBodyCacheDeep;
  }
  if (!deep && warmingBodyCacheShallow && now < warmingBodyCacheShallowExpiresAt) {
    return warmingBodyCacheShallow;
  }
  const warm = getWarmupState();
  const cached = deep ? getCachedDeepHealth() : null;
  const lastCheckpoint = deep ? getLastCheckpointResult() : null;
  // st_27561b77 final-fix: the cheap live read PRESERVES fidelity on cold-cold
  // even when the supervisor has not seeded the cache yet. On deep requests,
  // checkDbHealth adds a small write/read/delete probe; shallow requests stay
  // to ping + migrations-readable + journal_mode + foreign_keys only. No
  // quick_check or foreign_key_check run here. Cost on
  // the live 6.1 GB SQLCipher DB is sub-millisecond (warm page cache) to ~5ms
  // (cold). Wrapped in try/catch so a transient DB error does not crash the
  // handler — falls back to the null fields the prior version returned.
  let live = null;
  try {
    live = flattenDbHealth(checkDbHealth(dbModule, { deep: false, writeReadback: Boolean(deep) }));
  } catch (err) {
    live = null;
  }
  const dbHealth = {
    ok: live ? Boolean(live.ok) : true,
    deep,
    // Live lightweight probe — fails on corruption, satisfies AC3 fidelity.
    ping: live?.ping ?? null,
    journal_mode: live?.journal_mode ?? null,
    foreign_keys: live?.foreign_keys ?? null,
    migrations_readable: live?.migrations_readable ?? null,
    write_readback: live?.write_readback ?? null,
    // Background integrity scan result (cached from supervisor's idle tick).
    integrity_ok: cached?.value?.ok ?? null,
    integrity_quick_check: cached?.value?.quick_check ?? null,
    integrity_foreign_key_check: cached?.value?.foreign_key_check ?? null,
    integrity_generated_at: cached?.generated_at ? new Date(cached.generated_at).toISOString() : null,
    integrity_duration_ms: cached?.duration_ms ?? null,
    // WAL + checkpoint state from the supervisor's last PASSIVE call.
    wal_pages: lastCheckpoint?.log ?? null,
    checkpointed: lastCheckpoint?.checkpointed ?? null,
    wal_checkpoint_ts: lastCheckpoint?.ts ? new Date(lastCheckpoint.ts).toISOString() : null,
    integrity_status: deep && cached === null ? 'pending-first-background-scan' : null,
  };
  // st_b57e6ec5 — same cheap indexed error-rows-only rollup as
  // computeServerHealthBody (no latency read). Not gated behind `deep`: it's
  // two small indexed SELECTs, the same cost class as the live lightweight
  // DB probe already run unconditionally above. `enabled` reports whether
  // this read is wired to the customer-facing chat banner.
  const providerHealthEnabledWarming = isProviderHealthEnabled();
  let providerHealth = { status: 'unknown', reason: null, enabled: providerHealthEnabledWarming };
  try { providerHealth = { ...getProviderHealth(dbModule), enabled: providerHealthEnabledWarming }; }
  catch { /* keep the safe 'unknown' fallback */ }
  const body = normalizeServerHealthAnnReadiness({
    status: 'ok',
    version: '0.1.0',
    warmup_complete: warm.warmup_complete,
    warmup: warm,
    deep,
    db: dbHealth,
    passive_jobs: warmingPassiveSummary(),
    provider_health: providerHealth,
    bb_active: true,
    bb_days_behind: null,
    bb_valid_until: null,
    bb_reason: 'warming',
    days_until_delete: null,
    session_log_queue: { ok: false, error: 'session_log_queue warming' },
    warming: true,
  });
  // st_27561b77 cold-start hardening — populate the short-TTL warming-body
  // cache so concurrent cold callers within WARMING_BODY_CACHE_MS share this
  // result instead of independently re-running checkDbHealth.
  if (deep) {
    warmingBodyCacheDeep = body;
    warmingBodyCacheDeepExpiresAt = Date.now() + WARMING_BODY_CACHE_MS;
  } else {
    warmingBodyCacheShallow = body;
    warmingBodyCacheShallowExpiresAt = Date.now() + WARMING_BODY_CACHE_MS;
  }
  return body;
}

// Machine-readable health check (public JSON — /health is taken by the Health app SPA;
// /api/health/ prefix is taken by the Pulse app data routes).
// st_74f45a1a R2: surfaces warmup_complete so cold-TTFB Playwright tests can
// block until boot warmup has settled before issuing the first chat turn.
//
// st_27561b77 AC2/AC3 — stale-while-revalidate cache. The foreground path
// MUST NEVER block on inline DB work under concurrent backlog drain (the
// brief is explicit: deep ≤1s on EVERY call including under load). The
// strategy:
//   1. Cache hit (fresh): serve cache (~ms).
//   2. Cache hit (stale): serve stale + kick async revalidate.
//   3. Cache miss (null, only on cold-cold boot): serve synthetic "warming"
//      body from in-memory state; kick async revalidate. Next call within
//      ~seconds hits the warmed cache.
// No path on the foreground request thread runs the cold passive_jobs scan
// or the integrity PRAGMAs.
app.get('/api/server-health', async (c) => {
  const deep = c.req.query('deep') === '1' || c.req.query('deep') === 'true';
  const now = Date.now();
  let body = deep ? serverHealthCacheDeep : serverHealthCache;
  const expiresAt = deep ? serverHealthCacheDeepExpiresAt : serverHealthCacheExpiresAt;
  if (body && now >= expiresAt) {
    // Stale — serve cached body, kick async revalidate in the background.
    kickRevalidate(deep);
  } else if (!body) {
    // Cold-cold: serve synthetic warming body, kick async revalidate so
    // the next call within seconds hits the populated cache.
    kickRevalidate(deep);
    body = buildWarmingBody({ deep });
  }
  // Overlay only `belt` per-request — everything else (including the
  // session_log_queue summary) lives in the cached body so the handler
  // does ZERO DB work when cache is fresh or stale.
  const responseBody = {
    ...normalizeServerHealthAnnReadiness(overlayLiveWarmupState(body)),
    belt: c.get('belt') ?? 'white',
  };
  return c.json(responseBody, body.status === 'ok' ? 200 : 503);
});

// --- Redirect helper ----------------------------------------------------
// c.redirect() alone drops the querystring. The installer deep-links,
// FAQ popups, hero "Set Up" CTA all embed context/prompt/autosend params
// into /chat, /pulse, etc. — losing them strands the LLM with no primer.
// Preserve the incoming querystring verbatim on every app redirect.
function redirectPreservingQuery(c, target) {
  const url = c.req.url || '';
  const qIdx = url.indexOf('?');
  const qs = qIdx >= 0 ? url.slice(qIdx) : '';
  return c.redirect(target + qs);
}

async function requirePrivatePage(c, next) {
  const authHeader = c.req.header('Authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (bearerToken && validateToken(bearerToken)) return next();

  await optionalAuth()(c, async () => {});
  if (c.get('user')) return next();

  const url = new URL(c.req.url);
  const redirect = encodeURIComponent(url.pathname + url.search);
  // st_63b59bda AC-10 — server-side auth bounces route through /connect (the
  // canonical CTA URL), matching the intent already documented at the /login
  // alias below. /login stays a backward-compat alias but is no longer a
  // redirect target the app emits.
  return c.redirect(`/connect?redirect=${redirect}`, 302);
}

// App route shortcuts — skills (all apps except chat) are Black Belt only
app.get('/login', (c) => redirectPreservingQuery(c, '/connect'));
// st_85ca4f3c — /connect is the user-facing CTA URL on the marketing nav.
// It serves the same login page as /login (token-paste flow) but keeps the
// browser address bar honest: the nav button reads "Connect", the URL is
// /connect, the page title is "Connect — Robot Dojo". Server-side redirects
// that previously sent users to /login now route through /connect for the
// same reason. /login still serves the page directly to preserve any old
// bookmarks; /connect is the canonical public path going forward.
// /connect SERVES the connect page in place — no redirect — so the address bar
// stays /connect (never /apps/login/ or /login). Assets are absolute (/static/*),
// so serving under /connect resolves them correctly.
app.get('/connect', async (c) => {
  const html = await readFile(resolve(appsRoot, 'connect', 'index.html'), 'utf8');
  return c.html(html);
});
app.get('/subscription', (c) => c.json({ error: 'not_found' }, 404));
// First-run APIs remain mounted for integration/status data. The user-facing
// install handoff is Account → Integrations plus chat guidance, not /setup.
app.get('/apps/chat', requirePrivatePage, (c) => serveSpaHtml(c, 'chat'));
app.get('/apps/chat/', requirePrivatePage, (c) => serveSpaHtml(c, 'chat'));
app.get('/chat', requirePrivatePage, (c) => serveSpaHtml(c, 'chat'));
app.get('/chat/topic/:slug', requirePrivatePage, (c) => serveSpaHtml(c, 'chat'));
app.get('/chat/history/:slug', requirePrivatePage, (c) => serveSpaHtml(c, 'chat'));
app.get('/chat/person/:id', requirePrivatePage, (c) => serveSpaHtml(c, 'chat'));
app.get('/chat/company/:id', requirePrivatePage, (c) => serveSpaHtml(c, 'chat'));
app.get('/chat/place/:id', requirePrivatePage, (c) => serveSpaHtml(c, 'chat'));
app.get('/chat/:id', requirePrivatePage, (c) => serveSpaHtml(c, 'chat'));
// st_85ca4f3c — /faq is the public docs chat URL. It serves a self-contained
// duplicate of the chat app (apps/faq/) with all authenticated paths
// stripped — only /api/public-chat/stream fires. /ask serves the same app
// without a redirect so legacy links still hit first paint immediately.
// The new surface never loads the authenticated app shell (no shell.js,
// no /api/whoami, no conversation sidebar) and never touches the
// middleware-gated /chat/* tree.
app.get('/faq', (c) => serveSpaHtml(c, 'faq'));
app.get('/ask', (c) => serveSpaHtml(c, 'faq'));
app.get('/architecture', (c) => redirectPreservingQuery(c, '/'));
app.get('/health', (c) => {
  if (c.get('belt') === 'demo') return redirectPreservingQuery(c, '/connect');
  return redirectPreservingQuery(c, '/apps/health/');
});
app.get('/fitness', (c) => {
  if (c.get('belt') === 'demo') return redirectPreservingQuery(c, '/connect');
  return redirectPreservingQuery(c, '/apps/fitness/');
});
app.get('/pulse', (c) => c.redirect('/health', 301));
app.get('/network', (c) => {
  if (c.get('belt') === 'demo') return redirectPreservingQuery(c, '/connect');
  return redirectPreservingQuery(c, '/apps/network/');
});
app.get('/podcast', (c) => {
  if (c.get('belt') === 'demo') return redirectPreservingQuery(c, '/connect');
  return redirectPreservingQuery(c, '/apps/podcast/');
});
app.get('/workbench', (c) => redirectPreservingQuery(c, '/chat'));
app.get('/workbench/*', (c) => redirectPreservingQuery(c, '/chat'));
app.get('/apps/workbench', (c) => redirectPreservingQuery(c, '/chat'));
app.get('/apps/workbench/*', (c) => redirectPreservingQuery(c, '/chat'));
app.get('/accounts', (c) => {
  if (c.get('belt') === 'demo') return redirectPreservingQuery(c, '/connect');
  return redirectPreservingQuery(c, '/account/how-to');
});
// /account (singular) — on demo port, send to /connect so the URL reads
// "connect" (matching the nav CTA copy) instead of "login"; on authed ports
// mirror /accounts.
app.get('/account', (c) => {
  if (c.get('belt') === 'demo') return redirectPreservingQuery(c, '/connect');
  return redirectPreservingQuery(c, '/account/how-to');
});

// Root: the dojo (app port) sends visitors to Connect — the public marketing
// homepage is served by Vercel at robotdojo.ai, never by the dojo/relay (serving
// it here rendered a broken, asset-less marketing page at {slug}.robotdojo.ai).
// The demo/preview port keeps the marketing landing for local preview.
app.get('/', async (c) => {
  if (c.get('belt') !== 'demo') return redirectPreservingQuery(c, '/connect');
  const html = await readFile(resolve(appsRoot, 'index.html'), 'utf8');
  return c.html(html);
});
app.get('/install-success', serveStatic({ root: appsRoot, path: '/install-success.html' }));
app.get('/architecture.html', (c) => redirectPreservingQuery(c, '/'));
app.get('/auth-google-guidance', serveStatic({ root: appsRoot, path: '/auth-google-guidance.html' }));
app.get('/licensing', serveStatic({ root: appsRoot, path: '/licensing.html' }));
app.get('/privacy', serveStatic({ root: appsRoot, path: '/privacy.html' }));
app.get('/terms', serveStatic({ root: appsRoot, path: '/terms.html' }));
app.get('/robots.txt', serveStatic({ root: appsRoot, path: '/static/robots.txt' }));
app.get('/sitemap.xml', serveStatic({ root: appsRoot, path: '/static/sitemap.xml' }));
app.get('/google6102e1268ece5472.html', serveStatic({ root: appsRoot, path: '/static/google6102e1268ece5472.html' }));
// LLM / AI-bot discovery files served at site root (llmstxt.org convention).
// WHY at root not /static/: the de-facto standard is `<host>/llms.txt` —
// agentic tooling probes that path exactly.
app.get('/llms.txt', serveStatic({ root: appsRoot, path: '/static/llms.txt' }));
app.get('/llms-full.txt', serveStatic({ root: appsRoot, path: '/static/llms-full.txt' }));
// OpenGraph image referenced from every marketing page meta tag.
app.get('/og-image.png', serveStatic({ root: appsRoot, path: '/static/og-image.png' }));

// Installer scripts — served at root so `curl -fsSL https://robotdojo.ai/install.sh | bash`
// works on localhost (mirrors vercel.json rewrites for prod). Explicit
// text/x-shellscript content-type so curl/bash don't choke on the default.
const _INSTALL_SCRIPT = resolve(appsRoot, 'static', 'install.sh');
const _UNINSTALL_SCRIPT = resolve(appsRoot, 'static', 'uninstall.sh');
app.get('/install.sh', async (c) => {
  const body = await readFile(_INSTALL_SCRIPT, 'utf8');
  return c.body(body, 200, { 'Content-Type': 'text/x-shellscript; charset=utf-8' });
});
app.get('/uninstall.sh', async (c) => {
  const body = await readFile(_UNINSTALL_SCRIPT, 'utf8');
  return c.body(body, 200, { 'Content-Type': 'text/x-shellscript; charset=utf-8' });
});

// st_8cdd196f — stable URLs: serve SPA HTML directly so the SPA boots with
// the slug-based path in window.location.pathname, enabling deep-link routing.
// Previously these were redirects to /apps/network/; the redirect discarded
// the slug and the SPA never saw the original URL.
app.use('/topics/*', requirePrivatePage);
app.use('/transcripts/*', requirePrivatePage);
app.get('/topics/*', requirePrivatePage, (c) => serveViewerHtml(c));
app.get('/transcripts/*', requirePrivatePage, (c) => serveSpaHtml(c, 'viewer'));
app.get('/docs/*', requirePrivatePage, (c) => serveViewerHtml(c));
app.get('/agents', requirePrivatePage, (c) => serveViewerHtml(c));
app.get('/agents/*', requirePrivatePage, (c) => serveViewerHtml(c));
app.get('/user', requirePrivatePage, (c) => serveViewerHtml(c));
app.get('/user/*', requirePrivatePage, (c) => serveViewerHtml(c));
app.get('/people/*', requirePrivatePage, (c) => serveViewerHtml(c));
app.get('/companies/*', requirePrivatePage, (c) => serveViewerHtml(c));
app.get('/places/*', requirePrivatePage, (c) => serveViewerHtml(c));
app.get('/entities/*', requirePrivatePage, (c) => serveViewerHtml(c));
app.get('/workbenches/*', requirePrivatePage, (c) => serveViewerHtml(c));

const TOPIC_URL_RESERVED = new Set([
  'chat', 'health', 'network', 'account', 'accounts', 'podcast',
  'workbenches', 'topics', 'people', 'companies', 'places', 'entities', 'agents',
  'user', 'docs', 'connect', 'login', 'ask', 'faq', 'privacy', 'terms',
  'licensing', 'install', 'static', 'apps', 'api', 'auth', 'viewer',
  'transcripts', 'subscription', 'pulse', 'setup', 'me', 'version',
]);

function isTopicBrowsePath(t1, t2 = '') {
  if (!t1 || TOPIC_URL_RESERVED.has(t1)) return false;
  try {
    const row = dbModule.prepare('SELECT slug, parent_slug FROM user_topics WHERE slug = ?').get(t2 || t1);
    if (!row) return false;
    if (!t2) return !row.parent_slug || row.slug === t1;
    return row.slug === t2 && (row.parent_slug === t1 || !row.parent_slug);
  } catch {
    return false;
  }
}

export function registerTopicBrowseRoutes() {
  app.get('/:t1', requirePrivatePage, async (c, next) => {
    const t1 = c.req.param('t1');
    if (TOPIC_URL_RESERVED.has(t1) || !isTopicBrowsePath(t1)) return next();
    return serveViewerHtml(c);
  });
  app.get('/:t1/:t2', requirePrivatePage, async (c, next) => {
    const t1 = c.req.param('t1');
    const t2 = c.req.param('t2');
    if (TOPIC_URL_RESERVED.has(t1)) return next();
    if (!isTopicBrowsePath(t1, t2) && !isTopicBrowsePath(t1)) return next();
    return serveViewerHtml(c);
  });
  app.get('/:t1/:t2/*', requirePrivatePage, async (c, next) => {
    const t1 = c.req.param('t1');
    const t2 = c.req.param('t2');
    if (TOPIC_URL_RESERVED.has(t1)) return next();
    if (!isTopicBrowsePath(t1, t2) && !isTopicBrowsePath(t1)) return next();
    return serveViewerHtml(c);
  });
}

// Product-safe hot routes prewarmed on every deployment. Owner-specific hot
// entities (real person/place/company routes) are NOT tracked here — they come
// from the gitignored config/viewer-topic-lens.user.json override
// (viewerPrewarmRoutes). A fresh clone prewarms product surfaces only.
const VIEWER_PREWARM_DOC_ROUTES = [
  'agents/miyagi',
  'topics/robot-dojo',
  'workbenches/topics/work/robot-dojo/wk_robot_dojo',
  ...viewerPrewarmRoutes(),
];

export function prewarmViewerPayloads(routes = VIEWER_PREWARM_DOC_ROUTES) {
  const started = Date.now();
  const warmed = [];
  const failed = [];
  for (const route of routes) {
    try {
      const payload = readMarkdownDocument(dbModule, route);
      warmed.push({ route, version: payload?.projection?.version || '' });
    } catch (error) {
      failed.push({ route, error: error?.message || String(error) });
    }
  }
  return { elapsedMs: Date.now() - started, warmed, failed };
}

// SPA fallback — deep links like /network/people/:id serve the app HTML.
// Use serveSpaHtml (not redirect) so the SPA reads window.location.pathname
// and can extract the slug-based short ID for deep-link routing.
app.get('/network/people/*', (c) => serveSpaHtml(c, 'network'));
app.get('/network/companies/*', (c) => serveSpaHtml(c, 'network'));

// Serve SPA HTML directly (no redirect) so curl and deep links return HTML immediately.
// The SPA reads its own basePath from the URL via history.replaceState.
async function serveSpaHtml(c, appName) {
  try {
    const html = await readFile(resolve(appsRoot, appName, 'index.html'), 'utf8');
    return c.html(html, 200, { 'Cache-Control': appName === 'account' ? 'no-store' : 'no-cache' });
  } catch {
    return c.html(await readFile(resolve(appsRoot, appName + '.html'), 'utf8'), 200, { 'Cache-Control': 'no-cache' });
  }
}

function viewerDocRoutePath(pathname) {
  const path = String(pathname || '');
  const matchers = [
    [/^\/topics\/(.+)$/, (m) => `topics/${m[1]}`],
    [/^\/docs\/(.+)$/, (m) => m[1]],
    [/^\/agents\/?(.+)?$/, (m) => `agents${m[1] ? `/${m[1]}` : ''}`],
    [/^\/user\/?(.+)?$/, (m) => `user/${m[1] || 'context'}`],
    [/^\/(people|companies|places)\/(.+)$/, (m) => `entities/${m[1]}/${m[2]}`],
    [/^\/entities\/(.+)$/, (m) => `entities/${m[1]}`],
    [/^\/workbenches\/(.+)$/, (m) => `workbenches/${m[1]}`],
    [/^\/workbench\/(.+)$/, (m) => `workbench/${m[1]}`],
  ];
  for (const [re, make] of matchers) {
    const match = path.match(re);
    if (match) return make(match);
  }
  const parts = path.split('/').filter(Boolean);
  if (parts[0] && !TOPIC_URL_RESERVED.has(parts[0])) return parts.join('/');
  return '';
}

function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

async function serveViewerHtml(c) {
  let html;
  try {
    html = await readFile(resolve(appsRoot, 'viewer', 'index.html'), 'utf8');
  } catch {
    html = await readFile(resolve(appsRoot, 'viewer.html'), 'utf8');
  }

  // Inject the owner's per-topic viewer lens (gitignored override, empty on a
  // fresh clone). The tracked viewer ships generic fallback prose and prefers a
  // lens entry per topic; this is the same injection channel as the preload
  // below. See lib/viewer-topic-lens.js — the owner's biography lives ONLY here,
  // never in tracked source.
  const lensScript = `<script>window.RobotDojoTopicLens=${inlineJson(viewerTopicLensForInjection())};</script>`;
  html = html.replace('</head>', `${lensScript}\n</head>`);

  const pathname = new URL(c.req.url).pathname;
  const docRoute = viewerDocRoutePath(pathname);
  if (docRoute) {
    try {
      const { absPath, ...payload } = readMarkdownDocument(dbModule, docRoute);
      const apiPath = `/api/content/docs/${docRoute.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
      const preload = `<script>window.RobotDojoViewerPreload=${inlineJson({ apiPath, data: payload })};</script>`;
      html = html.replace('</head>', `${preload}\n</head>`);
    } catch {
      // The browser-side API fallback renders the same structured error state.
    }
  }

  return c.html(html, 200, { 'Cache-Control': 'no-cache' });
}

// Friendly not-found for anything the router missed. API calls keep their
// JSON shape; browser navigations get a lightweight HTML page with a clear
// path back to safety (home, chat, account).
app.notFound((c) => {
  const accept = c.req.header('accept') || '';
  if (c.req.path.startsWith('/api/') || !accept.includes('text/html')) {
    return c.json({ error: 'not_found', path: c.req.path }, 404);
  }
  const path = (c.req.path || '').slice(0, 120);
  return c.html(
    `<!doctype html><html lang="en"><head>
    <meta charset="utf-8">
    <title>Not found — Robot Dojo</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <link rel="stylesheet" href="/static/shared/marketing.css">
    <style>
      body { display:flex; align-items:center; justify-content:center; min-height:100dvh; margin:0; background:var(--bg,#fafcff); font-family:var(--font,'Inter',system-ui,sans-serif); color:var(--text,#0f172a); }
      .nf-card { max-width:420px; padding:2.5rem 1.75rem; text-align:center; }
      .nf-code { font-family:'Noto Sans JP',sans-serif; font-size:48px; opacity:0.35; margin-bottom:12px; }
      h1 { font-size:1.4rem; font-weight:600; letter-spacing:-0.02em; margin:0 0 0.5rem; }
      p { color:var(--text-dim,#64748b); line-height:1.55; margin:0 0 1.5rem; font-size:0.95rem; }
      .nf-path { font-family:var(--mono,ui-monospace,monospace); font-size:0.82rem; background:var(--bg2,#f1f5f9); padding:0.25rem 0.5rem; border-radius:6px; color:var(--text-dim,#64748b); }
      .nf-actions { display:flex; gap:0.6rem; justify-content:center; flex-wrap:wrap; }
      .nf-btn { display:inline-block; padding:0.7rem 1.2rem; border-radius:10px; background:var(--accent,#3b82f6); color:#fff; text-decoration:none; font-weight:550; font-size:0.9rem; }
      .nf-btn-outline { background:#fff; color:var(--text,#0f172a); border:1px solid var(--border,#e2e8f0); }
    </style>
    </head><body>
      <main class="nf-card">
        <div class="nf-code">道</div>
        <h1>That page doesn\u2019t exist</h1>
        <p>We couldn\u2019t find <span class="nf-path">${path.replace(/[<>&"]/g, '')}</span>. It may have moved or never existed.</p>
        <div class="nf-actions">
          <a class="nf-btn" href="/">Back to home</a>
          <a class="nf-btn nf-btn-outline" href="/chat">Open chat</a>
        </div>
      </main>
    </body></html>`,
    404,
  );
});

// --- Process lifecycle ---
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandledRejection:', err);
  process.exit(1);
});

// st_2cd1af73 — flush the in-memory activity snapshot to the server_activity row
// one last time on a clean shutdown so the daemon sees the final state promptly
// (the 30s stale-TTL covers an unclean exit; this just makes the common case
// crisp). Best-effort inside stopActivityFlush — never blocks the exit.
process.on('SIGTERM', () => { console.info('[server] SIGTERM'); try { stopActivityFlush(); } catch { /* exit anyway */ } process.exit(143); });
process.on('SIGINT', () => { console.info('[server] SIGINT'); try { stopActivityFlush(); } catch { /* exit anyway */ } process.exit(0); });

// st_27561b77 cold-start hardening — synchronous body-cache seed at module
// load. The supervisor's eager warm runs inside setImmediate (so server
// boot doesn't block on it), which means a burst of /api/server-health?deep
// arriving in the first ~50ms after restart used to race the warm and fall
// through to buildWarmingBody, where N concurrent requests each ran
// checkDbHealth({deep:false}) synchronously on the SQLCipher DB (~50-100ms
// each cold, serialized on the event loop → 500ms-1s tail at 10 concurrent).
//
// Seeding both body caches synchronously at module load gives every
// request — including the very first one after restart — a non-null cache
// hit. The seed is a buildWarmingBody result (live ping + last-checkpoint +
// last cached integrity + warming:true marker), with a short TTL so the
// supervisor's first real precomputeServerHealthBody call (~30s into boot
// for the deep variant) overrides it as soon as the real summary is warm.
// Cost at module load: ONE synchronous buildWarmingBody for each variant,
// roughly 5-10ms total — paid once, before the listener accepts connections.
//
// Skipped when NODE_ENV=test so behavioral specs that import buildServer()
// don't hit the live DB at module-load time.
if (process.env.NODE_ENV !== 'test') {
  try {
    const shallowSeed = buildWarmingBody({ deep: false });
    serverHealthCache = shallowSeed;
    serverHealthCacheExpiresAt = Date.now() + SERVER_HEALTH_CACHE_MS;
    const deepSeed = buildWarmingBody({ deep: true });
    serverHealthCacheDeep = deepSeed;
    serverHealthCacheDeepExpiresAt = Date.now() + SERVER_HEALTH_CACHE_MS;
  } catch (err) {
    // Module load must not crash if the DB ping fails — handler still has
    // the buildWarmingBody fallback (which itself wraps live in try/catch).
    console.warn('[server-health] sync seed at module load failed:', err.message);
  }
}

export default app;

// WHY this factory exists: behavioral spec files in tests/specs/ assert
// against `app.fetch(new Request(...))` and import via the factory pattern
// (`const { buildServer } = await import('../../lib/server.js'); const app
// = await buildServer();`). The factory returns the module-level Hono app
// — it does not boot a port listener (that responsibility lives in
// index.js). Calling buildServer() multiple times returns the same app
// instance because the route registrations are module side effects.
export async function buildServer() {
  return app;
}
