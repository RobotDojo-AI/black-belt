/**
 * lib/rag/embed.js
 *
 * embedChunks(topic) — embed all un-embedded chunks for a topic.
 *
 * For each topic:
 *   1. Ensure chunk_vec_{topic} vec0 table exists (CREATE IF NOT EXISTS)
 *   2. Fetch chunks whose local embedding signature is missing/stale.
 *   3. Batch-embed via local embedBatch() from lib/rag.js
 *   4. DELETE existing row by chunk_id, then INSERT into chunk_vec_{topic}
 *   5. Mark chunks.embedded=1
 *   6. Repeat until no more unembedded rows
 *
 * WHY chunk_id as TEXT: sqlite-vec vec0 requires TEXT PRIMARY KEY for MATCH queries.
 * WHY DELETE+INSERT (st_f6315f0b): sqlite-vec 0.1.9's vec0 virtual table does
 *   NOT implement INSERT OR REPLACE semantics — it raises UNIQUE constraint
 *   failed on a chunk_id that already exists in the table. The prior code used
 *   INSERT OR REPLACE which poison-pilled the entire batch every 120s. The
 *   DELETE removes any existing row before the INSERT, both inside one
 *   transaction with markEmbedded so partial state is impossible. Upstream
 *   fix is pending in v0.1.10-alpha.3 (pre-release only).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import db, { openEmbeddingsDb } from '../db.js';
import {
  EMBED_DIM,
  EMBED_MODEL,
  contentHash,
  embedBatch,
  embeddingSignature,
  vectorToBuffer,
} from '../rag.js';
import { embedInputCharCap } from './local-embed.js';
import { rssCeilingDecision } from '../idle-gate.js';

const DEFAULT_BATCH_SIZE = 8;
const configuredBatchSize = Number(process.env.ROBOTDOJO_EMBED_BATCH_SIZE || DEFAULT_BATCH_SIZE);
const BATCH_SIZE = Number.isFinite(configuredBatchSize) && configuredBatchSize > 0
  ? Math.floor(configuredBatchSize)
  : DEFAULT_BATCH_SIZE;

// st_2cd1af73 AC-3 — adaptive batch size for long-input topics.
//
// WHY: the ONNX CPU path pads every sequence in a batch to the longest one and
// allocates intermediate activations sized batch×seq_len×hidden. For long inputs
// (transcript/coaching chunks, ~4000 chars ≈ 1k tokens after the input cap) a full
// batch of 8 balloons RSS and runs minutes; measured on this box, batch=8 over
// 4000-char inputs climbed without bound and ran >130 s, while batch=2 over the
// same inputs stayed ~6 GB and finished in 46 s. Email-class chunks are short, so
// they keep the full batch for throughput (~0.17 s/chunk). The effective batch
// size is chosen per fetched batch from its OWN average input length: long → small
// batch, short → full batch. Tunable via config/defaults.json embed.* + env.
const EMBED_DEFAULTS = (() => {
  try {
    const raw = readFileSync(resolve(homedir(), 'robotdojo', 'config', 'defaults.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return cfg?.embed && typeof cfg.embed === 'object' ? cfg.embed : {};
  } catch {
    return {};
  }
})();

function numFromEnvOrCfg(envName, cfgVal, fallback) {
  const env = Number(process.env[envName]);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  if (Number.isFinite(Number(cfgVal)) && Number(cfgVal) > 0) return Math.floor(Number(cfgVal));
  return fallback;
}

const LONG_INPUT_CHAR_THRESHOLD = numFromEnvOrCfg('ROBOTDOJO_EMBED_LONG_INPUT_CHARS', EMBED_DEFAULTS.longInputCharThreshold, 2000);
const LONG_INPUT_BATCH_SIZE = numFromEnvOrCfg('ROBOTDOJO_EMBED_LONG_INPUT_BATCH', EMBED_DEFAULTS.longInputBatchSize, 2);

// st_fd14cdd4 AC9 — the DAY-PROFILE in-flight-inference cap (the MEDIUM tier).
//
// THE BUG THIS FIXES: a single ONNX inference is UNINTERRUPTIBLE — the abort signal
// is only checked BETWEEN extractor() calls (lib/rag/local-embed.js embedLocalBatch),
// so the worst-case "chat turn caught mid-inference" latency is exactly one
// extractor() call's wall clock. effectiveBatchSize was a BINARY: avg ≤ 2000 chars →
// full short batch (8), else the long tier (2). MEASURED on this box at the day
// intra-op (2 threads): a SHORT-classified batch of medium chunks (avg ~1750 chars,
// still ≤ the 2000 long threshold) embedded at batch 8 in ~3.9s — OVER the ≤3s bar.
// A chat turn landing during it ate that full ~3.9s (and worse under contention — the
// 7.2s the brief measured). The short band is fine: avg ~159 chars at batch 8 is
// ~0.27s. It is the MEDIUM band (≈800–2000 chars) at batch 8 that breaks the bar.
//
// FIX: a third length band. avg ≤ MEDIUM_INPUT_CHAR_THRESHOLD → the full short tier
// (genuinely short, ~0.27s at 8); ≤ LONG_INPUT_CHAR_THRESHOLD → the MEDIUM tier
// (measured ≤ ~1.8s at batch 4 across the whole 800–2000 band); else the long tier.
// EVERY day in-flight inference unit is then ≤ ~2s — comfortably under the ≤3s bar.
//
// OFF-HOURS keeps big batches (the brief): night mode passes a widened shortBatchSize
// (NIGHT_SHORT_BATCH, default 16) for the short tier AND widens the MEDIUM tier in
// proportion (half the night short batch), so the medium band still drains in wider
// ORT sub-batches when chat has been quiet 15 min — there is no live turn to protect
// then, so a larger medium unit is acceptable for throughput. The LONG tier stays
// profile-invariant at LONG_INPUT_BATCH_SIZE (its peak activation memory is the
// jetsam-balloon risk — the 95GB scar). Day medium is the bounded MEDIUM_INPUT_BATCH_SIZE.
const MEDIUM_INPUT_CHAR_THRESHOLD = numFromEnvOrCfg('ROBOTDOJO_EMBED_MEDIUM_INPUT_CHARS', EMBED_DEFAULTS.mediumInputCharThreshold, 800);
const MEDIUM_INPUT_BATCH_SIZE = numFromEnvOrCfg('ROBOTDOJO_EMBED_MEDIUM_INPUT_BATCH', EMBED_DEFAULTS.mediumInputBatchSize, 4);
const CHAT_HISTORY_FIRST_SOURCE_TYPES = Object.freeze([
  'conversation',
]);
const COVERAGE_FIRST_SOURCE_TYPES = Object.freeze([
  'conversation',
  'user-fact',
  'workbench',
  'transcript',
  'llm_export',
  'health',
  'calendar',
  'drive',
  'asana',
  'imessage',
]);

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Choose the embed batch size for a set of texts from their average post-cap input
 * length. THREE length bands (st_fd14cdd4 AC9) so a single uninterruptible inference
 * stays bounded by INPUT length, not just by the short/long binary:
 *   - short  (avg ≤ MEDIUM_INPUT_CHAR_THRESHOLD): full short tier (throughput).
 *   - medium (avg ≤ LONG_INPUT_CHAR_THRESHOLD): the bounded MEDIUM tier (the day cap).
 *   - long   (avg >  LONG_INPUT_CHAR_THRESHOLD): the small long tier (RSS bound).
 * The cap (embedInputCharCap) is applied first so the decision reflects the bytes the
 * tokenizer actually sees.
 *
 * st_2cd1af73 / st_fd14cdd4 NIGHT MODE — `shortBatchSize` overrides the SHORT tier
 * (NIGHT_SHORT_BATCH, default 16) AND widens the MEDIUM tier in proportion (half the
 * night short batch, floored at the day MEDIUM size) so the medium band also drains
 * faster off-hours. The LONG tier is NEVER widened — its peak activation memory is the
 * jetsam-balloon risk and the RSS contract is profile-invariant (the 95GB incident).
 * Absent the override (DAY profile, or any non-daemon caller) the short tier is the
 * normal BATCH_SIZE and the medium tier is the bounded MEDIUM_INPUT_BATCH_SIZE — so the
 * day in-flight inference unit is always ≤ ~2s, the ≤3s bar the brief sets.
 *
 * @param {string[]} texts batch contents
 * @param {object} [opts]
 * @param {number} [opts.shortBatchSize] override for the short tier (night mode)
 * @returns {number} effective batch size (>=1)
 */
