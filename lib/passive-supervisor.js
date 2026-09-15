/**
 * lib/passive-supervisor.js — st_27561b77 P3/P4/P6, st_2cd1af73 AC-1.
 *
 * The in-process supervisor. After st_2cd1af73 it is a THIN MAIN-THREAD
 * COORDINATOR: it spawns and supervises an off-process maintenance worker and
 * does only lightweight, bounded bookkeeping. The heavy work — the passive-job
 * drain (maintenance routines + email_history_backfill), the PASSIVE WAL
 * checkpoint, and the deep-health integrity scan — runs in
 * scripts/supervisor-maintenance-worker.mjs, NOT here.
 *
 * WHY this changed (the bug st_2cd1af73 AC-1 fixes): st_27561b77 ran
 * drainPassiveJobs + passiveCheckpoint + checkDbHealth({deep:true}) INSIDE this
 * module's supervisorTick on the server's main thread, every ~15s. The drain's
 * synchronous SQL plus the PASSIVE checkpoint's SQLCipher per-page AES decrypt
 * over a 7GB DB starved the Node event loop for measured blocks of 12–17s at the
 * tick cadence — every chat turn froze, and even /api/server-health (zero DB
 * work) hung. The codebase had already moved embedding off-process (the
 * chunk-embed daemon); this completes the same move for the supervisor's heavy
 * work. The main thread now MAY ONLY enqueue/signal/read status — it never
 * executes a job handler or a checkpoint.
 *
 * What still runs ON the main thread (all bounded ≤50ms; a self-check log warns
 * if any step exceeds that):
 *
 *   1. maintenanceRoutineProbe (one-shot on start + every MAINT_PROBE_MS):
 *      ONE batched freshness SELECT + keyed upserts that ENQUEUE every
 *      maintenance routine whose freshness window has lapsed
 *      (lib/maintenance-routines.js) plus email_history_backfill per
 *      backfill-declaring integration (lib/integration-registry.js). This is the
 *      queue the off-process worker drains; it is cheap (one scan, no checkpoint)
 *      and stays in-process so a restarted server re-seeds stale routines within
 *      one probe tick. st_fd14cdd4 AC8: this REPLACED the hardcoded NIGHTLY_TYPES
 *      seed list — scheduling is freshness, not calendars; nothing waits for 9 PM.
 *
 *      st_fd14cdd4 AC9 (final layer) — the probe YIELDS to chat exactly like the
 *      off-process embed daemon + maintenance worker. It (a) returns early when a
 *      chat turn is active (request-observer.js activityPauseDecision); (b) reads
 *      freshness for all routines in ONE GROUP BY instead of one point SELECT per
 *      routine; and (c) lowers its OWN busy_timeout for the probe so a contended
 *      writer surfaces SQLITE_BUSY fast and the tick defers (next tick re-seeds)
 *      rather than parking the main thread on the global 30s lock wait. WHY this
 *      matters: before this layer, an unguarded probe on the main thread waited up
 *      to 30s PER statement under embedder/worker writer contention; the compounded
 *      statements produced measured 18–70s main-thread stalls that froze every chat
 *      turn (the residual "12–70s spikes"). The yield contract closes that gap.
 *
 *   2. Summary pre-warm + /api/server-health body precompute (every
 *      SUMMARY_REFRESH_MS): uses the YIELDING getPassiveJobSummaryAsync variant
 *      (setImmediate between each aggregate scan), so no single sync chunk
 *      exceeds the event-loop ceiling. Keeps the foreground request always
 *      hitting a warm cache.
 *
 *   3. Maintenance-worker lifecycle: spawn once on start; respawn on exit
 *      (KeepAlive-equivalent) with a small backoff. The server is the worker's
 *      supervisor, so a crashed worker restarts and its leased jobs lease-recover
 *      exactly as they already do.
 *
 * The checkpoint + deep-health RESULTS the worker produces are read back from
 * the supervisor_status row (lib/supervisor-status.js) so /api/server-health
 * keeps its WAL + integrity fields with zero heavy main-thread work.
 */

import { execFileSync, spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readFileSync, unlinkSync } from 'node:fs';
import db from './db.js';
import { enqueuePassiveJob, _isBusyErrorForTest as isBusyError } from './passive-jobs.js';
import { maintSliceSecondsFor, maintTimeoutMsFor } from './passive-maintenance-handlers.js';
import { ROUTINES } from './maintenance-routines.js';
import { historyBackfillEntries, historySweepEntries } from './integration-registry.js';
import { getActivitySignal, activityPauseDecision } from './request-observer.js';
import { readEmbedPauseHold } from './embed-pause-hold.js';
import {
  readSupervisorCheckpoint,
  readSupervisorDeepHealth,
  readSupervisorHeartbeat,
} from './supervisor-status.js';

