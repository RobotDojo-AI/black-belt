/**
 * lib/idle-gate.js — st_f6315f0b
 *
 * The single primitive every CPU-intensive background worker shares.
 *
 * Three exports, three jobs:
 *   - getIdleSeconds()                 → seconds since the user last touched the machine
 *   - enforceIdleGate(workerName)      → if user is active, exit 0 within 1s (skip the workload)
 *   - installCancelHandler(ac, db)     → SIGTERM → abort in-flight HTTP + safe DB shutdown
 *
 * WHY this is one tiny module and not a sprawling framework:
 *   The previous attempt (st_b9c149b8) shipped a 923-line resource-watchdog daemon
 *   and was reverted on overengineering grounds 70 minutes after the build commit.
 *   The whole defect resolves with one shared primitive + one declaration per
 *   entrypoint + a small watchdog extension. Anything more is rope.
 *
 * WHY HIDIdleTime (and not chat_turn_metrics):
 *   ioreg's HIDIdleTime reports seconds since the last keyboard/mouse/trackpad
 *   event from the kernel. It captures activity regardless of which app — chat,
 *   accounts, terminal, browser — so a user reading a long doc with the laptop
 *   physically open still resets it. chat_turn_metrics only captures chat. We
 *   want the broadest possible "user is here" signal. (Research: macOS
 *   Developer Forums #721530, Karabiner-Elements issue #385 — both confirm
 *   HIDIdleTime is the right primitive on a standard Apple-Silicon laptop;
 *   Karabiner/Screen-Sharing edge cases don't apply to typical user hardware.)
 *
 * WHY no dependencies beyond Node built-ins:
 *   This module is imported at the top of every IDLE_GATED worker. An import
 *   failure here crashes every background worker. The dependency-free posture
 *   keeps the blast radius at zero.
 *
 * Testing hooks (env vars):
 *   IDLE_FIXTURE_SECONDS    → override getIdleSeconds() to return this integer
 *   IDLE_GATE_THRESHOLD     → override the 300-second threshold (used in tests)
 *   RSS_FIXTURE_MB          → override workerRssMb() to return this integer
 *   ROBOTDOJO_EMBED_RSS_CEILING_MB → override the self-imposed RSS ceiling
 *
 * st_b50005df Phase 3 — bounded RSS + HID-idle hard-pause:
 *   rssCeilingDecision()  → is this worker's resident set above its self-cap?
 *   idlePauseDecision()   → has the user returned (HID idle below threshold)?
 *   Both are the per-batch "should the embed loop keep trickling" checks. The
 *   embed loop calls them between bounded batches and stops cleanly (benign
 *   re-queue, attempts unchanged) when either fires. Stopping on the RSS
 *   ceiling lets launchd respawn the worker fresh on its next 120s fire — that
 *   respawn IS the embed-subprocess restart that drops RSS back to baseline
 *   BEFORE the OS jetsam path would kill it. Research (st_b50005df 01): an
 *   in-process guard cannot prevent the OS kill, so the worker must (a) stay
 *   structurally small and (b) survive being killed — this is the (a) backstop.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// Read the 5-minute threshold from config/defaults.json. Centralising the
// constant means a future tuning story changes one file, not 13.
let IDLE_THRESHOLD_SECONDS = 300;
try {
  const raw = readFileSync(
    resolve(homedir(), 'robotdojo', 'config', 'defaults.json'),
    'utf8',
  );
  const cfg = JSON.parse(raw);
  if (cfg?.idleGate?.thresholdSeconds && Number.isFinite(cfg.idleGate.thresholdSeconds)) {
    IDLE_THRESHOLD_SECONDS = cfg.idleGate.thresholdSeconds;
  }
} catch {
  // No defaults.json or no idleGate section — keep the safe 300s default.
  // Workers must not crash because a config file is missing.
}
if (process.env.IDLE_GATE_THRESHOLD) {
  const override = Number(process.env.IDLE_GATE_THRESHOLD);
  if (Number.isFinite(override) && override >= 0) IDLE_THRESHOLD_SECONDS = override;
}

/**
 * Read macOS `HIDIdleTime` — seconds since the last HID event
 * (keyboard, mouse, trackpad). Returns 0 on parse failure, which the
 * gate treats as "user is active" — the safe-fail direction.
 *
 * Env override: IDLE_FIXTURE_SECONDS=N → return N without invoking ioreg.
 * Used by all qa runners so they don't depend on the live machine state.
 *
 * @returns {number} idle seconds (integer ≥ 0)
 */
