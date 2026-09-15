/**
 * Robot Dojo — entry point.
 *   :4336 — Marketing site (HTTP, public, no auth)
 *   :4338 — App (HTTPS when SNI passthrough cert exists, HTTP otherwise)
 *           Bound to 127.0.0.1 only.
 *   :4339 — Internal HTTP proxy port for tunnel-agent (only started in HTTPS mode).
 *           Loopback only; avoids TLS cert validation on localhost fetches.
 *
 * TLS strategy: if the active Robot Dojo config dir has tls/device.crt + device.key (provisioned
 * by install.sh via lib/gateway-tls.js), the app port starts as HTTPS so TLS
 * terminates ON the Mac and the relay is a blind TCP forwarder. Without a cert,
 * the server starts HTTP as before (local-only, no privacy risk).
 */

// st_f6315f0b: the server is the interactive surface — gating it on idle
// would make the app unreachable until the user stopped using it (a
// contradiction in terms). OS_PROTECTED in scripts/ram-watchdog.sh also
// includes com.robotdojo.server so the watchdog never boots it out.
export const IDLE_GATED = false;

import dns from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';
// Node 17+ defaults to IPv6-first. On this Mac the LaunchAgent's IPv6 route
// to Cloudflare-fronted provider APIs blackholes, so undici dies at its 10s
// connect timeout ("fetch failed") and chat never gets a token.
dns.setDefaultResultOrder('ipv4first');
setGlobalDispatcher(new Agent({
  connect: { timeout: 15_000, family: 4 },
}));

import { serve, createAdaptorServer } from '@hono/node-server';
import https from 'node:https';
import { createSecureContext } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import app, { setBelt, prewarmViewerPayloads, registerTopicBrowseRoutes } from './lib/server.js';
import config, { overrideSecret, secret } from './lib/config.js';
import { startEventLoopMonitor } from './lib/observability/event-loop-monitor.js';

// st_27561b77 P1 — event-loop instrumentation. Opt-in via
// ROBOTDOJO_EVENT_LOOP_TRACE=1. No-op otherwise; <1ms steady-state overhead
// when enabled (sampled histogram + 50ms watchdog timer). Must run BEFORE
// any product code so the watchdog sees the first synchronous block.
if (startEventLoopMonitor()) {
  console.info('[event-loop-monitor] enabled — JSONL log under ~/.robotdojo/logs/event-loop/');
}

// st_27561b77 P3 — operations log-name symlink.
// The server plist routes stdout to robotdojo-server.out.log (legacy);
// monitoring + criteria globs against server*.log . Create a symlink on
// boot so external tooling that uses the canonical name finds the file.
// Idempotent and non-fatal — log monitoring is not critical-path.
try {
  const { symlinkSync, unlinkSync, existsSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const logDir = join(process.env.HOME || '/tmp', '.robotdojo', 'logs');
  try { mkdirSync(logDir, { recursive: true }); } catch { /* exists */ }
  const linkPath = join(logDir, 'server.log');
  if (existsSync(linkPath)) {
    try { unlinkSync(linkPath); } catch { /* exists/perm */ }
  }
  try { symlinkSync(join(logDir, 'robotdojo-server.out.log'), linkPath); } catch { /* exists/perm */ }
} catch { /* non-fatal */ }
import { getCertPaths, getLocalhostCertPaths } from './lib/gateway-tls.js';
import { ensureKeychainSecret, readKeychainSecret, writeKeychainSecret } from './lib/keychain.js';
import { mintAuthToken } from './lib/auth.js';

function writeHttpPort(port) {
  try {
    const dir = config.configDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, '.http-port'), String(port), 'utf8');
  } catch { /* non-fatal */ }
}

// ─── Startup secret validation ─────────────────────────────────────────────
// Warn loudly but do not crash — lets the server boot so local recovery works.
function ensureLocalKeychainSecret(name, makeValue) {
  if (process.platform !== 'darwin') return null;
  const envKey = name.replace(/-/g, '_').toUpperCase();
  const current = process.env[envKey] || secret(name);
  if (process.env.NODE_ENV === 'test' && current) {
    overrideSecret(name, current);
    return current;
  }

  const read = readKeychainSecret(name);
  if (read) return read;

  if (current) {
    const migrated = writeKeychainSecret(name, current);
    if (migrated) console.info(`[startup] ${name}: migrated runtime secret into Keychain`);
    else console.error(`[startup] ERROR: ${name} present at runtime but Keychain migration failed`);
    overrideSecret(name, current);
    return current;
  }

  const { value, created } = ensureKeychainSecret(name, makeValue);
  if (!value) {
    console.error(`[startup] ERROR: ${name} missing and Keychain self-heal failed`);
    return null;
  }

  overrideSecret(name, value);
  if (created) console.info(`[startup] ${name}: generated and stored in Keychain`);
  return value;
}

