/**
 * lib/passive-maintenance-handlers.js — st_2cd1af73 AC-1 (maintenance
 * isolation), st_fd14cdd4 AC8 (overnight deletion → always-on routines).
 *
 * The passive-job HANDLERS the maintenance drain runs: one handler per
 * declared routine in lib/maintenance-routines.js, plus email_history_backfill.
 * Used by the off-thread maintenance worker
 * (scripts/supervisor-maintenance-worker.mjs) and the supervisor's tests, so
 * both import the exact same handler set.
 *
 * HISTORY (why this module exists): st_27561b77 ran these handlers inside the
 * SERVER process's supervisorTick on the main thread; the drain's synchronous
 * SQL plus the PASSIVE checkpoint over a 7GB SQLCipher DB starved the event
 * loop for 12–17s per tick — every chat froze. st_2cd1af73 AC-1 moved the
 * whole drain + checkpoint into a separate long-lived process. st_fd14cdd4
 * then deleted the overnight batch the handlers used to serve: the former six
 * nightly_* job types (plus the 14 phases nothing scheduled) are now the
 * always-on routine set in lib/maintenance-routines.js, drained continuously.
 *
 * Phase-backed routines spawn `scripts/maintenance-phases.js --phase NAME
 * --max-seconds N` as an async child (grandchild of the maintenance worker) —
 * NOT spawnSync — and honor a bounded-resumable contract: a slice runs at most
 * maxSeconds, exits 0 even when it stops early, and signals residual work with
 * the pinned stdout token MAINT_PARTIAL_PREFIX so the drain re-enqueues a
 * follow-up. The idle/activity gate (passed by the caller as idleCheck on the
 * drain, and re-checked here every 5s while a child runs) SIGTERMs the child
 * the moment the user is active; phase writes are idempotent (INSERT OR
 * IGNORE) so a partial pass is always safe.
 *
 * INTELLIGENCE_TIER: orchestration — coordinates deterministic child phases
 * and the backfill primitives; makes no direct LLM call against structured data.
 */
export const INTELLIGENCE_TIER = 'orchestration';

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTINES, getRoutine } from './maintenance-routines.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const MAINT_PHASES_SCRIPT = join(REPO_ROOT, 'scripts', 'maintenance-phases.js');

// ── Pinned cross-process tokens (ONE definition; emit + match share these) ──
// The partial-slice sentinel. EMIT sites: scripts/maintenance-phases.js
// (emitPartial) and scripts/ingest/index.js (exitPartial). MATCH sites: this
// module's child-stdout check and maintenance-phases.js's INGEST-child tee.
// All of them import THIS constant — never inline the literal (a one-sided
// rename of the pre-st_fd14cdd4 token would have broken partial-resume
// silently; tests/maintenance-partial-sentinel.test.js pins the sharing).
export const MAINT_PARTIAL_PREFIX = 'MAINT_PARTIAL: phase=';
// The launch DB writer guard label maintenance-phases.js registers under.
// db-writer-policy interpolates it into the lock-skip log line, which the
// handler below string-matches — so the label and the matcher must be the
// same constant.
export const MAINT_WRITER_GUARD_NAME = 'maintenance';
export const MAINT_LOCK_SKIP_TOKEN = `[db-writer-policy] ${MAINT_WRITER_GUARD_NAME} skipped: external DB writer lock unavailable`;

// st_27561b77 (expansion) — bounded slice budget per phase. Heavy phases
// (INGEST, TOPICS, RESCORE) write many small commits; a 4-minute slice fits
// comfortably in SQLCipher per-page decrypt budgets and leaves headroom for
// the idle re-check loop. The maintenance worker re-enqueues a follow-up on
// PARTIAL so residual work drains across multiple idle windows.
export const MAINT_SLICE_SECONDS = Number(process.env.ROBOTDOJO_MAINT_SLICE_SECONDS || 240);
// timeout = slice + 60s: the passive_jobs timeoutPromise races the handler.
// The +60s buffer covers child spawn cost + graceful exit on the wall-clock
// guard inside the phase script, so the timeout never fires before the
// slice's own bound. Routines with a maxSeconds override get the same +60s
// via maintTimeoutMsFor().
export const MAINT_TIMEOUT_MS = (MAINT_SLICE_SECONDS + 60) * 1000;

