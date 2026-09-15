#!/usr/bin/env node
/**
 * Real-time data sync daemon — runs every 5 minutes via com.robotdojo.sync.
 *
 * Pulls incremental data from Gmail, Outlook, Calendar, iMessage, Photos,
 * Drive, Asana, Granola, Oura, Eight Sleep, Notion, Monarch (Saturday AM), and derived import snapshots.
 *
 * Every unit of work is first registered in passive_jobs, then leased and
 * drained through the passive sync orchestrator. This keeps restarts, DB
 * locks, provider failures, and poison credentials out of foreground routes.
 *
 * CLI:
 *   node scripts/sync.js            # enqueue + drain bounded work
 *   node scripts/sync.js --dry-run  # plan only, no writes
 */

// st_f6315f0b: sync pulls from multiple vendor APIs every 5 minutes and writes
// to the live DB. Idle-gate keeps these aligned with user-away windows.
export const IDLE_GATED = true;

import { withLaunchDbWriterGuard } from '../lib/db-writer-policy.js';
import { getIdleSeconds, installCancelHandler } from '../lib/idle-gate.js';
import { spawn } from 'node:child_process';

console.info = (...a) => process.stderr.write(a.join(' ') + '\n');
console.log  = (...a) => process.stderr.write(a.join(' ') + '\n');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE_GOOGLE_FULL = process.argv.includes('--full-google') || process.argv.includes('--full-sync-google');
const SINCE_2H = new Date(Date.now() - 2 * 60 * 60 * 1000);
const DEFAULT_SYNC_IDLE_THRESHOLD_SECONDS = 15 * 60;
const DEFAULT_SYNC_DRAIN_LIMIT = 1;
const DEFAULT_SYNC_MAX_RUNTIME_MS = 45_000;
const DEFAULT_SYNC_REQUEUE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_SYNC_LIVENESS_STALE_MS = 30 * 60 * 1000;
const DEFAULT_SYNC_LIVENESS_DRAIN_LIMIT = 2;
const SYNC_LIVENESS_JOB_TYPES = Object.freeze([
  'oauth_sync',
  'granola_sync',
  'granola_call_asana',
  'oura_sync',
  'eight_sleep_sync',
  'asana_sync',
  'notion_sync',
  'monarch_sync',
]);

const ts  = () => new Date().toISOString().slice(11, 19);
const log = (m) => process.stderr.write(`[${ts()}] ${m}\n`);

function positiveIntEnv(name, fallback) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const SYNC_IDLE_THRESHOLD_SECONDS = positiveIntEnv(
  'ROBOTDOJO_SYNC_IDLE_THRESHOLD_SECONDS',
  DEFAULT_SYNC_IDLE_THRESHOLD_SECONDS,
);
const SYNC_DRAIN_LIMIT = positiveIntEnv('ROBOTDOJO_SYNC_DRAIN_LIMIT', DEFAULT_SYNC_DRAIN_LIMIT);
export const SYNC_MAX_RUNTIME_MS = positiveIntEnv('ROBOTDOJO_SYNC_MAX_RUNTIME_MS', DEFAULT_SYNC_MAX_RUNTIME_MS);
const SYNC_REQUEUE_INTERVAL_MS = positiveIntEnv('ROBOTDOJO_SYNC_REQUEUE_INTERVAL_MS', DEFAULT_SYNC_REQUEUE_INTERVAL_MS);
const SYNC_LIVENESS_STALE_MS = positiveIntEnv('ROBOTDOJO_SYNC_LIVENESS_STALE_MS', DEFAULT_SYNC_LIVENESS_STALE_MS);
const SYNC_LIVENESS_DRAIN_LIMIT = positiveIntEnv('ROBOTDOJO_SYNC_LIVENESS_DRAIN_LIMIT', DEFAULT_SYNC_LIVENESS_DRAIN_LIMIT);