ensureLocalKeychainSecret('SESSION_SECRET', () => randomBytes(32).toString('base64url'));
ensureLocalKeychainSecret('ROBOTDOJO_AUTH_TOKEN', () => mintAuthToken());

const REQUIRED_SECRETS = [
  { key: 'anthropicKey',  label: 'ANTHROPIC_API_KEY',  fatal: true,  reason: 'chat is unavailable' },
  { key: 'sessionSecret', label: 'SESSION_SECRET',     fatal: true,  reason: 'auth is broken — all logins will fail' },
  { key: 'authToken',     label: 'ROBOTDOJO_AUTH_TOKEN', fatal: true, reason: 'token-paste login is unavailable' },
  // RESEND_API_KEY removed in st_5a63545d (token-paste login replaces magic codes).
];
for (const { key, label, fatal, reason } of REQUIRED_SECRETS) {
  try {
    const val = config[key];
    if (!val) {
      const level = fatal ? 'ERROR' : 'WARN';
      console[fatal ? 'error' : 'warn'](`[startup] ${level}: ${label} missing — ${reason}`);
    }
  } catch {
    console.warn(`[startup] WARN: could not read ${label}`);
  }
}
// ───────────────────────────────────────────────────────────────────────────

// Route modules — all converted to local Hono exports (Phase 0, st_d499b891)
import contentRoutes from './routes/content.js';
import apiRoutes from './routes/api.js';
import chatRoutes from './routes/chat.js';
import publicChatRoutes from './routes/public-chat.js';
import filesRoutes from './routes/files.js';
import secureInputRoutes from './routes/secure-input.js';
// Domain routes (were side-effect imports from api.js; now mounted directly)
import networkRoutes from './routes/network.js';
// People-write sub-app: @assistant manual override for relation_tag (st_87a0d072).
// Mounted at /api/people; routes are PATCH /api/people/:id/relation-tag.
import peopleRoutes from './routes/people.js';
import healthRoutes from './routes/health.js';
import healthCoachRoutes from './routes/health-coach.js';
import podcastRoutes, { resumeAutoRenderPodcastSeries } from './routes/podcast.js';
import accountsRoutes from './routes/accounts.js';
import integrationsRoutes from './routes/integrations.js';
import billingHistoryRoutes from './routes/billing-history.js';
import billingBbRoutes from './routes/billing-bb.js';
import sessionLogRoutes from './routes/session-log.js';
import identityRoutes from './routes/identity.js';
// Auth and local setup APIs
import authRoutes from './routes/auth.js';
import localStartRoutes from './routes/auth/local-start.js';
import oauthRoutes from './routes/oauth.js';
import oauthMicrosoftRoutes from './routes/oauth-microsoft.js';
import billingStripe from './routes/billing-stripe.js';
import billingUsdc from './routes/billing-usdc.js';
import billingRoutes from './routes/billing.js';
import setupRoutes from './routes/setup.js';
import adminRoutes, { adminStatus } from './routes/admin.js';
import accountPrefsRoutes from './routes/account-prefs.js';
import notificationsRoutes from './routes/notifications.js';
import setupStepsRoutes from './routes/setup-steps.js';
import appsRoutes from './routes/apps.js';
import booksRoutes from './routes/books.js';

// Mount all route modules at root — routes carry their full /api/... paths
// st_8cdd196f — content API for stable-URL viewer (topics, entities, chats, transcripts).
// Mounted before other routes so /api/content/* is resolved before any SPA catch-alls.
app.route('/api/content', contentRoutes);
app.route('/', apiRoutes);
app.route('/', chatRoutes);
app.route('/', publicChatRoutes);
app.route('/', filesRoutes);
app.route('/', secureInputRoutes);
// Domain routes (previously side-effect imports from api.js)
app.route('/', networkRoutes);
app.route('/api/people', peopleRoutes);
app.route('/', healthRoutes);
app.route('/', healthCoachRoutes);
app.route('/', podcastRoutes);
app.route('/', accountsRoutes);
app.route('/', integrationsRoutes);
app.route('/', billingHistoryRoutes);
app.route('/', billingBbRoutes);
app.route('/', billingRoutes);
app.route('/', sessionLogRoutes);
app.route('/', identityRoutes);
app.route('/', appsRoutes);
app.route('/', booksRoutes);