/** Slice budget for a routine (its override or the shared default). */
export function maintSliceSecondsFor(routine) {
  return Number(routine?.maxSeconds) > 0 ? Math.floor(routine.maxSeconds) : MAINT_SLICE_SECONDS;
}

/** Enqueue timeout for a routine — always slice + 60s. */
export function maintTimeoutMsFor(routine) {
  return (maintSliceSecondsFor(routine) + 60) * 1000;
}

const MAINT_REENQUEUE_DELAY_MS = Number(process.env.ROBOTDOJO_MAINT_REENQUEUE_DELAY_MS || 30_000);
// How often, while a child runs, the handler re-checks the activity/idle gate
// and SIGTERMs the child if the user came back. 5s bounds the yield latency.
const CHILD_IDLE_RECHECK_MS = Number(process.env.ROBOTDOJO_MAINT_CHILD_RECHECK_MS || 5_000);
// st_fd14cdd4 AC9 — how often the handler re-checks the CHAT-APP-ACTIVE signal
// while a phase grandchild runs. The HID-idle recheck above (5s) is far too slow
// for the ≤1s writer-release the brief requires: a chat turn that lands while a
// phase holds the single SQLite writer would wait up to 5s for the SIGTERM. This
// dedicated FAST recheck mirrors the embedder's ACTIVITY_WATCH_MS (250ms) — the
// instant chat opens, the child is SIGTERM'd (a BENIGN abort → idempotent requeue,
// attempts unchanged, exactly like the idle-gate SIGTERM), so it stops acquiring
// the writer and the writer is free well within ~1s. Env-tunable.
const CHILD_APP_ACTIVE_RECHECK_MS = Number(process.env.ROBOTDOJO_MAINT_CHILD_APP_ACTIVE_RECHECK_MS || 500);

/**
 * Spawn a bounded child and resolve with a bounded-resumable result.
 * SIGTERMs the child if `idleDecision()` (the caller's activity/idle gate)
 * returns not-ok while it runs; a SIGTERM exit rejects with an AbortError so
 * runPassiveJob routes it to a benign requeue (attempts UNCHANGED — see the
 * WHY below), never to quarantine.
 *
 * @param {string} label for error messages (phase or script name)
 * @param {string[]} args full argv after the node binary
 * @param {object} [deps]
 * @param {() => {ok:boolean}} [deps.idleDecision]
 * @param {() => boolean} [deps.appActiveCheck] st_fd14cdd4 AC9 — chat-app-active
 *   predicate; when it returns true the child is SIGTERM'd on a FAST recheck
 *   (CHILD_APP_ACTIVE_RECHECK_MS, 500ms) so a phase releases the writer within ~1s
 *   of the chat app opening, far faster than the 5s HID-idle recheck. A SIGTERM
 *   here is the SAME benign AbortError → idempotent requeue path as the idle gate.
 * @param {AbortSignal} [deps.signal] master shutdown — SIGTERMs the child too
 * @param {(stdout:string, stderr:string) => boolean} [deps.partialMatcher]
 * @returns {Promise<{ok:boolean, label:string, partial:boolean, lockSkipped:boolean, stdout:string}>}
 */
