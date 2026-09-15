import { readEmbedPauseHold } from './embed-pause-hold.js';

const DEFAULT_SLOW_MS = 2_000;
const DEFAULT_HOT_WINDOW_MS = 10_000;
const DEFAULT_HOT_COUNT = 60;
const MAX_FIELD_LENGTH = 180;
const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'auth',
  'authorization',
  'code',
  'key',
  'password',
  'refresh_token',
  'secret',
  'session',
  'state',
  'token',
]);

function positiveEnvInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function trunc(value) {
  const s = String(value || '');
  if (s.length <= MAX_FIELD_LENGTH) return s;
  return `${s.slice(0, MAX_FIELD_LENGTH - 3)}...`;
}

export function sanitizeRequestPath(raw) {
  try {
    const url = new URL(String(raw || '/'), 'http://robotdojo.local');
    const path = url.pathname || '/';
    const keys = [];
    for (const key of url.searchParams.keys()) {
      const lower = key.toLowerCase();
      const label = SENSITIVE_QUERY_KEYS.has(lower) ? `${key}:redacted` : key;
      if (!keys.includes(label)) keys.push(label);
    }
    return keys.length ? `${path}?${keys.join('&')}` : path;
  } catch {
    const fallback = String(raw || '/').split('?')[0] || '/';
    return fallback.startsWith('/') ? fallback : `/${fallback}`;
  }
}

export function createRequestObserver({
  logger = console,
  slowMs = positiveEnvInt('ROBOTDOJO_SLOW_REQUEST_MS', DEFAULT_SLOW_MS),
  hotWindowMs = positiveEnvInt('ROBOTDOJO_HOT_REQUEST_WINDOW_MS', DEFAULT_HOT_WINDOW_MS),
  hotCount = positiveEnvInt('ROBOTDOJO_HOT_REQUEST_COUNT', DEFAULT_HOT_COUNT),
  now = () => Date.now(),
} = {}) {
  const buckets = new Map();
  let windowStartedAt = now();

  function emit(kind, detail) {
    const safe = {
      ...detail,
      path: sanitizeRequestPath(detail.path),
      host: trunc(detail.host),
      user_agent: trunc(detail.user_agent),
    };
    logger.warn?.(`[request-observer] ${kind}`, safe);
  }

  function record({
    method = 'GET',
    path = '/',
    status = 0,
    durationMs = 0,
    belt = null,
    host = '',
    userAgent = '',
  } = {}) {
    const safePath = sanitizeRequestPath(path);
    const key = `${String(method).toUpperCase()} ${safePath}`;
    const bucket = buckets.get(key) || {
      method: String(method).toUpperCase(),
      path: safePath,
      count: 0,
      total_ms: 0,
      max_ms: 0,
      statuses: new Map(),
      belt,
      host,
      user_agent: userAgent,
    };
    bucket.count += 1;
    bucket.total_ms += Number(durationMs) || 0;
    bucket.max_ms = Math.max(bucket.max_ms, Number(durationMs) || 0);
    bucket.statuses.set(status, (bucket.statuses.get(status) || 0) + 1);
    bucket.belt = belt ?? bucket.belt;
    bucket.host = host || bucket.host;
    bucket.user_agent = userAgent || bucket.user_agent;
    buckets.set(key, bucket);

    if ((Number(durationMs) || 0) >= slowMs) {
      emit('slow', {
        method: bucket.method,
        path: safePath,
        status,
        duration_ms: Math.round(Number(durationMs) || 0),
        belt,
        host,
        user_agent: userAgent,
      });
    }
  }

  function flush() {
    const elapsed = Math.max(1, now() - windowStartedAt);
    for (const bucket of buckets.values()) {
      if (bucket.count < hotCount) continue;
      emit('hot', {
        method: bucket.method,
        path: bucket.path,
        count: bucket.count,
        window_ms: elapsed,
        avg_ms: Math.round(bucket.total_ms / bucket.count),
        max_ms: Math.round(bucket.max_ms),
        statuses: Object.fromEntries(bucket.statuses.entries()),
        belt: bucket.belt,
        host: bucket.host,
        user_agent: bucket.user_agent,
      });
    }
    buckets.clear();
    windowStartedAt = now();
  }

  return { record, flush };
}