// Auth sub-apps
app.route('/api/auth', authRoutes);
// Installer→browser token handoff. Registered as a top-level auth path (not
// under /api/*) so it is reachable before a session exists; the handler
// authenticates by validating the token query param against Keychain/config.
app.route('/auth/local-start', localStartRoutes);
app.route('/auth', oauthRoutes);
app.route('/auth', oauthMicrosoftRoutes);
// st_d9fc573b AC 16 — the Accounts redesign Google connect cards link to
// /api/auth/google/start?account=<label>. Mount the same Hono sub-app at
// /api/auth so /google/start resolves at both /auth/google/start (legacy
// bookmark) and /api/auth/google/start (the new card spec).
app.route('/api/auth', oauthRoutes);
app.route('/api/auth', oauthMicrosoftRoutes);
app.route('/api/billing/stripe', billingStripe);
// st_d9fc573b — billingUsdc declares full /api/* paths internally (both the
// older /api/billing/usdc/* surface and the new /api/billing-usdc/wallet
// endpoint added by AC 21). Mount at root so both surfaces resolve.
app.route('/', billingUsdc);
// Account preferences + lifecycle (release channel, telemetry, beta opt-ins,
// feature requests, deletion). Session-authed — every
// endpoint derives account_id from the cookie, never from the client.
app.route('/api/account', accountPrefsRoutes);

// Admin — mount BEFORE /api/setup so the compatibility alias beats the
// setup.js admin sub-routes (Hono matches in registration order). The
// `/api/admin/status` probe is mounted outside the admin sub-app where
// `.use('*', requireAdmin())` would otherwise block anonymous + non-admin
// users and leak 403s to the UI.
app.get('/api/setup/admin/status', adminStatus);
app.get('/api/admin/status', adminStatus);
app.route('/api/setup/admin', adminRoutes);
app.route('/api/admin', adminRoutes);

// Local setup APIs — progress + inline identity save. Registered AFTER the
// admin alias so the alias takes precedence for `/api/setup/admin/*`.
app.route('/api/setup', setupRoutes);

// Notifications — real-time drop-folder events (SSE) + pending error hydration (REST).
app.route('/api/notifications', notificationsRoutes);

// Setup steps — onboarding task tile lifecycle (st_42799dbe). Auth handled
// route-locally via lib/auth.js#requireAuth so the same handler is testable
// without the global /api/* middleware.
app.route('/api/setup-steps', setupStepsRoutes);

registerTopicBrowseRoutes();

function bootLater(label, fn, delayMs = 250) {
  setTimeout(() => {
    Promise.resolve()
      .then(fn)
      .catch((err) => console.warn(`[${label}] boot task failed:`, err?.message || err));
  }, delayMs).unref?.();
}

