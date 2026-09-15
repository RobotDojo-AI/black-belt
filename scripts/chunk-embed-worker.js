// WHY: dedicated launchd-supervised worker that drains the embed queue on its own
// schedule — decoupled from sync.js so embed failures never block a sync cycle.
// The plist fires this every 120s. --dry-run flag allows verification without
// running real embeddings (used by VC3 in criteria-runner.js).
//
// st_5a63545d AC 20a — gate ingest work on isBBActive(). When the cohort is
// inactive (expired JWT, revoked week, or stale revocation cache), the worker
// no-ops with a clear "BB inactive — paused" line and exits 0. Chat itself
// remains functional against existing data; only NEW ingest is paused.
//
// st_b50005df (2026-06-09, owner-directed): the embedder runs CONTINUOUSLY in
// the background — NOT idle-gated. The original HID-idle gate stopped the worker
// whenever the user touched the keyboard (including driving a coding agent), so
// the 340k re-key backlog never drained. Safe to run continuously because:
// chat reads are concurrent with the embedder's writes (DB is WAL), the plist
// runs it at background QoS (yields CPU/IO to the foreground), and a bounded RSS
// ceiling + KeepAlive respawn make memory pressure kill the *embedder* (then
// resume via lease), never chat. The DB-writer overlap lock is still honored.
//   - Pending-work pre-check — skip the cycle when nothing is queued.
//   - AbortController + installCancelHandler — SIGTERM aborts in-flight local
//     embedding work and rolls back any open DB transaction.

export const INTELLIGENCE_TIER = 'orchestration';

// IDLE_GATED is read by check-idle-gated.js (pre-commit), the registry check,
// and ram-watchdog.sh. false: this worker is not HID-idle gated. It is still
// foreground-request gated below: chat/API activity always wins.
export const IDLE_GATED = false;

import { installCancelHandler } from '../lib/idle-gate.js';
import { withLaunchDbWriterGuard } from '../lib/db-writer-policy.js';

const isDryRun = process.argv.includes('--dry-run');

function positiveMsEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const MAX_RUNTIME_MS = positiveMsEnv('ROBOTDOJO_CHUNK_WORKER_MAX_MS', 30_000);
const RUNTIME_ABORT_GRACE_MS = positiveMsEnv('ROBOTDOJO_CHUNK_WORKER_RUNTIME_ABORT_GRACE_MS', 5_000);
const CHAT_APP_WATCHDOG_POLL_MS = positiveMsEnv('ROBOTDOJO_CHUNK_WORKER_CHAT_WATCHDOG_POLL_MS', 500);
const CHAT_APP_WATCHDOG_EXIT_MS = positiveMsEnv('ROBOTDOJO_CHUNK_WORKER_CHAT_WATCHDOG_EXIT_MS', 5_000);
const FOREGROUND_ACTIVITY_PAUSE_MS = positiveMsEnv(
  'ROBOTDOJO_CHUNK_WORKER_FOREGROUND_PAUSE_MS',
  positiveMsEnv('ROBOTDOJO_ACTIVITY_PAUSE_MS', 60_000),
);

function hardExitLaunchdSlice(db, message) {
  console.log(message);
  try { db?.close?.(); } catch { /* best-effort cleanup */ }
  process.exit(0);
}