export function startRequestObserver(observer, {
  intervalMs = positiveEnvInt('ROBOTDOJO_HOT_REQUEST_WINDOW_MS', DEFAULT_HOT_WINDOW_MS),
} = {}) {
  const timer = setInterval(() => observer.flush(), intervalMs);
  timer.unref?.();
  return timer;
}

const NON_FOREGROUND_ACTIVITY_PATHS = new Set([
  '/api/auth/probe',
  '/api/admin/data-plane-proof',
  '/api/server-health',
  '/api/public-chat/health',
  '/api/models',
  '/api/warm',
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
]);

const NON_FOREGROUND_ACTIVITY_PREFIXES = [
  '/api/session-log/',
  '/apps/',
  '/assets/',
  '/public/',
  '/static/',
  '/_next/',
  '/css/',
  '/js/',
  '/images/',
  '/fonts/',
];

const FOREGROUND_ACTIVITY_BASE_PREFIXES = [
  '/me/dojo',
];

const STATIC_ASSET_PATH_RE = /\.(?:avif|css|gif|ico|jpe?g|js|json|map|mjs|otf|png|svg|ttf|txt|wasm|webp|woff2?|xml)$/i;

function headerValue(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(lower) || '';
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === lower) return String(value || '');
    }
  }
  return '';
}

function normalizeForegroundActivityPath(pathname) {
  for (const prefix of FOREGROUND_ACTIVITY_BASE_PREFIXES) {
    if (pathname === prefix) return '/';
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) || '/';
  }
  return pathname;
}

/**
 * Does this route represent foreground product work that should make the
 * embedding daemon yield? Request logging still observes every route; this is
 * only the cross-process pause signal. Health/readiness and static asset probes
 * must not keep the embed backlog parked forever. App shell routes like /chat
 * stay foreground; their asset URLs like /chat/app.js do not.
 *
 * @param {{method?:string,path?:string}} request
 * @returns {boolean}
 */
export function shouldRecordForegroundActivity({ method = 'GET', path = '/', headers = null } = {}) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'OPTIONS' || m === 'HEAD') return false;
  if (headerValue(headers, 'x-robotdojo-warmup')) return false;

  const pathname = (() => {
    try { return new URL(String(path || '/'), 'http://robotdojo.local').pathname || '/'; }
    catch { return String(path || '/').split('?')[0] || '/'; }
  })();
  const normalizedPathname = normalizeForegroundActivityPath(pathname);

  if (NON_FOREGROUND_ACTIVITY_PATHS.has(normalizedPathname)) return false;
  if (NON_FOREGROUND_ACTIVITY_PREFIXES.some((prefix) => normalizedPathname.startsWith(prefix))) return false;
  if (m === 'GET' && STATIC_ASSET_PATH_RE.test(normalizedPathname)) return false;
  return true;
}

export function shouldRecordChatRequestActivity({ method = 'GET', path = '/', headers = null } = {}) {
  const m = String(method || 'GET').toUpperCase();
  if (m !== 'POST') return false;
  if (headerValue(headers, 'x-robotdojo-warmup')) return false;

  const pathname = (() => {
    try { return new URL(String(path || '/'), 'http://robotdojo.local').pathname || '/'; }
    catch { return String(path || '/').split('?')[0] || '/'; }
  })();
  const normalizedPathname = normalizeForegroundActivityPath(pathname);
  return normalizedPathname === '/api/chat/stream'
    || normalizedPathname === '/api/public-chat/stream';
}

