/**
 * lib/backup-guardian.js — the thing that notices the backup did not happen.
 *
 * THE CONSTRAINT THAT PICKED THE CARRIER (df_3df1f108 AC2(b), AC4(a2)): in the
 * scenario this defect describes the machine is off, so the backup does not
 * run. A staleness check hosted inside the backup job, its dispatcher, or its
 * LaunchAgent would not run either, and the owner would never be told. Same for
 * an auto-push that rides the backup. So the carrier must be independent of the
 * backup having run.
 *
 * It runs inside the always-on server process (`com.robotdojo.server`), started
 * by the in-process supervisor. Different process, different LaunchAgent, alive
 * whether or not a backup has ever run. Against the alternative — a dedicated
 * `com.robotdojo.*-watchdog` agent — the server wins on the property that
 * matters: ITS DEATH IS LOUD. Chat is the product; a dead server is noticed in
 * minutes. A dead watchdog agent is noticed by nobody. Both designs depend on
 * something staying alive; only one of them tells the owner when it doesn't.
 *
 * THE THREE BOUNDS ARE CHOSEN AS A SYSTEM, not one at a time. An earlier draft
 * set them independently and produced a contradiction: a catch-up run still
 * legitimately inside its own completion allowance would have tripped the
 * staleness alarm while succeeding — and a detector that fires wrongly trains
 * the owner to discount it, which destroys the capability it buys. Two
 * inequalities constrain them, and tests/backup-interval-composition.test.js
 * asserts the inequalities rather than the numbers, so a future edit to any one
 * constant fails the build instead of silently re-creating a false-alarm
 * generator:
 *
 *   1. No alarm on a healthy run:  DUE + MAX_RUN <= ALARM   (18 + 2 <= 21)
 *   2. Detection inside the ceiling: ALARM + MAX_RUN <= 24   (21 + 2 <= 23)
 *
 * TWO DISPATCH TRIGGERS, not one. The powered-on threshold alone does not
 * satisfy AC1's second bound. In this defect's own timeline — last success
 * 07-24 03:13, machine down 16:54 through 07-25 10:02 — the accumulator stands
 * at 13 h 41 m at boot and would not reach 18 h until 14:21, four hours after
 * the machine came back. So a missed SLOT is its own trigger.
 *
 * Compute tier 0 throughout — file reads, `git` subprocesses, `sysctl`. No LLM
 * call anywhere in this module.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accumulatePoweredOn,
  atomicWriteJson,
  currentBootSeconds,
  deriveOutcome,
  evidencePaths,
  isProcessAlive,
  lastScheduledSlot,
  readEvidence,
  readJson,
  readScanReport,
  resetPoweredOn,
  scheduledSlotMissed,
} from './backup-evidence.js';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..');
const DISPATCHER = join(REPO_ROOT, 'scripts', 'backup-dispatcher.js');
const SCAN_SCRIPT = join(REPO_ROOT, 'scripts', 'backup-scan.js');

// ── Bounds ───────────────────────────────────────────────────────────────────
// D — powered-on hours after which a catch-up is due.
export const DUE_POWERON_HOURS = 18;
// C — the completion allowance for one run. The observed full strict run is 43
// minutes (02:30 → 03:13), so this is ~2.8x the observed case. It is NOT 3
// hours: a bound that generous cannot coexist with an alarm inside the 24-hour
// ceiling, and a run past 2 hours is not healthy-but-slow, it is past its
// allowance and the alarm should say so.
export const MAX_RUN_HOURS = 2;
// A — powered-on hours after which silence raises the alarm. Sitting 3 hours
// above the due threshold gives the catch-up a full repair window first.
export const ALARM_POWERON_HOURS = 21;
// The powered-on ceiling the owner approved, verbatim: "1 24 hours yes".
export const POWERON_CEILING_HOURS = 24;

export const TICK_MS = 60_000;
// A 28 GB read starting the moment the server comes up would contend with login
// warmup and the morning sync. Apple explicitly warns about speculative work at
// load, so the first dispatch waits out a boot settle.
export const BOOT_SETTLE_MS = 10 * 60_000;
export const DISPATCH_WITHIN_MS = 30 * 60_000;
export const PUSH_SCAN_MS = 10 * 60_000;
export const COVERAGE_SCAN_MS = 6 * 60 * 60_000;
// An alarm that repeats every tick is noise. One task per fault per 6 hours.
export const ALERT_REPEAT_MS = 6 * 60 * 60_000;
export const SCHEDULE = Object.freeze({ hour: 2, minute: 30 });

const HOUR_MS = 3_600_000;

export function guardianStatePath(configDir) {
  return join(evidencePaths(configDir).dir, 'backup-guardian.json');
}

// ── Pure decisions ───────────────────────────────────────────────────────────

/**
 * Is a marker a run that is actually happening right now?
 *
 * A marker whose process is gone is the `killed` outcome — it suppresses
 * nothing and alarms immediately. A dead run must never look like a running
 * one, because a running one silences the alarm.
 */
