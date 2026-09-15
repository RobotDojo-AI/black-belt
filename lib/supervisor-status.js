/**
 * lib/supervisor-status.js — st_2cd1af73 AC-1.
 *
 * Cross-process channel for the maintenance worker's results. The worker
 * (scripts/supervisor-maintenance-worker.mjs) is a SEPARATE process; the server
 * cannot read its in-memory state. Before st_2cd1af73, getLastCheckpointResult()
 * and getCachedDeepHealth() returned module-local memory written by the
 * IN-PROCESS supervisor tick. Now that the heavy checkpoint + deep-health work
 * runs off-process, those results must cross the process boundary.
 *
 * This is the cheapest correct IPC for it — the same single-row UPDATE-in-place
 * pattern as `server_activity` (lib/request-observer.js): one row, never grows.
 * The worker writes; the server reads. A read is one indexed point lookup over a
 * one-row table — sub-millisecond, no scan, no decrypt cost worth measuring — so
 * the server's /api/server-health stays off any heavy path.
 *
 * The server side ALSO caches the read in process memory (READ_CACHE_TTL_MS) so
 * a burst of /api/server-health hits collapses to one DB read every TTL. The
 * cache is a pure latency optimization; the values are already eventually-
 * consistent (the worker refreshes every ~15s), so a sub-second stale read is
 * within the same fidelity bar the in-process version had.
 *
 * INTELLIGENCE_TIER: extraction — deterministic single-row reads/writes; no LLM.
 */
export const INTELLIGENCE_TIER = 'extraction';

import dbDefault from './db.js';

const ROW_ID = 1;
// Passive/session-log summaries are status surfaces, not foreground data-plane
// truth. Serve a visibly-aged worker summary during active launch use instead
// of forcing the server thread to rebuild it from the large passive_jobs table.
const DEFAULT_SUMMARY_STALE_MS = Number(process.env.ROBOTDOJO_SUPERVISOR_SUMMARY_STALE_MS || 15 * 60_000);

// Prepared-statement cache keyed by connection (server + worker pass their own).
const stmtCache = new WeakMap();
function stmts(db) {
  let s = stmtCache.get(db);
  if (s) return s;
  s = {
    read: db.prepare(`
      SELECT checkpoint_busy, checkpoint_log, checkpointed, checkpoint_ts,
             deep_health_json, deep_health_duration_ms, deep_health_ts,
             passive_summary_json, passive_summary_ts,
             session_log_summary_json, session_log_summary_ts, heartbeat_ts,
             api_healthy, last_ok_latency_ms, api_health_ts
        FROM supervisor_status WHERE id = ${ROW_ID}
    `),
    writeApiHealth: db.prepare(`
      UPDATE supervisor_status
         SET api_healthy = ?, last_ok_latency_ms = ?, api_health_ts = ?,
             heartbeat_ts = ?
       WHERE id = ${ROW_ID}
    `),
    writeSummaries: db.prepare(`
      UPDATE supervisor_status
         SET passive_summary_json = ?, passive_summary_ts = ?,
             session_log_summary_json = ?, session_log_summary_ts = ?,
             heartbeat_ts = ?
       WHERE id = ${ROW_ID}
    `),
    writeCheckpoint: db.prepare(`
      UPDATE supervisor_status
         SET checkpoint_busy = ?, checkpoint_log = ?, checkpointed = ?, checkpoint_ts = ?,
             heartbeat_ts = ?
       WHERE id = ${ROW_ID}
    `),
    writeDeepHealth: db.prepare(`
      UPDATE supervisor_status
         SET deep_health_json = ?, deep_health_duration_ms = ?, deep_health_ts = ?,
             heartbeat_ts = ?
       WHERE id = ${ROW_ID}
    `),
    writeHeartbeat: db.prepare(`
      UPDATE supervisor_status SET heartbeat_ts = ? WHERE id = ${ROW_ID}
    `),
  };
  stmtCache.set(db, s);
  return s;
}

/**
 * Worker → write the latest PASSIVE checkpoint result. Best-effort: a write
 * failure must never crash the worker's loop.
 * @param {object} db worker's connection
 * @param {{busy:number, log:number, checkpointed:number}} result
 */
