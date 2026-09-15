/**
 * lib/rag/lane-pool.js — st_db4b3118 parallel inference lanes.
 *
 * Compute tier: orchestration. This module spawns and coordinates N CHILD
 * PROCESSES ("lanes"), each owning its own ONNX embedding session, and fans one
 * fetched batch out across them. It makes NO LLM call against structured data and
 * NEVER touches the DB — the PARENT (lib/rag/embed.js) does every read and write,
 * preserving the single-writer + jetsam contracts. A lane receives {texts} over
 * IPC and returns {vectors}; that is the whole lane contract.
 *
 * WHY child processes, not worker_threads (the design choice the brief asked for):
 *   1. RSS isolation. Each lane is its own OS process, so its ~1.9GB model +
 *      activation working set is a separately-measurable resident set. The sum-RSS
 *      jetsam gate can read each lane pid's RSS independently; a balloon in one
 *      lane is visible and bounded, and KeepAlive-style respawn resets it. In a
 *      worker_thread every lane's allocation rolls into ONE process RSS, so the
 *      6GB ceiling could not attribute or isolate a balloon — the exact 95GB scar
 *      this guards against.
 *   2. Session safety. onnxruntime-node's native session and transformers.js'
 *      memoized extractor are module-level singletons; sharing one V8 isolate
 *      across worker_threads leaves that native/module state co-resident in ways
 *      that are not verified thread-safe. Separate processes each load the model
 *      ONCE into their own address space — the proven-safe path.
 *   3. True CPU parallelism with a hard yield. Killing a child frees its CPU and
 *      memory immediately and unconditionally; a worker_thread mid-inference holds
 *      native CPU that the parent cannot preempt.
 *
 * The cost is IPC: texts go out and 1024-float vectors come back as transferable
 * buffers. Measured against the win (N× inference streams) this is noise — the
 * embedding itself dominates by orders of magnitude.
 *
 * This file is split into a PURE core (planLaneDispatch, reassembleVectors,
 * sumRssDecision) that is unit-tested without spawning anything, and the live
 * LanePool class that drives real children. The pure core is where dispatch
 * disjointness, vector ordering, and the sum-RSS gate are proven.
 */

import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { rssCeilingDecision } from '../idle-gate.js';

const HOME = process.env.HOME || homedir();
const ROOT = process.env.ROBOTDOJO_HOME || resolve(HOME, 'robotdojo');
const LANE_SCRIPT = resolve(ROOT, 'scripts', 'chunk-embed-lane.mjs');

// EMBED_DIM is duplicated here as a guard constant so the pool can validate a
// lane's returned vector length WITHOUT importing the model module (which would
// load transformers). The single source of truth is lib/rag/local-embed.js
// LOCAL_EMBED_DIM; this must equal it, and the lane worker validates against the
// real constant — this is only the parent-side length check.
export const LANE_VECTOR_DIM = 1024;

// ─── PURE CORE (no spawning, no DB, no model) ────────────────────────────────

/**
 * Plan how a fetched batch's texts split across `laneCount` lanes.
 *
 * Returns one assignment per lane: a CONTIGUOUS, DISJOINT index range over the
 * input array, in ascending order, covering the whole array with no overlap and
 * no gap. Contiguous (not round-robin) so each lane embeds similar-length
 * neighbours — embed.js length-sorts the batch first, so a contiguous split keeps
 * each lane's sub-batch tightly padded (the padding-waste win), and keeps vector
 * reassembly a trivial concat.
 *
 * Disjointness + full coverage is the load-bearing invariant: the same chunk must
 * never embed on two lanes (wasted compute, and — since the parent writes by the
 * row's own id — a double DELETE+INSERT race shape we forbid by construction), and
 * no chunk may be dropped (a silent embedded=0 leak).
 *
 * @param {number} total number of texts in the batch
 * @param {number} laneCount number of lanes (>=1)
 * @returns {Array<{lane:number, start:number, end:number}>} end exclusive; empty
 *   assignments (when total < laneCount) are omitted so no lane gets a 0-length call
 */