export function runBoundedChild(label, args, { idleDecision = null, appActiveCheck = null, signal = null, partialMatcher = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const recheck = setInterval(() => {
      try {
        if (idleDecision && idleDecision().ok === false) child.kill('SIGTERM');
      } catch { /* idle-check failure must not kill the child */ }
    }, CHILD_IDLE_RECHECK_MS);
    recheck.unref?.();
    // st_fd14cdd4 AC9 — the FAST chat-app-active recheck. Separate timer (500ms vs
    // the 5s HID recheck) so a phase grandchild is SIGTERM'd within ~1s of the chat
    // app opening, releasing the single SQLite writer before the user's first turn.
    // A SIGTERM is routed to the benign AbortError requeue below, identical to the
    // idle-gate SIGTERM, so phase progress is idempotently resumed next window.
    const appRecheck = appActiveCheck
      ? setInterval(() => {
          try { if (appActiveCheck()) child.kill('SIGTERM'); }
          catch { /* app-active check failure must not kill the child */ }
        }, CHILD_APP_ACTIVE_RECHECK_MS)
      : null;
    appRecheck?.unref?.();
    const onMasterAbort = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
    signal?.addEventListener?.('abort', onMasterAbort, { once: true });

    const cleanup = () => {
      clearInterval(recheck);
      if (appRecheck) clearInterval(appRecheck);
      signal?.removeEventListener?.('abort', onMasterAbort);
    };

    child.on('exit', (code, sig) => {
      cleanup();
      if (sig === 'SIGTERM') {
        // Idle/activity pause — the user became active and we SIGTERM'd the
        // slice. This is a BENIGN interruption, NOT a real failure:
        // runPassiveJob routes an error named 'AbortError' to
        // requeuePassiveJob (attempts UNCHANGED, no march to quarantine).
        // Phase writes are idempotent so the re-queued slice safely resumes.
        // WHY this matters: under heavy chat load the activity gate fires
        // often; without the AbortError name a plain Error would consume an
        // attempt each time and quarantine a perfectly healthy routine after
        // max_attempts (observed live pre-st_2cd1af73: 5 jobs quarantined
        // purely from user-active SIGTERMs).
        const err = new Error(`${label} interrupted by SIGTERM (user-active)`);
        err.name = 'AbortError';
        return reject(err);
      }
      if (code === 0) {
        const partial = partialMatcher
          ? partialMatcher(stdout, stderr)
          : stdout.includes(MAINT_PARTIAL_PREFIX);
        const lockSkipped = stdout.includes(MAINT_LOCK_SKIP_TOKEN) || stderr.includes(MAINT_LOCK_SKIP_TOKEN);
        return resolve({ ok: true, label, partial: partial || lockSkipped, lockSkipped, stdout: stdout.slice(-500) });
      }
      return reject(new Error(`${label} exited ${code}: ${stderr.slice(-500)}`));
    });
    child.on('error', (err) => { cleanup(); reject(err); });
  });
}

/**
 * Run one maintenance phase slice: `scripts/maintenance-phases.js --phase
 * NAME --max-seconds N`. Exported for tests.
 */
export function runMaintenancePhase(job, routine, deps = {}) {
  const maxSeconds = Number(job?.payload?.maxSeconds) > 0
    ? Math.floor(Number(job.payload.maxSeconds))
    : maintSliceSecondsFor(routine);
  const args = [MAINT_PHASES_SCRIPT, '--phase', routine.phase, '--max-seconds', String(maxSeconds)];
  return runBoundedChild(`maintenance ${routine.phase}`, args, deps);
}

/**
 * Argv (after the script path) for a script-backed routine slice. Script args
 * derive from the job/routine payload: `source` becomes `--source X`,
 * `account` becomes `--account X` (provider-history sweeps are per-account —
 * st_fd14cdd4 reopen), and the slice budget is always passed for scripts that
 * honor `--max-seconds` (extras are ignored by scripts that don't parse them
 * — update-models takes no args and Node scripts only read argv they ask
 * for). Exported so tests pin the derivation without spawning a child.
 */
export function scriptRoutineArgs(job, routine) {
  const args = [];
  const extraArgs = Array.isArray(job?.payload?.args)
    ? job.payload.args
    : Array.isArray(routine.payload?.args)
      ? routine.payload.args
      : [];
  for (const arg of extraArgs) {
    if (arg !== undefined && arg !== null && String(arg).trim()) args.push(String(arg));
  }
  const source = job?.payload?.source || routine.payload?.source;
  if (source) args.push('--source', String(source));
  const account = job?.payload?.account || routine.payload?.account;
  if (account) args.push('--account', String(account));
  if (routine.script !== 'scripts/update-models.js') {
    args.push('--max-seconds', String(maintSliceSecondsFor(routine)));
  }
  return args;
}