export function effectiveBatchSize(texts, { shortBatchSize } = {}) {
  const nightWidened = Number.isFinite(Number(shortBatchSize)) && Number(shortBatchSize) > 0;
  const shortTier = nightWidened ? Math.floor(Number(shortBatchSize)) : BATCH_SIZE;
  // Night widens the medium tier to half the night short batch (so a wider short
  // batch lifts the medium band too), never below the day MEDIUM size; day uses the
  // bounded MEDIUM_INPUT_BATCH_SIZE (the ≤~2s day cap measured on this hardware).
  const mediumTier = nightWidened
    ? Math.max(MEDIUM_INPUT_BATCH_SIZE, Math.floor(shortTier / 2))
    : MEDIUM_INPUT_BATCH_SIZE;
  if (!texts.length) return shortTier;
  const cap = embedInputCharCap();
  let total = 0;
  for (const t of texts) {
    const len = String(t || '').length;
    total += cap > 0 ? Math.min(len, cap) : len;
  }
  const avg = total / texts.length;
  if (avg > LONG_INPUT_CHAR_THRESHOLD) return Math.max(1, LONG_INPUT_BATCH_SIZE);
  if (avg > MEDIUM_INPUT_CHAR_THRESHOLD) return Math.max(1, mediumTier);
  return shortTier;
}

// st_b50005df Phase 3 — self-imposed RSS ceiling backstop. Checked between
// bounded batches (never mid-batch — a half-written transaction must finish).
// A breach is a benign stop, not a failure: the loop sets `aborted` and breaks,
// the passive handler re-queues the topic with attempts unchanged, and the next
// launchd fire respawns the worker fresh with RSS reset to baseline. We keep the
// embedder loaded ONCE per process (research: model load is the dominant fixed
// cost), so the only way to drop accumulated RSS is a fresh process — which is
// exactly what the respawn provides. Returns true if the loop should stop.
function rssCeilingBreached(workerName) {
  if (!workerName) return false;
  const decision = rssCeilingDecision(workerName);
  if (decision.ok) return false;
  console.log(decision.message);
  return true;
}

/**
 * Sanitize topic name to a safe SQL identifier segment.
 * Mirrors the same function in rag-search.js so table names match.
 */
function safeTableName(topic) {
  return `chunk_vec_${topic.replace(/[^a-z0-9_]/g, '_')}`;
}

/**
 * Ensure the vec0 virtual table for a topic exists.
 * Idempotent — CREATE VIRTUAL TABLE IF NOT EXISTS.
 *
 * st_1cfe9061 — accepts optional embeddingsDb. When provided, CREATE/DROP TABLE
 * operations target embeddingsDb (the split vec store); the embedded=0 reset
 * always stays on db (the canonical chunks store).
 */
