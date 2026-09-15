/**
 * Launch-safe database writer policy.
 *
 * This is the minimum viable D1 boundary: the interactive server keeps owning
 * normal app writes, while detached import workers and scheduled external
 * workers must opt in before they mutate the live SQLite database.
 */
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { idleGateDecision } from './idle-gate.js';
import { waitWhileChatAppActive } from './request-observer.js';

const STATE_DIR = process.env.ROBOTDOJO_STATE_DIR || resolve(homedir(), '.robotdojo');
const LOCK_PATH = process.env.ROBOTDOJO_EXTERNAL_DB_WRITER_LOCK
  || resolve(STATE_DIR, 'external-db-writer.lock');

// st_2cd1af73 AC-1 — a lock whose payload cannot be parsed (empty, truncated by
// a process killed mid-write, or corrupt) has no readable pid to liveness-check.
// We cannot tell from the payload whether its holder is alive, so we sweep it
// only after it has sat untouched (by file mtime) longer than this TTL — long
// enough that any real in-flight holder would have refreshed or released it.
// This is the self-healing path for the corpse-lock class: a launch writer that
// died holding the lock with an unreadable payload no longer blocks every later
// run forever.
//
// Read DYNAMICALLY (not cached at module load) so an ops override via env takes
// effect on the next launchd tick without a server restart — and so tests can
// set it per-case. Default 10 min.
function lockStaleTtlMs() {
  const raw = parseInt(process.env.ROBOTDOJO_EXTERNAL_DB_WRITER_LOCK_TTL_MS || '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 10 * 60_000;
}

function truthy(value) {
  return value === '1' || value === 'true' || value === 'yes';
}

export function detachedDbWritersEnabled(env = process.env) {
  return truthy(env.ROBOTDOJO_ALLOW_DETACHED_DB_WRITES);
}

export function detachedDbWriterDecision(workerName, env = process.env) {
  if (detachedDbWritersEnabled(env)) {
    return { ok: true, workerName, reason: 'explicit-env-allow' };
  }
  return {
    ok: false,
    workerName,
    reason: 'detached-db-writer-disabled',
    message: `[db-writer-policy] ${workerName} blocked: detached DB writers are disabled for launch. Set ROBOTDOJO_ALLOW_DETACHED_DB_WRITES=1 for a manual run.`,
  };
}

function readLock() {
  try { return JSON.parse(readFileSync(LOCK_PATH, 'utf8')); }
  catch { return null; }
}

function processAlive(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

// Age of the lock file by mtime, in ms; Infinity if it cannot be stat'd. Used
// only for the malformed-payload sweep, where no in-payload timestamp is
// readable. Clamped at 0: statSync().mtimeMs carries sub-millisecond precision
// and can read fractionally AHEAD of Date.now() (which truncates to integer
// ms) for a file written micro-seconds ago, yielding a small negative age. A
// just-written lock is age 0, never "negative age", so a TTL of 0 sweeps it.
function lockFileAgeMs() {
  try { return Math.max(0, Date.now() - statSync(LOCK_PATH).mtimeMs); }
  catch { return Infinity; }
}

// Remove the stale lock and re-attempt acquisition. Logs the sweep with the
// worker doing the sweep, the swept cause, and the dead holder (when known) so
// a self-healed corpse-lock is visible in ops logs instead of silent. Returns
// an explicit failure shape if the unlink itself fails.
function sweepAndRetry(workerName, depth, cause, deadHolder) {
  const who = deadHolder
    ? `${deadHolder.workerName || 'unknown'} pid=${deadHolder.pid ?? '?'}`
    : 'unparseable payload';
  console.log(`[db-writer-policy] ${workerName} swept stale lock (${cause}): ${who}`);
  try {
    unlinkSync(LOCK_PATH);
  } catch (unlinkErr) {
    // ENOENT means another racer already swept it — fall through to a retry,
    // which will succeed or re-observe a fresh holder.
    if (unlinkErr?.code !== 'ENOENT') {
      return {
        ok: false,
        reason: 'stale-lock-unlink-failed',
        error: unlinkErr.message,
        existing: deadHolder || null,
        lockPath: LOCK_PATH,
      };
    }
  }
  return acquireLock(workerName, depth + 1);
}

function acquireLock(workerName, depth = 0) {
  mkdirSync(STATE_DIR, { recursive: true });
  const payload = {
    workerName,
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  try {
    const fd = openSync(LOCK_PATH, 'wx');
    writeFileSync(fd, JSON.stringify(payload, null, 2));
    closeSync(fd);
    return { ok: true, lockPath: LOCK_PATH, payload };
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      return { ok: false, reason: 'lock-error', error: err.message, lockPath: LOCK_PATH };
    }
    // Bound the sweep→retry recursion: one sweep of a dead holder, one of a
    // malformed payload, then give up so we never spin.
    if (depth > 1) {
      return { ok: false, reason: 'stale-lock-retry-exhausted', existing: readLock(), lockPath: LOCK_PATH };
    }
    const existing = readLock();
    if (existing) {
      // Readable payload: sweep ONLY if the named holder pid is dead. A live
      // holder is always respected — never sweep a process that is still
      // running (process.kill(pid,0) succeeds).
      if (!processAlive(existing.pid)) {
        return sweepAndRetry(workerName, depth, 'dead-holder', existing);
      }
      return { ok: false, reason: 'locked', existing, lockPath: LOCK_PATH };
    }
    // Unparseable payload (empty/truncated/corrupt — e.g. a writer killed
    // mid-write). No pid to liveness-check, so sweep only after the file has
    // sat untouched past the TTL; otherwise treat as a fresh in-flight write.
    if (lockFileAgeMs() >= lockStaleTtlMs()) {
      return sweepAndRetry(workerName, depth, 'malformed-payload-ttl', null);
    }
    return { ok: false, reason: 'locked-unparseable', existing: null, lockPath: LOCK_PATH };
  }
}

function releaseLock(lock) {
  if (!lock?.ok) return;
  const existing = readLock();
  if (existing?.pid === process.pid) {
    try { unlinkSync(LOCK_PATH); } catch {}
  }
}

export function scheduledDbWriterGuard(workerName, opts = {}) {
  if (opts.dryRun) return { ok: true, workerName, dryRun: true, release: () => {} };
  if (truthy(process.env.ROBOTDOJO_DISABLE_SCHEDULED_DB_WRITERS)) {
    return {
      ok: false,
      workerName,
      reason: 'scheduled-db-writers-disabled',
      message: `[db-writer-policy] ${workerName} skipped: scheduled DB writers disabled by ROBOTDOJO_DISABLE_SCHEDULED_DB_WRITERS.`,
    };
  }
  const lock = acquireLock(workerName);
  if (!lock.ok) {
    return {
      ok: false,
      workerName,
      reason: lock.reason,
      message: `[db-writer-policy] ${workerName} skipped: external DB writer lock unavailable (${lock.reason}).`,
      lock,
    };
  }
  return { ok: true, workerName, lock, release: () => releaseLock(lock) };
}

export async function withScheduledDbWriterGuard(workerName, fn, opts = {}) {
  const guard = scheduledDbWriterGuard(workerName, opts);
  if (!guard.ok) {
    console.log(guard.message);
    return { skipped: true, reason: guard.reason };
  }
  try {
    return await fn();
  } finally {
    guard.release();
  }
}

export async function withLaunchDbWriterGuard(workerName, fn, opts = {}) {
  const guard = scheduledDbWriterGuard(workerName, opts);
  if (!guard.ok) {
    console.log(guard.message);
    return { skipped: true, reason: guard.reason };
  }

  if (opts.idleGated !== false) {
    const idle = idleGateDecision(workerName);
    if (!idle.ok) {
      console.log(idle.message);
      guard.release();
      return { skipped: true, reason: idle.reason };
    }
  }

  try {
    return await fn();
  } finally {
    guard.release();
  }
}

/**
 * st_1cfe9061 — withChatYieldingWrite: wraps withLaunchDbWriterGuard and
 * exposes a yield() hook the caller invokes between sub-batch writes. Before
 * each bounded write unit, fn awaits yield(), which polls waitWhileChatAppActive
 * and pauses if chat is active. If aborted (signal), fn may skip remaining units.
 *
 * @param {string} workerName
 * @param {(ctx: { yield: () => Promise<boolean> }) => Promise<any>} fn
 * @param {import('better-sqlite3-multiple-ciphers').Database} db - the robotdojo.db connection for activity polling
 * @param {{ signal?: AbortSignal, idleGated?: boolean }} [opts]
 */
export async function withChatYieldingWrite(workerName, fn, db, opts = {}) {
  const signal = opts.signal || null;
  const yieldToChat = () => waitWhileChatAppActive(db, { signal });
  return withLaunchDbWriterGuard(workerName, () => fn({ yield: yieldToChat }), opts);
}