/**
 * Run a script-backed routine slice (e.g. scripts/update-models.js,
 * scripts/backfill-participants.js).
 */
function runScriptRoutine(job, routine, deps = {}) {
  const script = join(REPO_ROOT, routine.script);
  const args = [script, ...scriptRoutineArgs(job, routine)];
  // backfill-participants reports residual work as `"partial": true` in its
  // JSON stdout (it exits 0 on a budget stop); match that alongside the
  // shared sentinel so a partial backfill re-enqueues like a partial phase.
  const partialMatcher = (stdout) => stdout.includes(MAINT_PARTIAL_PREFIX) || /"partial":\s*true/.test(stdout);
  return runBoundedChild(routine.script, args, { ...deps, partialMatcher });
}

/**
 * Re-enqueue a routine job when the just-completed slice was partial. The
 * follow-up runs after MAINT_REENQUEUE_DELAY_MS so other queue types get a
 * turn (fairness) and the idle gate re-checks on the new tick. requeueDone
 * revives the keyed row even when the prior slice is `done`.
 */
export function reenqueueMaintenanceSlice(database, enqueuePassiveJob, prevJob, routine) {
  try {
    const runAfter = new Date(Date.now() + MAINT_REENQUEUE_DELAY_MS).toISOString();
    const payload = {
      ...(prevJob?.payload || {}),
      ...(routine.phase ? { phase: routine.phase } : {}),
      maxSeconds: maintSliceSecondsFor(routine),
      resumed_from: prevJob?.id || null,
    };
    enqueuePassiveJob({
      database,
      jobType: routine.jobType,
      // Preserve the PREVIOUS job's keyed identity. Probe-seeded per-account
      // sweep jobs (st_fd14cdd4 reopen) carry uniqueKey
      // `participants_backfill:{source}:{email}` / targetType 'account'; a
      // re-enqueue that fell back to the routine's system/granola identity
      // would fork a SECOND row per slice and orphan the account-keyed one.
      uniqueKey: prevJob?.unique_key || undefined,
      targetType: prevJob?.target_type || 'system',
      targetId: prevJob?.target_id || routine.targetId || 'maintenance',
      priority: prevJob?.priority ?? routine.priority,
      timeoutMs: maintTimeoutMsFor(routine),
      runAfter,
      payload,
      metadata: { source: 'maintenance-partial-resume', prev_job_id: prevJob?.id || null },
      requeueDone: true,
    });
  } catch (err) {
    console.warn(`[maintenance] re-enqueue ${routine.jobType} failed:`, err.message);
  }
}

function enqueueRoutineSlice(database, enqueuePassiveJob, routine, { metadataSource, payload = {} } = {}) {
  return enqueuePassiveJob({
    database,
    jobType: routine.jobType,
    targetType: 'system',
    targetId: routine.targetId || 'maintenance',
    priority: routine.priority,
    timeoutMs: maintTimeoutMsFor(routine),
    payload: {
      ...(routine.phase ? { phase: routine.phase } : {}),
      maxSeconds: maintSliceSecondsFor(routine),
      ...payload,
    },
    metadata: { source: metadataSource },
    requeueDone: true,
  });
}

// pipeline_entities follows pipeline_ingest COMPLETION (AC8 disposition row
// 5): a full (non-partial) ingest pass means the graph's raw fold is current,
// so the structural entity pass should run next. Debounced on the routine's
// keyed row; a partial ingest re-enqueues ingest itself instead.
export function chainPipelineEntities(database, enqueuePassiveJob) {
  const routine = getRoutine('pipeline_entities');
  if (!routine) return null;
  try {
    return enqueueRoutineSlice(database, enqueuePassiveJob, routine, {
      metadataSource: 'pipeline-ingest-completion',
    });
  } catch (err) {
    console.warn('[maintenance] pipeline_entities chain enqueue failed:', err.message);
    return null;
  }
}

