/**
 * Event-loop monitor — Phase 1 diagnostic instrumentation for st_27561b77.
 *
 * Captures synchronous operations that block the Node event loop for >250ms
 * and writes one JSONL record per event to ~/.robotdojo/logs/event-loop/.
 *
 * Pinned JSONL contract (per 02-plan.md AC1 — every parser downstream relies on
 * this exact shape; do not change without owner sign-off):
 *
 *   {"ts":"<ISO-8601>","delay_ms":<number>,"leaf":"<innermost named fn>",
 *    "class":"cpu|wait","stack":"<newline-delimited frames>"}
 *
 * Mechanism:
 *   - perf_hooks.monitorEventLoopDelay() — a sampled histogram of event-loop
 *     lag. ~1ms steady-state overhead, NOT synchronous per-callback. The
 *     histogram itself does not tell you WHICH operation blocked, only how
 *     long it stalled the loop.
 *   - Watchdog timer (setInterval) on a separate uv timer — its scheduled
 *     fire time slips by exactly the duration of any synchronous block on
 *     the main thread. The watchdog measures (now - lastTick) - intervalMs;
 *     if that exceeds threshold, a block just ended and we capture stack +
 *     CPU usage for the SAME tick during which the block landed.
 *   - Classification: we sample process.cpuUsage() before/after the gap; if
 *     CPU consumed during the gap is ≥ MIN_CPU_RATIO of wall-time → cpu-bound
 *     (burn), else wait-bound (fsync, lock-wait, blocked I/O).
 *   - The leaf is the innermost USER frame from a fresh Error().stack captured
 *     at the moment the watchdog detects the gap. We skip frames inside this
 *     module and inside node:internal — what remains is the first product
 *     frame on the resumption tick. WHY this works: in better-sqlite3's
 *     synchronous model, the very next event-loop callback after a long
 *     blocking call IS the continuation of the caller's microtask queue,
 *     so the stack we capture there is dominated by the still-running
 *     synchronous chain or its immediate successor.
 *
 * Opt-in: only enabled when ROBOTDOJO_EVENT_LOOP_TRACE=1. No effect otherwise.
 * Safe to import unconditionally — start() is a no-op without the env flag.
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { mkdirSync, appendFileSync, openSync, closeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

// ─── Tunable thresholds (pinned by AC1; do not hardcode at call sites) ────
// 250ms threshold matches the plan's pinned "synchronous operation
// blocking the loop >~250ms" contract. Lower = noise; higher = misses.
const DEFAULT_DELAY_THRESHOLD_MS = 250;
// 10ms histogram resolution gives sub-frame granularity without the per-sample
// CPU cost of microsecond resolution.
const HISTOGRAM_RESOLUTION_MS = 10;
// 50ms watchdog interval — short enough to catch the END of a >250ms block
// within ~50ms; long enough that the watchdog itself doesn't materially
// perturb event-loop timing under normal load.
const WATCHDOG_INTERVAL_MS = 50;
// If CPU time consumed during the gap is ≥ this fraction of wall-time,
// classify as CPU-bound. 0.7 is the empirically defensible threshold: pure
// burn approaches 1.0; pure fsync stays near 0; mixed work falls in the middle.
const CPU_BOUND_RATIO = 0.7;

let _started = false;
let _logPath = null;
let _histogram = null;
let _watchdogTimer = null;
let _lastWatchdogTick = 0;
let _lastCpuUsage = null;
let _parseErrorsCount = 0; // reserved for parser-side use; published for symmetry

// In-flight named-operation stack. Pushed by traceSync(name, fn) before
// entering a suspect synchronous operation, popped on exit (even on throw).
// WHY this is necessary: a setInterval callback fires AFTER the blocking
// synchronous chain has returned, so Error.stack at that point only contains
// the watchdog callback frame — the real leaf is gone. The trace stack
// preserves the named context across the gap.
const _inFlight = [];

// The most recently exited trace marker, captured at the moment of pop.
// Holds { name, enteredAt, exitedAt, parents }. WHY this exists: the
// watchdog fires AFTER traceSync's finally block runs (the synchronous
// chain that contained the marker has fully unwound by the time the
// timer callback gets its tick), so _inFlight is empty when the watchdog
// reads it. _lastExited preserves the last marker chain that was active
// up to a microsecond ago — if the watchdog detects a gap whose window
// overlaps [enteredAt, exitedAt] of this marker, the marker IS the leaf
// that caused the gap.
let _lastExited = null;

/**
 * Resolve log directory. Defaults to ~/.robotdojo/logs/event-loop/. Test
 * harnesses override via ROBOTDOJO_EVENT_LOOP_LOG_DIR.
 */