// ──────────────────────────────────────────────────────────────────────────────
// Server-activity signal (st_2cd1af73 — cross-process channel for the embedder)
// ──────────────────────────────────────────────────────────────────────────────
//
// WHY a single-row table is the cross-process channel: the chunk-embed daemon
// (scripts/chunk-embed-daemon.mjs), the supervisor maintenance worker, and the
// maintenance children are SEPARATE processes. They cannot read this server's in-memory
// state, so they read activity across the process boundary by SELECTing the
// `server_activity` row. The table is the cheapest correct IPC — exactly one row,
// UPDATE-in-place (no row growth, ever), WAL-concurrent with chat reads.
//
// WHY the request path is now IN-MEMORY and the row write is OFF the hot path
// (st_2cd1af73 AC-1, the proven residual): recordActivityStart used to run a
// SYNCHRONOUS `UPDATE server_activity` on the single SQLCipher writer at the very
// FIRST step of every request. Under the embed daemon's continuous writes that
// stamp blocked for SECONDS (entry-trace measured 9,900ms and 61,939ms) because
// it had to wait for the daemon's in-flight write transaction to release the
// writer — turning an observability stamp into the dominant TTFT term. The fix:
// the request path mutates process-local counters only (no DB, no lock, sub-µs);
// a single unref'd interval flushes that snapshot to the row off the request
// path. The daemon still sees an active chat burst inside one flush interval
// (≤ FLUSH_INTERVAL_MS, well under ACTIVITY_PAUSE_MS), so its yield behavior is
// unchanged. In-process callers (getActivitySignal in this server) read memory
// directly, which is both correct and faster than a row read.
//
// WHY in_flight is a counter, not a boolean: concurrent requests overlap. Start
// increments, finish decrements; the daemon pauses while in_flight>0 OR the last
// request finished within ACTIVITY_PAUSE_MS. A counter that only ever increments
// (a leaked +1 on an unmatched finish) would pin the embedder paused forever — so
// finish floors the counter at 0 and the readers additionally honor a staleness
// TTL (a dead server's stale row is treated as "no activity").
//
// WHY best-effort try/catch on the flush: observability must NEVER break a chat
// turn, and the flush must NEVER park the event loop. A momentarily-busy DB makes
// the flush skip silently; the very next flush carries the current snapshot, and
// the readers' 30s stale-TTL already tolerates a missed write. The flush also
// caps its own lock wait with a tiny busy_timeout so a contended writer can never
// hold the flusher (and thus the event loop) for more than that window.

const ACTIVITY_ROW_ID = 1;

// How often the in-memory snapshot is flushed to the server_activity row. Must
// stay well under ACTIVITY_PAUSE_MS (1500ms) so an active chat burst reflects in
// the row in time for the daemon to yield: at 1000ms, a request stamps memory and
// the row carries it within ≤1s, leaving ≥500ms of pause budget. Tunable for a
// box where a longer cadence is acceptable.
const FLUSH_INTERVAL_MS = positiveEnvInt('ROBOTDOJO_ACTIVITY_FLUSH_MS', 1_000);

// Lock-wait cap for the flush UPDATE only. The server connection's global
// busy_timeout is 30000ms (db.js) — far too long to hold on a flush, which runs
// on the same event loop as chat. We lower busy_timeout to this value around the
// flush statement and restore it immediately after, so a contended writer can
// stall the flush for at most this long before it surfaces SQLITE_BUSY and the
// flush skips. 50ms is generous for a single-row UPDATE yet imperceptible if it
// is ever fully spent.
const FLUSH_BUSY_TIMEOUT_MS = positiveEnvInt('ROBOTDOJO_ACTIVITY_FLUSH_BUSY_MS', 50);

// Process-local activity state. This is the source of truth for THIS process; the
// row is a periodically-flushed projection of it for OTHER processes to read.
//
// lastChatRequestAt (st_2cd1af73 AC-3) is stamped ONLY by chat-stream requests
// (recordChatActivity), never by background traffic. It is the chat-only quiet
// signal the daemon's long-input start gate reads, so the 333k long-dominated
// bulk drains overnight when no human is chatting — background /api/* polling no
// longer pins that gate shut. lastRequestAt still tracks ALL traffic for the
// normal yield-the-WAL-writer slice gate.
//
// lastChatAppActiveAt (st_fd14cdd4 AC9) is stamped when the chat APP is OPEN — on
// app load, on focus/visibility-visible, and on a heartbeat while it stays open —
// NOT when a turn is submitted. It is the "a human has chat open right now" signal
// the embedder reads to drop its in-flight chunk and stay paused, so the writer is
// free BEFORE the user finishes typing. Stamped only by the /api/chat/active ping
// (recordChatAppActive); ordinary chat-stream traffic does not touch it.
const memState = { inFlight: 0, lastRequestAt: 0, lastChatRequestAt: 0, lastChatAppActiveAt: 0, updatedAt: 0 };

// The connection + interval handle the flusher was armed with. Armed lazily on
// the first recordActivityStart so importing this module for getActivitySignal
// (the daemon/worker/maintenance path) never starts a server-side flush loop.
let flushDb = null;
let flushTimer = null;
let flushDirty = false; // memory changed since the last successful flush

// Prepared-statement cache keyed by the better-sqlite3 connection. The server and
// any test pass their own db; we memoize per connection so we prepare once.
const activityStmtCache = new WeakMap();