// All tunable values come from env vars with safe defaults.
const TICK_MS = Number(process.env.ROBOTDOJO_SUPERVISOR_TICK_MS || 15_000);
// Routine freshness probe cadence. Must sit comfortably under the smallest
// freshness window in lib/maintenance-routines.js (pipeline_ingest, 15 min)
// or that routine's floor silently stretches to the probe interval.
const MAINT_PROBE_MS = Number(process.env.ROBOTDOJO_MAINT_PROBE_MS || 5 * 60_000); // 5 min
// A routine probe is idempotent catch-up work. It must not run immediately after
// launch or in the gaps between foreground requests; login/chat own that window.
const MAINT_PROBE_BOOT_GRACE_MS = Number(process.env.ROBOTDOJO_MAINT_PROBE_BOOT_GRACE_MS || 15 * 60_000);
const MAINT_PROBE_QUIET_MS = Number(process.env.ROBOTDOJO_MAINT_PROBE_QUIET_MS || 15 * 60_000);
// Start the worker after the foreground launch window. Even its "read-only"
// summary publication can be CPU-heavy on a large SQLCipher DB, so first login
// and first chat get the machine before maintenance does. Operators can shorten
// this with ROBOTDOJO_MAINT_WORKER_START_DELAY_MS when explicitly running an
// unattended backfill window.
const MAINT_WORKER_START_DELAY_MS = Number(
  process.env.ROBOTDOJO_MAINT_WORKER_START_DELAY_MS
  || process.env.ROBOTDOJO_MAINT_WORKER_BOOT_GRACE_MS
  || 15 * 60_000,
);
// Summary pre-warm interval — refreshes the passive-jobs summary + server-health
// body caches on its own timer. Must be well below SUMMARY_CACHE_TTL_MS (30s).
const SUMMARY_REFRESH_MS = Number(process.env.ROBOTDOJO_SUMMARY_REFRESH_MS || 10_000);
// st_2cd1af73 AC-1 — self-check ceiling. Any supervisor-owned MAIN-THREAD step
// taking longer than this is a regression of the off-thread contract; we log a
// warning so it is visible. Env-overridable for a slower box.
const MAIN_THREAD_BUDGET_MS = Number(process.env.ROBOTDOJO_SUPERVISOR_MAIN_BUDGET_MS || 50);
// Maintenance-worker respawn backoff after an exit. Bounded so a crash-looping
// worker does not spin the CPU, short enough that recovery is quick.
const WORKER_RESPAWN_MS = Number(process.env.ROBOTDOJO_MAINT_RESPAWN_MS || 3_000);
const WORKER_HOLD_RESPAWN_MS = Number(process.env.ROBOTDOJO_MAINT_HOLD_RESPAWN_MS || 60_000);
const WORKER_ORPHAN_TERM_WAIT_MS = Number(process.env.ROBOTDOJO_MAINT_ORPHAN_TERM_WAIT_MS || 1_500);
const WORKER_ORPHAN_KILL_WAIT_MS = Number(process.env.ROBOTDOJO_MAINT_ORPHAN_KILL_WAIT_MS || 500);
// st_fd14cdd4 AC9 (final layer) — lock-wait cap for the routine probe's
// SELECT + enqueue statements ONLY. The server's global connection keeps
// busy_timeout=30000 (db.js) so a foreground chat write waits out a transient
// lock — but the probe is idempotent catch-up work that must YIELD to chat, not
// block the main thread on it. Under embedder/worker writer contention the old
// probe waited up to the full 30s PER statement (39 statements compounded to the
// measured 18–70s main-thread stalls that froze chat). We lower busy_timeout to
// this value around the probe and restore it immediately after, mirroring the
// activity-flush discipline in request-observer.js: a contended writer surfaces
// SQLITE_BUSY in ≤this window and the probe defers (next tick re-seeds) instead
// of parking the event loop.
//
// Set to 100ms: the enqueue batch is idempotent catch-up seeding that the next
// tick re-runs, so a tight cap costs nothing and bounds the common write-write
// contention case to ~100ms. RESIDUAL (measured, honest): the embed daemon's
// periodic wal_checkpoint(TRUNCATE) takes a BRIEF EXCLUSIVE lock on the 13GB DB
// that the probe's BEGIN IMMEDIATE must wait out in full — busy_timeout caps the
// poll interval, not a peer's continuous hold — so a tick that collides with a
// TRUNCATE can still take ~1.7s (measured). That residual lands ONLY in chat-
// quiet windows: the activity gate defers the entire tick whenever a chat turn is
// in flight or finished <ACTIVITY_PAUSE_MS ago, so the collision never sits on a
// user's chat latency. Fully closing it would mean moving the seed enqueue off
// the main thread into the worker (a larger seam, deferred).
const PROBE_BUSY_TIMEOUT_MS = Number(process.env.ROBOTDOJO_MAINT_PROBE_BUSY_MS || 100);