export function writeSupervisorCheckpoint(db, { busy, log, checkpointed } = {}) {
  const now = Date.now();
  try {
    stmts(db).writeCheckpoint.run(
      Number(busy) || 0, Number(log) || 0, Number(checkpointed) || 0, now, now,
    );
  } catch { /* status IPC must never break the worker */ }
}

/**
 * Worker → write the latest deep-health (integrity) scan result.
 * @param {object} db worker's connection
 * @param {{value:object, durationMs:number}} result
 */
export function writeSupervisorDeepHealth(db, { value, durationMs } = {}) {
  const now = Date.now();
  try {
    stmts(db).writeDeepHealth.run(
      JSON.stringify(value ?? null), Number(durationMs) || 0, now, now,
    );
  } catch { /* best-effort */ }
}

/** Worker → stamp liveness so the server can detect a dead worker. */
export function writeSupervisorHeartbeat(db) {
  try { stmts(db).writeHeartbeat.run(Date.now()); }
  catch { /* best-effort */ }
}

/**
 * Worker → publish the Anthropic API health signal (st_db4b3118). The maintenance
 * worker derives this from the warmup ping log (3 consecutive sub-1500ms `ok`
 * lines = healthy) and writes it here so any process — the AM cert flow, a future
 * gate, anything — reads one cheap row instead of re-parsing the log. Best-effort:
 * a write failure must never crash the worker loop.
 * @param {object} db worker's connection
 * @param {{healthy:boolean, lastOkLatencyMs:number}} signal
 */
export function writeSupervisorApiHealth(db, { healthy, lastOkLatencyMs } = {}) {
  const now = Date.now();
  try {
    stmts(db).writeApiHealth.run(
      healthy ? 1 : 0, Math.max(0, Number(lastOkLatencyMs) || 0), now, now,
    );
  } catch { /* status IPC must never break the worker */ }
}

/**
 * Worker → write the passive-jobs summary + session-log queue summary the
 * server-health body needs. The worker computes these on its own connection so
 * the SERVER thread never runs the aggregate scans (which decrypt last_error
 * overflow pages and cost seconds when the WAL is large). Best-effort.
 * @param {object} db worker's connection
 * @param {{passiveSummary:object, sessionLogSummary:object}} summaries
 */
export function writeSupervisorSummaries(db, { passiveSummary, sessionLogSummary } = {}) {
  const now = Date.now();
  try {
    stmts(db).writeSummaries.run(
      passiveSummary == null ? null : JSON.stringify(passiveSummary),
      passiveSummary == null ? 0 : now,
      sessionLogSummary == null ? null : JSON.stringify(sessionLogSummary),
      sessionLogSummary == null ? 0 : now,
      now,
    );
  } catch { /* best-effort */ }
}

// ─── Server-side cached reads ────────────────────────────────────────────────
// One DB read per TTL collapses a burst of /api/server-health hits. Pure latency
// optimization; values are eventually-consistent regardless.
const READ_CACHE_TTL_MS = Number(process.env.ROBOTDOJO_SUPERVISOR_STATUS_CACHE_MS || 2_000);
let _cache = null; // { row, at }

function readRowCached(db) {
  const now = Date.now();
  if (_cache && now - _cache.at < READ_CACHE_TTL_MS) return _cache.row;
  let row = null;
  try { row = stmts(db).read.get() || null; } catch { row = null; }
  _cache = { row, at: now };
  return row;
}

/**
 * Server → last PASSIVE checkpoint result, in the shape the server-health body
 * builder already consumes: { busy, log, checkpointed, ts } | null. `ts` is an
 * epoch-ms (matching the prior in-process getLastCheckpointResult() contract).
 * Returns null until the worker has checkpointed at least once.
 * @param {object} [db]
 */
export function readSupervisorCheckpoint(db = dbDefault) {
  const row = readRowCached(db);
  if (!row || !row.checkpoint_ts) return null;
  return {
    busy: row.checkpoint_busy,
    log: row.checkpoint_log,
    checkpointed: row.checkpointed,
    ts: row.checkpoint_ts,
  };
}