function bootDelayMs(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

// ─── Belt bootstrap ────────────────────────────────────────────────────────
// Load Black modules from disk if a key is present from a prior session. Defer
// it so DB-backed belt checks cannot delay the HTTP listeners.
bootLater('module-loader', async () => {
  const { loadModules } = await import('./lib/module-loader.js');
  await loadModules();
}, bootDelayMs('ROBOTDOJO_MODULE_LOADER_DELAY_MS', 2500));
// ───────────────────────────────────────────────────────────────────────────

if (
  process.env.ROBOTDOJO_DISABLE_BACKGROUND !== '1' &&
  process.env.ROBOTDOJO_DISABLE_PODCAST_AUTORENDER_RESUME !== '1' &&
  process.env.NODE_ENV !== 'test'
) {
  bootLater('podcast-render-resume', async () => {
    const result = await resumeAutoRenderPodcastSeries();
    if (result.resumed) console.info(`[podcast] resumed ${result.resumed} audio render queue(s)`);
  }, bootDelayMs('ROBOTDOJO_PODCAST_AUTORENDER_RESUME_DELAY_MS', 15000));
}

// ─── Boot warmup (st_74f45a1a R2) ──────────────────────────────────────────
// Fire-and-forget. Three parallel calls prime: (1) the Gemini embed endpoint
// HTTPS handshake, (2) the sqlite-vec MATCH path for the ambient `general`
// topic, (3) the Anthropic SDK connection + cipher handshake.
//
// Without this the first real chat turn eats 22 s of cold-start tail (R2.A).
// With it, the same turn issues against already-warm sockets and OS page cache.
//
// We do NOT block app.listen on completion — Vercel health checks need
// instant accept. The completion state is observable via /api/server-health
// so Playwright cold-TTFB specs can wait for warmup_complete=true.
import { runBootWarmup } from './lib/warmup.js';
if (
  process.env.ROBOTDOJO_DISABLE_WARMUP !== '1' &&
  process.env.ROBOTDOJO_DISABLE_BACKGROUND !== '1' &&
  process.env.NODE_ENV !== 'test'
) {
  // Per-install 90-day BB trial clock — must exist before workers evaluate isBBActive.
bootLater('bb-trial-config', async () => {
  try {
    const { ensureInstallBbTrialConfig, getBBStatus } = await import('./lib/cohort/active.js');
    const ensured = ensureInstallBbTrialConfig();
    if (ensured.wrote) console.info(`[bb] stamped install trial → ${ensured.bb_expires_at}`);
    const s = await getBBStatus();
    console.info(`[bb] status active=${s.active} reason=${s.reason || 'ok'} until=${s.valid_until || 'n/a'}`);
  } catch (err) {
    console.warn('[bb] trial/config probe failed:', err.message);
  }
}, 100);

bootLater('voice-learn', async () => {
  try {
    const { maybeLearnOwnerVoice } = await import('./lib/writing-learn.js');
    const r = await maybeLearnOwnerVoice();
    if (r.learned) console.info(`[voice-learn] owner voice.md compounded; next bar ${r.nextChars} chars`);
  } catch (err) {
    console.warn('[voice-learn] skipped:', err.message);
  }
}, 2500);

bootLater('voice-mine', async () => {
  try {
    const { spawn } = await import('node:child_process');
    const { join } = await import('node:path');
    const { REPO_ROOT } = await import('./lib/robotdojo-paths.js');
    spawn(process.execPath, [join(REPO_ROOT, 'scripts/mine-conversation-feedback.js'), '--no-identity'], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  } catch (err) {
    console.warn('[voice-mine] skipped:', err.message);
  }
}, 4000);

bootLater('warmup', async () => {
    const state = await runBootWarmup();
      const dt = state.completed_at - state.started_at;
      console.info(`[warmup] complete in ${dt}ms — embed=${state.embed_done} retrieve=${state.retrieve_done} anthropic=${state.anthropic_done} ann=${state.ann_done} context_warm=${state.context_warm_done} boot_context_warm_ms=${state.boot_context_warm_ms} fullturn=${state.fullturn_done} fullturn_ttft_ms=${state.fullturn_ttft_ms}`);
      if (state.fullturn_error) console.warn('[warmup] fullturn:', state.fullturn_error);
      if (state.embed_error) console.warn('[warmup] embed:', state.embed_error);
      if (state.retrieve_error) console.warn('[warmup] retrieve:', state.retrieve_error);
      if (state.anthropic_error) console.warn('[warmup] anthropic:', state.anthropic_error);
      if (state.ann_error) console.warn('[warmup] ann:', state.ann_error);
  }, bootDelayMs('ROBOTDOJO_BOOT_WARMUP_DELAY_MS', 2500));
} else {
  console.info('[warmup] disabled for test/QA mode');
}
// ───────────────────────────────────────────────────────────────────────────

function beltFetch(belt) {
  return (req, env) => {
    setBelt(belt);
    return app.fetch(req, env);
  };
}

// st_fd14cdd4: tolerate EADDRINUSE on boot instead of crashing.
//
// WHY: on a restart (launchctl kickstart -k of com.robotdojo.server), launchd
// SIGTERMs the old process and immediately spawns the new one. The old process
// may not have released its listening sockets yet — the kernel holds them in
// TIME_WAIT / closing for a short window. The new process then hits
// `listen EADDRINUSE` on PORT_SITE (4336) or PORT_APP (4338). With no `error`
// listener, that error bubbles to the global uncaughtException handler in
// lib/server.js, which calls process.exit(1) — so the restart fails to boot
// and chat stays down until the next watchdog tick. Confirmed live in the
// server err log (repeated `[fatal] uncaughtException: listen EADDRINUSE ...
// 0.0.0.0:4336`).
//
// FIX: attach an `error` listener that retries listen() on a bounded backoff
// for EADDRINUSE only. Any other listen error (EACCES, etc.) is genuinely
// fatal and is re-thrown so it still surfaces via uncaughtException. The retry
// is bounded — after the schedule is exhausted the error is re-thrown so a
// truly stuck port (a foreign process holding it) is not masked forever.
//
// Tunables live in config/defaults.json#serverListen.retryDelaysMs (the
// per-attempt backoff). Read directly from defaults.json — the established
// pattern in lib/topic-context.js, lib/idle-gate.js, etc. — with a hardcoded
// fallback so a missing/unreadable defaults.json never breaks boot.
function _loadListenRetryDelays() {
  try {
    const raw = readFileSync(resolve(import.meta.dirname, 'config', 'defaults.json'), 'utf8');
    const delays = JSON.parse(raw)?.serverListen?.retryDelaysMs;
    if (Array.isArray(delays) && delays.length && delays.every((d) => Number.isFinite(d) && d >= 0)) {
      return delays;
    }
  } catch { /* missing/unreadable defaults.json — fall through to hardcode */ }
  return [250, 500, 1000, 2000, 4000];
}
const _LISTEN_RETRY_DELAYS_MS = _loadListenRetryDelays();

function listenWithRetry(server, label, doListen) {
  let attempt = 0;
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attempt < _LISTEN_RETRY_DELAYS_MS.length) {
      const delay = _LISTEN_RETRY_DELAYS_MS[attempt];
      attempt += 1;
      console.warn(`[server] ${label}: EADDRINUSE — port not yet released by prior process; retry ${attempt}/${_LISTEN_RETRY_DELAYS_MS.length} in ${delay}ms`);
      setTimeout(() => doListen(), delay).unref?.();
      return;
    }
    // Non-EADDRINUSE, or retries exhausted: this is genuinely fatal. Re-throw
    // so the global uncaughtException handler logs it and exits (no silent
    // masking of a port held by a foreign process).
    throw err;
  });
  doListen();
}

