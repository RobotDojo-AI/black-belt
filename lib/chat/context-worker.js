/**
 * lib/chat/context-worker.js — volatile context assembly on a worker thread
 * (st_df0a8d71 D5 / AC-11).
 *
 * WHY a worker thread: better-sqlite3 is synchronous — once a statement
 * starts, a JS timeout on the main thread CANNOT interrupt it. Under embed-
 * daemon writer contention the "3-second" fast-context budget was observed
 * running 16–22 s (live turns 8215c17e, 70c6f762): the sync SQL pinned the
 * event loop, so the timer that was supposed to bound it could not fire. The
 * fallback designed to protect TTFT was itself the TTFT violation.
 *
 * Moving the volatile-tail builds (buildFastTimeoutContext, and the
 * direct-entity detection path) onto a worker_threads worker makes the budget
 * REAL: the worker's sync SQL blocks only the worker; the main thread's race
 * timer fires exactly at the budget, the turn proceeds with a LOUD skip
 * (enrichment status 'timeout' + per-turn record + console.warn), and the
 * 16–22 s blocked-turn class becomes structurally impossible. The cached
 * prefix path (identity/ego/brief — memory reads after first assembly) never
 * goes near this module, so TTFT and the prompt-cache invariant are untouched.
 *
 * WORKER DB DISCIPLINE: the worker opens its OWN connection by importing
 * lib/db.js in its thread (the standard module path — same idempotent
 * migration behavior as every background script) and then immediately locks it
 * with PRAGMA query_only=1 BEFORE serving any request, so every query the
 * worker ever runs is read-only-enforced at the SQL layer. If the worker
 * cannot boot (cipher/key failure), the client falls back to the inline path
 * exactly like the kill-switch — worst case is today's behavior, minus the
 * silence.
 *
 * KILL-SWITCH: ROBOTDOJO_CONTEXT_WORKER=0 restores the inline path instantly,
 * no deploy.
 *
 * WEDGE RECOVERY: a request that outlives its deadline leaves the worker
 * suspect. The client probes it with a ping (2 s); no pong → terminate and
 * lazily respawn in the background. Turns during the respawn window fall back
 * inline (loud), never wait.
 */

import { Worker, isMainThread, parentPort } from 'node:worker_threads';