function installChatAppAbortWatchdog({
  db,
  abortController,
  getActivitySignal,
  chatAppActiveDecision,
  activityPauseDecision,
  readEmbedPauseHold,
}) {
  let tripped = false;
  let exitTimer = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    if (exitTimer) clearTimeout(exitTimer);
  };
  const abortForForegroundHold = (reason) => {
    if (tripped) return;
    tripped = true;
    const message = reason === 'chat app opened'
      ? '[chunk-worker] chat app opened mid-job — aborting launchd slice'
      : `[chunk-worker] ${reason} mid-job — aborting launchd slice`;
    console.log(message);
    try { abortController.abort(); } catch { /* already aborted */ }
    if (timer) clearInterval(timer);
    exitTimer = setTimeout(() => {
      hardExitLaunchdSlice(db, '[chunk-worker] chat app still open after abort grace — exiting launchd slice');
    }, CHAT_APP_WATCHDOG_EXIT_MS);
    exitTimer.unref?.();
  };
  const timer = setInterval(() => {
    if (abortController.signal.aborted) {
      if (timer) clearInterval(timer);
      return;
    }
    try {
      const hold = readEmbedPauseHold?.();
      const signal = getActivitySignal(db);
      const activity = activityPauseDecision(signal, { pauseMs: FOREGROUND_ACTIVITY_PAUSE_MS });
      if (hold?.active) abortForForegroundHold(hold.reason || 'embed pause hold active');
      else if (chatAppActiveDecision(signal)) abortForForegroundHold('chat app opened');
      else if (activity.pause) abortForForegroundHold(activity.reason || 'foreground activity');
    } catch (err) {
      console.warn(`[chunk-worker] chat app watchdog skipped: ${err.message}`);
    }
  }, CHAT_APP_WATCHDOG_POLL_MS);
  timer.unref?.();
  abortController.signal.addEventListener('abort', () => { if (timer) clearInterval(timer); }, { once: true });
  return stop;
}

function foregroundYieldDecision({
  db,
  getActivitySignal,
  chatAppActiveDecision,
  activityPauseDecision,
  readEmbedPauseHold,
}) {
  const hold = readEmbedPauseHold();
  if (hold.active) return { ok: false, reason: hold.reason || 'embed-pause-hold' };
  const signal = getActivitySignal(db);
  if (chatAppActiveDecision(signal)) return { ok: false, reason: 'chat-app-open' };
  const activity = activityPauseDecision(signal, { pauseMs: FOREGROUND_ACTIVITY_PAUSE_MS });
  if (activity.pause) return { ok: false, reason: activity.reason || 'foreground-activity' };
  return { ok: true };
}