const _skipListen = process.env.ROBOTDOJO_NO_LISTEN === '1';
const _skipBackground = process.env.ROBOTDOJO_DISABLE_BACKGROUND === '1' || process.env.NODE_ENV === 'test';
const _skipTunnel = process.env.ROBOTDOJO_SKIP_TUNNEL === '1';

if (!_skipListen && process.env.NODE_ENV !== 'test' && process.env.ROBOTDOJO_ENABLE_VIEWER_PREWARM === '1') {
  bootLater('viewer-prewarm', async () => {
    const result = prewarmViewerPayloads();
    const failed = result.failed.length ? ` failed=${result.failed.length}` : '';
    console.info(`[viewer] prewarmed ${result.warmed.length} stable payloads in ${result.elapsedMs}ms${failed}`);
  }, bootDelayMs('ROBOTDOJO_VIEWER_PREWARM_DELAY_MS', 30_000));
}

const _certPaths = _skipListen ? null : getCertPaths();
const _localhostCertPaths = _skipListen ? null : getLocalhostCertPaths();

if (!_skipListen) {
  // Marketing site — plain HTTP, public. Tests can force localhost binding in
  // sandboxed environments that reject 0.0.0.0 binds.
  const siteHostname = process.env.ROBOTDOJO_SITE_HOST || '0.0.0.0';
  const _siteServer = createAdaptorServer({ fetch: beltFetch('demo'), hostname: siteHostname });
  listenWithRetry(_siteServer, 'marketing-site', () => {
    _siteServer.listen(config.ports.site, siteHostname, () => {
      console.info(`[robotdojo] Marketing site on http://${siteHostname}:${_siteServer.address()?.port}`);
    });
  });
}