function resolveLogDir() {
  if (process.env.ROBOTDOJO_EVENT_LOOP_LOG_DIR) {
    return process.env.ROBOTDOJO_EVENT_LOOP_LOG_DIR;
  }
  return resolve(homedir(), '.robotdojo', 'logs', 'event-loop');
}

/**
 * Resolve log file path. Default is rolling per-date file
 * (event-loop-YYYY-MM-DD.log). The AC1 reproduce step targets specifically
 * named files (before-{date}.log / after-{date}.log) via env override.
 */
function resolveLogPath() {
  const dir = resolveLogDir();
  if (process.env.ROBOTDOJO_EVENT_LOOP_LOG_FILE) {
    return resolve(dir, process.env.ROBOTDOJO_EVENT_LOOP_LOG_FILE);
  }
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return resolve(dir, `event-loop-${date}.log`);
}

/**
 * Capture a stack trace, skipping frames inside this module and node internals.
 * The first surviving frame is the leaf — the innermost USER function at the
 * resumption tick. Returns { leaf, stack } where stack is a newline-joined
 * frame list per the pinned contract.
 *
 * WHY filter node:internal: those frames are uv/libuv plumbing; the leaf we
 * want is the product code being executed. WHY skip THIS module's frames:
 * the watchdog and writeBlockEvent are bookkeeping — they are by definition
 * NOT the leaf that caused the block.
 */