function activityStmts(db) {
  let stmts = activityStmtCache.get(db);
  if (stmts) return stmts;
  stmts = {
    write: db.prepare(`
      UPDATE server_activity
         SET in_flight = ?,
             last_request_at = ?,
             last_chat_request_at = ?,
             last_chat_app_active_at = ?,
             updated_at = ?
       WHERE id = ${ACTIVITY_ROW_ID}
    `),
    read: db.prepare(`
      SELECT in_flight, last_request_at, last_chat_request_at, last_chat_app_active_at, updated_at
        FROM server_activity
       WHERE id = ${ACTIVITY_ROW_ID}
    `),
  };
  activityStmtCache.set(db, stmts);
  return stmts;
}

function isSqliteBusyError(err) {
  const text = String(err?.code || err?.message || err || '');
  return /SQLITE_(BUSY|LOCKED)|database is locked|database locked/i.test(text);
}

function foregroundActiveSignal(now = Date.now()) {
  return {
    inFlight: 1,
    lastRequestAt: now,
    lastChatRequestAt: now,
    lastChatAppActiveAt: now,
    updatedAt: now,
  };
}

/**
 * Flush the in-memory activity snapshot to the server_activity row. One bounded
 * single-row UPDATE, off the request path. Best-effort: a busy/locked DB skips
 * silently (the next flush covers it; readers' stale-TTL tolerates the gap), and
 * a tiny busy_timeout caps how long a contended writer can stall the flush so it
 * can never park the event loop.
 *
 * Exported so a unit test can drive a flush deterministically and so the server
 * can force a final flush on shutdown.
 *
 * @param {object} db better-sqlite3 connection
 * @returns {boolean} true if the row was written, false if the flush was skipped
 */
export function flushActivity(db) {
  if (!db) return false;
  // Snapshot under no async boundary — this is synchronous, single-threaded JS,
  // so the reads are atomic with respect to record* mutations.
  const { inFlight, lastRequestAt, lastChatRequestAt, lastChatAppActiveAt, updatedAt } = memState;
  let prevTimeout;
  try {
    // Cap the flush's lock wait so a contended writer cannot hold the event loop.
    try { prevTimeout = db.pragma('busy_timeout', { simple: true }); } catch { prevTimeout = undefined; }
    try { db.pragma(`busy_timeout = ${FLUSH_BUSY_TIMEOUT_MS}`); } catch { /* keep going at the existing timeout */ }
    activityStmts(db).write.run(inFlight, lastRequestAt, lastChatRequestAt, lastChatAppActiveAt, updatedAt);
    flushDirty = false;
    return true;
  } catch {
    // Busy/locked/missing-table — skip. The next interval carries the snapshot;
    // the readers' 30s stale-TTL already tolerates a missed write.
    return false;
  } finally {
    if (prevTimeout !== undefined) {
      try { db.pragma(`busy_timeout = ${prevTimeout}`); } catch { /* best-effort restore */ }
    }
  }
}

/**
 * Arm the periodic flusher on the given connection. Idempotent: a second call
 * with the same db is a no-op; importing this module without ever recording an
 * activity never arms a timer (the daemon/worker/maintenance readers stay timer-free).
 * The interval is unref'd so it never holds the process open on its own.
 *
 * @param {object} db better-sqlite3 connection
 */