// App — HTTPS if a device cert is present (SNI passthrough); HTTP otherwise.
// TLS terminates on the Mac; the relay is a blind TCP forwarder in HTTPS mode.
if (!_skipListen && _certPaths) {
  // Pre-load the device cert/key as the default TLS context. This is the
  // cert used when SNI doesn't match a localhost name (i.e. tunnel traffic
  // arriving as {slug}.robotdojo.ai via the SNI-passthrough NLB → gateway).
  const _deviceCert = readFileSync(_certPaths.certPath);
  const _deviceKey  = readFileSync(_certPaths.keyPath);

  // mkcert-provisioned local context. install.sh#provision_mkcert_local_tls
  // writes ~/.robotdojo/tls/localhost.{crt,key} covering localhost+127.0.0.1+::1.
  // If the file pair isn't present (fresh install before mkcert step ran,
  // or mkcert failed), localContext stays null and SNICallback returns
  // null → node falls back to the default device context. The browser then
  // sees a cert-name-mismatch warning on https://localhost:4338, which is
  // the documented degraded path (warning, not failure).
  let _localContext = null;
  if (_localhostCertPaths) {
    try {
      _localContext = createSecureContext({
        cert: readFileSync(_localhostCertPaths.certPath),
        key:  readFileSync(_localhostCertPaths.keyPath),
      });
      console.info('[server] mkcert localhost cert loaded — local SNI will use trusted cert');
    } catch (e) {
      console.warn('[server] failed to load mkcert localhost cert:', e.message);
      _localContext = null;
    }
  }

  // SNICallback runs once per TLS handshake. servername is the SNI extension
  // value sent by the client (`localhost`, `127.0.0.1` is rare via SNI but
  // returned by some Hono fetch wrappers; modern browsers send the hostname
  // even on localhost connections). Returning null hands control back to
  // node which uses the default cert/key on the server options — that is,
  // the device cert for non-local traffic.
  //
  // We match `localhost`, `127.0.0.1`, and `::1` explicitly. Tunnel traffic
  // arriving via the SNI-passthrough NLB carries `{slug}.robotdojo.ai` as
  // the servername — that case hits `return null` and gets the device cert.
  function _sniCallback(servername, cb) {
    if (
      _localContext &&
      typeof servername === 'string' &&
      (servername === 'localhost' ||
       servername === '127.0.0.1' ||
       servername === '::1')
    ) {
      return cb(null, _localContext);
    }
    return cb(null, null); // null → use default context (device cert)
  }

  // HTTPS mode — TLS on Mac, relay is a blind TCP forwarder
  // createAdaptorServer passes serverOptions as first arg to createServer.
  // We provide https.createServer so it receives { cert, key, SNICallback }.
  function createHttpsAppServer(hostname) {
    const server = createAdaptorServer({
      fetch: beltFetch('black'),
      createServer: https.createServer.bind(https),
      serverOptions: {
        cert: _deviceCert,
        key:  _deviceKey,
        SNICallback: _sniCallback,
      },
      hostname,
    });
    // Extend timeouts for long-running awaited synthesis calls (e.g. /context/refresh → Sonnet, ~70s).
    // Node.js default headersTimeout is 60s — too short for synchronous AI API calls.
    server.headersTimeout = 180_000; // 3 min
    server.requestTimeout = 180_000; // 3 min
    return server;
  }

  const _httpsServer = createHttpsAppServer('127.0.0.1');
  listenWithRetry(_httpsServer, 'app-https', () => {
    _httpsServer.listen(config.ports.app, '127.0.0.1', () => {
      const slug = config.deviceSlug || '?';
      console.info(`[server] HTTPS on PORT_APP IPv4 (${slug}.robotdojo.ai)`);
    });
  });
  const _httpsServerV6 = createHttpsAppServer('::1');
  listenWithRetry(_httpsServerV6, 'app-https-ipv6', () => {
    _httpsServerV6.listen(config.ports.app, '::1', () => {
      console.info('[server] HTTPS on PORT_APP IPv6 loopback');
    });
  });
  // Tunnel-agent proxy port — plain HTTP, loopback only. TLS is not needed
  // here because this socket never leaves the Mac. The HTTPS port above is
  // only for the SNI-passthrough path (external → NLB → gateway TCP → Mac).
  const _internalPort = config.ports.app + 1;
  const _internalServer = createAdaptorServer({ fetch: beltFetch('black'), hostname: '127.0.0.1' });
  listenWithRetry(_internalServer, 'app-http-internal', () => {
    _internalServer.listen(_internalPort, '127.0.0.1', () => {
      const port = _internalServer.address()?.port;
      console.info(`[server] HTTP internal on ${port} (tunnel-agent proxy)`);
      writeHttpPort(port);
    });
  });
} else if (!_skipListen) {
  // HTTP mode — local only, no cert
  const _httpServer = createAdaptorServer({ fetch: beltFetch('black'), hostname: '127.0.0.1' });
  listenWithRetry(_httpServer, 'app-http', () => {
    _httpServer.listen(config.ports.app, '127.0.0.1', () => {
      const port = _httpServer.address()?.port;
      console.info(`[server] HTTP on PORT_APP IPv4 (local only) — http://127.0.0.1:${port}`);
      writeHttpPort(port);
    });
  });
  const _httpServerV6 = createAdaptorServer({ fetch: beltFetch('black'), hostname: '::1' });
  listenWithRetry(_httpServerV6, 'app-http-ipv6', () => {
    _httpServerV6.listen(config.ports.app, '::1', () => {
      console.info(`[server] HTTP on PORT_APP IPv6 loopback — http://[::1]:${config.ports.app}`);
    });
  });
} else {
  console.info('[server] ROBOTDOJO_NO_LISTEN=1 — routes mounted without port listeners');
}

