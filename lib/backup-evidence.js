/**
 * lib/backup-evidence.js — what happened to the last backup, including the
 * outcome nothing survives to report.
 *
 * THE PROBLEM THIS EXISTS FOR: a failed run and a run that never happened left
 * the same evidence — none. And a run the RAM watchdog SIGKILLs (it names
 * `node.*backup-to-gcp` and `gcloud.*rsync` as kill candidates below 10% free
 * RAM) runs no error path at all, so it is byte-identical to a run that never
 * started. Those two need different responses: one means memory pressure, the
 * other means the scheduler failed.
 *
 * THE MECHANISM: an attempt marker written BEFORE any work begins, and a
 * terminal record written after. The kill case falls out of the pair — a marker
 * with no terminal record, whose pid is gone or whose boot session has ended,
 * is a run that died without reporting. The evidence does not depend on the
 * dying process, which is the whole point: the guardian, alive after the kill,
 * does the inferring.
 *
 * WHY files and not the database: a marker must be writable before the 28 GB
 * encrypted database is opened, and while it may be locked by the very run the
 * marker describes. `backup:last_success` continues to mirror into kv_store so
 * the existing health probes keep working.
 *
 * POWERED-ON TIME lives here too, because it answers the same class of
 * question. `kern.boottime` is used ONLY to detect that a new boot session
 * began — never as the counter. A boot-reset counter reports zero powered-on
 * hours after a reboot while the backup is genuinely stale, which is this
 * defect's own scenario.
 *
 * Compute tier 0 — file reads, `sysctl`. No LLM call.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const OUTCOMES = Object.freeze(['succeeded', 'failed', 'skipped', 'never_started', 'killed']);

export function stateDir(configDir = process.env.ROBOTDOJO_CONFIG || join(homedir(), '.robotdojo')) {
  return join(configDir, 'state');
}

export function evidencePaths(configDir) {
  const dir = stateDir(configDir);
  return {
    dir,
    attempt: join(dir, 'backup-attempt.json'),
    terminal: join(dir, 'backup-terminal.json'),
    poweron: join(dir, 'backup-poweron.json'),
    // Written by scripts/backup-scan.js, read by lib/backup-guardian.js. The
    // path lives HERE so the guardian never has to import from scripts/ —
    // lib depending on scripts is the dependency inversion, not the reverse.
    scan: join(dir, 'backup-scan.json'),
  };
}

export function readScanReport(configDir) {
  return readJson(evidencePaths(configDir).scan);
}

export function atomicWriteJson(path, payload) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// ── boot session ─────────────────────────────────────────────────────────────

// Memoised for the process lifetime. `kern.boottime` cannot change while this
// process is alive — a reboot ends the process — and reading it costs a
// synchronous fork. This function is reached from the server-health body, which
// is on a request path, so paying that fork per call would be a self-inflicted
// latency regression in a codebase where chat speed is a P0.
let cachedBootSeconds;

/**
 * Seconds value from `kern.boottime`. A CHANGE in this number means a new boot
 * session; the number itself is never used as a clock. Returns null off macOS
 * or when sysctl is unavailable — callers treat null as "same session", which
 * errs toward crediting less time, not more.
 *
 * @param {Function} [exec] injectable for tests; an injected exec bypasses the cache
 */