export function getIdleSeconds() {
  if (process.env.IDLE_FIXTURE_SECONDS !== undefined) {
    const fixture = Number(process.env.IDLE_FIXTURE_SECONDS);
    if (!Number.isFinite(fixture) || fixture < 0) return 0;
    return Math.floor(fixture);
  }

  // ioreg output looks like:  "HIDIdleTime" = 1234567890
  // The value is in nanoseconds; divide by 1e9 for seconds. We pipe through
  // a 2-second hard timeout because a hung ioreg would deadlock every worker.
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    // Match the FIRST HIDIdleTime line. Multiple are listed for multi-display
    // setups; the first is the system-wide value.
    const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (!m) return 0;
    const nanos = Number(m[1]);
    if (!Number.isFinite(nanos)) return 0;
    return Math.floor(nanos / 1e9);
  } catch {
    // ioreg missing, timed out, or returned junk. Treat as "user is active"
    // so we never run heavy work in an unknown state. Pessimistic by design.
    return 0;
  }
}

export function idleGateDecision(workerName) {
  const idle = getIdleSeconds();
  if (idle < IDLE_THRESHOLD_SECONDS) {
    return {
      ok: false,
      reason: 'user-active',
      idle,
      threshold: IDLE_THRESHOLD_SECONDS,
      message: `[${workerName}] idle-gate skipped — user active (idle=${idle}s)`,
    };
  }
  return { ok: true, idle, threshold: IDLE_THRESHOLD_SECONDS };
}

// st_b50005df / st_2cd1af73 — self-imposed RSS ceiling. Default 6000 MB. The
// local embedding model's resident set is ~2 GB once loaded; a long-input
// (~2600-char) ONNX batch transiently balloons the arena to ~3.5–4 GB, so the
// prior 1200 MB ceiling breached on model load alone and restarted the worker
// after ~8 chunks (the 340k backlog never drained). 6000 MB leaves real headroom
// above a long-input batch; a breach still means a fresh launchd respawn (cheap,
// lease-reclaimed / KeepAlive) rather than marching into the OS jetsam path.
//
// WHY this is safe on a 16 GB box even though 6000 MB sounds high: the daemon
// runs with ROBOTDOJO_MMAP_SIZE=0 (its plist), which sheds the 16 GiB SQLite mmap
// reservation lib/db.js makes by default. WITHOUT that env (the state the daemon
// ran in overnight before its plist reload) the daemon's jetsam footprint
// included that 16 GiB mapping — making it BY FAR the largest memory consumer on
// the box and the first process jetsam SIGKILLs under pressure (observed: a
// JetsamEvent where the node embed process showed a ~95 GB rpages footprint). With
// mmap shed, the ceiling bounds the REAL working set and the jetsam exposure drops
// to the model + arena. Tunable per-process via ROBOTDOJO_EMBED_RSS_CEILING_MB
// (e.g. lower it on a smaller box). Read at call time so a test or operator can
// set it per-process.
const DEFAULT_RSS_CEILING_MB = 6000;

function configuredRssCeilingMb() {
  const raw = Number(process.env.ROBOTDOJO_EMBED_RSS_CEILING_MB);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_RSS_CEILING_MB;
}

/**
 * Current resident-set size of THIS process, in whole MB.
 *
 * Env override: RSS_FIXTURE_MB=N → return N without reading process memory.
 * Used by tests so they don't depend on the live RSS of the test runner.
 *
 * @returns {number} resident set size in MB (integer ≥ 0)
 */
export function workerRssMb() {
  if (process.env.RSS_FIXTURE_MB !== undefined) {
    const fixture = Number(process.env.RSS_FIXTURE_MB);
    if (!Number.isFinite(fixture) || fixture < 0) return 0;
    return Math.floor(fixture);
  }
  return Math.floor(process.memoryUsage().rss / (1024 * 1024));
}

