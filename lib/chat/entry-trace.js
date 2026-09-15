/**
 * Chat request-entry tracer — high-resolution per-step timing for the
 * /api/chat/stream hot path (st_2cd1af73 AC-1).
 *
 * WHY this exists: the time-to-first-SSE-frame (TTFT's leading term) is the
 * sum of synchronous request-entry work that runs BEFORE the ReadableStream's
 * start() emits the `status` frame — middleware DB stamps, conversation upsert,
 * the observability INSERT, model resolution — plus any event-loop blocking
 * (a large WAL checkpoint, a contended synchronous write) that the new
 * request's entry work queues behind. To fix the dominant term you must first
 * NAME it with numbers; this tracer does exactly that, per turn.
 *
 * Contract:
 *   - Zero cost when ROBOTDOJO_CHAT_ENTRY_TRACE !== '1' (the mark() calls
 *     short-circuit on a single boolean read; no allocation, no Date.now()).
 *   - When enabled, one tracer per request accumulates {label, t} marks using
 *     performance.now() (monotonic, sub-ms) and emits a single stderr line at
 *     flush() with each inter-step delta in ms. One line per turn keeps the
 *     log greppable: `[entry-trace] <id> total=Xms steps=a:1.2,b:3.4,...`.
 *   - Never throws. A tracing failure must never break a chat turn.
 *
 * This is diagnostic instrumentation kept behind an env flag — off in
 * production, on for a measurement run. It is intentionally tiny and
 * dependency-free so it can live permanently without cost.
 */

const ENABLED = process.env.ROBOTDOJO_CHAT_ENTRY_TRACE === '1';

// Monotonic clock — performance.now() is immune to wall-clock jumps and gives
// sub-millisecond resolution, which matters when individual steps are <1ms but
// their sum is the thing we're chasing.
const now = () => (typeof performance !== 'undefined' && performance.now)
  ? performance.now()
  : Date.now();

class NoopTracer {
  mark() {}
  flush() {}
}
const NOOP = new NoopTracer();

class EntryTracer {
  constructor(id) {
    this.id = id;
    this.t0 = now();
    this.last = this.t0;
    this.marks = [];
  }

  /**
   * Record a labeled checkpoint. Stores the delta from the previous mark so
   * the flushed line reads as a per-step breakdown, not cumulative offsets.
   */
  mark(label) {
    const t = now();
    this.marks.push([label, t - this.last]);
    this.last = t;
  }

  /**
   * Emit one stderr line for the marks accumulated since construction (or since
   * the previous flush) and then reset the mark buffer.
   *
   * WHY reset (st_fd14cdd4): the hot path flushes TWICE — once at the `status`
   * frame (the pre-first-frame request-entry decomposition) and once after the
   * model's first token (the per-layer / per-phase context-build decomposition,
   * fed by the onTiming observer). Resetting after the first flush keeps the
   * second line scoped to the post-status marks, so the two lines read as two
   * distinct cost buckets instead of the second re-printing the first. The `tag`
   * prefixes the line so a grep can separate the entry phase from the ctx phase.
   */
  flush(label, tag = 'entry-trace') {
    if (label) this.mark(label);
    const total = (this.last - this.t0).toFixed(1);
    const steps = this.marks.map(([l, d]) => `${l}:${d.toFixed(1)}`).join(',');
    process.stderr.write(`[${tag}] ${this.id} total=${total}ms steps=${steps}\n`);
    // Reset so a later flush() reports only the marks taken after this one.
    this.t0 = now();
    this.last = this.t0;
    this.marks = [];
  }
}

/**
 * Create a tracer for one request. Returns a no-op singleton when tracing is
 * disabled so call sites stay branch-free and allocation-free in production.
 *
 * @param {string} id - short request/turn id for log correlation
 * @returns {EntryTracer|NoopTracer}
 */
export function startEntryTrace(id) {
  return ENABLED ? new EntryTracer(id) : NOOP;
}

export const ENTRY_TRACE_ENABLED = ENABLED;