export function monarchDrainRuntimeBudgetMs({
  dueJobTypes = [],
  syncMaxRuntimeMs = SYNC_MAX_RUNTIME_MS,
  monarchTimeoutMs,
  padMs,
} = {}) {
  const timeout = Number.isFinite(Number(monarchTimeoutMs)) && Number(monarchTimeoutMs) > 0
    ? Number(monarchTimeoutMs)
    : positiveIntEnv('MONARCH_TIMEOUT_MS', 600_000);
  const pad = Number.isFinite(Number(padMs)) && Number(padMs) >= 0
    ? Number(padMs)
    : positiveIntEnv('MONARCH_WATCHDOG_PAD_MS', 15_000);
  if (dueJobTypes.includes('monarch_sync')) {
    return Math.max(syncMaxRuntimeMs, timeout + pad);
  }
  return syncMaxRuntimeMs;
}

function dueMonarchSync(database, now = new Date()) {
  try {
    const row = database.prepare(`
      SELECT 1 AS ok FROM passive_jobs
       WHERE job_type = 'monarch_sync'
         AND status = 'queued'
         AND run_after <= ?
       LIMIT 1
    `).get(now.toISOString());
    return !!row;
  } catch {
    return false;
  }
}

function syncIdleDecision() {
  const idle = getIdleSeconds();
  if (idle < SYNC_IDLE_THRESHOLD_SECONDS) {
    return {
      ok: false,
      reason: 'user-active',
      idle,
      threshold: SYNC_IDLE_THRESHOLD_SECONDS,
    };
  }
  return { ok: true, idle, threshold: SYNC_IDLE_THRESHOLD_SECONDS };
}