export function planLaneDispatch(total, laneCount) {
  const n = Math.max(0, Math.floor(total));
  const lanes = Math.max(1, Math.floor(laneCount));
  if (n === 0) return [];
  // Even split with the remainder spread one-per-lane across the FIRST lanes, so
  // sizes differ by at most 1 — no lane carries the whole remainder.
  const base = Math.floor(n / lanes);
  const extra = n % lanes;
  const out = [];
  let cursor = 0;
  for (let lane = 0; lane < lanes; lane++) {
    const size = base + (lane < extra ? 1 : 0);
    if (size === 0) continue; // total < laneCount: fewer slices than lanes
    out.push({ lane, start: cursor, end: cursor + size });
    cursor += size;
  }
  return out;
}

/**
 * Reassemble per-slice vector results back into one array in ORIGINAL input order.
 *
 * Each result is { start, vectors } where `vectors` are the embeddings for
 * texts[start..start+vectors.length). The merged array must equal what a single
 * serial embed of the whole batch would have produced, index-for-index — that is
 * the property the daemon relies on to map vector[i] → toEmbed[i] when it writes.
 *
 * Throws if coverage is wrong (a hole or an overlap or a length mismatch): a
 * silent misalignment would write the WRONG vector under a chunk_id, corrupting
 * recall invisibly. Better to fail loud and re-fetch the batch.
 *
 * @param {Array<{start:number, vectors:Array}>} results
 * @param {number} total expected length of the merged array
 * @returns {Array} vectors in original order, length === total
 */
export function reassembleVectors(results, total) {
  const n = Math.max(0, Math.floor(total));
  const merged = new Array(n).fill(undefined);
  for (const r of results) {
    const start = Math.floor(Number(r.start));
    const vecs = r.vectors || [];
    for (let i = 0; i < vecs.length; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= n) {
        throw new Error(`lane result index ${idx} out of range [0,${n})`);
      }
      if (merged[idx] !== undefined) {
        throw new Error(`lane results overlap at index ${idx}`);
      }
      merged[idx] = vecs[i];
    }
  }
  for (let i = 0; i < n; i++) {
    if (merged[i] === undefined) {
      throw new Error(`lane results have a hole at index ${i} (incomplete batch)`);
    }
  }
  return merged;
}

/**
 * Sum-RSS jetsam gate. The single hard memory invariant of the lane pool: the
 * TOTAL resident set of the parent daemon PLUS every live lane child must stay
 * under the same ceiling a single embedder respected (default 6000MB). A lane is
 * a separate process, so process.memoryUsage() on the parent alone misses the
 * lanes entirely — the sum is what the OS jetsam path actually sees.
 *
 * Pure: the caller passes the measured RSS of the parent and each lane (MB), so
 * this is testable without spawning. `ok:false` means stop dispatching and exit
 * for a fresh respawn (every lane reloads its model, RSS resets to baseline),
 * exactly as the single-embedder ceiling did.
 *
 * @param {number} parentRssMb
 * @param {number[]} laneRssMb one entry per live lane
 * @param {number} ceilingMb
 * @returns {{ok:boolean, sumMb:number, ceilingMb:number, reason?:string, message?:string}}
 */
export function sumRssDecision(parentRssMb, laneRssMb, ceilingMb) {
  const parent = Math.max(0, Number(parentRssMb) || 0);
  const lanes = (Array.isArray(laneRssMb) ? laneRssMb : []).reduce(
    (a, v) => a + Math.max(0, Number(v) || 0), 0,
  );
  const sumMb = Math.round(parent + lanes);
  const ceiling = Math.floor(Number(ceilingMb) || 0);
  if (ceiling > 0 && sumMb >= ceiling) {
    return {
      ok: false,
      sumMb,
      ceilingMb: ceiling,
      reason: 'sum-rss-ceiling',
      message: `[lane-pool] sum-rss ceiling reached — parent+lanes ${sumMb}MB >= ${ceiling}MB; exiting for fresh respawn`,
    };
  }
  return { ok: true, sumMb, ceilingMb: ceiling };
}

// ─── LIVE POOL (spawns real lane children) ───────────────────────────────────

/**
 * Read a process's RSS in MB from /proc-equivalent. macOS has no /proc, so we shell
 * to `ps -o rss=` (KB) for the pid. Returns 0 on any failure (a dead/unknown pid
 * contributes nothing to the sum — correct, it is not resident). Synchronous and
 * cheap (one ps per lane, only at slice boundaries).
 */
function pidRssMb(pid) {
  if (!pid) return 0;
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    const kb = Number(String(out).trim());
    return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : 0;
  } catch {
    return 0;
  }
}