// Tunnel agent — outbound WSS to relay.robotdojo.ai. Token sources,
// in order:
//   1. ROBOTDOJO_TUNNEL_TOKEN env var (ops / CI override)
//   2. Minted locally from TUNNEL_JWT_SECRET in Keychain + the admin user
//      row. This is the owner-install path — no round-trip to the cloud
//      needed because the same secret lives on the Mac.
// Absence of BOTH is a no-op (free users pre-onboarding). Details: why
// mint locally vs calling out is covered in lib/mint-tunnel-token.js.
if (!_skipListen && !_skipBackground && !_skipTunnel) bootLater('tunnel-agent', async () => {
  const [{ startTunnelAgent }, { mintOwnerTunnelToken }] = await Promise.all([
    import('./lib/tunnel-agent.js'),
    import('./lib/mint-tunnel-token.js'),
  ]);
  let token = process.env.ROBOTDOJO_TUNNEL_TOKEN || null;
  if (!token) {
    try { token = mintOwnerTunnelToken(); }
    catch (err) { console.warn('[tunnel-agent] mint skipped:', err.message); }
  }
  const localOrigin = _certPaths
    ? `http://127.0.0.1:${config.ports.app + 1}`
    : undefined; // default in tunnel-agent (http://127.0.0.1:4338) // check-literals:ignore-line
  if (token) startTunnelAgent({ token }, localOrigin ? { localOrigin } : {});
  else console.info('[tunnel-agent] no owner token — agent not started');
});

// SNI passthrough tunnel client — only starts when deviceSlug + deviceSecret are configured.
if (!_skipListen && !_skipBackground && !_skipTunnel && config.deviceSlug && config.deviceSecret && config.gatewayUrl) {
  // st_63b59bda AC-5: the relay authenticates this Mac by its device secret
  // alone — no email ever crosses the wire. The WS upgrade carries only the
  // slug and the secret.
  bootLater('tunnel', async () => {
    const { startTunnelClient } = await import('./lib/tunnel-client.js');
    startTunnelClient();
    console.info('[tunnel] SNI passthrough client started');
  });
}
if (!_skipListen && !_skipBackground && _skipTunnel) {
  console.info('[tunnel] skipped in server process — standalone LaunchAgent owns relay');
}

// USDC watcher — self-disabling if ALCHEMY_API_KEY / USDC_RECEIVING_WALLET
// aren't configured. Safe to leave mounted in dev.
if (!_skipListen && !_skipBackground) bootLater('usdc-watcher', async () => {
  const m = await import('./lib/usdc-watcher.js');
  m.start();
});

// Drop folder watcher — picks up files dropped into ~/Robot Dojo/Inbox/.
// Safe to run in dev; it no-ops if the tree hasn't been initialised.
if (!_skipListen && !_skipBackground) bootLater('drop-folder', async () => {
  const m = await import('./lib/drop-folder/watcher.js');
  m.start();
}, bootDelayMs('ROBOTDOJO_DROP_FOLDER_BOOT_DELAY_MS', 120000));

// st_27561b77 P4/P6 — in-process passive-job supervisor. Drives
// drainPassiveJobs from inside the server process so passive jobs make
// progress between launchd fires; idle-checks every iteration so the user
// re-becoming active pauses the current job within ~1 slice. Also runs
// the background deep-health worker and the nightly startup probe.
//
// Disable: ROBOTDOJO_SUPERVISOR_ENABLED=0 or NODE_ENV=test (already
// honored inside startInProcessSupervisor()).
if (!_skipListen && !_skipBackground) {
  bootLater('supervisor', async () => {
    const { startInProcessSupervisor } = await import('./lib/passive-supervisor.js');
    try { startInProcessSupervisor(); }
    catch (err) { console.warn('[supervisor] failed to start:', err.message); }
  }, bootDelayMs('ROBOTDOJO_SUPERVISOR_BOOT_DELAY_MS', 150000));
}