// st_fd14cdd4 AC9 (final layer) — the distinct routine job types, computed once.
// The freshness scan MUST be scoped to these types. WHY (the measured root cause
// of the 2.4s scan): the passive_jobs `default` queue is shared with
// session_log_turn, whose done-history was ~25k rows on the live DB — an
// unscoped GROUP BY decrypted every one of them on the 13GB SQLCipher DB (2396ms
// measured). The freshness decision only consults the ~20 ROUTINE identities, so
// `job_type IN (these)` turns the scan into an index seek per type (0.2ms
// measured). The per-account backfill/sweep enqueues do NOT consult freshness
// (they rely on enqueuePassiveJob's no-revive-when-done), so they need not be in
// this set. Frozen so the prepared SQL placeholder count is stable per process.
const ROUTINE_FRESHNESS_TYPES = Object.freeze([...new Set(ROUTINES.map((r) => r.jobType))]);
const ROUTINE_TYPE_PLACEHOLDERS = ROUTINE_FRESHNESS_TYPES.map(() => '?').join(', ');

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MAINT_WORKER_SCRIPT = resolve(SCRIPT_DIR, '..', 'scripts', 'supervisor-maintenance-worker.mjs');
const STATE_DIR = process.env.ROBOTDOJO_STATE_DIR || resolve(homedir(), '.robotdojo');
const MAINT_LOCK = process.env.ROBOTDOJO_MAINT_LOCK || resolve(STATE_DIR, 'supervisor-maintenance.lock');

let timers = { maintProbe: null, summary: null };
let supervisorStarted = false;
let maintChild = null;
let maintSpawnTimer = null;
let maintRespawnTimer = null;
let stopping = false;
let lastPostDrainHoldLogAt = 0;

function activePostDrainHold() {
  try {
    const hold = readEmbedPauseHold({ maxCacheMs: 0 });
    return hold?.active && hold.reason === 'post_drain_pipeline_sole_writer' ? hold : null;
  } catch {
    return null;
  }
}

function logPostDrainHoldOnce(message) {
  const now = Date.now();
  if (now - lastPostDrainHoldLogAt > 60_000) {
    lastPostDrainHoldLogAt = now;
    console.info(message);
  }
}

/**
 * st_2cd1af73 AC-1 — run a main-thread step and warn if it blows the budget.
 * The supervisor must not block the event loop; this names any step that does.
 */
function withMainThreadBudget(label, fn) {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const dt = performance.now() - t0;
    if (dt > MAIN_THREAD_BUDGET_MS) {
      console.warn(`[supervisor] STOP-THE-LINE: main-thread step '${label}' took ${dt.toFixed(0)}ms > ${MAIN_THREAD_BUDGET_MS}ms budget — must run off-thread`);
    }
  }
}

/**
 * st_2cd1af73 AC-1 — last PASSIVE checkpoint result, read from the off-process
 * worker's status row. Shape: { busy, log, checkpointed, ts } | null. The
 * /api/server-health?deep=1 handler reads `log` (WAL frame count) and
 * `checkpointed` from this. Null until the worker checkpoints at least once.
 */
export function getLastCheckpointResult() {
  return readSupervisorCheckpoint(db);
}

/**
 * st_2cd1af73 AC-1 — cached deep-health (integrity) result, read from the
 * off-process worker's status row. Shape: { value, generated_at, duration_ms } |
 * null. Null until the worker runs a deep scan at least once.
 */
export function getCachedDeepHealth() {
  return readSupervisorDeepHealth(db);
}

/** st_2cd1af73 AC-1 — maintenance-worker liveness for ops/health surfaces. */
export function getMaintenanceWorkerHealth() {
  return readSupervisorHeartbeat(db);
}