/**
 * One inference lane: a child process holding a loaded ONNX session. The pool owns
 * a small set of these. A lane is a dumb function-over-IPC: send {reqId, texts},
 * receive {reqId, vectors} | {reqId, error}. It never sees the DB.
 */
class Lane {
  constructor(index, { env, onExit, laneScript = LANE_SCRIPT }) {
    this.index = index;
    this.onExit = onExit;
    this.laneScript = laneScript;
    this.busy = false;
    this.ready = false;
    this.pending = null; // { reqId, resolve, reject }
    this._spawn(env);
  }

  _spawn(env) {
    // Inherit the parent's env (so ROBOTDOJO_MMAP_SIZE=0, DB key, ORT overrides,
    // and the night-profile env all flow to the lane) but force the lane into the
    // single-stream session config: it is ONE of N parallel processes, so each
    // lane pins a SMALL intra-op thread count and never widens its own batch. The
    // parallelism is across lanes, not within a lane — N lanes × few threads each
    // saturates the box without any single lane spawning an unbounded pool.
    this.proc = spawn(process.execPath, [this.laneScript, String(this.index)], {
      detached: false,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, ...env },
    });
    this.proc.on('message', (msg) => this._onMessage(msg));
    this.proc.on('exit', (code, signal) => this._onExit(code, signal));
    this.proc.on('error', (err) => this._onError(err));
  }

  get pid() { return this.proc?.pid || 0; }

  rssMb() { return pidRssMb(this.pid); }

  _onMessage(msg) {
    if (msg?.type === 'ready') { this.ready = true; return; }
    if (msg?.type === 'result' && this.pending && msg.reqId === this.pending.reqId) {
      const p = this.pending;
      this.pending = null;
      this.busy = false;
      if (msg.error) p.reject(new Error(`lane ${this.index}: ${msg.error}`));
      else p.resolve({ vectors: msg.vectors });
    }
  }

  _onError(err) {
    // A spawn/IPC error fails any in-flight request; the pool re-dispatches it.
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.busy = false;
      p.reject(new Error(`lane ${this.index} error: ${err?.message || err}`));
    }
  }

  _onExit(code, signal) {
    this.ready = false;
    // Lane death mid-request: reject the in-flight request so the pool re-dispatches
    // its slice to a healthy lane. The slice is durable on the PARENT (those rows
    // are still embedded=0 in the DB), so re-dispatch loses nothing.
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.busy = false;
      p.reject(Object.assign(new Error(`lane ${this.index} exited (code=${code} signal=${signal}) mid-request`), { laneDied: true }));
    }
    if (this.onExit) this.onExit(this.index, code, signal);
  }

  /**
   * Embed one disjoint slice of texts. Resolves with { vectors } in slice order.
   * @param {string[]} texts
   * @param {number} ortBatchSize the lane's internal ORT sub-batch
   * @param {number} timeoutMs hard per-slice ceiling
   */
  embed(texts, ortBatchSize, timeoutMs) {
    return new Promise((resolve, reject) => {
      const reqId = `${this.index}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      this.busy = true;
      const timer = setTimeout(() => {
        if (this.pending && this.pending.reqId === reqId) {
          // A wedged lane: kill it so onExit fires and the pool re-dispatches; the
          // killed process frees its CPU + RSS immediately.
          this.pending = null;
          this.busy = false;
          try { this.proc.kill('SIGKILL'); } catch { /* already gone */ }
          reject(Object.assign(new Error(`lane ${this.index} slice timeout ${timeoutMs}ms`), { laneDied: true }));
        }
      }, timeoutMs);
      this.pending = {
        reqId,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      try {
        this.proc.send({ type: 'embed', reqId, texts, ortBatchSize });
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        this.busy = false;
        reject(Object.assign(new Error(`lane ${this.index} send failed: ${err?.message || err}`), { laneDied: true }));
      }
    });
  }

  destroy() {
    try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

/**
 * The lane pool. Lifecycle: construct (spawns lanes, each loads the model once),
 * embedBatch() repeatedly (one fetched batch at a time), destroy() at shutdown.
 *
 * The pool is created lazily by embed.js only when laneCount >= 2; laneCount 1
 * uses the in-process embedBatch and never constructs a pool (zero new processes
 * for the day profile / non-daemon callers — the cost is opt-in to the night fan-out).
 */
export class LanePool {
  /**
   * @param {object} opts
   * @param {number} opts.laneCount
   * @param {object} [opts.env] extra env for each lane (e.g. pin intra-op threads)
   * @param {number} [opts.sliceTimeoutMs] per-lane hard ceiling for one slice
   */
  constructor({ laneCount, env = {}, sliceTimeoutMs = 180_000, laneScript = LANE_SCRIPT } = {}) {
    this.laneCount = Math.max(1, Math.floor(laneCount));
    this.env = env;
    this.sliceTimeoutMs = sliceTimeoutMs;
    this.laneScript = laneScript;
    this.destroyed = false;
    this.lanes = [];
    for (let i = 0; i < this.laneCount; i++) {
      this.lanes.push(new Lane(i, {
        env,
        laneScript,
        onExit: (idx) => this._respawnLane(idx),
      }));
    }
  }

  _respawnLane(idx) {
    if (this.destroyed) return;
    // KeepAlive for lanes: a dead lane is replaced so the pool stays at full width
    // for the next batch. The in-flight slice that died was already rejected (and
    // is being re-dispatched); this just restores capacity.
    this.lanes[idx] = new Lane(idx, {
      env: this.env,
      laneScript: this.laneScript,
      onExit: (i) => this._respawnLane(i),
    });
  }

  /** Sum-RSS of parent + all live lanes, MB. */
  sumRssMb() {
    const parent = Math.round(process.memoryUsage().rss / 1048576);
    const lanes = this.lanes.map((l) => l.rssMb());
    return { parent, lanes, sum: parent + lanes.reduce((a, v) => a + v, 0) };
  }

  /**
   * Pre-dispatch sum-RSS gate. Returns sumRssDecision against the live ceiling.
   * The daemon calls this between batches; ok:false → exit for a fresh respawn.
   */
  rssGate(workerName) {
    const { parent, lanes } = this.sumRssMb();
    // Reuse the single-embedder ceiling constant so day and night share one budget.
    const ceilingMb = rssCeilingDecision(workerName).ceilingMb;
    return sumRssDecision(parent, lanes, ceilingMb);
  }

  /**
   * Wait for every lane to send its ready signal before the first dispatch.
   *
   * Lane construction starts child processes asynchronously. Calling embedBatch()
   * immediately can race model load and surface "lane not ready" as if inference
   * failed. Daemon-style callers use this startup barrier once; steady-state lane
   * respawns still rely on embedBatch's existing ready-lane fallback/retry path.
   */
  async waitUntilReady({ timeoutMs = 300_000, pollMs = 100 } = {}) {
    const timeout = Math.max(1, Number(timeoutMs) || 300_000);
    const poll = Math.max(10, Number(pollMs) || 100);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.destroyed) throw new Error('lane pool destroyed before ready');
      if (this.lanes.length && this.lanes.every((l) => l && l.ready)) return true;
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
    const ready = this.lanes.filter((l) => l && l.ready).length;
    throw new Error(`lane pool not ready after ${timeout}ms (${ready}/${this.laneCount} ready)`);
  }

  /**
   * Kill every lane whose process is currently embedding (busy). st_fd14cdd4 AC9 —
   * an ONNX inference inside a lane is CPU-bound and UNINTERRUPTIBLE from the
   * parent: the lane child receives only {texts, ortBatchSize} over IPC and runs
   * the batch to completion with no in-process abort channel. So when chat lands
   * mid-batch, the ONLY way to free the lanes' ~3.7 cores immediately is to KILL
   * the busy lane processes — SIGKILL frees their CPU and RSS unconditionally and
   * at once. The slices they were embedding are durable on the parent (those rows
   * are still embedded=0 in the DB), so the kill loses no data; the killed lanes
   * respawn (KeepAlive via _respawnLane) and reload the model for the next quiet
   * pass. This is the difference between "stop DISPATCHING new batches" (which left
   * the in-flight lanes grinding for the full multi-second batch — the 27s-TTFT
   * defect) and "free the CPU NOW".
   * @returns {number} count of lanes killed
   */
  cancelInFlight() {
    let killed = 0;
    for (const l of this.lanes) {
      if (l && l.busy) {
        try { l.proc?.kill('SIGKILL'); killed++; } catch { /* already gone */ }
      }
    }
    return killed;
  }

  /**
   * Embed a whole fetched batch across the lanes and return the vectors in the
   * SAME order as `texts`. Splits via planLaneDispatch (disjoint contiguous
   * slices), dispatches each slice to its lane, re-dispatches a slice whose lane
   * died, and reassembles via reassembleVectors. The result is index-for-index
   * identical to a serial embed — embed.js maps vector[i] → toEmbed[i] unchanged.
   *
   * st_fd14cdd4 AC9 — when `signal` aborts mid-flight (chat landed: the daemon's
   * activityWatch fired sliceAc.abort()), the busy lanes are KILLED immediately so
   * their CPU frees within one watch tick rather than after the full lane batch.
   * The abort then propagates as an AbortError (a benign yield in embed.js), and
   * the killed lanes respawn for the next quiet pass. A lane death caused by THIS
   * abort must NOT be retried (the whole point is to stop, not re-dispatch), so the
   * abort listener sets a flag the retry loop checks.
   *
   * @param {string[]} texts
   * @param {number} ortBatchSize the per-lane internal ORT sub-batch size
   * @param {AbortSignal} [signal] master abort (chat landed / shutdown)
   * @returns {Promise<Array>} vectors, length === texts.length
   */
  async embedBatch(texts, ortBatchSize, signal = null) {
    if (this.destroyed) throw new Error('lane pool destroyed');
    if (!texts.length) return [];
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const plan = planLaneDispatch(texts.length, this.laneCount);

    // st_fd14cdd4 AC9 — on a mid-flight abort, kill the busy lanes so their CPU
    // frees at once instead of after the full batch. `aborting` makes the retry
    // loop treat the resulting lane death as an abort (stop), not a lane-died
    // (retry) — without it the killed slice would be re-dispatched to a respawned
    // lane and keep the CPU busy, defeating the yield.
    let aborting = false;
    const onAbort = () => { aborting = true; this.cancelInFlight(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    // Dispatch every slice; a slice whose lane dies is retried on a (respawned)
    // lane up to maxAttempts times before giving up on the whole batch.
    const maxAttempts = this.laneCount + 1;
    const runSlice = async ({ lane, start, end }) => {
      let attempt = 0;
      let lastErr = null;
      while (attempt < maxAttempts) {
        if (signal?.aborted || aborting) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        attempt++;
        // Pick the assigned lane if alive; if it died and a respawn is mid-flight,
        // fall back to any ready lane. The slice index range is fixed; only WHICH
        // process runs it changes — disjointness is preserved because the slice
        // bounds never change.
        const target = this.lanes[lane]?.ready ? this.lanes[lane]
          : (this.lanes.find((l) => l && l.ready && !l.busy) || this.lanes[lane]);
        try {
          const { vectors } = await target.embed(texts.slice(start, end), ortBatchSize, this.sliceTimeoutMs);
          return { start, vectors };
        } catch (err) {
          lastErr = err;
          if (err?.name === 'AbortError') throw err;
          // st_fd14cdd4 AC9 — a lane death caused by OUR abort kill is an abort,
          // not a transient crash: surface it as AbortError so the batch stops
          // and the slice is NOT re-dispatched (which would re-busy the CPU).
          if (aborting || signal?.aborted) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          }
          if (!err?.laneDied) throw err; // a real model error is not a retry case
          // lane died: brief yield so the respawn can come up, then retry.
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      throw lastErr || new Error(`slice [${start},${end}) failed after ${maxAttempts} attempts`);
    };

    let results;
    try {
      results = await Promise.all(plan.map(runSlice));
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    const merged = reassembleVectors(results, texts.length);
    // IPC carries each vector as a plain number[] (a Float32Array does not survive
    // child_process structured-clone as a typed array). Rebuild Float32Array here so
    // the pool's return type is IDENTICAL to the in-process embedBatch() — embed.js
    // hands these straight to vectorToBuffer(), which requires a Float32Array. Do
    // the conversion at this single boundary so reassembleVectors stays type-agnostic
    // (and unit-testable with plain arrays).
    return merged.map((v) => (v instanceof Float32Array ? v : Float32Array.from(v)));
  }

  destroy() {
    this.destroyed = true;
    for (const l of this.lanes) l.destroy();
    this.lanes = [];
  }
}