/**
 * Self-imposed RSS ceiling check. `ok:false` means the worker's resident set
 * has crossed its self-cap and it should stop the current drain cleanly so the
 * next launchd fire respawns it fresh (model reloaded, RSS reset) — staying out
 * of the jetsam range proactively rather than waiting for the OS to act.
 *
 * @param {string} workerName e.g. "chunk-embed-worker"
 * @returns {{ok:boolean, reason?:string, rssMb:number, ceilingMb:number, message?:string}}
 */
export function rssCeilingDecision(workerName) {
  const rssMb = workerRssMb();
  const ceilingMb = configuredRssCeilingMb();
  if (rssMb >= ceilingMb) {
    return {
      ok: false,
      reason: 'rss-ceiling',
      rssMb,
      ceilingMb,
      message: `[${workerName}] rss-ceiling reached — restarting embed subprocess (rss=${rssMb}MB ceiling=${ceilingMb}MB)`,
    };
  }
  return { ok: true, rssMb, ceilingMb };
}

/**
 * Test helper: return the active RSS ceiling so qa/tests can compute fixtures.
 * NOT exported for production use.
 */
export function _getRssCeilingMbForTesting() {
  return configuredRssCeilingMb();
}

/**
 * Worker-side gate: if the user is active, log a skip line and exit(0).
 * Otherwise, return cleanly so the worker proceeds with its workload.
 *
 * The log line is load-bearing: `scripts/qa/idle-gate-runner.js` matches
 * `[<workerName>] idle-gate skipped — user active (idle=Ns)` exactly.
 *
 * @param {string} workerName e.g. "chunk-embed-worker"
 * @returns {Promise<void>}   Resolves if proceeding; calls process.exit(0)
 *                            if skipping (the caller never sees a return value
 *                            on the skip path — the process is gone).
 */
export async function enforceIdleGate(workerName) {
  const decision = idleGateDecision(workerName);
  if (!decision.ok) {
    // Single-line log — qa runners grep this exact shape.
    console.log(decision.message);
    process.exit(0);
  }
  // User idle long enough — workload proceeds.
}

/**
 * Wire SIGTERM (and SIGINT for terminal kill) to:
 *   1. abort()  — cancels in-flight fetch() so embedBatch doesn't outlive us
 *   2. close DB — better-sqlite3 close() flushes & releases WAL locks cleanly
 *   3. exit(0)  — clean exit, never blocks past 2 seconds
 *
 * A hard 2-second hard-exit guard catches the rare case where the SIGTERM
 * handler itself stalls (e.g. an open fetch that doesn't honor abort).
 *
 * @param {AbortController} ac
 * @param {object|null} db better-sqlite3 instance (optional)
 */
export function installCancelHandler(ac, db) {
  let shuttingDown = false;
  const onSignal = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[idle-gate] ${signal} received — aborting`);

    // (1) Cancel in-flight HTTP. Built-in fetch in Node ≥18 honors AbortSignal
    // and throws DOMException [AbortError] which the caller's try/catch swallows
    // cleanly. (Research: AppSignal 2025-02-12 confirms behavior in Node 25.)
    try { ac.abort(); } catch { /* already aborted is fine */ }

    // (2) Close better-sqlite3. WAL is committed-or-rolled-back atomically by
    // SQLite itself on next open; the close() call merely releases this
    // process's locks so a follow-up launchd fire doesn't see stale reader
    // marks. (Research: sqlite.org/wal.html — incomplete WAL txns are rolled
    // back automatically by the next opener.)
    if (db) {
      try { db.close(); } catch { /* DB may already be closed */ }
    }

    // (3) Hard-exit guard. If something downstream blocks the event loop or
    // an awaited promise refuses to reject, we still exit within 1500ms —
    // qa runners assert sub-2000ms shutdown. NOT unref()'d on purpose: we
    // want this timer to keep the event loop alive *only* if it would have
    // exited cleanly first. process.exit() inside the handler still wins
    // either way.
    setTimeout(() => process.exit(0), 1500);
  };

  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

/**
 * Test helper: return the active threshold so qa scripts can compute fixtures.
 * NOT exported for production use.
 */
export function _getThresholdSecondsForTesting() {
  return IDLE_THRESHOLD_SECONDS;
}