// st_fd14cdd4 AC8 — freshness seeding, not calendars. For every routine in
// lib/maintenance-routines.js: enqueue when its newest done/queued row is
// older than its freshness window. The slice budget rides on the job payload
// so the off-process handler can re-pass it to maintenance-phases.js without
// looking up env again; budgets come from the shared handlers module so the
// enqueue side and the drain side agree on one number.
//
// A queued/running row counts as fresh (never double-enqueue). A quarantined
// DECLARED routine is stale and revives here: these rows are deterministic
// projections from the maintenance schedule, so a timeout or worker death must
// not strand the pipeline until an operator notices. Connector/account history
// jobs stay terminal because they are not in ROUTINES. The freshness check uses
// finished_at because routine rows are keyed (one row per routine identity,
// recycled by requeueDone/requeueQuarantined): created_at never changes after
// the first enqueue.
function maintenanceRoutineProbe({ ignoreActivity = false } = {}) {
  const t0 = performance.now();

  if (!ignoreActivity && activePostDrainHold()) {
    logPostDrainHoldOnce('[supervisor] post-drain writer hold active — maintenance routine probe deferred');
    return { skipped: true, reason: 'post-drain-writer-hold' };
  }

  // st_fd14cdd4 AC9 (final layer) — ACTIVITY GATE. The probe yields to chat
  // exactly like the off-process embed daemon and maintenance worker do
  // (request-observer.js activityPauseDecision). WHY: the probe runs on the
  // server's MAIN THREAD; a chat turn in flight (or one that finished <1.5s ago)
  // means any writer contention here lands directly on the latency the user
  // sees. Deferring a probe tick is harmless — the probe is idempotent stale-
  // routine seeding on a 5-min cadence, and the off-process worker carries its
  // OWN freshness backstop, so a skipped tick re-seeds at the next quiet probe.
  // This is the missing yield contract that the prior fixes installed in the
  // embed lanes but not here. Skipping returns early WITHOUT touching the writer.
  if (!ignoreActivity) {
    try {
      const decision = activityPauseDecision(getActivitySignal(db), { pauseMs: MAINT_PROBE_QUIET_MS });
      if (decision.pause) {
        return { skipped: true, reason: decision.reason };
      }
    } catch {
      // A signal-read failure reads as "quiet" (safe-fail toward letting the
      // probe run) — the probe's own lock-tolerance below still protects chat.
    }
  }

  // st_fd14cdd4 AC9 (final layer) — LOCK-TOLERANT, MAIN-THREAD-SAFE writer use.
  // Lower THIS connection's busy_timeout to PROBE_BUSY_TIMEOUT_MS for the probe's
  // duration so a contended writer surfaces SQLITE_BUSY fast instead of parking
  // the event loop for up to the global 30s, then restore it in finally. Each
  // enqueue is wrapped so a busy lock DEFERS that one routine (next tick re-seeds)
  // rather than throwing the whole probe to the catch — partial progress under
  // contention beats all-or-nothing. Non-busy errors still surface.
  let prevTimeout;
  let deferred = 0;
  let enqueued = 0;
  let revivedPartial = 0;
  let scanMs = 0;       // freshness-scan wall time (phase instrumentation)
  let enqueueMs = 0;    // enqueue-flush wall time (phase instrumentation)
  // st_fd14cdd4 AC9 (final layer) — collect the stale-routine enqueue arg sets
  // here and flush them in ONE IMMEDIATE transaction (flushEnqueues). WHY a
  // single transaction, not one enqueue at a time: each enqueuePassiveJob is its
  // own implicit transaction, so N stale routines were N separate writer
  // acquisitions. Under the embedder's bursty writer holds the live probe waited
  // a fresh ~busy_timeout window PER enqueue and compounded to a measured 11.8s
  // main-thread block (phase log: enqueue=11809ms for 5 routines). Batching makes
  // it ONE acquisition: if the writer is free the whole batch commits in ~1ms; if
  // busy, the batch defers in a SINGLE ≤busy_timeout wait (SQLITE_BUSY → next tick
  // re-seeds), never N waits. This is the SQLite-correct shape for a main-thread
  // writer that must yield to chat.
  const pending = [];
  const enqueueLockTolerant = (args) => { pending.push(args); };

  try {
    try { prevTimeout = db.pragma('busy_timeout', { simple: true }); } catch { prevTimeout = undefined; }
    try { db.pragma(`busy_timeout = ${PROBE_BUSY_TIMEOUT_MS}`); } catch { /* keep going at the existing timeout */ }
    const scan0 = performance.now();

    // st_fd14cdd4 AC9 (final layer) — BOUNDED FRESHNESS in ONE SCOPED query.
    // The old probe ran one indexed SELECT PER routine (one round-trip each),
    // each decrypting passive_jobs index pages on the 13GB SQLCipher DB. Collapse
    // to a single GROUP BY — SCOPED TO THE ROUTINE TYPES (job_type IN …) — that
    // returns, per (job_type, target_id), the newest finished_at among done rows
    // and whether any queued/running row exists. A routine is FRESH when it has a
    // queued/running row OR a done row newer than its window; the per-routine
    // decision is then a pure in-memory Map lookup. The IN-scope is the load-
    // bearing bound: without it the GROUP BY walks the ~25k session_log_turn
    // done-history that shares the queue (2396ms measured on the live DB); with
    // it the scan is an index seek over the ~20 routine identities (0.2ms).
    const freshnessRows = db.prepare(`
      SELECT job_type,
             target_id,
             MAX(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS has_open,
             MAX(CASE WHEN status = 'done' THEN COALESCE(finished_at, updated_at) END) AS newest_done
        FROM passive_jobs
       WHERE queue = 'default'
         AND status IN ('queued','running','done')
         AND job_type IN (${ROUTINE_TYPE_PLACEHOLDERS})
       GROUP BY job_type, target_id
    `).all(...ROUTINE_FRESHNESS_TYPES);
    scanMs = performance.now() - scan0;
    const freshness = new Map();
    for (const r of freshnessRows) {
      freshness.set(`${r.job_type}|${r.target_id}`, {
        hasOpen: r.has_open === 1,
        newestDone: r.newest_done || null,
      });
    }
    const hasPartialDone = db.prepare(`
      SELECT 1
        FROM passive_jobs
       WHERE queue = 'default'
         AND status = 'done'
         AND job_type IN (${ROUTINE_TYPE_PLACEHOLDERS})
         AND (metadata LIKE '%"partial":true%' OR metadata LIKE '%"lockSkipped":true%')
       LIMIT 1
    `).get(...ROUTINE_FRESHNESS_TYPES);
    // A routine identity is fresh if it has an open (queued/running) row, or its
    // newest done row is at/after the cutoff for its freshness window.
    const isFresh = (jobType, targetId, cutoffIso) => {
      const state = freshness.get(`${jobType}|${targetId}`);
      if (!state) return false;
      if (state.hasOpen) return true;
      return state.newestDone != null && state.newestDone >= cutoffIso;
    };
    const shouldReviveTimedOutQuarantine = (uniqueKey) => {
      try {
        const row = db.prepare(`
          SELECT status, last_error, quarantine_reason
            FROM passive_jobs
           WHERE unique_key = ?
           LIMIT 1
        `).get(uniqueKey);
        if (!row || row.status !== 'quarantined') return false;
        return /ETIMEDOUT|timed out/i.test(`${row.last_error || ''}\n${row.quarantine_reason || ''}`);
      } catch {
        return false;
      }
    };

    for (const routine of ROUTINES) {
      const targetId = routine.targetId || 'maintenance';
      const cutoffIso = new Date(Date.now() - routine.freshnessMinutes * 60_000).toISOString();
      if (isFresh(routine.jobType, targetId, cutoffIso)) continue;
      enqueueLockTolerant({
        jobType: routine.jobType,
        targetType: 'system',
        targetId,
        priority: routine.priority,
        timeoutMs: maintTimeoutMsFor(routine),
        payload: {
          ...(routine.payload || {}),
          ...(routine.phase ? { phase: routine.phase } : {}),
          maxSeconds: maintSliceSecondsFor(routine),
        },
        metadata: { source: 'supervisor-routine-probe' },
        requeueDone: true,
        requeueQuarantined: true,
      }, routine.jobType);
    }
    // Email history backfill: one job per active account of every integration
    // that DECLARES a history backfill in lib/integration-registry.js
    // (st_fd14cdd4 — derived, not hardcoded-Google; adding outlook history
    // later is a descriptor field + handler, no supervisor edit).
    const activeAccountEmails = (vendor, accountType) => {
      try {
        return db.prepare(`
          SELECT DISTINCT email FROM accounts
           WHERE vendor=?
             AND type=?
             AND status IN ('active', 'connected')
             AND email IS NOT NULL
             AND email != ''
        `).all(vendor, accountType)
          .map((row) => String(row.email || '').trim().toLowerCase()).filter(Boolean);
      } catch { return []; }
    };
    for (const { descriptor, spec } of historyBackfillEntries()) {
      for (const email of activeAccountEmails(descriptor.vendor, spec.accountType)) {
        enqueueLockTolerant({
          jobType: spec.jobType,
          uniqueKey: `${spec.jobType}:${email}`,
          targetType: 'account',
          targetId: email,
          priority: spec.priority,
          timeoutMs: spec.timeoutMs,
          payload: { email, ...(spec.payload || {}) },
          metadata: { source: 'supervisor-routine-probe' },
        }, spec.jobType);
      }
    }
    // Provider-history sweeps (st_fd14cdd4 reopen): one keyed
    // participants_backfill job per active account of every integration that
    // declares a historySweep — Gmail Message-ID matching recovers imported
    // To/Cc; the Microsoft walk pulls pre-registration mailbox history. The
    // sweep cursor lives in the account row's metadata, so each slice
    // resumes; once a sweep completes its done row is never revived here
    // (one-through — new mail is the live sync's job).
    for (const { descriptor, spec } of historySweepEntries()) {
      for (const email of activeAccountEmails(descriptor.vendor, spec.accountType)) {
        const uniqueKey = `${spec.jobType}:${spec.source}:${email}`;
        enqueueLockTolerant({
          jobType: spec.jobType,
          uniqueKey,
          targetType: 'account',
          targetId: `${spec.source}:${email}`,
          priority: spec.priority,
          timeoutMs: spec.timeoutMs,
          payload: { source: spec.source, account: email, ...(spec.payload || {}) },
          metadata: { source: 'supervisor-routine-probe' },
          requeueQuarantined: shouldReviveTimedOutQuarantine(uniqueKey),
        }, spec.jobType);
      }
    }

    // Flush every collected enqueue in ONE IMMEDIATE transaction. A busy writer
    // defers the WHOLE batch in a single ≤busy_timeout wait (next tick re-seeds);
    // a free writer commits all of them atomically in ~1ms. This is the line that
    // turns the prior N-acquisition 11.8s block into one bounded wait.
    const flush0 = performance.now();
    if (pending.length > 0 || hasPartialDone) {
      const flushBatch = db.transaction((items) => {
        revivedPartial = db.prepare(`
          UPDATE passive_jobs
             SET status = 'queued',
                 run_after = ?,
                 last_success_at = NULL,
                 finished_at = NULL,
                 last_error = 'partial slice — residual work remains',
                 updated_at = ?
           WHERE queue = 'default'
             AND status = 'done'
             AND job_type IN (${ROUTINE_TYPE_PLACEHOLDERS})
             AND (metadata LIKE '%"partial":true%' OR metadata LIKE '%"lockSkipped":true%')
        `).run(new Date().toISOString(), new Date().toISOString(), ...ROUTINE_FRESHNESS_TYPES).changes;
        for (const args of items) {
          enqueuePassiveJob({ database: db, ...args });
          enqueued += 1;
        }
      });
      try {
        // IMMEDIATE so the writer lock is taken (or BUSY-rejected) up front — not
        // mid-batch after partial work — which is what makes the single bounded
        // wait honest.
        flushBatch.immediate(pending);
      } catch (err) {
        if (isBusyError(err)) {
          // The whole batch deferred on a busy writer; nothing was committed
          // (transaction rolled back). The next tick re-seeds. This replaces the
          // old per-enqueue deferral count with a single batch-deferred signal.
          enqueued = 0;
          deferred = pending.length;
        } else {
          throw err; // a non-busy error is a real bug — surface it
        }
      }
    }
    enqueueMs = performance.now() - flush0;
    return { skipped: false, enqueued, deferred, revived_partial: revivedPartial };
  } catch (err) {
    // A busy SELECT (freshness/accounts) is a transient lock, not a fault: defer
    // the whole tick quietly (next tick re-seeds). Any other error surfaces.
    if (isBusyError(err)) return { skipped: true, reason: 'database-busy' };
    console.warn('[supervisor] maintenance routine probe failed:', err.message);
    return { skipped: false, error: err.message };
  } finally {
    if (prevTimeout !== undefined) {
      try { db.pragma(`busy_timeout = ${prevTimeout}`); } catch { /* best-effort restore */ }
    }
    const dt = performance.now() - t0;
    if (dt > MAIN_THREAD_BUDGET_MS) {
      // Phase breakdown so a future regression names the slow line directly
      // (scan vs enqueue vs deferred) instead of a bare total — the measure-the-
      // line discipline that found the unscoped 2.4s scan in the first place.
      console.warn(`[supervisor] STOP-THE-LINE: maintenance routine probe took ${dt.toFixed(0)}ms > ${MAIN_THREAD_BUDGET_MS}ms budget (scan=${scanMs.toFixed(0)}ms enqueue=${enqueueMs.toFixed(0)}ms enqueued=${enqueued} deferred=${deferred})`);
    }
  }
}