// ─────────────────────────────────────────────────────────────────────────────
// WORKER SIDE
// ─────────────────────────────────────────────────────────────────────────────
if (!isMainThread && parentPort) {
  // Open the DB via the standard module, then lock the connection read-only
  // before any request is served (see WORKER DB DISCIPLINE above).
  const { default: workerDb } = await import('../db.js');
  try {
    workerDb.pragma('query_only = 1');
  } catch (err) {
    // query_only failing means we cannot GUARANTEE read-only — refuse to
    // serve rather than run un-fenced (fail loud; parent falls back inline).
    parentPort.postMessage({ fatal: `query_only pragma failed: ${err?.message || err}` });
    process.exit(1);
  }
  const { buildFastTimeoutContext, buildDirectEntityAnswer } = await import('../chat-context.js');

  parentPort.on('message', async (msg) => {
    const { id, kind, args } = msg || {};
    if (kind === 'ping') {
      parentPort.postMessage({ id, ok: true, result: 'pong' });
      return;
    }
    try {
      let result = null;
      if (kind === 'fast_context') {
        result = await buildFastTimeoutContext(args.query, args.opts || {});
      } else if (kind === 'direct_entity') {
        result = await buildDirectEntityAnswer(args.query, args.opts || {});
      } else if (kind === 'test_stall') {
        // Test hook (st_df0a8d71 context-worker spec): genuinely BLOCK this
        // thread synchronously — the honest stand-in for un-interruptible
        // sync SQL. Atomics.wait cannot be preempted by any JS timer in this
        // thread, exactly like a long better-sqlite3 statement.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(args?.ms) || 10_000);
        result = { stalled: true };
      } else {
        throw new Error(`unknown request kind: ${kind}`);
      }
      parentPort.postMessage({ id, ok: true, result });
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
    }
  });

  parentPort.postMessage({ ready: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT SIDE (main thread)
// ─────────────────────────────────────────────────────────────────────────────

function workerEnabled() {
  // Read at call time so tests can flip the kill-switch without module reload.
  if (process.env.ROBOTDOJO_CONTEXT_WORKER === '0') return false;
  // An in-memory DB cannot be shared across threads — the worker would open
  // its OWN empty :memory: database and answer from nothing. Unit tests and
  // ephemeral fixtures therefore always run the inline path.
  if (process.env.ROBOTDOJO_DB === ':memory:') return false;
  return true;
}

const WORKER_BOOT_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_CONTEXT_WORKER_BOOT_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 15_000;
})();
const WORKER_PROBE_TIMEOUT_MS = 2_000;

let _worker = null;          // live Worker or null
let _workerReady = null;     // Promise resolving true once the worker signals ready
let _workerFatal = false;    // worker reported an unrecoverable boot failure
let _nextRequestId = 1;
const _pending = new Map();  // id → { resolve, reject }
let _probeInFlight = false;

function failAllPending(err) {
  for (const [, entry] of _pending) {
    try { entry.reject(err); } catch { /* consumer already raced past */ }
  }
  _pending.clear();
}

function teardownWorker() {
  const w = _worker;
  _worker = null;
  _workerReady = null;
  if (w) { try { w.terminate(); } catch { /* already dead */ } }
  failAllPending(new Error('context worker terminated'));
}

function ensureWorker() {
  if (_worker || _workerFatal) return _worker;
  try {
    _worker = new Worker(new URL(import.meta.url), {
      // ROBOTDOJO_MMAP_SIZE=0: the worker's connection skips the 16 GiB mmap
      // reservation (same jetsam-exposure precedent as the persistent embed
      // worker — see lib/db.js MMAP override). The worker serves bounded
      // budget-raced reads; paying read() page faults there is cheaper than
      // doubling the process's mapped footprint on a 16 GB machine.
      // ROBOTDOJO_DB_SKIP_MIGRATE=1: this connection is read-only. Re-running
      // schema writes on first chat contended with the live turn and surfaced
      // as first_delta_timeout on every provider.
      env: { ...process.env, ROBOTDOJO_MMAP_SIZE: '0', ROBOTDOJO_DB_SKIP_MIGRATE: '1' },
    });
  } catch (err) {
    console.warn('[context-worker] spawn failed — inline fallback:', err?.message || err);
    _workerFatal = true;
    return null;
  }
  // The worker must never hold the server process open on shutdown.
  _worker.unref();
  _workerReady = new Promise((resolveReady) => {
    const bootTimer = setTimeout(() => resolveReady(false), WORKER_BOOT_TIMEOUT_MS);
    if (typeof bootTimer.unref === 'function') bootTimer.unref();
    _worker?.on('message', (msg) => {
      if (msg?.ready) {
        clearTimeout(bootTimer);
        // A late ready after the boot timer must still flip the client: a 29GB
        // SQLCipher open can miss WORKER_BOOT_TIMEOUT_MS, and a sticky false
        // made every later turn inline sync SQL on the main thread.
        _workerReady = Promise.resolve(true);
        resolveReady(true);
        return;
      }
      if (msg?.fatal) {
        clearTimeout(bootTimer);
        console.warn('[context-worker] worker fatal at boot — inline fallback:', msg.fatal);
        _workerFatal = true;
        teardownWorker();
        resolveReady(false);
        return;
      }
      const entry = _pending.get(msg?.id);
      if (!entry) return; // request already timed out / abandoned
      _pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || 'context worker error'));
    });
  });
  _worker.on('error', (err) => {
    console.warn('[context-worker] worker error — respawning lazily:', err?.message || err);
    teardownWorker();
  });
  _worker.on('exit', (code) => {
    if (code !== 0) console.warn(`[context-worker] worker exited code=${code} — respawning lazily`);
    if (_worker) teardownWorker();
  });
  return _worker;
}

/**
 * Probe a suspect worker after a request deadline passed. No pong within
 * WORKER_PROBE_TIMEOUT_MS ⇒ the thread is wedged in sync work — terminate it;
 * the next request respawns a fresh one. Background-only: never awaited by a
 * chat turn.
 */
function probeWorkerHealth() {
  if (_probeInFlight || !_worker) return;
  _probeInFlight = true;
  const id = _nextRequestId++;
  const timer = setTimeout(() => {
    _pending.delete(id);
    _probeInFlight = false;
    console.warn('[context-worker] worker wedged (ping timeout) — terminating and respawning in background');
    teardownWorker();
    // Eager respawn so the next turn finds a warm worker instead of paying
    // boot cost inline with a user waiting.
    setImmediate(() => { try { ensureWorker(); } catch { /* lazy retry */ } });
  }, WORKER_PROBE_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  _pending.set(id, {
    resolve: () => { clearTimeout(timer); _probeInFlight = false; },
    reject: () => { clearTimeout(timer); _probeInFlight = false; },
  });
  try { _worker.postMessage({ id, kind: 'ping' }); } catch {
    clearTimeout(timer);
    _probeInFlight = false;
    teardownWorker();
  }
}

class ContextWorkerTimeout extends Error {
  constructor(ms) {
    super(`context worker request exceeded ${ms}ms`);
    this.name = 'ContextWorkerTimeout';
    this.code = 'CONTEXT_WORKER_TIMEOUT';
  }
}

/**
 * Post one request and race a REAL timer. The timer is a plain (ref'd)
 * setTimeout on the main thread; because the heavy sync SQL now lives in the
 * worker, nothing can starve this timer — the budget fires at the budget.
 *
 * @returns {Promise<any>} resolves with the worker result; rejects with
 *   ContextWorkerTimeout at the deadline or a worker error.
 */
export async function requestFromContextWorker(kind, args, { timeoutMs = 3_000 } = {}) {
  const w = ensureWorker();
  if (!w) throw new Error('context worker unavailable');
  const ready = await Promise.race([
    _workerReady,
    new Promise((r) => {
      const t = setTimeout(() => r(false), timeoutMs);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
  if (!ready || !_worker) throw new Error('context worker not ready');

  const id = _nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id);
      // Deadline passed with the request still in flight — the worker may be
      // wedged in sync SQL. Probe in the background; the turn itself has
      // already been released by this rejection.
      probeWorkerHealth();
      reject(new ContextWorkerTimeout(timeoutMs));
    }, timeoutMs);
    _pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      _worker.postMessage({ id, kind, args });
    } catch (err) {
      clearTimeout(timer);
      _pending.delete(id);
      reject(err);
    }
  });
}