export function inFlightRun(marker, terminal, { bootSec = null, pidAlive = isProcessAlive } = {}) {
  if (!marker) return null;
  if (terminal && terminal.attempt_id && terminal.attempt_id === marker.attempt_id) return null;
  const sameBoot = marker.boot_sec == null || bootSec == null || marker.boot_sec === bootSec;
  if (!sameBoot) return null;
  if (!pidAlive(marker.pid)) return null;
  return marker;
}

/**
 * The alarm's three-state table. Written as data so both directions of the
 * suppression are testable: suppression without an expiry would let a wedged
 * run silence the alarm indefinitely — the hung-job fault absence monitoring
 * exists to catch.
 *
 *   poweron < A                            → no alarm
 *   poweron >= A, in flight, age < C       → no alarm, suppressed until started_at + C
 *   poweron >= A, in flight, age >= C      → ALARM 'run_hung'
 *   poweron >= A, no run in flight         → ALARM 'stale_no_run'
 */
export function evaluateStaleness({
  poweronSeconds = 0,
  inFlight = null,
  now = new Date(),
  alarmHours = ALARM_POWERON_HOURS,
  maxRunHours = MAX_RUN_HOURS,
} = {}) {
  if (poweronSeconds < alarmHours * 3600) {
    return { alarm: false, reason: null, poweron_hours: poweronSeconds / 3600, suppressed_until: null };
  }
  if (inFlight) {
    const startedMs = new Date(inFlight.started_at).getTime();
    const ageMs = Number.isFinite(startedMs) ? now.getTime() - startedMs : Infinity;
    if (ageMs < maxRunHours * HOUR_MS) {
      return {
        alarm: false,
        reason: null,
        poweron_hours: poweronSeconds / 3600,
        suppressed_until: new Date(startedMs + maxRunHours * HOUR_MS).toISOString(),
      };
    }
    return {
      alarm: true,
      reason: 'run_hung',
      poweron_hours: poweronSeconds / 3600,
      suppressed_until: null,
      detail: `backup running since ${inFlight.started_at} — past its ${maxRunHours}h allowance`,
    };
  }
  return {
    alarm: true,
    reason: 'stale_no_run',
    poweron_hours: poweronSeconds / 3600,
    suppressed_until: null,
    detail: `no verified backup in ${(poweronSeconds / 3600).toFixed(1)}h of powered-on time and nothing is running`,
  };
}

/**
 * Whether to dispatch a catch-up, and under which trigger.
 *
 * T1 — MISSED SLOT. A scheduled slot passed since the last verified success and
 * no attempt covers it. Forces: it stands in for a missed scheduled run, which
 * is gate-mandated to make a real attempt.
 *
 * T2 — POWERED-ON DUE-NESS. 18 hours accumulated since the last verified
 * success. Does NOT force: it lands in the owner's evening, so it respects the
 * RAM gate and a low-RAM deferral is recorded as `skipped` and retried next
 * tick. The 3 hours between D and A is the retry window; if every retry defers,
 * the alarm fires, which is correct.
 */
export function decideDispatch({
  now = new Date(),
  poweronSeconds = 0,
  inFlight = null,
  lastSuccessAt = null,
  lastAttemptAt = null,
  bootSettled = true,
  dueHours = DUE_POWERON_HOURS,
  schedule = SCHEDULE,
} = {}) {
  if (inFlight) return { dispatch: false, trigger: null, force: false, reason: 'run_in_flight' };
  if (!bootSettled) return { dispatch: false, trigger: null, force: false, reason: 'boot_settle' };

  if (scheduledSlotMissed({ now, lastSuccessAt, lastAttemptAt, schedule })) {
    return {
      dispatch: true,
      trigger: 'missed_slot',
      force: true,
      reason: `scheduled slot ${lastScheduledSlot(now, schedule).toISOString()} passed with no attempt`,
    };
  }
  if (poweronSeconds >= dueHours * 3600) {
    return {
      dispatch: true,
      trigger: 'poweron_due',
      force: false,
      reason: `${(poweronSeconds / 3600).toFixed(1)}h powered-on since last verified success`,
    };
  }
  return { dispatch: false, trigger: null, force: false, reason: 'fresh' };
}