/**
 * st_2cd1af73 AC-1 — spawn the off-process maintenance worker and keep it alive.
 *
 * detached:false so the worker is tied to the server's process group; if the
 * server dies, the worker is reaped with it (no orphaned drainer). stdio piped to
 * the parent so the worker's `wal_checkpoint(PASSIVE)` marker + drain logs land
 * in the server log (observability preserved). On exit, respawn after a small
 * backoff (KeepAlive-equivalent) unless we are shutting down. The worker's own
 * pidfile singleton guard makes a double-spawn race a no-op (the second instance
 * exits 0 immediately), so even an over-eager respawn cannot double-drain.
 */
/**
 * st_2cd1af73 AC-1 — kill a maintenance worker orphaned by a prior server
 * kickstart. `kickstart -k` SIGKILLs the old server but its child worker can be
 * reparented to launchd (PPID=1) and keep running — a second drainer. On boot,
 * we sweep both the lock holder and any process table match for this repo's
 * worker script, wait briefly for exit, then escalate to SIGKILL before clearing
 * the lock. Clearing a live worker's lock first lets the fresh worker acquire it
 * while the old worker is still inside a long tick, which is exactly the
 * duplicate-writer failure this guard exists to prevent.
 */
function processAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* bounded boot-only wait */ }
  }
}