// pipeline_entities COMPLETION is the first moment source rows have become
// graph facts and relationship edges. Wake the context layer here, not at raw
// data-arrival time, so topic/entity context is regenerated from the current
// graph instead of racing ahead of ingest.
export async function chainDataArrivalContext(database, enqueuePassiveJob) {
  const queued = [];
  const routine = getRoutine('maint_topics');
  if (routine) {
    try {
      queued.push(enqueueRoutineSlice(database, enqueuePassiveJob, routine, {
        metadataSource: 'pipeline-entities-completion',
        payload: {
          trigger: 'pipeline-entities-completion',
          pipeline: 'source-enrichment',
        },
      }));
    } catch (err) {
      console.warn('[maintenance] maint_topics chain enqueue failed:', err.message);
    }
  }

  try {
    const [
      { getBBStatus },
      { enrichmentDecision },
      { reconcileEntityEnrich },
    ] = await Promise.all([
      import('./cohort/active.js'),
      import('./entity-enrich-policy.js'),
      import('./passive-reconciler.js'),
    ]);
    const bbStatus = await getBBStatus();
    const decision = enrichmentDecision({ bbActive: bbStatus?.active === true });
    if (decision.enabled) {
      const result = reconcileEntityEnrich(database, {
        source: 'pipeline-entities-completion',
        reason: 'data-arrival entity context backlog',
      });
      if (result.enqueued) queued.push({ job_type: 'entity_enrich', ...result });
    }
  } catch (err) {
    console.warn('[maintenance] entity_enrich chain enqueue failed:', err.message);
  }
  return queued;
}

/**
 * Build the full maintenance handler map: every declared routine plus
 * email_history_backfill. The caller injects `database`, `enqueuePassiveJob`
 * (for the partial-resume re-enqueue), an optional `idleDecision` gate, and an
 * optional master abort `signal`. The same map is used by the worker and tests.
 *
 * @param {object} deps
 * @param {object} deps.database better-sqlite3 connection
 * @param {Function} deps.enqueuePassiveJob enqueue fn (for partial re-enqueue)
 * @param {() => {ok:boolean}} [deps.idleDecision] activity/idle gate
 * @param {() => boolean} [deps.appActiveCheck] st_fd14cdd4 AC9 — chat-app-active
 *   predicate; SIGTERMs an in-flight phase grandchild on a fast recheck so a heavy
 *   phase releases the SQLite writer within ~1s of the chat app opening.
 * @param {AbortSignal} [deps.signal] master shutdown signal
 * @param {Function} [deps.runBackfillPass] override for tests (defaults to the
 *   lazily-imported scripts/backfill-email-history.js#runBackfillPass)
 * @returns {Record<string, (job:object)=>Promise<object>>}
 */
export function buildMaintenanceHandlers({ database, enqueuePassiveJob, idleDecision = null, appActiveCheck = null, signal = null, runBackfillPass = null } = {}) {
  const handlers = {};
  for (const routine of ROUTINES) {
    handlers[routine.jobType] = async (job) => {
      const result = routine.phase
        ? await runMaintenancePhase(job, routine, { idleDecision, appActiveCheck, signal })
        : await runScriptRoutine(job, routine, { idleDecision, appActiveCheck, signal });
      if (result?.partial) {
        reenqueueMaintenanceSlice(database, enqueuePassiveJob, job, routine);
      } else if (routine.jobType === 'pipeline_ingest') {
        chainPipelineEntities(database, enqueuePassiveJob);
      } else if (routine.jobType === 'pipeline_entities') {
        await chainDataArrivalContext(database, enqueuePassiveJob);
      }
      return result;
    };
  }
  handlers.email_history_backfill = async (job) => {
    const email = job?.payload?.email;
    if (!email) throw new Error('email_history_backfill missing payload.email');
    const chunk = Number(job?.payload?.chunk) || 3000;
    const pass = runBackfillPass || (await import('../scripts/backfill-email-history.js')).runBackfillPass;
    return pass({ email, chunk });
  };
  return handlers;
}

export const MAINTENANCE_JOB_TYPES = Object.freeze([
  ...new Set(ROUTINES.map((r) => r.jobType)),
  'email_history_backfill',
]);