// ── Persisted guardian state ─────────────────────────────────────────────────

const EMPTY_GUARDIAN = Object.freeze({
  started_at: null,
  last_tick_at: null,
  last_dispatch_at: null,
  last_dispatch_trigger: null,
  last_push_scan_at: null,
  last_coverage_scan_at: null,
  alerts: {},
  staleness: null,
  push: null,
  coverage: null,
});

export function readGuardianState(configDir) {
  return { ...EMPTY_GUARDIAN, ...(readJson(guardianStatePath(configDir)) || {}) };
}

function writeGuardianState(configDir, state) {
  try { atomicWriteJson(guardianStatePath(configDir), state); } catch { /* never break the tick */ }
}

/**
 * The guardian's view of the world, for `/api/server-health` and for the backup
 * health probe. Pure file reads — safe to call on a request path.
 */
export function readGuardianStatus(configDir) {
  const state = readGuardianState(configDir);
  const { marker, terminal, poweron } = readEvidence(configDir);
  const bootSec = currentBootSeconds();
  const flight = inFlightRun(marker, terminal, { bootSec });
  const poweronSeconds = poweron?.poweron_seconds ?? 0;
  const staleness = evaluateStaleness({ poweronSeconds, inFlight: flight, now: new Date() });
  const outcome = deriveOutcome(marker, terminal, { bootSec });
  return {
    running: Boolean(state.started_at),
    last_tick_at: state.last_tick_at,
    poweron_seconds: poweronSeconds,
    poweron_hours: Number((poweronSeconds / 3600).toFixed(2)),
    due_poweron_hours: DUE_POWERON_HOURS,
    alarm_poweron_hours: ALARM_POWERON_HOURS,
    max_run_hours: MAX_RUN_HOURS,
    next_due_in_hours: Number(Math.max(0, DUE_POWERON_HOURS - poweronSeconds / 3600).toFixed(2)),
    last_dispatch_at: state.last_dispatch_at,
    last_dispatch_trigger: state.last_dispatch_trigger,
    last_outcome: outcome.outcome,
    in_flight: flight ? { attempt_id: flight.attempt_id, started_at: flight.started_at, trigger: flight.trigger } : null,
    stale: staleness.alarm,
    stale_reason: staleness.reason,
    suppressed_until: staleness.suppressed_until,
    unpushed: state.push?.single_copy ?? null,
    uncovered: state.coverage?.uncovered_count ?? null,
  };
}

// ── Alert delivery ───────────────────────────────────────────────────────────

/**
 * PUSHED to the owner, not parked on a dashboard he has to open. Asana is his
 * own stated channel ("i want errors and system issues to surface via an asana
 * task") and is in daily use by gate.js and the maintenance phases.
 *
 * `createNotificationTask` returns null on error and never throws, so a
 * swallowed null is the exact failure mode to guard against — the email
 * fallback exists for that, and a failure to deliver either way is recorded so
 * the next tick retries rather than the alarm being lost.
 */
export async function deliverAlert(title, body, { asana, email, ownerEmail } = {}) {
  let gid = null;
  try {
    const createNotificationTask = asana || (await import('./asana.js')).createNotificationTask;
    gid = await createNotificationTask(title, body);
  } catch (err) {
    console.warn(`[backup-guardian] asana alert threw: ${err?.message || err}`);
  }
  if (gid) return { delivered: true, channel: 'asana', id: gid };

  try {
    const sendEmail = email || (await import('./email.js')).sendEmail;
    const to = ownerEmail || (await import('./identity.js')).ownerEmails()[0];
    if (to) {
      await sendEmail({ to, subject: title, text: body });
      return { delivered: true, channel: 'email', id: null };
    }
  } catch (err) {
    console.warn(`[backup-guardian] email alert failed: ${err?.message || err}`);
  }
  return { delivered: false, channel: null, id: null };
}

/** Rate limit: one alert per fault key per ALERT_REPEAT_MS. */
export function shouldAlert(state, key, now, repeatMs = ALERT_REPEAT_MS) {
  const last = state.alerts?.[key];
  if (!last) return true;
  const lastMs = new Date(last).getTime();
  if (!Number.isFinite(lastMs)) return true;
  return now.getTime() - lastMs >= repeatMs;
}

// ── The tick ─────────────────────────────────────────────────────────────────

let timer = null;
let started = false;
let startedAtMs = null;