function captureStack() {
  const err = new Error('event-loop-monitor-stack');
  // Error.stack on V8 is: "Error: <msg>\n    at <frame>\n    at <frame>\n..."
  const raw = err.stack || '';
  const lines = raw.split('\n').slice(1); // drop the "Error: ..." header

  const cleaned = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // Skip our own module frames — by file basename, robust across path styles.
    if (t.includes('event-loop-monitor.js')) continue;
    // Skip node internal frames (node:internal/, internal/, node:perf_hooks).
    if (t.includes('node:internal') || t.includes('(internal/')) continue;
    cleaned.push(t);
  }

  // Leaf = innermost remaining frame, parsed for a usable function label.
  // V8 format: "at FunctionName (path:line:col)" or "at path:line:col".
  // Anonymous: "at /abs/path.js:L:C". Synthesize "<anonymous>@basename:L".
  const leafLine = cleaned[0] || '<no-frame>';
  const fnMatch = leafLine.match(/^at\s+([^(]+?)\s+\(/);
  let leaf;
  if (fnMatch) {
    leaf = fnMatch[1].trim();
  } else {
    const locMatch = leafLine.match(/at\s+(.+?:\d+:\d+)/);
    leaf = locMatch ? `<anonymous>@${locMatch[1].split('/').slice(-2).join('/')}` : leafLine;
  }

  return { leaf, stack: cleaned.join('\n') };
}

/**
 * Classify CPU-bound vs wait-bound based on process.cpuUsage delta vs
 * wall-time of the measured gap.
 *
 *   CPU-bound: tight synchronous computation, large vector scan, SQLCipher
 *     per-page decrypt, embedding inference — process.cpuUsage delta ≈
 *     wall-time. ratio → 1.
 *   Wait-bound: blocked on a lock, fsync, fd readiness — process.cpuUsage
 *     delta ≈ 0. ratio → 0.
 *
 * cpuDeltaUs = (user + system) microseconds since last sample.
 * gapMs = wall-time elapsed.
 * ratio = cpuDeltaUs / 1000 / gapMs.
 */
function classifyBlock(gapMs, cpuDeltaUs) {
  const cpuMs = cpuDeltaUs / 1000;
  const ratio = gapMs > 0 ? cpuMs / gapMs : 0;
  return ratio >= CPU_BOUND_RATIO ? 'cpu' : 'wait';
}

/**
 * Append one JSONL line per the pinned AC1 contract.
 *
 * WHY synchronous appendFileSync (vs a WriteStream): block events are
 * sparse by design (>250ms threshold), and the process may exit immediately
 * after the last write (test harnesses, ad-hoc reproduction scripts). A
 * WriteStream's deferred flush lost the entire log buffer in the Phase 1
 * harness — process.exit before the close event fired. appendFileSync
 * guarantees the line is on disk before this function returns. The cost
 * (~hundreds of microseconds per write under a sparse write rate) is
 * negligible vs the 250ms+ blocks being observed.
 *
 * Observability errors must never break the process being observed:
 * any I/O failure logs to stderr and continues.
 */
function writeBlockEvent({ ts, delayMs, leaf, klass, stack }) {
  const record = {
    ts,
    delay_ms: Number(delayMs.toFixed(1)),
    leaf,
    class: klass,
    stack,
  };
  try {
    appendFileSync(_logPath, JSON.stringify(record) + '\n');
  } catch (err) {
    process.stderr.write(`[event-loop-monitor] write failed: ${err.message}\n`);
  }
}

/**
 * The watchdog: fires every WATCHDOG_INTERVAL_MS. If a previous tick was
 * delayed by more than the threshold (i.e. wall-clock since last tick minus
 * the configured interval exceeds the threshold), a synchronous block on
 * the main thread just released. We capture stack and classify.
 */
function watchdogTick(thresholdMs) {
  const now = performance.now();
  const elapsed = _lastWatchdogTick === 0 ? WATCHDOG_INTERVAL_MS : now - _lastWatchdogTick;
  const gap = elapsed - WATCHDOG_INTERVAL_MS;
  const cpuNow = process.cpuUsage();
  const cpuDeltaUs = _lastCpuUsage
    ? (cpuNow.user - _lastCpuUsage.user) + (cpuNow.system - _lastCpuUsage.system)
    : 0;
  _lastWatchdogTick = now;
  _lastCpuUsage = cpuNow;

  if (gap < thresholdMs) return; // No block this tick — nothing to log.

  // Determine the leaf at the moment the gap occurred. Three resolution
  // sources, in priority order:
  //
  //   1. _inFlight — still-active markers when the watchdog fires. Rare in
  //      practice (the watchdog runs AFTER synchronous unwind), but covers
  //      blocks that are still in progress at watchdog-tick boundaries.
  //   2. _lastExited — a marker that just exited within the gap window
  //      (exitedAt > _lastWatchdogTick - INTERVAL). This is the common case:
  //      the synchronous block ran inside traceSync, popped, and the very
  //      next event-loop tick ran the watchdog. We attribute the gap to
  //      this marker because its [enteredAt, exitedAt] window overlaps
  //      the gap window.
  //   3. Error.stack — fallback when no trace markers were active. Tends
  //      to return only the watchdog callback frame ("<no-frame>") for
  //      gaps that ended before the watchdog ran; useful for unmarked
  //      sites that should be discovered and added to the marker list.
  let leaf;
  let stack;
  const gapStartedAt = now - elapsed + WATCHDOG_INTERVAL_MS; // approx
  if (_inFlight.length > 0) {
    leaf = _inFlight[_inFlight.length - 1];
    stack = _inFlight.slice().reverse().join('\n');
  } else if (_lastExited && _lastExited.exitedAt >= gapStartedAt - WATCHDOG_INTERVAL_MS) {
    leaf = _lastExited.name;
    stack = _lastExited.parents.length
      ? [_lastExited.name, ..._lastExited.parents].join('\n')
      : _lastExited.name;
  } else {
    const captured = captureStack();
    leaf = captured.leaf;
    stack = captured.stack;
  }
  const klass = classifyBlock(elapsed, cpuDeltaUs);
  writeBlockEvent({
    ts: new Date().toISOString(),
    delayMs: gap,
    leaf,
    klass,
    stack,
  });
}

/**
 * Wrap a synchronous operation so the watchdog can name it as the leaf if
 * the operation blocks the event loop for >threshold. Zero overhead when the
 * monitor is disabled (the trace stack is just an array push/pop). Use at
 * known heavy sync call sites: PRAGMA quick_check, foreign_key_check,
 * write_readback, db.transaction(...) bodies, large getPassiveJobSummary
 * scans, etc.
 *
 * Pushes name onto the in-flight stack, calls fn(), pops on return (even on
 * throw). The watchdog reads the stack at gap-detection time.
 *
 *   import { traceSync } from './observability/event-loop-monitor.js';
 *   const value = traceSync('checkDbHealth.quick_check', () =>
 *     database.pragma('quick_check', { simple: true }));
 */
export function traceSync(name, fn) {
  if (!_started) return fn();
  const enteredAt = performance.now();
  _inFlight.push(name);
  try {
    return fn();
  } finally {
    const exitedAt = performance.now();
    // Snapshot the parent stack (outer markers, innermost-out order) BEFORE
    // popping. Used by watchdogTick when this is the most-recently-exited
    // marker. We do NOT keep _lastExited across more than the next watchdog
    // tick — see _lastExited freshness check in watchdogTick.
    const parents = _inFlight.slice(0, -1).reverse();
    _inFlight.pop();
    _lastExited = { name, enteredAt, exitedAt, parents };
  }
}

/**
 * Start the monitor. Idempotent — second call is a no-op. No-op without
 * ROBOTDOJO_EVENT_LOOP_TRACE=1. Returns true if started, false if disabled.
 *
 * thresholdMs: optional override for the >250ms block threshold. Tests may
 * lower this; production keeps the AC1 contract value.
 */
export function startEventLoopMonitor({ thresholdMs = DEFAULT_DELAY_THRESHOLD_MS } = {}) {
  if (_started) return true;
  if (process.env.ROBOTDOJO_EVENT_LOOP_TRACE !== '1') return false;

  _logPath = resolveLogPath();
  try {
    mkdirSync(dirname(_logPath), { recursive: true });
    // Touch the file so a "monitor started but no block captured" run still
    // produces a non-empty artifact (the parser distinguishes this from
    // "monitor never ran" by checking for the class:"header" line).
    closeSync(openSync(_logPath, 'a'));
  } catch (err) {
    process.stderr.write(`[event-loop-monitor] cannot create log file: ${err.message}\n`);
    return false;
  }

  // perf_hooks histogram — runs at the libuv layer, ~1ms steady-state
  // overhead. Enables a coarse end-of-run summary; not used to drive
  // per-event logging.
  _histogram = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
  _histogram.enable();

  _lastWatchdogTick = performance.now();
  _lastCpuUsage = process.cpuUsage();
  _watchdogTimer = setInterval(() => watchdogTick(thresholdMs), WATCHDOG_INTERVAL_MS);
  _watchdogTimer.unref?.(); // Never block process exit on observability.

  _started = true;

  // Header to disk so the file is non-empty even if no block occurs (helps
  // distinguish "no block captured" from "monitor never ran"). NOT a block
  // event — has its own marker shape. Parsers per the pinned contract skip
  // any line that fails JSON.parse with `class` in {"cpu","wait"}; a
  // `class:"header"` line is therefore counted as a "non-block" entry,
  // which is the desired semantic.
  writeBlockEvent({
    ts: new Date().toISOString(),
    delayMs: 0,
    leaf: '<monitor-start>',
    klass: 'header',
    stack: `threshold_ms=${thresholdMs} resolution_ms=${HISTOGRAM_RESOLUTION_MS} watchdog_ms=${WATCHDOG_INTERVAL_MS} pid=${process.pid}`,
  });

  return true;
}

/**
 * Stop the monitor. Flushes the histogram summary as a final JSONL entry
 * (also class:"summary", not a block event), closes the write stream,
 * clears the watchdog. Idempotent.
 */
export function stopEventLoopMonitor() {
  if (!_started) return;
  clearInterval(_watchdogTimer);
  _watchdogTimer = null;

  if (_histogram) {
    const h = _histogram;
    writeBlockEvent({
      ts: new Date().toISOString(),
      delayMs: Number((h.max / 1e6).toFixed(1)),
      leaf: '<monitor-summary>',
      klass: 'summary',
      stack: `min_ms=${(h.min / 1e6).toFixed(1)} max_ms=${(h.max / 1e6).toFixed(1)} mean_ms=${(h.mean / 1e6).toFixed(1)} p99_ms=${(h.percentile(99) / 1e6).toFixed(1)} samples=${h.exceeds}`,
    });
    h.disable();
    _histogram = null;
  }

  _logPath = null;
  _started = false;
}

/**
 * st_27561b77 AC1 — reset the histogram while keeping the monitor running.
 *
 * Used by scripts/qa/capture-after-log.js after a settle window so the
 * histogram summary at end-of-run reflects only steady-state behavior,
 * not startup transients (the first watchdog tick after scheduler thaw
 * can record a 200-300ms inter-tick gap that is pure scheduler latency,
 * not a foreground block).
 *
 * The watchdog's per-event block capture is independent of the histogram
 * and continues to record any real ≥250ms block.
 */
export function _resetHistogramForTest() {
  if (_histogram && typeof _histogram.reset === 'function') {
    _histogram.reset();
  }
}

/**
 * Test helper: return current state for assertions.
 */
export function getMonitorState() {
  return {
    started: _started,
    parseErrors: _parseErrorsCount,
    logPath: _started ? _logPath : null,
  };
}