export function startActivityFlush(db) {
  if (flushTimer && flushDb === db) return;
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  flushDb = db;
  flushTimer = setInterval(() => {
    // Only write when memory changed since the last successful flush. A quiet
    // server then writes the row at most once after going idle (carrying the
    // final lastRequestAt the readers' pause window needs), not every second.
    if (flushDirty) flushActivity(flushDb);
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

/**
 * Stop the periodic flusher and flush one last time so the row reflects the
 * final state (e.g. on a clean server shutdown). Exported for tests and lifecycle.
 */
export function stopActivityFlush() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (flushDb) flushActivity(flushDb);
  flushDb = null;
}

/** Test helper: reset all in-memory activity state and tear down the flusher. */
export function _resetActivityForTest() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  flushDb = null;
  flushDirty = false;
  memState.inFlight = 0;
  memState.lastRequestAt = 0;
  memState.lastChatRequestAt = 0;
  memState.lastChatAppActiveAt = 0;
  memState.updatedAt = 0;
}

/**
 * Record that a request has started: bump the in-memory in-flight counter and
 * stamp freshness. PURE MEMORY — no DB write, no lock, sub-microsecond. Arms the
 * off-path flusher on first call so the row begins tracking this process.
 *
 * @param {object} db better-sqlite3 connection (used only to arm the flusher)
 * @param {object} [opts]
 * @param {number} [opts.now] epoch ms (test hook)
 */
export function recordActivityStart(db, { now = Date.now() } = {}) {
  memState.inFlight += 1;
  memState.updatedAt = now;
  flushDirty = true;
  if (!flushTimer && db) startActivityFlush(db);
}

/**
 * Record that a request has finished: decrement the in-memory in-flight counter
 * (floored at 0) and stamp last_request_at so the readers see recency. PURE
 * MEMORY — no DB write, no lock.
 *
 * @param {object} db better-sqlite3 connection (unused on the finish path; kept
 *   for call-site symmetry with recordActivityStart)
 * @param {object} [opts]
 * @param {number} [opts.now] epoch ms (test hook)
 */
export function recordActivityFinish(db, { now = Date.now() } = {}) {
  memState.inFlight = Math.max(0, memState.inFlight - 1);
  memState.lastRequestAt = now;
  memState.updatedAt = now;
  flushDirty = true;
}

/**
 * Record that a CHAT-stream request occurred (st_2cd1af73 AC-3). Stamps the
 * chat-only recency signal the daemon's long-input start gate reads. Called from
 * the chat-stream route boundaries ONLY (authenticated /api/chat/stream and
 * public /api/public-chat/stream), so background traffic — health probes,
 * login-probe, sync, integration-monitor, the supervisor's localhost calls,
 * maintenance children — does NOT touch it. PURE MEMORY: no DB write, no lock; the
 * off-path flusher carries it to the row for the cross-process daemon to read.
 * Arms the flusher on first call so a chat turn that arrives before any other
 * request still begins tracking. The general lastRequestAt is stamped by the
 * wildcard middleware as usual; this is the narrower chat-scoped signal layered
 * on top, not a replacement.
 *
 * @param {object} db better-sqlite3 connection (used only to arm the flusher)
 * @param {object} [opts]
 * @param {number} [opts.now] epoch ms (test hook)
 */
export function recordChatActivity(db, { now = Date.now() } = {}) {
  memState.lastChatRequestAt = now;
  memState.updatedAt = now;
  flushDirty = true;
  if (!flushTimer && db) startActivityFlush(db);
}

/**
 * Record that the CHAT APP is OPEN right now (st_fd14cdd4 AC9). Called from the
 * /api/chat/active ping the chat app fires on load, on focus / visibility→visible,
 * and on a heartbeat while it stays open — so "the app is open" is a SUSTAINED
 * state, not a one-shot. This stamps the broadest, earliest yield signal: the
 * embedder reads it (via getActivitySignal across the process boundary) and, when
 * it is fresh, DROPS its in-flight chunk and stays paused while the app holds open,
 * freeing the SQLCipher writer BEFORE the user finishes typing — distinct from
 * recordChatActivity, which fires only once the user has already submitted a turn.
 * PURE MEMORY: no DB write, no lock; the off-path flusher carries it to the row for
 * the cross-process daemon to read. Arms the flusher on first call so an app load
 * that arrives before any other request still begins tracking.
 *
 * @param {object} db better-sqlite3 connection (used only to arm the flusher)
 * @param {object} [opts]
 * @param {number} [opts.now] epoch ms (test hook)
 */
export function recordChatAppActive(db, { now = Date.now() } = {}) {
  memState.lastChatAppActiveAt = now;
  memState.updatedAt = now;
  flushDirty = true;
  if (!flushTimer && db) startActivityFlush(db);
  // st_fd14cdd4 — WRITE THE APP-ACTIVE STAMP THROUGH TO THE ROW SYNCHRONOUSLY, not
  // on the next ≤1s flush tick. WHY this is the one residual the rest of the story
  // left: every OTHER signal here is fine riding the 1s flush — the embedder's
  // pause windows (recent-chat 1.5s, in-flight) and the day/night gates all tolerate
  // up to a flush-interval of staleness. The app-active stamp does NOT: it is the
  // signal that must beat the user's FIRST keystroke. The chat app pings here on
  // load and the user can submit a turn within ~1.25s; if the daemon reads the row
  // up to FLUSH_INTERVAL_MS (1s) late and then takes its ACTIVITY_WATCH_MS (250ms)
  // to abort, the immediate first turn catches the embedder still grinding — the
  // 24–38s spike this fix kills. Flushing the stamp through on the ping itself
  // collapses that to the daemon's 250ms watch alone, so the lanes drop within
  // ~250ms of app-load, free before the user finishes typing.
  //
  // This is ONE bounded single-row UPDATE on the ping path (a few-per-minute event:
  // load + focus + a 30s heartbeat), NOT a change to FLUSH_INTERVAL_MS — the
  // periodic flush still carries every other signal at the unchanged 1s cadence, so
  // this adds no write load to the hot chat-stream path. flushActivity is the same
  // best-effort, busy-capped writer the periodic flush uses: a contended DB skips
  // silently (the next periodic flush still carries the stamp), so the synchronous
  // write can never throw into the ping route or park the event loop.
  if (db) flushActivity(db);
}

/**
 * Read the current server-activity signal for a reader's pause decision.
 *
 * In THIS process (the server, once the flusher is armed) the in-memory snapshot
 * IS the truth and is read directly — both correct and faster than a row read.
 * In a SEPARATE process (the chunk-embed daemon, supervisor worker, maintenance) the
 * flusher was never armed, so the periodically-flushed row is read instead. The
 * branch keys off whether this process owns the flusher for the passed db.
 *
 * @param {object} db better-sqlite3 connection
 * @returns {{inFlight:number, lastRequestAt:number, lastChatRequestAt:number, lastChatAppActiveAt:number, updatedAt:number}}
 *   signal — all-zero when the row is missing (a fresh DB before the first
 *   request). lastChatRequestAt is the chat-only recency the long-input gate reads;
 *   lastChatAppActiveAt is the chat-app-open recency the embedder's drop-and-pause
 *   gate reads (st_fd14cdd4 AC9).
 */
export function getActivitySignal(db) {
  // In-process fast path: this process owns the flusher, so memory is authoritative.
  if (flushTimer && flushDb === db) {
    return {
      inFlight: memState.inFlight,
      lastRequestAt: memState.lastRequestAt,
      lastChatRequestAt: memState.lastChatRequestAt,
      lastChatAppActiveAt: memState.lastChatAppActiveAt,
      updatedAt: memState.updatedAt,
    };
  }
  // Cross-process path: read the flushed row.
  try {
    const row = activityStmts(db).read.get();
    if (!row) return { inFlight: 0, lastRequestAt: 0, lastChatRequestAt: 0, lastChatAppActiveAt: 0, updatedAt: 0 };
    return {
      inFlight: Number(row.in_flight) || 0,
      lastRequestAt: Number(row.last_request_at) || 0,
      lastChatRequestAt: Number(row.last_chat_request_at) || 0,
      lastChatAppActiveAt: Number(row.last_chat_app_active_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
    };
  } catch (err) {
    // A contended DB is itself foreground signal: the server may be trying to
    // write login/session/chat state right now. Fail closed and make background
    // workers pause. Missing schema still reads quiet so a stopped/fresh server
    // cannot pin maintenance forever.
    if (isSqliteBusyError(err)) return foregroundActiveSignal();
    return { inFlight: 0, lastRequestAt: 0, lastChatRequestAt: 0, lastChatAppActiveAt: 0, updatedAt: 0 };
  }
}

// Default pause window: pause the embedder when the last request finished less
// than this many ms ago. 1500ms is long enough to ride out the gap between a
// chat turn's sub-requests (prefetch → stream → events) without thrashing, short
// enough that the embedder resumes within ~2s of the user going quiet. Tunable
// via ROBOTDOJO_ACTIVITY_PAUSE_MS for a slower/faster box.
export const ACTIVITY_PAUSE_MS = positiveEnvInt('ROBOTDOJO_ACTIVITY_PAUSE_MS', 1500);

// A signal row not refreshed within this window is treated as "no activity":
// a crashed or stopped server must never permanently pause the embedder. 30s is
// far longer than any real inter-request gap on an active server, so a live
// server always refreshes inside it; only a dead server's row goes stale.
export const ACTIVITY_STALE_TTL_MS = positiveEnvInt('ROBOTDOJO_ACTIVITY_STALE_TTL_MS', 30_000);

// st_fd14cdd4 AC9 — how long after the last chat-app-active ping the app counts as
// OPEN. The chat app pings on load and then on a heartbeat (CHAT_APP_HEARTBEAT_MS,
// 30s); this window must cover the heartbeat interval with margin so a single
// dropped ping (or the ≤1s flush staleness on the cross-process row) does not flip
// the app to "closed" mid-session and let the lanes pile back on. 75s ≈ heartbeat
// × 2.5: an open app refreshes well inside it; once the user actually navigates
// away the heartbeat stops and the window lapses within ~75s, so the embedder
// resumes the night drain. Tunable for a slower/faster heartbeat.
export const CHAT_APP_ACTIVE_WINDOW_MS = positiveEnvInt('ROBOTDOJO_CHAT_APP_ACTIVE_WINDOW_MS', 75_000);
export const CHAT_APP_ACTIVE_STALE_TTL_MS = positiveEnvInt(
  'ROBOTDOJO_CHAT_APP_ACTIVE_STALE_TTL_MS',
  Math.max(ACTIVITY_STALE_TTL_MS, CHAT_APP_ACTIVE_WINDOW_MS + 15_000),
);

/**
 * Pure decision (st_fd14cdd4 AC9): is the chat app OPEN right now? True when the
 * last chat-app-active ping arrived within CHAT_APP_ACTIVE_WINDOW_MS AND the
 * activity row is fresh (a stale/dead/booting server is never "app open", mirroring
 * the other stale guards so a stopped server cannot pin the embedder paused forever
 * — the AC-3 wedge defense). The embedder folds this into its pause/drop gate so it
 * yields the writer the instant the app loads, not only when a turn is submitted.
 *
 * @param {{lastChatAppActiveAt:number, updatedAt:number}} signal
 * @param {object} [opts]
 * @param {number} [opts.now] epoch ms
 * @param {number} [opts.windowMs]
 * @param {number} [opts.staleTtlMs]
 * @returns {boolean}
 */
export function chatAppActiveDecision(signal, {
  now = Date.now(),
  windowMs = CHAT_APP_ACTIVE_WINDOW_MS,
  staleTtlMs = CHAT_APP_ACTIVE_STALE_TTL_MS,
} = {}) {
  const updatedAt = Number(signal?.updatedAt) || 0;
  // A dead/stale/booting server row is never "app open" — never let a stopped
  // server's stale row pin the embedder paused.
  if (updatedAt === 0 || (now - updatedAt) > staleTtlMs) return false;
  const lastActive = Number(signal?.lastChatAppActiveAt) || 0;
  if (lastActive === 0) return false; // no app-active ping ever seen this session
  return (now - lastActive) < windowMs;
}

// ──────────────────────────────────────────────────────────────────────────────
// Chat-yield gate for detached heavy children (st_fd14cdd4 integration-self-reg)
// ──────────────────────────────────────────────────────────────────────────────
//
// WHY this helper exists (the spike this fix kills): the chunk-embed-daemon and
// the supervisor-maintenance-worker each YIELD to chat in their own long-lived
// loop, but the DETACHED children they (or launchd) spawn — chunk-embed-worker.js
// (the launchd-fired chunk-scan + entity-enrich drain) and build-global-hnsw.js
// (the 10–30 min global-index rebuild) — were spawned `detached:true` + .unref(),
// so the chat-app-active SIGTERM path could not reach them. Each ran a long
// CPU-bound loop with ZERO chat awareness; an additive-budget measurement
// attributed the worst-case warm-turn spikes (a 19–32s chunk-embed-worker drain;
// a 16.9s first-turn during an HNSW rebuild) to exactly these children stealing
// the CPU the chat process's local embed + retrieval needs. They cannot be
// SIGTERM'd externally, so they must SELF-YIELD: between work units, read the
// cross-process server_activity row and PAUSE while the chat app is open.
//
// This is the shared seam, extracted (vs. duplicated into 2 children) so the
// drop-and-pause behavior has ONE definition. It mirrors the maintenance
// worker's waitForQuiet() but gates on chatAppActiveDecision — the BROADEST,
// earliest "a human has chat open right now" signal (stamped on app load/focus/
// heartbeat, not only on submit) — so a heavy child drops within ~1 poll of the
// app opening, BEFORE the user finishes typing. A stale/dead-server row reads as
// "not active" (chatAppActiveDecision's stale guard), so a stopped server can
// never pin a child paused forever.

// Poll cadence while paused for chat. Short enough that a child resumes within
// ~one poll of the app closing (the CHAT_APP_ACTIVE_WINDOW_MS lapse), and that a
// child yields within ~one poll of the app opening when checked at a unit
// boundary. 500ms matches the maintenance worker's PAUSE_POLL_MS.
export const CHAT_YIELD_POLL_MS = positiveEnvInt('ROBOTDOJO_CHAT_YIELD_POLL_MS', 500);

/**
 * Block (async sleep-poll) while the chat app is open, returning once it closes
 * or the abort signal fires. The caller invokes this at a SAFE UNIT BOUNDARY in
 * a heavy detached child (between job batches, between HNSW slices) so the child
 * pauses its next CPU-bound unit while a human is chatting and resumes the moment
 * the app closes — without ever being externally signalled.
 *
 * Pure-ish: the only IO is the cross-process getActivitySignal row read and the
 * sleep. The decision is chatAppActiveDecision, so the stale/dead-server guard is
 * shared with the embedder — a stopped server's stale row is never "active".
 *
 * @param {object} db better-sqlite3 connection (read-only here — row SELECT)
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] aborts the wait immediately on SIGTERM
 * @param {number} [opts.pollMs] poll cadence while paused
 * @param {(reason:string)=>void} [opts.onPause] called once when the wait first parks (for a log line)
 * @param {(reason:string)=>void} [opts.onResume] called once when the wait releases after having paused
 * @param {string[]} [opts.ignoreEmbedPauseHoldReasons] hold reasons owned by
 *   the caller and safe to ignore for this wait
 * @returns {Promise<boolean>} true if released because chat is closed (proceed),
 *   false if released because the signal aborted (the caller should stop).
 */
export async function waitWhileChatAppActive(db, {
  signal = null,
  pollMs = CHAT_YIELD_POLL_MS,
  onPause = null,
  onResume = null,
  ignoreEmbedPauseHoldReasons = [],
} = {}) {
  let paused = false;
  const ignoredHoldReasons = new Set(ignoreEmbedPauseHoldReasons);
  while (!signal?.aborted) {
    const hold = readEmbedPauseHold();
    const holdActive = hold.active && !ignoredHoldReasons.has(hold.reason);
    const active = holdActive || chatAppActiveDecision(getActivitySignal(db));
    if (!active) {
      if (paused && typeof onResume === 'function') {
        try { onResume('chat-app closed / pause hold released'); } catch { /* never break the child on a log */ }
      }
      return true; // chat closed (or never opened) — safe to do the next unit
    }
    if (!paused) {
      paused = true;
      if (typeof onPause === 'function') {
        try { onPause(holdActive ? hold.reason : 'chat-app open'); } catch { /* never break the child on a log */ }
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false; // aborted
}

/**
 * Pure decision function: given a signal and the current time, should the
 * embedder pause? Pulled out so the daemon and its tests share one truth.
 *
 *   - in_flight > 0 with a FRESH row → pause (a request is mid-flight).
 *   - last request finished < ACTIVITY_PAUSE_MS ago → pause (user just acted).
 *   - row older than the stale TTL → never pause (dead server; ignore it).
 *
 * @param {{inFlight:number, lastRequestAt:number, updatedAt:number}} signal
 * @param {object} [opts]
 * @param {number} [opts.now] epoch ms
 * @param {number} [opts.pauseMs]
 * @param {number} [opts.staleTtlMs]
 * @returns {{pause:boolean, reason:string}}
 */
export function activityPauseDecision(signal, {
  now = Date.now(),
  pauseMs = ACTIVITY_PAUSE_MS,
  staleTtlMs = ACTIVITY_STALE_TTL_MS,
} = {}) {
  const updatedAt = Number(signal?.updatedAt) || 0;
  const stale = updatedAt === 0 || (now - updatedAt) > staleTtlMs;
  // A stale/dead-server row is ignored entirely — neither in-flight nor recency
  // can pause the embedder once the server has gone quiet past the TTL.
  if (stale) return { pause: false, reason: 'stale' };
  if ((Number(signal?.inFlight) || 0) > 0) return { pause: true, reason: 'in-flight' };
  const lastRequestAt = Number(signal?.lastRequestAt) || 0;
  if (lastRequestAt > 0 && (now - lastRequestAt) < pauseMs) {
    return { pause: true, reason: 'recent-request' };
  }
  return { pause: false, reason: 'quiet' };
}