function dispatchBackup(trigger, force) {
  const args = [DISPATCHER, '--strict', `--trigger=${trigger}`];
  if (force) args.push('--force-scheduled');
  spawn(process.execPath, args, { detached: true, stdio: 'ignore', cwd: REPO_ROOT }).unref();
}

/** Fire the heavy scans into their own process. Fire-and-forget by design. */
function spawnScan({ push, coverage }) {
  const args = [SCAN_SCRIPT];
  if (push) args.push('--push');
  if (coverage) args.push('--coverage');
  spawn(process.execPath, args, { detached: true, stdio: 'ignore', cwd: REPO_ROOT }).unref();
}

/**
 * One guardian tick. Every dependency is injectable so the whole decision path
 * is testable without a clock, a backup, or a network call.
 */
export async function guardianTick({
  now = new Date(),
  configDir,
  bootSec = currentBootSeconds(),
  // `kern.boottime` seconds ARE the wall-clock instant this session began, so
  // the same reading serves as both the session id and the uptime origin. It is
  // never used as the counter — only to cap how much a new session may credit.
  bootTimeMs = bootSec != null ? bootSec * 1000 : null,
  dispatch = dispatchBackup,
  alert = deliverAlert,
  scan = spawnScan,
  pushEnabled = true,
  coverageEnabled = true,
  bootSettleFromMs = startedAtMs,
} = {}) {
  const state = readGuardianState(configDir);
  const paths = evidencePaths(configDir);
  const { marker, terminal, poweron } = readEvidence(configDir);

  // ── 1. Powered-on accumulation ───────────────────────────────────────────
  const successAt = terminal?.outcome === 'success' ? terminal.finished_at : null;
  let poweronNext;
  if (successAt && (!poweron?.since || new Date(successAt).getTime() > new Date(poweron.since).getTime())) {
    // A verified success is the ONLY thing that resets the counter. Not a boot,
    // not a restart, not an attempt — this defect's scenario is precisely a
    // reboot with a genuinely stale backup.
    poweronNext = resetPoweredOn({ now, bootSec });
    poweronNext.since = successAt;
  } else {
    poweronNext = accumulatePoweredOn(poweron, { now, bootSec, bootTimeMs });
  }
  try { atomicWriteJson(paths.poweron, poweronNext); } catch { /* never break the tick */ }

  const flight = inFlightRun(marker, terminal, { bootSec });
  const poweronSeconds = poweronNext.poweron_seconds;

  // ── 2. Catch-up dispatch ─────────────────────────────────────────────────
  const bootSettled = bootSettleFromMs == null || (now.getTime() - bootSettleFromMs) >= BOOT_SETTLE_MS;
  const decision = decideDispatch({
    now,
    poweronSeconds,
    inFlight: flight,
    lastSuccessAt: successAt,
    lastAttemptAt: marker?.started_at || null,
    bootSettled,
  });
  if (decision.dispatch) {
    try {
      dispatch(decision.trigger, decision.force);
      state.last_dispatch_at = now.toISOString();
      state.last_dispatch_trigger = decision.trigger;
      console.info(`[backup-guardian] dispatched catch-up (${decision.trigger}): ${decision.reason}`);
    } catch (err) {
      console.warn(`[backup-guardian] dispatch failed: ${err?.message || err}`);
    }
  }

  // ── 3. Staleness alarm ───────────────────────────────────────────────────
  const staleness = evaluateStaleness({ poweronSeconds, inFlight: flight, now });
  state.staleness = staleness;
  if (staleness.alarm && shouldAlert(state, `stale:${staleness.reason}`, now)) {
    const result = await alert(
      `Backup stale — ${staleness.reason === 'run_hung' ? 'run hung' : 'no backup completed'}`,
      [
        staleness.detail,
        `Powered-on time since the last verified backup: ${(poweronSeconds / 3600).toFixed(1)}h (alarm at ${ALARM_POWERON_HOURS}h).`,
        `Last attempt: ${marker?.started_at || 'none recorded'}.`,
        `Last verified success: ${successAt || 'none recorded'}.`,
        'Run `node scripts/backup-status.js` for the full record.',
      ].join('\n'),
    );
    if (result?.delivered) {
      state.alerts = { ...state.alerts, [`stale:${staleness.reason}`]: now.toISOString() };
    } else {
      console.warn('[backup-guardian] staleness alert undelivered — retrying next tick');
    }
  }

  // ── 4. Auto-push and coverage scans, OFF this thread ─────────────────────
  // Committed work reaches a remote within 30 minutes of being committed, and
  // it does NOT ride the backup — same constraint as the alarm, same reason.
  //
  // Both scans are SPAWNED, never run inline. The coverage audit walks 224K
  // ignored files (~5.7 s measured) and the push scan ends in `git push`, which
  // is network I/O of unbounded duration. The guardian lives in the server
  // process, and this codebase already paid for heavy synchronous work there —
  // the supervisor's own history records 12–70 s main-thread stalls that froze
  // every chat turn. The child writes a report; the next tick reads it.
  const dueForPush = pushEnabled
    && (!state.last_push_scan_at || now.getTime() - new Date(state.last_push_scan_at).getTime() >= PUSH_SCAN_MS);
  const dueForCoverage = coverageEnabled
    && (!state.last_coverage_scan_at || now.getTime() - new Date(state.last_coverage_scan_at).getTime() >= COVERAGE_SCAN_MS);
  if (dueForPush || dueForCoverage) {
    if (dueForPush) state.last_push_scan_at = now.toISOString();
    if (dueForCoverage) state.last_coverage_scan_at = now.toISOString();
    try { scan({ push: dueForPush, coverage: dueForCoverage }); }
    catch (err) { console.warn(`[backup-guardian] scan spawn failed: ${err?.message || err}`); }
  }

  // ── 5. Alert on whatever the last completed scan found ───────────────────
  const report = readScanReport(configDir) || {};
  state.push = report.push
    ? { pushed: report.push.pushed || [], single_copy: (report.push.problems || []).length, at: report.push.at }
    : state.push;
  state.coverage = report.coverage
    ? { uncovered_count: report.coverage.uncovered_count, at: report.coverage.at }
    : state.coverage;

  const pushProblems = report.push?.problems || [];
  if (pushProblems.length && shouldAlert(state, 'push', now)) {
    const result = await alert(
      'Committed work is held on one disk',
      [
        'These repositories carry commit history no remote holds. `.git` is excluded from the cloud copy,',
        'so losing this machine loses that history. Nothing was force-pushed.',
        '',
        ...pushProblems.map((p) => `- [${p.kind}] ${p.detail}`),
      ].join('\n'),
    );
    if (result?.delivered) state.alerts = { ...state.alerts, push: now.toISOString() };
  }

  const uncovered = report.coverage?.uncovered || [];
  if (uncovered.length && shouldAlert(state, 'coverage', now)) {
    const result = await alert(
      `${report.coverage.uncovered_count} file(s) held by neither GitHub nor the cloud copy`,
      [
        'These files exist on this machine only. Losing it loses them.',
        '',
        ...uncovered.map((entry) => `- ${entry.path}${entry.reason ? ` (${entry.reason})` : ''}`),
      ].join('\n'),
    );
    if (result?.delivered) state.alerts = { ...state.alerts, coverage: now.toISOString() };
  }

  state.last_tick_at = now.toISOString();
  writeGuardianState(configDir, state);
  return { poweron: poweronNext, decision, staleness, state };
}

