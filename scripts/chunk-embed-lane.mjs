#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/chunk-embed-lane.mjs — st_db4b3118 parallel inference lane.
//
// Compute tier: orchestration (no LLM-against-structured-data; this runs the
// deterministic local ONNX embed primitive). ONE inference lane: a child process
// the lane pool (lib/rag/lane-pool.js) spawns. It loads the embedding model ONCE
// into its OWN address space, then answers {texts} → {vectors} over IPC forever.
//
// HARD CONTRACT (the single-writer + jetsam invariants depend on it):
//   - A lane NEVER opens the DB. It imports the model module only — no lib/db.js,
//     no chunks table, no vec0 write. The PARENT daemon does every read and write.
//     This keeps exactly one SQLCipher writer (the parent) and means a lane can be
//     SIGKILLed at any instant with zero risk to data: the rows it was embedding
//     are still embedded=0 on the parent and get re-dispatched.
//   - A lane pins a SMALL intra-op thread count (it is one of N parallel lanes;
//     parallelism is ACROSS lanes, not within one). Inherited ORT memory bounds
//     (arena + mem-pattern OFF, sequential) keep each lane's RSS near the model
//     working set so the pool's sum-RSS gate stays meaningful.
//
// Vectors cross IPC as plain number[] (structured-clone mangles a Float32Array
// into an index object across child_process IPC); the parent rebuilds the typed
// array. The lane validates dimension before sending so a bad vector fails here,
// loud, rather than being written under a chunk_id.
// ─────────────────────────────────────────────────────────────────────────────

export const INTELLIGENCE_TIER = 'orchestration';

import { homedir } from 'node:os';
import { resolve } from 'node:path';

const HOME = process.env.HOME || homedir();
const ROOT = process.env.ROBOTDOJO_HOME || resolve(HOME, 'robotdojo');

const laneIndex = process.argv[2] || '0';
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} [embed-lane-${laneIndex}] ${m}`);

// Send to the parent over IPC, swallowing a closed-channel error. If the parent
// died (EPIPE / ERR_IPC_CHANNEL_CLOSED), the lane is about to be torn down anyway;
// crashing on the report would leave a noisy err-log line on every restart. A
// dropped result is harmless: the parent already rejected that in-flight slice on
// the lane's exit and re-dispatched it.
//
// WHY the callback form (not just try/catch): process.send() reports a failed write
// BOTH ways — it can throw synchronously AND it emits an async 'error' event on the
// process. A try/catch catches only the synchronous throw; the async 'error' event
// would still be unhandled and crash the lane (the EPIPE seen in the err log).
// Passing a callback makes Node deliver the error to the callback INSTEAD of emitting
// the 'error' event — so this one guard covers both paths. A belt-and-suspenders
// process-level 'error' handler below catches anything that still slips through.
function safeSend(msg) {
  try {
    if (!process.connected) return false;
    process.send(msg, undefined, undefined, () => { /* swallow async send error */ });
    return true;
  } catch {
    return false;
  }
}

// A lane is one of N; it must NOT also try to grab the full P-core set or the
// box oversubscribes (N lanes × full cores = thrash). Pin a small per-lane count.
// Env-tunable (ROBOTDOJO_LANE_INTRA_THREADS); the pool passes a sensible default.
// We set the same env the model module reads for the DAY profile thread count so
// the lane's session is built with this count regardless of profile flag — the
// lane is always a single bounded inference stream.
if (!process.env.ROBOTDOJO_EMBED_ORT_INTRA_THREADS) {
  process.env.ROBOTDOJO_EMBED_ORT_INTRA_THREADS = process.env.ROBOTDOJO_LANE_INTRA_THREADS || '2';
}

const { embedLocalBatch, LOCAL_EMBED_DIM } = await import(resolve(ROOT, 'lib/rag/local-embed.js'));

// Load the model ONCE up front (a cold lane that lazy-loaded on first request would
// stall the whole batch behind one ~60s load). prewarm with a trivial input, then
// signal ready so the pool only dispatches to a warm lane.
let ready = false;
async function warmUp() {
  try {
    await embedLocalBatch(['robot dojo lane warmup'], { batchSize: 1, inputType: 'document' });
    ready = true;
    log('model loaded, ready');
    safeSend({ type: 'ready' });
  } catch (err) {
    log(`FATAL warmup failed: ${err?.message || err}`);
    process.exit(1);
  }
}

/**
 * Embed one slice of texts. Returns plain number[][] in input order, validated to
 * the model dim. Throws on any dim/shape error so the parent re-fetches rather
 * than writing a malformed vector.
 */
async function embedSlice(texts, ortBatchSize) {
  const batchSize = Number.isFinite(Number(ortBatchSize)) && Number(ortBatchSize) > 0
    ? Math.floor(Number(ortBatchSize))
    : 8;
  const vecs = await embedLocalBatch(texts, { batchSize, inputType: 'document' });
  if (vecs.length !== texts.length) {
    throw new Error(`lane returned ${vecs.length} vectors for ${texts.length} texts`);
  }
  return vecs.map((v) => {
    if (!v || v.length !== LOCAL_EMBED_DIM) {
      throw new Error(`lane vector dim ${v?.length} != ${LOCAL_EMBED_DIM}`);
    }
    // Float32Array → plain array for IPC; the parent rebuilds the Float32Array.
    return Array.from(v);
  });
}

process.on('message', async (msg) => {
  if (msg?.type !== 'embed') return;
  const { reqId, texts, ortBatchSize } = msg;
  if (!ready) {
    safeSend({ type: 'result', reqId, error: 'lane not ready' });
    return;
  }
  try {
    const vectors = await embedSlice(Array.isArray(texts) ? texts : [], ortBatchSize);
    safeSend({ type: 'result', reqId, vectors });
  } catch (err) {
    safeSend({ type: 'result', reqId, error: err?.message || String(err) });
  }
});

// A parent exit / disconnect ends the lane — it has no work without the pool.
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
// Belt-and-suspenders: a parent that dies mid-send can still surface a channel
// 'error' on the process instance (the EPIPE seen in the err log). The callback in
// safeSend handles the common case; this catches any residual one so the lane exits
// cleanly (a dead parent is a benign teardown — the parent re-dispatches that slice)
// instead of crashing non-zero and spamming the err log on every restart. A lane
// holds no recoverable state, so any process-level error is a clean exit.
process.on('error', () => process.exit(0));

await warmUp();