export function currentBootSeconds(exec) {
  if (!exec && cachedBootSeconds !== undefined) return cachedBootSeconds;
  const run = exec || execFileSync;
  let value = null;
  try {
    const out = String(run('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }));
    const match = out.match(/sec\s*=\s*(\d+)/);
    value = match ? Number(match[1]) : null;
  } catch {
    value = null;
  }
  if (!exec) cachedBootSeconds = value;
  return value;
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ── attempt marker + terminal record ────────────────────────────────────────

/**
 * Writes the attempt marker. MUST be called before any real work — the marker's
 * whole value is that it survives a process that reports nothing.
 * Never throws: a backup must not fail because its bookkeeping did.
 */
export function writeAttemptMarker({ configDir, attemptId, trigger = 'unknown', pid = process.pid, bootSec, now = new Date() } = {}) {
  const paths = evidencePaths(configDir);
  const marker = {
    attempt_id: attemptId || `${Math.floor(now.getTime() / 1000)}-${pid}`,
    started_at: now.toISOString(),
    pid,
    boot_sec: bootSec === undefined ? currentBootSeconds() : bootSec,
    trigger,
  };
  try { atomicWriteJson(paths.attempt, marker); } catch { /* bookkeeping must never break the backup */ }
  return marker;
}

/**
 * Writes the terminal record for an attempt.
 * @param {'success'|'failure'|'skipped'} outcome
 */
export function writeTerminalRecord({ configDir, attemptId, outcome, reason = null, error = null, detail = null, now = new Date() } = {}) {
  const paths = evidencePaths(configDir);
  const record = {
    attempt_id: attemptId || null,
    finished_at: now.toISOString(),
    outcome,
    reason,
    error,
    detail,
  };
  try { atomicWriteJson(paths.terminal, record); } catch { /* see above */ }
  return record;
}

export function readEvidence(configDir) {
  const paths = evidencePaths(configDir);
  return { marker: readJson(paths.attempt), terminal: readJson(paths.terminal), poweron: readJson(paths.poweron) };
}

const TERMINAL_TO_OUTCOME = { success: 'succeeded', failure: 'failed', skipped: 'skipped' };

/**
 * Which of the five outcomes describes the last resolved attempt, and whether
 * a run is in flight right now.
 *
 * A marker is IN FLIGHT only when its pid is alive AND its boot session is the
 * current one. A marker whose process is gone is the `killed` outcome — a dead
 * run must never look like a running one, because a run that looks like it is
 * running suppresses the staleness alarm.
 *
 * @param {object|null} marker  attempt marker
 * @param {object|null} terminal terminal record
 * @param {object} ctx
 * @param {number|null} ctx.bootSec current boot session
 * @param {(pid:number)=>boolean} [ctx.pidAlive]
 * @returns {{outcome: string, attempt_id: string|null, in_flight: object|null, resolved_from: string}}
 */
export function deriveOutcome(marker, terminal, { bootSec = null, pidAlive = isProcessAlive } = {}) {
  const terminalOutcome = terminal ? (TERMINAL_TO_OUTCOME[terminal.outcome] || 'failed') : null;
  const markerResolved = Boolean(marker && terminal && terminal.attempt_id && terminal.attempt_id === marker.attempt_id);

  if (marker && !markerResolved) {
    const sameBoot = marker.boot_sec == null || bootSec == null || marker.boot_sec === bootSec;
    if (sameBoot && pidAlive(marker.pid)) {
      return {
        outcome: terminalOutcome || 'never_started',
        attempt_id: terminal?.attempt_id || null,
        in_flight: marker,
        resolved_from: terminal ? 'previous_terminal' : 'no_prior_attempt',
      };
    }
    // Marker with no terminal record, and its process is gone: the run died
    // without running an error path. This is the fifth outcome (AC5(a)).
    return { outcome: 'killed', attempt_id: marker.attempt_id, in_flight: null, resolved_from: 'orphaned_marker' };
  }

  if (terminalOutcome) {
    return { outcome: terminalOutcome, attempt_id: terminal.attempt_id || null, in_flight: null, resolved_from: 'terminal_record' };
  }
  return { outcome: 'never_started', attempt_id: null, in_flight: null, resolved_from: 'no_evidence' };
}

// ── scheduled-slot bookkeeping ───────────────────────────────────────────────

/**
 * The most recent occurrence of the daily scheduled slot at or before `now`.
 * Local time, because the LaunchAgent's StartCalendarInterval is local.
 */
export function lastScheduledSlot(now, { hour = 2, minute = 30 } = {}) {
  const slot = new Date(now.getTime());
  slot.setHours(hour, minute, 0, 0);
  if (slot.getTime() > now.getTime()) slot.setDate(slot.getDate() - 1);
  return slot;
}

/**
 * True when the last scheduled slot passed with no attempt covering it — the
 * `never started` outcome, and the T1 catch-up trigger.
 *
 * @param {object} ctx
 * @param {Date} ctx.now
 * @param {string|null} ctx.lastSuccessAt ISO of the last VERIFIED success
 * @param {string|null} ctx.lastAttemptAt ISO of the most recent attempt marker
 */
export function scheduledSlotMissed({ now, lastSuccessAt, lastAttemptAt, schedule } = {}) {
  const slot = lastScheduledSlot(now, schedule);
  const covered = [lastSuccessAt, lastAttemptAt]
    .filter(Boolean)
    .map((iso) => new Date(iso).getTime())
    .filter((ms) => Number.isFinite(ms));
  if (covered.length === 0) return true;
  return Math.max(...covered) < slot.getTime();
}

// ── powered-on accumulator ───────────────────────────────────────────────────

export const EMPTY_POWERON = Object.freeze({ poweron_seconds: 0, tick_at: null, boot_sec: null, since: null });

/**
 * Credit powered-on seconds for one guardian tick.
 *
 * Three properties, each asserted by tests:
 *
 *   1. Time the machine spent OFF is never credited. The guardian does not tick
 *      while the machine is off, and a boot-session change caps the credit at
 *      this session's uptime — so a 32-hour outage credits at most the seconds
 *      since boot.
 *   2. The counter survives reboot. It is persisted and only ever reset by a
 *      VERIFIED backup success.
 *   3. Sleep is credited as powered-on. Deliberate: over-counting fires the
 *      alarm early, under-counting fires it late or never.
 *
 * @param {object} state previous {poweron_seconds, tick_at, boot_sec}
 * @param {object} ctx
 * @param {Date} ctx.now
 * @param {number|null} ctx.bootSec current boot session seconds
 * @param {number} ctx.bootTimeMs wall-clock ms at which this session booted
 * @returns {object} next state
 */
export function accumulatePoweredOn(state, { now, bootSec = null, bootTimeMs = null } = {}) {
  const prev = state && Number.isFinite(state.poweron_seconds) ? state : EMPTY_POWERON;
  const nowMs = now.getTime();
  const tickAtMs = prev.tick_at ? new Date(prev.tick_at).getTime() : null;

  let credit = 0;
  if (Number.isFinite(tickAtMs)) {
    const gap = (nowMs - tickAtMs) / 1000;
    const newSession = prev.boot_sec != null && bootSec != null && prev.boot_sec !== bootSec;
    if (newSession) {
      // Only THIS session's uptime can count — everything between the previous
      // tick and this boot is time the machine was down.
      const uptime = Number.isFinite(bootTimeMs) ? (nowMs - bootTimeMs) / 1000 : 0;
      credit = Math.min(Math.max(uptime, 0), Math.max(gap, 0));
    } else {
      credit = gap;
    }
  }

  return {
    poweron_seconds: Math.max(0, prev.poweron_seconds + Math.max(0, credit)),
    tick_at: now.toISOString(),
    boot_sec: bootSec,
    since: prev.since || null,
  };
}

/** Reset the accumulator. Called ONLY on a verified backup success. */
export function resetPoweredOn({ now, bootSec = null } = {}) {
  return { poweron_seconds: 0, tick_at: now.toISOString(), boot_sec: bootSec, since: now.toISOString() };
}