/**
 * Start the guardian. Idempotent. Disabled under the same switches as the rest
 * of the supervisor so tests and headless runs never dispatch a real backup.
 */
export function startBackupGuardian() {
  if (started) return false;
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.ROBOTDOJO_SUPERVISOR_ENABLED === '0') return false;
  if (process.env.ROBOTDOJO_DISABLE_BACKGROUND === '1') return false;
  if (process.env.ROBOTDOJO_BACKUP_GUARDIAN === '0') return false;
  started = true;
  startedAtMs = Date.now();

  const state = readGuardianState();
  state.started_at = new Date().toISOString();
  writeGuardianState(undefined, state);

  const run = () => {
    guardianTick({ bootSettleFromMs: startedAtMs }).catch((err) => {
      console.warn(`[backup-guardian] tick failed: ${err?.message || err}`);
    });
  };
  // First tick within 60s so the powered-on clock starts immediately; the
  // 10-minute boot settle gates the DISPATCH, not the accounting.
  timer = setInterval(run, TICK_MS);
  timer.unref?.();
  setTimeout(run, 5_000).unref?.();
  console.info(`[backup-guardian] started — due=${DUE_POWERON_HOURS}h alarm=${ALARM_POWERON_HOURS}h allowance=${MAX_RUN_HOURS}h`);
  return true;
}

export function stopBackupGuardian() {
  if (timer) { clearInterval(timer); timer = null; }
  started = false;
  startedAtMs = null;
}

/** Health snapshot for `/api/server-health`. Never throws. */
export function guardianHealthSnapshot() {
  try {
    return readGuardianStatus();
  } catch (err) {
    return { running: false, error: err?.message || 'backup guardian status unavailable' };
  }
}