function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    sleepSync(50);
  }
  return !processAlive(pid);
}

function maintenanceWorkerPidsFromPs() {
  let out = '';
  try {
    out = execFileSync('ps', ['-ww', '-axo', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    try {
      out = execFileSync('ps', ['-axo', 'pid=,command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return [];
    }
  }
  const pids = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[2] || '';
    if (!pid || pid === process.pid || pid === maintChild?.pid) continue;
    if (command.includes(MAINT_WORKER_SCRIPT)) pids.push(pid);
  }
  return pids;
}

function sweepOrphanMaintenanceWorker() {
  let holder = null;
  try { holder = JSON.parse(readFileSync(MAINT_LOCK, 'utf8')); } catch { holder = null; }
  const pid = Number(holder?.pid);
  const targets = new Set(maintenanceWorkerPidsFromPs());
  if (pid && pid !== process.pid && pid !== maintChild?.pid) targets.add(pid);

  if (!targets.size) {
    if (pid && !processAlive(pid)) {
      try { unlinkSync(MAINT_LOCK); } catch { /* already gone */ }
    }
    return;
  }

  let liveAfterSweep = false;
  for (const targetPid of targets) {
    if (!processAlive(targetPid)) continue;
    try { process.kill(targetPid, 'SIGTERM'); } catch { /* race: already gone */ }
    if (!waitForProcessExit(targetPid, WORKER_ORPHAN_TERM_WAIT_MS)) {
      try { process.kill(targetPid, 'SIGKILL'); } catch { /* race: already gone */ }
      waitForProcessExit(targetPid, WORKER_ORPHAN_KILL_WAIT_MS);
    }
    if (processAlive(targetPid)) {
      liveAfterSweep = true;
      console.warn(`[supervisor] orphan maintenance worker still alive pid=${targetPid}; keeping singleton lock`);
    } else {
      console.info(`[supervisor] swept orphan maintenance worker pid=${targetPid}`);
    }
  }

  if (!liveAfterSweep) {
    try { unlinkSync(MAINT_LOCK); } catch { /* already gone */ }
  }
}

function liveMaintenanceWorkerLock() {
  let holder = null;
  try { holder = JSON.parse(readFileSync(MAINT_LOCK, 'utf8')); } catch { return null; }
  const pid = Number(holder?.pid);
  if (!pid || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return { pid, started_at: holder?.started_at || null };
  } catch {
    return null;
  }
}

function spawnMaintenanceWorker() {
  if (stopping) return;
  if (activePostDrainHold()) {
    logPostDrainHoldOnce('[supervisor] post-drain writer hold active — maintenance worker spawn deferred');
    scheduleMaintenanceRespawn(WORKER_HOLD_RESPAWN_MS);
    return;
  }
  try {
    maintChild = spawn(process.execPath, [MAINT_WORKER_SCRIPT], {
      detached: false,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    });
  } catch (err) {
    console.warn('[supervisor] maintenance worker spawn failed:', err.message);
    scheduleMaintenanceRespawn();
    return;
  }
  maintChild.on('exit', (code, signal) => {
    maintChild = null;
    if (stopping) return;
    // Singleton-decline guard: a child that exits 0 because ANOTHER worker
    // already holds the lock (fresh heartbeat) must NOT trigger a respawn — that
    // is what caused a 3s respawn storm while the real worker ran a long tick.
    // Only respawn when no live worker is publishing a heartbeat.
    const hb = readSupervisorHeartbeat(db);
    const liveLock = liveMaintenanceWorkerLock();
    if (code === 0 && hb.alive && liveLock) {
      // A live worker exists (this exit was a duplicate declining the lock).
      // Do nothing; the live worker owns the loop.
      return;
    }
    console.warn(`[supervisor] maintenance worker exited (code=${code} signal=${signal}) — respawning in ${WORKER_RESPAWN_MS}ms`);
    scheduleMaintenanceRespawn();
  });
  maintChild.on('error', (err) => {
    console.warn('[supervisor] maintenance worker error:', err.message);
  });
  console.info(`[supervisor] maintenance worker started pid=${maintChild.pid}`);
}

function scheduleMaintenanceRespawn(delayMs = WORKER_RESPAWN_MS) {
  if (stopping || maintRespawnTimer) return;
  maintRespawnTimer = setTimeout(() => {
    maintRespawnTimer = null;
    spawnMaintenanceWorker();
  }, delayMs);
  maintRespawnTimer.unref?.();
}

/**
 * Start the in-process supervisor. Opt-in via the server boot path. Idempotent.
 * Disable: ROBOTDOJO_SUPERVISOR_ENABLED=0, NODE_ENV=test, or
 * ROBOTDOJO_DISABLE_BACKGROUND=1.
 */
export function startInProcessSupervisor() {
  if (supervisorStarted) return false;
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.ROBOTDOJO_SUPERVISOR_ENABLED === '0') return false;
  if (process.env.ROBOTDOJO_DISABLE_BACKGROUND === '1') return false;
  supervisorStarted = true;
  stopping = false;

  // Fire the first routine probe only after the foreground launch window. A
  // restarted server should become usable first; stale routine seeding can lag.
  setTimeout(maintenanceRoutineProbe, MAINT_PROBE_BOOT_GRACE_MS).unref?.();

  // Sweep old workers immediately, then start the fresh worker after a short
  // boot delay. The worker may publish read-only summaries right away, but its
  // drain/checkpoint/value-rank paths remain foreground-gated in the worker.
  sweepOrphanMaintenanceWorker();
  maintSpawnTimer = setTimeout(() => {
    maintSpawnTimer = null;
    spawnMaintenanceWorker();
  }, MAINT_WORKER_START_DELAY_MS);
  maintSpawnTimer.unref?.();

  // Eager cohort + server-health body warm so the first /api/server-health after
  // restart doesn't pay the cohort import-graph compile. NOTE: the passive-jobs
  // summary is NO LONGER warmed here — the off-process worker computes it and
  // publishes it to supervisor_status; precomputeServerHealthBody reads that one
  // small row. The server main thread runs ZERO passive_jobs aggregate scans.
  setImmediate(async () => {
    try {
      const { getBBStatus } = await import('./cohort/active.js');
      await getBBStatus();
    } catch (err) { console.warn('[supervisor] eager cohort warm failed:', err.message); }
    try {
      const { precomputeServerHealthBody } = await import('./server.js');
      await precomputeServerHealthBody({ deep: false });
      await precomputeServerHealthBody({ deep: true });
    } catch (err) {
      console.warn('[supervisor] eager server-health body seed failed:', err.message);
    }
  });

  // Periodic routine freshness probe (cheap; bounded by the self-check).
  timers.maintProbe = setInterval(maintenanceRoutineProbe, MAINT_PROBE_MS);
  timers.maintProbe.unref?.();

  // Server-health response-body refresh. precomputeServerHealthBody now reads
  // the worker-published summary (one small row) — no aggregate scan — so this
  // keeps the response-body cache warm off the request path at near-zero cost.
  timers.summary = setInterval(async () => {
    try {
      const { precomputeServerHealthBody } = await import('./server.js');
      await precomputeServerHealthBody({ deep: false });
      await precomputeServerHealthBody({ deep: true });
    } catch (err) { console.warn('[supervisor] server-health body refresh failed:', err.message); }
  }, SUMMARY_REFRESH_MS);
  timers.summary.unref?.();

  // df_3df1f108 AC2(b)/AC4(a2) — the backup guardian. It lives HERE, on the
  // always-on server, and nowhere near the backup job: in this defect's
  // scenario the machine is off and the backup does not run, so a staleness
  // check or an auto-push hosted on the backup would not run either and the
  // owner would never be told. Its own timer, its own state files, zero DB
  // work on this thread.
  setImmediate(async () => {
    try {
      const { startBackupGuardian } = await import('./backup-guardian.js');
      startBackupGuardian();
    } catch (err) { console.warn('[supervisor] backup-guardian start failed:', err.message); }
  });

  console.info(`[supervisor] started (off-thread maintenance delayed) — tick=${TICK_MS}ms maint_probe=${MAINT_PROBE_MS}ms worker_start_delay=${MAINT_WORKER_START_DELAY_MS}ms`);
  return true;
}

export function stopInProcessSupervisor() {
  stopping = true;
  import('./backup-guardian.js')
    .then((m) => m.stopBackupGuardian())
    .catch(() => { /* never started */ });
  for (const k of Object.keys(timers)) {
    if (timers[k]) { clearInterval(timers[k]); timers[k] = null; }
  }
  if (maintRespawnTimer) { clearTimeout(maintRespawnTimer); maintRespawnTimer = null; }
  if (maintSpawnTimer) { clearTimeout(maintSpawnTimer); maintSpawnTimer = null; }
  if (maintChild) {
    try { maintChild.kill('SIGTERM'); } catch { /* already gone */ }
    maintChild = null;
  }
  supervisorStarted = false;
}

// Exported for tests / criteria-runner.
function repairStaleMaintenanceRoutinesForLaunch() {
  return maintenanceRoutineProbe({ ignoreActivity: true });
}

export { repairStaleMaintenanceRoutinesForLaunch };
export { maintenanceRoutineProbe as _maintenanceRoutineProbeForTest };
export { withMainThreadBudget as _withMainThreadBudgetForTest };