// st_fd14cdd4 AC1/AC3 — integration reconciler. One pass at boot repairs
// credentials-without-registration (API-key slug rows, Microsoft legacy
// registry) and surfaces non-repairable states as visible integration_health
// errors — never silence. The 15-minute cadence lives in
// scripts/integration-monitor.js; this is the boot edge of "within minutes".
if (!_skipListen && !_skipBackground) {
  bootLater('model-key-cadence', async () => {
    const { startModelKeyCadence } = await import('./lib/model-key-cadence.js');
    const started = startModelKeyCadence();
    if (started.started) {
      console.info(`[model-key-cadence] in-process handshake every ${Math.round(started.cadenceMs / 60000)}m`);
    }
  }, bootDelayMs('ROBOTDOJO_MODEL_KEY_CADENCE_BOOT_MS', 8000));
}

if (!_skipListen && !_skipBackground) {
  bootLater('reconciler', async () => {
    const { reconcileIntegrations } = await import('./lib/integration-reconciler.js');
    const summary = reconcileIntegrations();
    const repaired = summary.createdAccounts.length + summary.microsoft.repaired.length;
    if (repaired > 0 || summary.error || summary.microsoft.no_mailbox_error) {
      console.info(`[reconciler] boot pass: created=${summary.createdAccounts.join(',') || 'none'} microsoft_repaired=${summary.microsoft.repaired.join(',') || 'none'}${summary.microsoft.no_mailbox_error ? ' microsoft=no_mailbox_error' : ''}${summary.error ? ` error=${summary.error}` : ''}`);
    }
  }, bootDelayMs('ROBOTDOJO_RECONCILER_BOOT_DELAY_MS', 180000));
}

// df_355651ca AC1 — integration-cards boot primer. The cards cache is
// in-process, so every restart used to leave the account page on the cold
// fallback until a request scheduled a build (Key decision 4a) — this primer
// is the second leg: one background build ~30s after boot warms the cache
// with zero page visits, well inside the two-minute budget. Never inline on
// the request path — the builder shells out to Keychain and runs dozens of
// COUNTs against the live DB. Raise the delay via env if boot contention is
// observed; the request-path scheduling still breaks the cold deadlock alone.
if (!_skipListen && !_skipBackground) {
  bootLater('integration-cards', async () => {
    const { primeIntegrationCardsCache } = await import('./routes/accounts.js');
    const result = await primeIntegrationCardsCache();
    console.info(`[integration-cards] boot primer warmed ${result.primed} cache key(s)`);
  }, bootDelayMs('ROBOTDOJO_INTEGRATION_CARDS_BOOT_DELAY_MS', 30000));
}

// Permission watcher + ingest orchestrator — only active during onboarding.
// Once the active config dir has `.onboarded`, the 5-phase pipeline has completed
// its first run and there's no reason to keep polling macOS permission state.
// This keeps the normal-operation loop lean.
if (!_skipListen && !_skipBackground) bootLater('onboarding', async () => {
  try {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const onboardedFlag = resolve(config.configDir, '.onboarded');
    if (existsSync(onboardedFlag)) {
      console.info('[onboarding] .onboarded present; skipping permission-watcher boot');
      return;
    }
    const orchestrator = await import('./lib/ingest-orchestrator.js');
    const watcher = await import('./lib/permission-watcher.js');
    // Wire: permission-watcher emits → ingest-orchestrator triggers phases.
    orchestrator.subscribeToPermissionEvents(watcher.events);
    // Wire: when Google OAuth completes anywhere in the app, phase 4 fires.
    // The emitter is the orchestrator's own bus — routes that finish OAuth
    // import `events` from ingest-orchestrator and call
    // `events.emit('google.auth.completed')`. That keeps routes/ decoupled
    // from this module wiring.
    orchestrator.subscribeToGoogleAuthEvents(orchestrator.events);
    watcher.start();
  } catch (err) {
    console.warn('[onboarding] failed to start permission-watcher:', err.message);
  }
}, bootDelayMs('ROBOTDOJO_ONBOARDING_BOOT_DELAY_MS', 90000));
if (!_skipListen && _skipBackground) {
  console.info('[server] background workers disabled for test/QA mode');
}