/**
 * Server → last deep-health result in the prior getCachedDeepHealth() shape:
 * { value, generated_at, duration_ms } | null. Returns null until the worker has
 * run a deep scan at least once.
 * @param {object} [db]
 */
export function readSupervisorDeepHealth(db = dbDefault) {
  const row = readRowCached(db);
  if (!row || !row.deep_health_ts || !row.deep_health_json) return null;
  let value = null;
  try { value = JSON.parse(row.deep_health_json); } catch { value = null; }
  if (value == null) return null;
  return { value, generated_at: row.deep_health_ts, duration_ms: row.deep_health_duration_ms };
}

/**
 * Server → the worker-computed passive-jobs summary, or null if the worker has
 * not written one yet (first ~15s after boot). Same shape getPassiveJobSummary
 * returns. The `_age_ms` field is attached so the caller can decide if it is too
 * stale to serve (the server-health body falls back to a warming stub if so).
 * @param {object} [db]
 * @param {object} [opts]
 */
export function readSupervisorPassiveSummary(db = dbDefault, { now = Date.now(), staleMs = DEFAULT_SUMMARY_STALE_MS } = {}) {
  const row = readRowCached(db);
  if (!row || !row.passive_summary_ts || !row.passive_summary_json) return null;
  const ageMs = now - row.passive_summary_ts;
  if (Number.isFinite(staleMs) && staleMs >= 0 && ageMs > staleMs) return null;
  let value = null;
  try { value = JSON.parse(row.passive_summary_json); } catch { return null; }
  if (value == null) return null;
  return { ...value, _age_ms: ageMs };
}

/**
 * Server → the worker-computed session-log queue summary, or null if not yet
 * written. Mirrors getSessionLogQueueStatus()'s shape.
 * @param {object} [db]
 * @param {object} [opts]
 */
export function readSupervisorSessionLogSummary(db = dbDefault, { now = Date.now(), staleMs = DEFAULT_SUMMARY_STALE_MS } = {}) {
  const row = readRowCached(db);
  if (!row || !row.session_log_summary_ts || !row.session_log_summary_json) return null;
  const ageMs = now - row.session_log_summary_ts;
  if (Number.isFinite(staleMs) && staleMs >= 0 && ageMs > staleMs) return null;
  let value = null;
  try { value = JSON.parse(row.session_log_summary_json); } catch { return null; }
  if (value == null) return null;
  return { ...value, _age_ms: ageMs };
}

/**
 * Server → worker liveness check. Returns { alive, heartbeat_ts, age_ms }.
 * `alive` is true when the heartbeat is fresher than staleMs (default 90s — 6×
 * the worker's 15s tick, so a momentarily slow drain never reads as dead).
 * @param {object} [opts]
 */
export function readSupervisorHeartbeat(db = dbDefault, { now = Date.now(), staleMs = 90_000 } = {}) {
  const row = readRowCached(db);
  const hb = row?.heartbeat_ts || 0;
  return { alive: hb > 0 && (now - hb) < staleMs, heartbeat_ts: hb || null, age_ms: hb ? now - hb : null };
}

/**
 * Consumer → the published Anthropic API health signal (st_db4b3118):
 * { healthy, last_ok_latency_ms, ts, age_ms } | null when never published.
 * `healthy` is treated as STALE-false if the signal is older than staleMs
 * (default 6 min — the worker republishes every ~15s, so a stale row means the
 * worker is down and "healthy" can no longer be trusted).
 * @param {object} [db]
 * @param {object} [opts]
 */
export function readSupervisorApiHealth(db = dbDefault, { now = Date.now(), staleMs = 6 * 60_000 } = {}) {
  const row = readRowCached(db);
  if (!row || !row.api_health_ts) return null;
  const ageMs = now - row.api_health_ts;
  const fresh = ageMs < staleMs;
  return {
    healthy: fresh && row.api_healthy === 1,
    last_ok_latency_ms: row.last_ok_latency_ms || 0,
    ts: row.api_health_ts,
    age_ms: ageMs,
    stale: !fresh,
  };
}

/** Test helper: clear the read cache so a test sees a fresh DB read. */
export function _resetStatusCacheForTest() { _cache = null; }