async function waitWhileForegroundActive({
  db,
  getActivitySignal,
  chatAppActiveDecision,
  activityPauseDecision,
  readEmbedPauseHold,
  signal = null,
  pollMs = CHAT_APP_WATCHDOG_POLL_MS,
  onPause = null,
  onResume = null,
} = {}) {
  let paused = false;
  let lastReason = null;
  while (!signal?.aborted) {
    const decision = foregroundYieldDecision({
      db,
      getActivitySignal,
      chatAppActiveDecision,
      activityPauseDecision,
      readEmbedPauseHold,
    });
    if (decision.ok) {
      if (paused && typeof onResume === 'function') {
        try { onResume(lastReason || 'foreground quiet'); } catch {}
      }
      return true;
    }
    lastReason = decision.reason;
    if (!paused) {
      paused = true;
      if (typeof onPause === 'function') {
        try { onPause(decision.reason); } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

async function main() {
  // Once past the launch DB writer guard we know we're allowed to run. NOW load
  // the DB first, then check the chat-app-active row before source scans or
  // queue reconciliation. This keeps a launchd fire cheap while the user has
  // chat open.
  const dbModule = await import('../lib/db.js');
  const db = dbModule.default;
  const { getActivitySignal, chatAppActiveDecision, activityPauseDecision } = await import('../lib/request-observer.js');
  const { readEmbedPauseHold } = await import('../lib/embed-pause-hold.js');
  if (!isDryRun) {
    const hold = readEmbedPauseHold();
    if (hold.active) {
      console.log(`[chunk-worker] ${hold.reason} — skipping launchd slice`);
      return { exitCode: 0, skipped: true, reason: hold.reason || 'embed-pause-hold' };
    }
    const foreground = foregroundYieldDecision({
      db,
      getActivitySignal,
      chatAppActiveDecision,
      activityPauseDecision,
      readEmbedPauseHold,
    });
    if (!foreground.ok) {
      console.log(`[chunk-worker] ${foreground.reason} — skipping launchd slice`);
      return { exitCode: 0, skipped: true, reason: foreground.reason };
    }
  }

  const { drainChunkWorkerJobs, enqueueChunkWorkerJobs, hasPendingWork, daemonOwnsEmbedding } = await import('../lib/chunk-worker.js');
  const { reconcilePassiveBacklog } = await import('../lib/passive-reconciler.js');
  const { isBBActive } = await import('../lib/cohort/active.js');
  const { enrichmentDecision } = await import('../lib/entity-enrich-policy.js');

  // st_2cd1af73 AC-3 — zombie guard: this process MUST NEVER load the ~2GB embed
  // model while the long-lived chunk-embed-daemon owns embedding. Two embedders
  // racing the single WAL writer + a doubled resident model on a 16GB box was a
  // co-resident memory thief (a stray daytime zombie of this exact script was
  // found pinned at 100% CPU). daemonOwnsEmbedding() (default true) already makes
  // every embed call site a no-op, so under the shipped config this worker only
  // scans chunk sources and never imports the model into RAM. The line below makes
  // that invariant LOUD and auditable: if anyone sets ROBOTDOJO_EMBED_OWNER=worker
  // on a box where the daemon is the owner, the misconfig is visible in this log
  // instead of silently re-creating the race. The lib gate is the enforcement;
  // this is the alarm. (Set ROBOTDOJO_EMBED_OWNER=worker only on a box with NO
  // daemon installed — e.g. CI or a fallback host.)
  if (daemonOwnsEmbedding()) {
    console.log('[chunk-worker] embed owner = daemon — this worker scans chunk sources only and will NOT load the embed model');
  } else {
    console.warn('[chunk-worker] WARNING: ROBOTDOJO_EMBED_OWNER!=daemon — in-worker embedding is ENABLED; this is only safe with NO chunk-embed-daemon installed (else two embedders race the WAL writer + double the resident model)');
  }

  // SIGTERM/SIGINT installer — wires the abort controller so any in-flight
  // Local embedding work cancels cleanly and the better-sqlite3 connection closes
  // before the process exits.
  const abortController = new AbortController();
  installCancelHandler(abortController, db);
  const startedAt = Date.now();
  const runtimeExpired = () => MAX_RUNTIME_MS > 0 && Date.now() - startedAt >= MAX_RUNTIME_MS;
  const runtimeTimer = MAX_RUNTIME_MS > 0
    ? setTimeout(() => {
        console.log(`[chunk-worker] runtime budget ${MAX_RUNTIME_MS}ms reached — aborting launchd slice`);
        abortController.abort();
      }, MAX_RUNTIME_MS)
    : null;
  runtimeTimer?.unref?.();
  const runtimeExitTimer = MAX_RUNTIME_MS > 0
    ? setTimeout(() => {
        hardExitLaunchdSlice(db, `[chunk-worker] runtime abort grace ${RUNTIME_ABORT_GRACE_MS}ms exceeded — exiting launchd slice`);
      }, MAX_RUNTIME_MS + RUNTIME_ABORT_GRACE_MS)
    : null;
  runtimeExitTimer?.unref?.();
  const stopChatAppAbortWatchdog = isDryRun
    ? () => {}
    : installChatAppAbortWatchdog({
        db,
        abortController,
        getActivitySignal,
        chatAppActiveDecision,
        activityPauseDecision,
        readEmbedPauseHold,
      });

  try {

  // Cohort-entitlement gate runs BEFORE dry-run so VC 20a (--dry-run +
  // BB_TEST_INACTIVE=1) emits "BB inactive — paused" instead of the dry-run
  // wiring-verified line.
  // Ensure the 90-day install trial clock exists before evaluating entitlement
  // so a missing config.json cannot freeze BB engines on an otherwise-valid install.
  try {
    const { ensureInstallBbTrialConfig } = await import('../lib/cohort/active.js');
    ensureInstallBbTrialConfig();
  } catch { /* best-effort */ }
  const active = await isBBActive();
  if (!active) {
    console.log('[chunk-worker] BB inactive — paused');
    return { exitCode: 0 };
  }

  if (isDryRun) {
    console.log('[chunk-worker] dry-run: wiring verified');
    return { exitCode: 0 };
  }

  // st_b50005df Phase 4 — entity enrichment default: ON under Black Belt. The
  // ONLY pause while BB is active is the explicit, local owner-box opt-out
  // (ROBOTDOJO_ENRICH_OWNER_BOX_DISABLED=1) — never the shipped default. When
  // enabled, the reconciler re-derives the enrichment backlog from
  // people.needs_regen and the drainer drains entity_enrich on this same worker
  // under the same lease/reconciler discipline as embedding. When the owner
  // opts out locally, no enrichment job is enqueued or drained — no spend.
  const enrichEnabled = enrichmentDecision({ bbActive: active }).enabled;
  if (!enrichEnabled) {
    console.log('[chunk-worker] entity enrichment paused — owner-box opt-out set');
  }

  // st_b50005df Phase 2 — reconcile the queue against the source of truth
  // BEFORE deciding whether there is work. This re-animates any quarantined
  // embed/chunk-scan job whose backlog still exists and re-derives missing
  // jobs, so a frozen or wiped queue rebuilds itself every fire. Runs before
  // the hasPendingWork short-circuit so a quarantined-but-still-needed job is
  // never skipped as "no work". Phase 4 — enrichment backlog is re-derived in
  // the same pass when enabled.
  const reconciled = reconcilePassiveBacklog({ database: db, enrichEnabled });
  if (reconciled.revived.length) {
    console.log(`[chunk-worker] reconciler revived ${reconciled.revived.length} quarantined embed/chunk/enrich job(s)`);
  }

  const pending = hasPendingWork();
  const enrichPending = enrichEnabled && reconciled.entityEnrich?.enqueued;
  if (!pending.hasWork && !enrichPending) {
    console.log('[chunk-worker] no pending work — skipping cycle');
    return { exitCode: 0 };
  }
  console.log(`[chunk-worker] pending: ${pending.reason || 'enrichment only'}; started`);

  // st_b50005df (owner-directed 2026-06-09): drain the WHOLE backlog in one
  // process so the local embedding model loads ONCE (its ~2 GB load is the
  // dominant fixed cost — paying it per 120s launchd fire was why the 340k
  // re-key backlog never drained). Loop enqueue→drain until the backlog is
  // empty, the RSS ceiling is breached (exit cleanly so launchd respawns fresh
  // with RSS reset and the lease reclaims any in-flight job), or SIGTERM aborts.
  const { rssCeilingDecision } = await import('../lib/idle-gate.js');
  // st_fd14cdd4 — chat-yield gate. This worker is launchd-fired + detached, so the
  // server's chat-app-active SIGTERM path cannot reach it; an additive-budget
  // measurement attributed 19–32s warm-turn spikes to this worker's chunk-scan +
  // entity-enrich drain stealing the CPU the chat process's local embed needs. The
  // worker therefore SELF-YIELDS: before each drain round (the safe unit boundary —
  // every job committed by the previous round is durable), pause while the chat app
  // is open and resume the moment it closes. A drain round is bounded (DRAIN_LIMIT
  // jobs), so the longest uninterruptible unit is one round, not the whole backlog.
  // Per-JOB chat-yield: drainPassiveJobs calls this BEFORE acquiring each job and
  // breaks the drain (leaving the next job queued) when ok:false. This stops the
  // drain at the tightest committed boundary — between jobs — the instant chat
  // opens, so a DRAIN_LIMIT round in progress does not run to completion while a
  // human is typing. The outer waitWhileForegroundActive then parks until the
  // foreground quiet window is clear.
  const chatYieldIdleCheck = () => foregroundYieldDecision({
    db,
    getActivitySignal,
    chatAppActiveDecision,
    activityPauseDecision,
    readEmbedPauseHold,
  });
  let totalDrained = 0;
  let emptyRounds = 0;
  while (!abortController.signal.aborted && !runtimeExpired()) {
    // Yield the CPU to chat at the round boundary. Returns false only on abort.
    const proceed = await waitWhileForegroundActive({
      db,
      getActivitySignal,
      chatAppActiveDecision,
      activityPauseDecision,
      readEmbedPauseHold,
      signal: abortController.signal,
      onPause: (reason) => console.log(`[chunk-worker] ${reason} — pausing drain (yielding CPU to chat)`),
      onResume: () => console.log('[chunk-worker] foreground quiet — resuming drain'),
    });
    if (!proceed) break;
    enqueueChunkWorkerJobs();
    const drained = await drainChunkWorkerJobs({ signal: abortController.signal, enrichEnabled, idleCheck: chatYieldIdleCheck });
    totalDrained += drained.length;
    if (abortController.signal.aborted) break;
    if (runtimeExpired()) {
      console.log(`[chunk-worker] runtime budget ${MAX_RUNTIME_MS}ms reached — exiting cleanly; next launchd fire resumes`);
      break;
    }
    const rss = rssCeilingDecision('chunk-embed-worker');
    if (!rss.ok) { console.log(`${rss.message} — exiting for a fresh respawn`); break; }
    if (drained.length === 0) {
      // Nothing advanced this round. Re-derive from truth once more; if still
      // nothing, the backlog is genuinely drained (or stuck behind a non-embed
      // gate) — stop rather than spin.
      reconcilePassiveBacklog({ database: db, enrichEnabled });
      if (!hasPendingWork().hasWork || ++emptyRounds >= 2) break;
    } else {
      emptyRounds = 0;
    }
  }
  console.log(`[chunk-worker] drained=${totalDrained} total; done`);
  return { exitCode: 0 };
  } finally {
    stopChatAppAbortWatchdog();
    if (runtimeTimer) clearTimeout(runtimeTimer);
    if (runtimeExitTimer) clearTimeout(runtimeExitTimer);
  }
}

/**
 * st_d0e47f5f AC-7 — LOCK-FREE PRE-CHECK.
 *
 * THE PROBLEM. `withLaunchDbWriterGuard` acquires the external DB writer lock
 * BEFORE invoking its callback, so the lock was taken on every launchd fire and
 * held across the DB open, the reconciler, and the pending-work check — then
 * released having done nothing. Measured on the live box: 2,695 of ~2,700 logged
 * cycles drained zero while holding it, 99.7% waste. Fourteen processes contend
 * that one advisory mutex with no queue and no fairness, and `maint_reclassify` /
 * `maint_reclassify_chunks` lost the race so consistently they had not succeeded
 * since 2026-07-02.
 *
 * THE FIX. Both questions this worker needs answered are pure SELECT probes
 * (`hasPendingWork` is indexed NOT-EXISTS LIMIT 1s; the quarantine count is a
 * single indexed COUNT). Neither needs the writer lock. Ask them first, on a
 * read-only connection, and acquire the lock only when there is real work.
 *
 * WHY the quarantine probe is part of the gate: `reconcilePassiveBacklog` runs
 * inside `main()` and re-animates quarantined embed/chunk/enrich jobs, so a wake
 * with zero pending work but a revivable quarantined job MUST still take the
 * lock. Checking only `hasPendingWork` here would reintroduce the frozen-queue
 * bug st_b50005df fixed.
 *
 * Failing open is deliberate: if the probe throws for any reason, fall through
 * and acquire the lock exactly as before. A broken optimisation must not become
 * a broken worker.
 */
async function hasAnyReasonToRun() {
  try {
    const { default: probeDb } = await import('../lib/db.js');
    const { hasPendingWork } = await import('../lib/chunk-worker.js');
    if (hasPendingWork().hasWork) return { run: true, why: 'pending work' };
    const q = probeDb.prepare(
      "SELECT COUNT(*) AS n FROM passive_jobs WHERE status = 'quarantined'",
    ).get();
    if ((q?.n ?? 0) > 0) return { run: true, why: `${q.n} quarantined job(s) to reconcile` };
    return { run: false, why: null };
  } catch (err) {
    return { run: true, why: `probe failed (${err.message}) — failing open` };
  }
}

const gate = await hasAnyReasonToRun();
if (!gate.run) {
  // The whole point: exit WITHOUT ever acquiring the writer lock.
  console.log('[chunk-worker] no pending work — skipping cycle (lock not acquired)');
  process.exit(0);
}
console.log(`[chunk-worker] proceeding: ${gate.why}`);

withLaunchDbWriterGuard('chunk-embed-worker', () => main(), { dryRun: isDryRun, idleGated: false })
  .then((result) => process.exit(result?.exitCode ?? 0))
  .catch((err) => {
    console.error('[chunk-worker] fatal:', err.message);
    process.exit(1);
  });