function installRuntimeWatchdog(timeoutMs) {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const hardKillSeconds = 3;
  try {
    const child = spawn('sh', [
      '-c',
      `sleep ${timeoutSeconds}; kill -TERM ${process.pid} 2>/dev/null || exit 0; sleep ${hardKillSeconds}; kill -KILL ${process.pid} 2>/dev/null || true`,
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    return child.pid || null;
  } catch {
    return null;
  }
}

function summarizeDrain(results = []) {
  const summary = { ok: 0, retrying: 0, paused: 0, quarantined: 0, skipped: 0 };
  for (const result of results) {
    if (result?.skipped) summary.skipped++;
    if (result?.ok) summary.ok++;
    const status = result?.job?.status;
    if (status === 'queued') summary.retrying++;
    if (status === 'paused') summary.paused++;
    if (status === 'quarantined') summary.quarantined++;
  }
  return summary;
}

export function dueSyncState(db, now = new Date(), jobTypes) {
  const types = Array.isArray(jobTypes) && jobTypes.length ? jobTypes : SYNC_LIVENESS_JOB_TYPES;
  const placeholders = types.map(() => '?').join(',');
  const nowIso = now.toISOString();
  // df_02d633dc — the `oldest_due` staleness anchor measures real neglect off
  // MIN(COALESCE(last_success_at, created_at)), NOT MIN(run_after). run_after is
  // reset to "now" for every non-oauth_sync type on every 5-minute re-plan
  // pass (enqueuePassiveSyncJobs), so anchoring on it hid two weeks of real
  // starvation from the liveness-bypass check. The WHERE filter that selects
  // which rows count as due (run_after <= now) is unchanged; only the aggregate
  // measuring how overdue the oldest one is moves off the self-resetting field.
  const queued = db.prepare(`
    SELECT COUNT(*) AS due_count,
           MIN(COALESCE(last_success_at, created_at)) AS oldest_due
      FROM passive_jobs
     WHERE status = 'queued'
       AND run_after <= ?
       AND job_type IN (${placeholders})
  `).get(nowIso, ...types);
  const doneCutoff = new Date(now.getTime() - SYNC_REQUEUE_INTERVAL_MS).toISOString();
  const done = db.prepare(`
    SELECT COUNT(*) AS due_count,
           MIN(last_success_at) AS oldest_success
      FROM passive_jobs
     WHERE status = 'done'
       AND last_success_at IS NOT NULL
       AND last_success_at <= ?
       AND job_type IN (${placeholders})
  `).get(doneCutoff, ...types);
  const doneDueAt = done?.oldest_success
    ? new Date(Date.parse(done.oldest_success) + SYNC_REQUEUE_INTERVAL_MS).toISOString()
    : null;
  const oldestDue = [queued?.oldest_due, doneDueAt].filter(Boolean).sort()[0] || null;
  return {
    due_count: (Number(queued?.due_count) || 0) + (Number(done?.due_count) || 0),
    queued_due_count: Number(queued?.due_count) || 0,
    done_due_count: Number(done?.due_count) || 0,
    oldest_due: oldestDue,
  };
}

export function staleLivenessState(db, now = new Date()) {
  const due = dueSyncState(db, now, SYNC_LIVENESS_JOB_TYPES);
  const oldestMs = due.oldest_due ? Date.parse(due.oldest_due) : NaN;
  const overdueMs = Number.isFinite(oldestMs) ? Math.max(0, now.getTime() - oldestMs) : 0;
  return {
    ...due,
    overdue_ms: overdueMs,
    stale: due.due_count > 0 && overdueMs >= SYNC_LIVENESS_STALE_MS,
  };
}

async function main() {
  const started = Date.now();
  const {
    enqueuePassiveSyncJobs,
    planPassiveSyncJobs,
    drainPassiveSyncJobs,
    PASSIVE_SYNC_JOB_TYPES,
  } = await import('../lib/passive-sync-orchestrator.js');
  const { getPassiveJobSummary } = await import('../lib/passive-jobs.js');
  const { getActivitySignal, chatAppActiveDecision, activityPauseDecision } = await import('../lib/request-observer.js');
  const { default: db } = await import('../lib/db.js');

  log(`sync start${DRY_RUN ? ' (dry-run)' : ''}`);

  if (DRY_RUN) {
    const planned = planPassiveSyncJobs({ forceGoogleFull: FORCE_GOOGLE_FULL, sinceDate: SINCE_2H });
    process.stdout.write(JSON.stringify({
      synced_at: new Date().toISOString(),
      dry_run: true,
      planned_jobs: planned.map((job) => ({
        job_type: job.jobType,
        target_id: job.targetId,
        kind: job.payload?.kind || null,
      })),
    }, null, 2) + '\n');
    log(`sync dry-run planned ${planned.length} passive jobs`);
    return;
  }

  // st_27561b77 P5 — wire SIGTERM so launchd kill-on-idle aborts cleanly.
  // The cancel-handler is the safety net if a drain pass runs long.
  const abortController = new AbortController();
  installCancelHandler(abortController, db);
  const watchdogPid = installRuntimeWatchdog(SYNC_MAX_RUNTIME_MS);
  let killedByBudget = false;
  let runtimeTimer = setTimeout(() => {
    killedByBudget = true;
    log(`sync runtime budget exceeded — terminating after ${SYNC_MAX_RUNTIME_MS}ms (watchdogPid=${watchdogPid || 'n/a'})`);
    process.kill(process.pid, 'SIGTERM');
  }, SYNC_MAX_RUNTIME_MS);

  const chatYieldIdleCheck = () => {
    if (chatAppActiveDecision(getActivitySignal(db))) {
      return { ok: false, reason: 'chat-app-open' };
    }
    return syncIdleDecision();
  };
  const foregroundQuietCheck = () => {
    const decision = activityPauseDecision(getActivitySignal(db));
    if (decision.pause) return { ok: false, reason: decision.reason };
    return { ok: true, reason: 'foreground-quiet' };
  };

  const livenessBefore = staleLivenessState(db);
  const firstGate = chatYieldIdleCheck();
  const livenessBypass = !firstGate.ok && livenessBefore.stale;
  if (!firstGate.ok && !livenessBypass) {
    clearTimeout(runtimeTimer);
    if (firstGate.reason === 'chat-app-open') log('sync skipped — chat app open');
    else log(`sync skipped — user active (idle=${firstGate.idle}s threshold=${firstGate.threshold}s)`);
    return;
  }
  if (livenessBypass) {
    log(`sync liveness bypass — oldest due ${livenessBefore.oldest_due} (${Math.round(livenessBefore.overdue_ms / 60000)}m overdue), foreground=${firstGate.reason}`);
  }

  try {
    const queued = enqueuePassiveSyncJobs({
      forceGoogleFull: FORCE_GOOGLE_FULL,
      sinceDate: SINCE_2H,
    });

    const effectiveJobTypes = livenessBypass ? SYNC_LIVENESS_JOB_TYPES : PASSIVE_SYNC_JOB_TYPES;
    const effectiveDrainLimit = livenessBypass ? SYNC_LIVENESS_DRAIN_LIMIT : SYNC_DRAIN_LIMIT;
    const due = dueSyncState(db, new Date(), effectiveJobTypes);
    const monarchDue = dueMonarchSync(db);
    const runtimeBudgetMs = monarchDrainRuntimeBudgetMs({
      dueJobTypes: monarchDue ? ['monarch_sync'] : [],
    });
    let activeWatchdogPid = watchdogPid;
    if (runtimeBudgetMs > SYNC_MAX_RUNTIME_MS) {
      clearTimeout(runtimeTimer);
      activeWatchdogPid = installRuntimeWatchdog(runtimeBudgetMs);
      runtimeTimer = setTimeout(() => {
        killedByBudget = true;
        log(`sync runtime budget exceeded — terminating after ${runtimeBudgetMs}ms (watchdogPid=${activeWatchdogPid || 'n/a'})`);
        process.kill(process.pid, 'SIGTERM');
      }, runtimeBudgetMs);
    }
    const drained = await drainPassiveSyncJobs({
      worker: livenessBypass ? 'sync:liveness' : 'sync',
      limit: Math.max(1, Math.min(due.due_count || 1, effectiveDrainLimit)),
      jobTypes: effectiveJobTypes,
      signal: abortController.signal,
      idleCheck: livenessBypass ? foregroundQuietCheck : chatYieldIdleCheck,
      // df_02d633dc — the one call site in the repo that opts into type-level
      // round-robin fairness. Every other drainPassiveJobs/drainPassiveSyncJobs
      // caller leaves fairnessMode null and runs the legacy priority ordering.
      fairnessMode: 'round_robin_by_type',
    });
    const durationMs = Date.now() - started;
    const passive = getPassiveJobSummary({
      jobTypes: ['oauth_sync', 'local_sync', 'granola_sync', 'granola_call_asana', 'oura_sync', 'eight_sleep_sync', 'asana_sync', 'notion_sync', 'imports_snapshot', 'monarch_sync'],
    });
    const drainSummary = summarizeDrain(drained);

    log(`sync done in ${(durationMs / 1000).toFixed(1)}s — planned=${queued.planned.length} drained=${drained.length}`);

    try {
      const { maybeLearnOwnerVoice } = await import('../lib/writing-learn.js');
      await maybeLearnOwnerVoice();
    } catch { /* observational; sync success is not gated on voice learn */ }

    process.stdout.write(JSON.stringify({
      synced_at: new Date().toISOString(),
      dry_run: false,
      duration_ms: durationMs,
      planned_jobs: queued.planned.length,
      drain_limit: effectiveDrainLimit,
      liveness_bypass: livenessBypass,
      oldest_liveness_due: livenessBefore.oldest_due,
      runtime_budget_ms: monarchDue ? runtimeBudgetMs : SYNC_MAX_RUNTIME_MS,
      watchdog_pid: watchdogPid,
      idle_threshold_seconds: SYNC_IDLE_THRESHOLD_SECONDS,
      drain: drainSummary,
      passive_jobs: passive,
    }, null, 2) + '\n');
  } finally {
    if (!killedByBudget) clearTimeout(runtimeTimer);
  }
}

// df_02d633dc — only run main() when invoked directly via
// `node scripts/sync.js` (or the launchd-launched app binary). Importing the
// module — e.g. the direct-call staleness test exercising the now-exported
// dueSyncState/staleLivenessState — must NOT trigger a real sync pass, its
// runtime watchdog (which spawns a detached kill timer against this pid), or
// any DB writes. Same _isMain guard pattern as scripts/backfill-email-history.js.
const _isMain = (() => {
  try {
    const url = new URL(import.meta.url);
    const argv1 = process.argv[1] || '';
    return url.pathname === argv1 || url.pathname.endsWith(argv1);
  } catch { return false; }
})();
if (_isMain) {
  withLaunchDbWriterGuard('sync', () => main(), { dryRun: DRY_RUN, idleGated: false }).catch(e => {
    process.stderr.write(`[sync] fatal: ${e.message}\n`);
    process.exit(0); // always exit 0 so launchd doesn't throttle
  });
}