function skippedFastContext(reason) {
  return {
    context: '',
    trace: {
      present: false,
      cache_hit: false,
      timeout: false,
      skipped: true,
      reason: String(reason || 'worker_unavailable'),
      tier: null,
      chars: 0,
      sections: [],
      source_types: [],
      target_types: [],
      event_types: [],
    },
  };
}

/**
 * Spawn the context worker during boot so the first real chat turn does not
 * pay worker-open + inline sqlite on the main thread.
 */
export function prewarmContextWorker() {
  if (!workerEnabled() || _workerFatal) return null;
  return ensureWorker();
}

/** Only serializable option fields cross the thread boundary. */
function serializableFastContextOpts(opts = {}) {
  return {
    belt: opts.belt,
    entityDetectionText: opts.entityDetectionText || null,
    layerTimeoutMs: opts.layerTimeoutMs,
    enrichmentFaults: opts.enrichmentFaults ? [...opts.enrichmentFaults] : null,
  };
}

/**
 * Worker-routed buildFastTimeoutContext with inline fallback.
 *
 * Timeout semantics: `budgetMs` is the mode budget the caller already races
 * on (lib/chat.js optionalEnrichment). The worker request uses budget + a
 * small grace so the caller's race is ALWAYS the first to fire (one timeout
 * authority; the worker client's own deadline exists only to drive wedge
 * detection/respawn after the turn has moved on).
 *
 * @returns {Promise<{context: string, trace: object}>}
 */
export async function buildFastTimeoutContextSmart(query, opts = {}, { budgetMs = 3_000 } = {}) {
  if (!workerEnabled() || _workerFatal) {
    const { buildFastTimeoutContext } = await import('../chat-context.js');
    return buildFastTimeoutContext(query, opts);
  }
  try {
    return await requestFromContextWorker(
      'fast_context',
      { query, opts: serializableFastContextOpts(opts) },
      { timeoutMs: budgetMs + 1_000 },
    );
  } catch (err) {
    if (err?.code === 'CONTEXT_WORKER_TIMEOUT') {
      // The caller's own race has already skipped this layer loudly; rethrow
      // so nothing double-consumes a stale result.
      throw err;
    }
    // Worker unavailable (boot / respawn window). Do NOT inline sync SQL on
    // the main thread — that is the blocked-loop class this worker exists to
    // prevent. Cached prefix + topic last-state still ride the turn.
    console.warn('[context-worker] fast-context skipped:', err?.message || err);
    return skippedFastContext(err?.message || err);
  }
}

/**
 * Worker-routed buildDirectEntityAnswer with a REAL deadline. Returns null on
 * timeout (loud) — the caller proceeds to the model path, matching the
 * existing null contract for "no direct local answer".
 */
export async function buildDirectEntityAnswerSmart(query, opts = {}, { budgetMs = 1_800 } = {}) {
  if (!workerEnabled() || _workerFatal) {
    const { buildDirectEntityAnswer } = await import('../chat-context.js');
    return buildDirectEntityAnswer(query, opts);
  }
  try {
    return await requestFromContextWorker(
      'direct_entity',
      { query, opts: { belt: opts.belt } },
      { timeoutMs: budgetMs },
    );
  } catch (err) {
    if (err?.code === 'CONTEXT_WORKER_TIMEOUT') {
      console.warn(`[context-worker] direct-entity lookup skipped loudly at ${budgetMs}ms (worker still busy)`);
      return null;
    }
    console.warn('[context-worker] direct-entity skipped:', err?.message || err);
    return null;
  }
}

/** Test hooks — deterministic worker lifecycle control. */
export function _terminateContextWorkerForTest() {
  _workerFatal = false;
  teardownWorker();
}
export function _contextWorkerStateForTest() {
  return { hasWorker: Boolean(_worker), pending: _pending.size, fatal: _workerFatal };
}