function ensureVecTable(topic, embeddingsDb) {
  const vecDb = embeddingsDb || db;
  const tableName = safeTableName(topic);
  const existing = vecDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  const dim = existing?.sql?.match(/embedding\s+float\[(\d+)\]/i)?.[1];
  if (dim && Number(dim) !== EMBED_DIM) {
    vecDb.exec(`DROP TABLE IF EXISTS ${tableName}`);
    db.prepare(`
      UPDATE chunks
         SET embedded = 0,
             embedding_signature = NULL,
             embedding_model_id = NULL,
             embedding_dim = NULL,
             embedded_at = NULL
       WHERE topic = ?
    `).run(topic);
  }
  // WHY: vec0 with TEXT PRIMARY KEY so chunk_id is the natural key
  // and MATCH queries in rag-search.js work without a separate rowid map.
  vecDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName}
    USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${EMBED_DIM}])
  `);
  return tableName;
}

let immediateEmbeddingsDb;
function getImmediateEmbeddingsDb() {
  if (immediateEmbeddingsDb !== undefined) return immediateEmbeddingsDb;
  try {
    immediateEmbeddingsDb = openEmbeddingsDb();
  } catch {
    immediateEmbeddingsDb = null;
  }
  return immediateEmbeddingsDb;
}

/**
 * Upsert one vec0 row by DELETE-then-INSERT.
 *
 * Exported for use by other modules that write to vec0 tables and would
 * otherwise hit the same sqlite-vec 0.1.9 INSERT OR REPLACE bug
 * (maintenance-phases.js, topic-lifecycle.js, ingest/05-reclassify-chunks.js,
 * ingest-agency-xlsx.js). Callers should wrap their batch in db.transaction()
 * for atomicity; this helper is intentionally per-row.
 *
 * @param {object}  database     better-sqlite3 instance
 * @param {string}  tableName    full vec0 table name (already sanitized)
 * @param {string}  chunkId      TEXT primary key
 * @param {Buffer}  embeddingBuf raw embedding bytes
 */
export function upsertVecRow(database, tableName, chunkId, embeddingBuf) {
  database.prepare(`DELETE FROM ${tableName} WHERE chunk_id = ?`).run(String(chunkId));
  database.prepare(`INSERT INTO ${tableName}(chunk_id, embedding) VALUES (?, ?)`)
    .run(String(chunkId), embeddingBuf);
}

function topicRequiresSplitVecStore(topic) {
  try {
    return !!db.prepare('SELECT 1 FROM topic_vec_migrations WHERE topic = ?').get(topic);
  } catch {
    return false;
  }
}

/**
 * Embed one known chunk immediately.
 *
 * Chat-learned facts are foreground promises: the next chat turn should be able
 * to retrieve them without waiting for the daemon's topic-ordered backlog pass.
 * This helper writes the chunk's primary topic vector and, by default, mirrors
 * it into the ambient `chunk_vec_general` shard so unscoped first-turn recall can
 * see the fresh row before the global ANN index rebuild absorbs it.
 */
export async function embedChunkNow(chunkId, options = {}) {
  const id = Number(chunkId);
  if (!Number.isSafeInteger(id)) {
    return { ok: false, error: 'invalid_chunk_id', embedded: 0, reused: 0 };
  }

  const chunk = db.prepare(`
    SELECT id, topic, content, skip_embed,
           content_hash, embedding_signature, embedding_model_id, embedding_dim
    FROM chunks
    WHERE id = ?
  `).get(id);
  if (!chunk) return { ok: false, error: 'chunk_not_found', embedded: 0, reused: 0 };
  if (Number(chunk.skip_embed) === 1) return { ok: false, error: 'chunk_skip_embed', embedded: 0, reused: 0 };
  if (!String(chunk.content || '').trim()) return { ok: false, error: 'chunk_empty', embedded: 0, reused: 0 };

  const topic = chunk.topic;
  let embeddingsDb = options.embeddingsDb || null;
  if (!embeddingsDb && topicRequiresSplitVecStore(topic)) {
    embeddingsDb = getImmediateEmbeddingsDb();
    if (!embeddingsDb) {
      return {
        ok: false,
        error: `topic "${topic}" is migrated to embeddings.db but no embeddingsDb connection is available`,
        embedded: 0,
        reused: 0,
      };
    }
  }

  const vecDb = embeddingsDb || db;
  const tableName = ensureVecTable(topic, embeddingsDb);
  const nextContentHash = contentHash(chunk.content);
  const nextSignature = embeddingSignature({
    content_hash: nextContentHash,
    topic,
    modelId: EMBED_MODEL,
    dim: EMBED_DIM,
  });

  const chunkIdStr = String(id);
  let vecBuf = null;
  let reused = 0;
  const existing = vecDb.prepare(`SELECT embedding FROM ${tableName} WHERE chunk_id = ?`).get(chunkIdStr);
  const signatureMatches =
    chunk.content_hash === nextContentHash
    && chunk.embedding_signature === nextSignature
    && chunk.embedding_model_id === EMBED_MODEL
    && Number(chunk.embedding_dim) === EMBED_DIM;

  if (signatureMatches && existing?.embedding) {
    vecBuf = existing.embedding;
    reused = 1;
  } else {
    let vectors;
    try {
      const embedBatchFn = typeof options.embedBatchFn === 'function'
        ? options.embedBatchFn
        : embedBatch;
      vectors = await embedBatchFn([chunk.content], 1, null, { inputType: 'document' });
    } catch (err) {
      return { ok: false, error: err.message || String(err), embedded: 0, reused: 0 };
    }
    const vec = vectors?.[0];
    if (!(vec instanceof Float32Array) || vec.length !== EMBED_DIM) {
      return {
        ok: false,
        error: `embedding dimension mismatch: expected ${EMBED_DIM}, got ${vec?.length ?? 'none'}`,
        embedded: 0,
        reused: 0,
      };
    }
    vecBuf = vectorToBuffer(vec);
  }

  const includeAmbientShard = options.includeAmbientShard !== false;
  const ambientTopic = options.ambientTopic || 'general';
  const ambientTable = includeAmbientShard ? ensureVecTable(ambientTopic, null) : null;
  const markEmbedded = db.prepare(`
    UPDATE chunks
       SET embedded = 1,
           content_hash = ?,
           embedding_model_id = ?,
           embedding_dim = ?,
           embedding_signature = ?,
           embedded_at = datetime('now')
     WHERE id = ?
  `);

  try {
    if (embeddingsDb) {
      if (!reused) {
        vecDb.transaction(() => {
          upsertVecRow(vecDb, tableName, chunkIdStr, vecBuf);
        })();
      }
      const verified = vecDb.prepare(`SELECT 1 FROM ${tableName} WHERE chunk_id = ?`).get(chunkIdStr);
      if (!verified) {
        return { ok: false, error: 'primary_vec_write_unverified', embedded: 0, reused };
      }
      db.transaction(() => {
        if (ambientTable && ambientTable !== tableName) {
          upsertVecRow(db, ambientTable, chunkIdStr, vecBuf);
        }
        markEmbedded.run(nextContentHash, EMBED_MODEL, EMBED_DIM, nextSignature, id);
      })();
    } else {
      db.transaction(() => {
        if (!reused) {
          upsertVecRow(db, tableName, chunkIdStr, vecBuf);
        }
        if (ambientTable && ambientTable !== tableName) {
          upsertVecRow(db, ambientTable, chunkIdStr, vecBuf);
        }
        markEmbedded.run(nextContentHash, EMBED_MODEL, EMBED_DIM, nextSignature, id);
      })();
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err), embedded: 0, reused };
  }

  return {
    ok: true,
    embedded: reused ? 0 : 1,
    reused,
    chunk_id: id,
    topic,
    table: tableName,
    ambient_table: ambientTable,
    split_store: !!embeddingsDb,
  };
}

/**
 * Embed all un-embedded chunks for a topic.
 *
 * @param {string} topic - Topic slug (must match chunks.topic exactly)
 * @param {AbortSignal} [signal] - Optional abort signal for SIGTERM-driven cancel
 * @param {object} [options]
 * @param {number} [options.maxBatches] - Optional manual/QA cap. Production
 *   workers omit this and drain the topic completely.
 * @param {string} [options.idleGateWorkerName] - Optional worker name; when
 *   provided, active-user idle checks abort before each embed batch.
 * @param {() => boolean} [options.activityCheck] - st_2cd1af73 AC-1 (residual,
 *   daemon end): a cheap predicate the daemon passes that returns true when a
 *   chat request is in-flight / the server is active. Checked between the
 *   SUB-BATCH write commits of a fetched batch (not just between fetched
 *   batches). When it returns true the remaining sub-batches of the current
 *   fetched batch are NOT written this pass — already-committed sub-batches are
 *   durable, the rest retries next pass — so the single SQLCipher writer is
 *   yielded to chat within one sub-batch (sub-second), defending TTFT in depth
 *   even when a turn lands mid-batch. Omitted by non-daemon callers (no yield).
 * @param {number} [options.nightShortBatchSize] - st_2cd1af73 NIGHT MODE: when
 *   the daemon is in the wide-quiet night profile it passes a larger SHORT-tier
 *   batch (default 16). It widens BOTH the fetch LIMIT and the ORT sub-batch for
 *   SHORT email-bulk batches so the short drain runs at a higher rate. The LONG
 *   tier is unaffected — a long-input batch still embeds at LONG_INPUT_BATCH_SIZE
 *   (the RSS bound is profile-invariant). The yield behavior (activityCheck +
 *   signal) is unchanged; night mode only changes work intensity, never the yield.
 * @param {() => void} [options.onBatchCommitted] - st_fd14cdd4 AC9: a callback the
 *   daemon passes that checkpoints the WAL (PASSIVE+TRUNCATE, throttled) at each
 *   fetched-batch boundary so the -wal frame count stays bounded DURING a long
 *   night slice instead of only between slices. Called only after a batch actually
 *   committed rows, at a point where this connection is not mid-write. Best-effort
 *   (wrapped in try/catch). Omitted by non-daemon callers → no mid-slice checkpoint.
 * @param {(payload: {embedded: number, reused: number, completed: number}) => void} [options.onBacklogCompleted]
 *   Optional committed-row progress callback. Fired after every sub-batch commit
 *   and signature-reuse commit so the daemon can keep liveness telemetry current
 *   while a long slice is still running.
 * @param {object} [options.lanePool] - st_db4b3118 PARALLEL LANES: a LanePool
 *   (lib/rag/lane-pool.js) the daemon owns. When present, each fetched batch's
 *   inference is fanned out across N child-process lanes instead of running on the
 *   in-process model — multiplying inference throughput. The PARENT (this function)
 *   still does every DB read/write and every sub-batch commit, so the single-writer
 *   and jetsam contracts are unchanged; only the embedBatch() inference call is
 *   parallelized. Absent (day profile / non-daemon callers) → the in-process path.
 *   The vectors the pool returns are index-for-index identical to a serial embed,
 *   so the write loop below is unchanged.
 * @returns {Promise<{embedded: number, skipped: number, reused: number, batches: number}>} Counts
 */
export async function embedChunks(topic, signal = null, options = {}) {
  // st_1cfe9061 — when embeddingsDb is provided, vec0 writes go to that DB;
  // markEmbedded updates stay on db. Legacy callers omit it and use db for both.
  // For a topic migrated to the split vec store, the caller need not thread the
  // connection through: resolve the process-wide embeddings.db handle here (the
  // same one the immediate-embed path opens). Only a topic that requires the
  // split store AND cannot open embeddings.db is a hard error — a plain legacy
  // vec write to the main DB would silently write to the wrong store.
  let embeddingsDb = options.embeddingsDb || null;
  if (!embeddingsDb && topicRequiresSplitVecStore(topic)) {
    embeddingsDb = getImmediateEmbeddingsDb();
    if (!embeddingsDb) {
      const message = `topic "${topic}" is migrated to embeddings.db but no embeddingsDb connection is available`;
      console.error(`[embed] ${message} — refusing legacy vec write`);
      return {
        embedded: 0,
        skipped: 0,
        reused: 0,
        batches: 0,
        error: message,
        aborted: false,
        abortReason: null,
        lastBatchMs: 0,
        elapsedMs: 0,
      };
    }
  }
  const vecDb = embeddingsDb || db;
  const tableName = ensureVecTable(topic, embeddingsDb);
  const maxBatches = Number.isFinite(Number(options.maxBatches)) && Number(options.maxBatches) > 0
    ? Math.floor(Number(options.maxBatches))
    : 0;
  // st_2cd1af73 NIGHT MODE — the SHORT-tier batch width for this call. Day/no
  // override → BATCH_SIZE; night → the daemon's nightShortBatchSize (e.g. 16).
  // The fetch LIMIT widens to this so a wider sub-batch has enough rows to fill.
  const nightShortBatchSize = Number.isFinite(Number(options.nightShortBatchSize)) && Number(options.nightShortBatchSize) > 0
    ? Math.floor(Number(options.nightShortBatchSize))
    : 0;
  // st_db4b3118 follow-up — resolve the optional child-process lane pool before
  // sizing the fetch. A pool multiplies inference capacity; fetches must fill each
  // lane while DB writes remain sub-batched below.
  const lanePool = options.lanePool && typeof options.lanePool.embedBatch === 'function'
    ? options.lanePool
    : null;
  const laneFetchMultiplier = lanePool?.laneCount > 1 ? Math.floor(lanePool.laneCount) : 1;
  const shortBatchSize = nightShortBatchSize > 0 ? Math.max(BATCH_SIZE, nightShortBatchSize) : BATCH_SIZE;
  // The fetch pulls enough rows to fill every inference lane. DB writes are still
  // committed in `ortBatchSize` sub-batches, so widening the fetch feeds CPU
  // parallelism without lengthening the single-writer hold.
  const fetchLimit = Math.max(BATCH_SIZE, shortBatchSize * laneFetchMultiplier);

  let totalEmbedded = 0;
  let totalSkipped = 0;
  let totalReused = 0;
  let batches = 0;
  let lastError = null;
  // st_2cd1af73 AC-3 — wall-clock of the most recent embed batch + the whole call,
  // surfaced on the result so the daemon's per-topic time budget can demote a slow
  // topic to the back of the work order (the watchdog cannot interrupt a single
  // uninterruptible ORT inference mid-flight, so the daemon decides AFTER the
  // committed batch finishes — finish the work, then demote).
  let lastBatchMs = 0;
  const callStartedAt = Date.now();
  // st_b50005df Phase 2 — distinguish "interrupted by idle/signal" from
  // "drained to completion". When the loop breaks on an abort we set this so
  // the passive-job handler re-queues benignly (attempts unchanged) instead of
  // marking the topic done while chunks remain unembedded.
  let aborted = false;
  // st_b50005df Phase 3 — names WHY the loop stopped early: 'idle' (user
  // returned), 'signal' (SIGTERM), or 'rss-ceiling' (self-cap breach). Surfaced
  // on the result so logs/QA can tell a benign RSS-restart from an idle-pause.
  let abortReason = null;

  // st_b50005df (owner-directed 2026-06-09): index-friendly fetch. `embedded=0`
  // is the canonical "needs embedding" flag (the local-embedding re-key and the
  // topic-edit-watcher both set it), so it alone selects the backlog.
  //
  // st_db4b3118 VALUE-FIRST: ORDER BY value_rank DESC (was id ASC). value_rank is a
  // precomputed INTEGER (lib/db.js) encoding (1) entity-linked first, (2) newest
  // first, (3) richer first — so within a topic the daemon drains the user's
  // people/companies content, then the most recent, then the longest. It stays
  // index-friendly: the partial index idx_chunks_value_drain
  // ON chunks(topic, embedded, value_rank DESC) WHERE skip_embed=0 means the fetch
  // walks the index in value order — O(BATCH) per fetch, NOT the whole-topic
  // re-sort that pinned a core in st_b50005df. value_rank already folds in recency
  // (epoch seconds) and length, so it is effectively unique per chunk — a plain
  // `ORDER BY value_rank DESC` is a pure index walk with NO temp b-tree (verified
  // via EXPLAIN QUERY PLAN); adding an `id` tiebreak would force a temp b-tree for
  // no real gain, so it is deliberately omitted. Cross-topic priority still applies
  // at the work-order level (daemonWorkOrder).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_value_drain
      ON chunks(topic, embedded, value_rank DESC)
      WHERE skip_embed = 0
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_source_value_drain
      ON chunks(topic, embedded, source_type, value_rank DESC)
      WHERE skip_embed = 0
  `);
  const fetchBatch = db.prepare(`
    SELECT id, content, content_hash, embedding_signature, embedding_model_id, embedding_dim
    FROM chunks
    WHERE topic = ?
      AND skip_embed = 0
      AND embedded = 0
      AND LENGTH(content) > 0
    ORDER BY value_rank DESC
    LIMIT ${fetchLimit}
  `);

  // st_2cd1af73 AC-3 — opt-in SHORT-FIRST drain. WHY: a topic like `personal`
  // mixes ~200k SHORT chunks (~0.17s each) with ~134k LONG chunks (~26s/batch).
  // The plain id-order fetch interleaves them, so every batch that happens to
  // contain a long chunk costs ~26s — the few long chunks dominate the wall clock
  // and the cheap short bulk (the volume that drives throughput) drains at the
  // long chunks' pace. With shortFirst, the daemon drains ALL of a topic's short
  // chunks at full speed first (recall surfaces fast, throughput is high), then
  // the long tail. STILL index-friendly: the LENGTH(content) predicate is a cheap
  // residual filter over the SAME (topic, embedded, id) PK range — O(scanned) per
  // fetch, never the whole-topic re-sort that pinned a core in st_b50005df. When
  // no short chunks remain the caller falls back to the plain fetch for the long
  // tail. Opt-in (daemon only) so manual backfills keep their single-query path.
  // st_db4b3118 VALUE-FIRST: short-first drain is ALSO value-ordered — within the
  // short tier the daemon embeds entity-linked → newest → richer first, same
  // value_rank DESC walk as the full fetch, with the LENGTH(content) <= longChars
  // residual selecting the short tier. The partial index covers it; the residual
  // is a cheap filter over the in-order value_rank range, never a re-sort.
  const longChars = LONG_INPUT_CHAR_THRESHOLD;
  const fetchShortBatch = db.prepare(`
    SELECT id, content, content_hash, embedding_signature, embedding_model_id, embedding_dim
    FROM chunks
    WHERE topic = ?
      AND skip_embed = 0
      AND embedded = 0
      AND LENGTH(content) > 0
      AND LENGTH(content) <= ${longChars}
    ORDER BY value_rank DESC
    LIMIT ${fetchLimit}
  `);
  const shortFirst = options.shortFirst === true;
  const coverageFirst = options.coverageFirst === true;
  const chatHistoryFirst = options.chatHistoryFirst === true;
  const chatHistorySourceSql = CHAT_HISTORY_FIRST_SOURCE_TYPES.map(sqlString).join(', ');
  const fetchChatHistoryShortBatch = db.prepare(`
    SELECT id, content, content_hash, embedding_signature, embedding_model_id, embedding_dim
    FROM chunks
    WHERE topic = ?
      AND source_type IN (${chatHistorySourceSql})
      AND skip_embed = 0
      AND embedded = 0
      AND LENGTH(content) > 0
      AND LENGTH(content) <= ${longChars}
    ORDER BY value_rank DESC
    LIMIT ${fetchLimit}
  `);
  const coverageSourceLimit = Math.max(
    1,
    Math.ceil(fetchLimit / COVERAGE_FIRST_SOURCE_TYPES.length),
    Number.isFinite(Number(options.coverageSourceLimit)) && Number(options.coverageSourceLimit) > 0
      ? Math.floor(Number(options.coverageSourceLimit))
      : 0,
  );
  const coverageSourceSelects = COVERAGE_FIRST_SOURCE_TYPES.map((sourceType, sourceRank) => `
    SELECT
      id,
      content,
      content_hash,
      embedding_signature,
      embedding_model_id,
      embedding_dim,
      value_rank,
      ${sourceRank} AS coverage_source_rank,
      ROW_NUMBER() OVER (ORDER BY value_rank DESC) AS coverage_slot
    FROM (
      SELECT id, content, content_hash, embedding_signature, embedding_model_id, embedding_dim, value_rank
      FROM chunks
      WHERE topic = ?
        AND source_type = ${sqlString(sourceType)}
        AND skip_embed = 0
        AND embedded = 0
        AND LENGTH(content) > 0
        AND LENGTH(content) <= ${longChars}
      ORDER BY value_rank DESC
      LIMIT ${coverageSourceLimit}
    )
  `).join('\nUNION ALL\n');
  const fetchCoverageShortBatch = db.prepare(`
    SELECT id, content, content_hash, embedding_signature, embedding_model_id, embedding_dim
    FROM (
      ${coverageSourceSelects}
    )
    ORDER BY coverage_slot ASC, coverage_source_rank ASC, value_rank DESC
    LIMIT ${fetchLimit}
  `);
  // Fetch the next batch: when shortFirst, exhaust SHORT chunks before touching
  // the long tail; otherwise the plain id-order fetch. Returned rows are uniform
  // either way, so the embed loop below is unchanged.
  const nextRows = () => {
    if (shortFirst) {
      if (chatHistoryFirst) {
        const chatHistory = fetchChatHistoryShortBatch.all(topic);
        if (chatHistory.length) return chatHistory;
      }
      if (coverageFirst) {
        const coverage = fetchCoverageShortBatch.all(...COVERAGE_FIRST_SOURCE_TYPES.map(() => topic));
        if (coverage.length) return coverage;
      }
      const short = fetchShortBatch.all(topic);
      if (short.length) return short;
    }
    return fetchBatch.all(topic);
  };

  // DELETE + INSERT, prepared once. See WHY block at top of file.
  // st_1cfe9061 — deleteVec/insertVec/vecExists target vecDb (embeddings.db when split).
  const deleteVec = vecDb.prepare(`
    DELETE FROM ${tableName} WHERE chunk_id = ?
  `);
  const insertVec = vecDb.prepare(`
    INSERT INTO ${tableName}(chunk_id, embedding) VALUES (?, ?)
  `);

  const markEmbedded = db.prepare(`
    UPDATE chunks
       SET embedded = 1,
           content_hash = ?,
           embedding_model_id = ?,
           embedding_dim = ?,
           embedding_signature = ?,
           embedded_at = datetime('now')
     WHERE id = ?
  `);
  const markReused = db.prepare('UPDATE chunks SET embedded = 1 WHERE id = ?');
  const vecExists = vecDb.prepare(`SELECT 1 FROM ${tableName} WHERE chunk_id = ?`);

  // st_2cd1af73 AC-1 (residual, daemon end): the daemon's "is chat active?"
  // predicate, resolved once. Used (a) before each inference to yield the CPU
  // before committing to a multi-second uninterruptible embed, (b) between
  // sub-batch write commits to yield the WAL writer, and (c) to CLASSIFY an
  // abort (st_fd14cdd4 AC9): a slice signal aborted while chat is active is a
  // benign chat-yield ('activity'), not a shutdown ('signal'). Absent (non-daemon
  // callers like manual backfills) → no yielding, drain as fast as possible.
  const activityCheck = typeof options.activityCheck === 'function' ? options.activityCheck : null;
  const onBacklogCompleted = typeof options.onBacklogCompleted === 'function'
    ? options.onBacklogCompleted
    : null;
  const notifyBacklogCompleted = ({ embedded = 0, reused = 0 } = {}) => {
    if (!onBacklogCompleted) return;
    const completed = (Number(embedded) || 0) + (Number(reused) || 0);
    if (completed <= 0) return;
    try {
      onBacklogCompleted({
        embedded: Number(embedded) || 0,
        reused: Number(reused) || 0,
        completed,
      });
    } catch {
      /* telemetry callback is best-effort */
    }
  };

  while (true) {
    // Honor abort BEFORE fetching the next batch — keeps the worker from
    // pulling more work after SIGTERM has fired.
    if (signal?.aborted) {
      // st_fd14cdd4 AC9 — classify the same way the embedBatch catch does: the
      // daemon's activityWatch aborts this signal the instant chat goes active
      // (and lib/rag/lane-pool.js kills the busy lanes), so a signal abort while
      // chat is active is a benign chat-yield, logged and never demoted. A quiet
      // signal abort is a real shutdown.
      const chatActiveNow = !!(activityCheck && activityCheck());
      console.log(`[embed] topic="${topic}" aborted by signal — stopping${chatActiveNow ? ' (chat active — yielding lane CPU)' : ''}`);
      aborted = true;
      abortReason = chatActiveNow ? 'activity' : 'signal';
      break;
    }

    // st_b50005df Phase 3 — self-imposed RSS ceiling backstop, checked between
    // bounded batches. A breach stops the drain cleanly so the next launchd
    // fire respawns the worker fresh (RSS reset). Benign: re-queued, no attempt.
    if (rssCeilingBreached(options.idleGateWorkerName)) {
      aborted = true;
      abortReason = 'rss-ceiling';
      break;
    }

    const rows = nextRows();
    if (!rows.length) break;

    const reusable = [];
    const toEmbed = [];
    for (const row of rows) {
      const nextContentHash = contentHash(row.content);
      const nextSignature = embeddingSignature({
        content_hash: nextContentHash,
        topic,
        modelId: EMBED_MODEL,
        dim: EMBED_DIM,
      });
      const hasVec = !!vecExists.get(String(row.id));
      const signatureMatches =
        row.content_hash === nextContentHash
        && row.embedding_signature === nextSignature
        && row.embedding_model_id === EMBED_MODEL
        && Number(row.embedding_dim) === EMBED_DIM;
      if (signatureMatches && hasVec) {
        reusable.push(row);
      } else {
        toEmbed.push({ ...row, nextContentHash, nextSignature });
      }
    }

    if (reusable.length) {
      db.transaction((chunks) => {
        for (const chunk of chunks) markReused.run(chunk.id);
      })(reusable);
      totalReused += reusable.length;
      notifyBacklogCompleted({ reused: reusable.length });
    }

    if (!toEmbed.length) continue;

    // st_b50005df: length-sort the batch before tokenization. The tokenizer
    // pads every sequence in a batch to the longest one, so co-locating
    // similar-length texts cuts wasted padding compute — a cheap throughput win
    // on CPU. Sorting toEmbed in place keeps texts/vectors/the write-loop all
    // aligned by index (they each iterate toEmbed in this same order). This is
    // a within-batch reordering only; chunk SELECTION already happened above by
    // priority (source_type, content_rank, recency), so value ordering is
    // unaffected — we only change the order chunks sit inside one bounded batch.
    toEmbed.sort((a, b) => a.content.length - b.content.length);

    const texts = toEmbed.map(r => r.content);
    // st_2cd1af73 AC-3 — split this fetched batch into ORT sub-batches sized by its
    // own average input length. Long-input topics (transcript/coaching) embed in
    // sub-batches of LONG_INPUT_BATCH_SIZE so peak inference memory stays bounded;
    // short email batches keep the full short-tier batch for throughput. The fetch
    // above already capped the row count at fetchLimit, so this only ever shrinks it.
    // st_2cd1af73 NIGHT MODE — the short tier is shortBatchSize (night-widened when
    // the daemon is in the wide-quiet profile); the long tier is unaffected.
    const ortBatchSize = effectiveBatchSize(texts, { shortBatchSize });

    // st_2cd1af73 AC-1 (residual, daemon end): an ONNX inference is CPU-bound and
    // UNINTERRUPTIBLE per call. A long-input chunk (~1000 tokens at the 4000-char
    // cap) was measured at ~11s; 40% of the backlog is long. If chat is active, we
    // must NOT commit the CPU to a fresh inference — that is what starves the
    // server event loop and blows up first-token latency. Check the activity
    // predicate RIGHT BEFORE the inference: if a request just landed, abort the
    // slice NOW (before the expensive call) so the daemon yields the CPU to chat
    // and resumes embedding on the next quiet pass. The already-embedded chunks
    // this slice are durable; the rest stay embedded=0. This is the dominant
    // defense — the mid-inference signal-abort (the daemon's activityWatch) only
    // catches a turn that lands AFTER the inference began; this catches the far
    // more common turn-then-inference ordering before any CPU is spent.
    if (activityCheck && activityCheck()) {
      console.log(`[embed] topic="${topic}" chat active — yielding CPU before inference (embedded ${totalEmbedded} so far)`);
      aborted = true;
      abortReason = 'activity';
      break;
    }

    let vectors;
    const batchStartedAt = Date.now();
    try {
      // st_db4b3118 PARALLEL LANES — when the daemon supplies a lane pool, fan this
      // batch's inference across N child-process lanes; otherwise run it in-process.
      // The pool returns vectors in the SAME order as `texts` (planLaneDispatch +
      // reassembleVectors guarantee disjoint slices reassembled in input order), so
      // the DELETE+INSERT write loop below maps vector[i] → toEmbed[i] identically
      // to the serial path. The pool throws on lane-death-after-retries or a dim
      // mismatch — caught below and handled like any embed error (skip + retry).
      if (lanePool) {
        vectors = await lanePool.embedBatch(texts, ortBatchSize, signal);
      } else {
        vectors = await embedBatch(texts, ortBatchSize, signal, { inputType: 'document' });
      }
      lastBatchMs = Date.now() - batchStartedAt;
    } catch (err) {
      // AbortError → graceful exit; any other error → log and break (skip topic)
      if (err.name === 'AbortError' || signal?.aborted) {
        // st_fd14cdd4 AC9 — classify the abort. With parallel lanes the daemon's
        // activityWatch aborts the slice signal (and lib/rag/lane-pool.js kills the
        // busy lanes) the instant chat goes active; that abort arrives here as an
        // AbortError with signal.aborted true, identical in shape to a master
        // SHUTDOWN abort. Distinguish them by re-checking the activity predicate: if
        // chat is active right now, this is a benign chat-yield ('activity') the
        // daemon logs as a yield and never demotes; otherwise it is a real shutdown
        // ('signal'). Absent activityCheck (non-daemon caller) → 'signal'/'idle' as
        // before. This keeps the lane-killed yield accounted as a chat-yield, not a
        // pathological slice.
        const chatActiveNow = !!(activityCheck && activityCheck());
        console.log(`[embed] topic="${topic}" aborted during embedBatch${chatActiveNow ? ' (chat active — yielding lane CPU)' : ''}`);
        aborted = true;
        abortReason = chatActiveNow ? 'activity' : (signal?.aborted ? 'signal' : 'idle');
        break;
      }
      console.error(`[embed] embedBatch failed for topic "${topic}":`, err.message);
      lastError = err.message || String(err);
      totalSkipped += toEmbed.length;
      // Don't abort the worker — skip this topic and let the next cycle retry.
      break;
    }

    // DELETE existing rows by chunk_id, INSERT fresh vectors, then mark
    // embedded — each SUB-BATCH in its own transaction so partial state is
    // impossible WITHIN a commit. If any statement throws, better-sqlite3 rolls
    // that sub-batch's transaction back and `embedded` stays 0 for retry.
    //
    // st_2cd1af73 AC-1 (residual, daemon end): the writer-hold is bounded to one
    // sub-batch (subBatchSize rows), and the activity signal is checked BETWEEN
    // sub-batch commits — not only between fetched batches. When a chat request
    // is in-flight mid-batch, we stop writing the remaining sub-batches this pass
    // (already-committed sub-batches are durable; the unwritten chunks stay
    // embedded=0 and are picked up next pass) and yield the single SQLCipher
    // writer to chat within one sub-batch (sub-second). This is defense-in-depth
    // behind the server-side deferral: even if the daemon holds the writer when a
    // turn lands, it lets go fast.
    // st_1cfe9061 — split path: vec0 writes go to vecDb (embeddings.db), then
    // markEmbedded on db only when vec count matches. Legacy path: single db.transaction.
    const subBatchWrite = embeddingsDb
      ? function splitWrite(chunkSlice, vecSlice) {
          const chunkIds = [];
          vecDb.transaction((chunks, vecs) => {
            for (let i = 0; i < chunks.length; i++) {
              const chunk = chunks[i];
              const vec = vecs[i];
              const vecBuf = vectorToBuffer(vec);
              const chunkIdStr = String(chunk.id);
              deleteVec.run(chunkIdStr);
              insertVec.run(chunkIdStr, vecBuf);
              chunkIds.push(chunkIdStr);
            }
          })(chunkSlice, vecSlice);
          const placeholders = chunkIds.map(() => '?').join(', ');
          const actualCount = vecDb.prepare(
            `SELECT COUNT(*) as n FROM ${tableName} WHERE chunk_id IN (${placeholders})`
          ).get(...chunkIds).n;
          if (actualCount !== chunkSlice.length) {
            console.error(`[embed] topic="${topic}" rowcount mismatch: expected ${chunkSlice.length} vec0 rows, got ${actualCount} — skipping markEmbedded`);
            return;
          }
          db.transaction((chunks) => {
            for (const chunk of chunks) {
              markEmbedded.run(chunk.nextContentHash, EMBED_MODEL, EMBED_DIM, chunk.nextSignature, chunk.id);
            }
          })(chunkSlice);
        }
      : db.transaction((chunks, vecs) => {
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const vec = vecs[i];
            const vecBuf = vectorToBuffer(vec);
            const chunkIdStr = String(chunk.id);
            deleteVec.run(chunkIdStr);
            insertVec.run(chunkIdStr, vecBuf);
            markEmbedded.run(
              chunk.nextContentHash,
              EMBED_MODEL,
              EMBED_DIM,
              chunk.nextSignature,
              chunk.id,
            );
          }
        });

    // Commit in sub-batches sized to the ORT sub-batch so each writer-hold is
    // small and uniform. activityCheck() is the daemon's "is chat active?"
    // predicate; absent (non-daemon callers) the whole fetched batch commits as
    // before, one sub-batch at a time.
    const subBatchSize = Math.max(1, ortBatchSize);
    let wroteThisBatch = 0;
    let yieldedForActivity = false;
    for (let off = 0; off < toEmbed.length; off += subBatchSize) {
      // Yield to chat BEFORE opening the next sub-batch write transaction (but
      // never mid-transaction — a started commit always finishes). The first
      // sub-batch always writes so we make forward progress every pass.
      if (off > 0 && (signal?.aborted || (activityCheck && activityCheck()))) {
        yieldedForActivity = !signal?.aborted;
        break;
      }
      const chunkSlice = toEmbed.slice(off, off + subBatchSize);
      const vecSlice = vectors.slice(off, off + subBatchSize);
      subBatchWrite(chunkSlice, vecSlice);
      wroteThisBatch += chunkSlice.length;
      notifyBacklogCompleted({ embedded: chunkSlice.length });
    }

    totalEmbedded += wroteThisBatch;
    batches++;
    console.log(`[embed] topic="${topic}" embedded ${totalEmbedded} chunks, reused ${totalReused} signatures so far`);

    // st_fd14cdd4 AC9 — checkpoint the WAL BETWEEN fetched batches, not only
    // between slices. LIVE finding: a single night slice runs ~167s and writes
    // thousands of vec0 frames; the daemon's only checkpoint call site was the
    // outer between-slices boundary, so for those ~167s the -wal grew unchecked
    // (measured: 87k uncheckpointed frames, the file at 632MB) and any chat read
    // landing mid-slice traversed that frameset. This callback fires at each
    // fetched-batch boundary — a point where this connection is NOT mid-write (the
    // sub-batch transaction already committed) — so the daemon can run its
    // throttled PASSIVE+TRUNCATE and keep the frame count bounded DURING the grind.
    // The callback self-throttles (the daemon's checkpointWal is rate-limited), so
    // calling it every batch is cheap. Absent (non-daemon callers) → no checkpoint.
    if (typeof options.onBatchCommitted === 'function' && wroteThisBatch > 0) {
      try { options.onBatchCommitted(); } catch { /* checkpoint is best-effort */ }
    }

    // If we stopped early to yield the writer to an active chat turn, end the
    // call cleanly now — benign, re-queued like an idle pause. The unwritten
    // chunks of this fetched batch remain embedded=0 for the next pass.
    if (yieldedForActivity) {
      console.log(`[embed] topic="${topic}" yielding writer to active chat (wrote ${wroteThisBatch} of ${toEmbed.length} this batch) — stopping`);
      aborted = true;
      abortReason = 'activity';
      break;
    }
    if (signal?.aborted) {
      aborted = true;
      abortReason = 'signal';
      break;
    }
    if (maxBatches && batches >= maxBatches) {
      console.log(`[embed] topic="${topic}" reached manual maxBatches=${maxBatches}`);
      break;
    }
  }

  return {
    embedded: totalEmbedded,
    skipped: totalSkipped,
    reused: totalReused,
    batches,
    error: lastError,
    aborted,
    abortReason,
    lastBatchMs,
    elapsedMs: Date.now() - callStartedAt,
  };
}
