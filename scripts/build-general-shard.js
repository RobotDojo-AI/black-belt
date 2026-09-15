#!/usr/bin/env node
/**
 * scripts/build-general-shard.js — st_2cd1af73 Phase 2, wired to the always-on
 * maintenance loop by st_2d941f89 (gap 1).
 *
 * Builds the ambient `chunk_vec_general` shard so a no-topic ("general"-scoped)
 * chat query takes the VECTOR path instead of silently degrading to FTS-only.
 *
 * WHY this shard exists (research st_2cd1af73 §5 + lib/chat-context.js):
 *   A first-turn conversation has no `conversation_topics` rows yet, so
 *   resolveTopicScope() returns ['general'] (the ambient shard). That scope is
 *   threaded to searchAll(): the global-HNSW path post-filters candidates by
 *   chunkTopicMap to chunks whose topic == 'general' (none — no chunk is tagged
 *   'general'), and the per-topic sqlite-vec FALLBACK reads `chunk_vec_general`.
 *   That table never existed, so BOTH vector paths returned nothing and the
 *   query fell back to FTS-only. This script populates the fallback table the
 *   ambient scope reads, making the vector path live for no-topic chat.
 *
 * MECHANISM (the smallest correct version — no parallel embedder, no LLM):
 *   The embeddings already exist in the per-topic `chunk_vec_{topic}` tables
 *   (written by the embed daemon via lib/rag/embed.js). This script COPIES the
 *   already-computed vector for an ambient cross-topic sample of embedded chunks
 *   into `chunk_vec_general`. No re-embedding — it is pure vector relocation +
 *   index construction, so INTELLIGENCE_TIER is `extraction`. The shard's rows
 *   key on real chunks.id, so rag-search.js hydrates them through the normal
 *   chunkById lookup (topic-agnostic) on a hit.
 *
 * VALUE-FIRST + BOUNDED:
 *   The ambient sample is the top `ROBOTDOJO_GENERAL_SHARD_MAX` embedded chunks
 *   across all topics, ranked by content_rank DESC (high-signal first; the
 *   corpus quality_score column is uniformly 0 today so content_rank is the live
 *   value signal) with embedded_at DESC as a recency tiebreaker. Bounding keeps
 *   the ambient shard small and fast — it is a first-turn breadth shard, not a
 *   replacement for the full per-topic + HNSW retrieval that a scoped chat uses.
 *
 * IDEMPOTENT / RE-RUNNABLE (for the end-of-story full rebuild):
 *   CREATE VIRTUAL TABLE IF NOT EXISTS; then a full refresh — DELETE rows that
 *   are no longer in the current ambient sample, upsert (DELETE+INSERT) every
 *   row in the sample. Re-running on a grown corpus converges to the current
 *   top-N with no duplicates and no drift. Re-running on an unchanged corpus is
 *   a no-op in effect (same rows rewritten).
 *
 * CONCURRENCY (the embed daemon is running):
 *   This is a separate process contending the single WAL writer with the daemon.
 *   We set a short busy_timeout (2s) and wrap each per-row write in a small retry
 *   so a transient SQLITE_BUSY backs off and retries rather than aborting the
 *   build. Writes are per-row (the upsertVecRow contract) and committed in small
 *   batches so the writer is never held long — the daemon's own 2s timeout then
 *   succeeds between our batches.
 *
 * BOUNDED / CHAT-YIELDING SLICE MODE (st_2d941f89 gap 1):
 *   This script used to be correct-but-unscheduled: present, tested in
 *   isolation, never invoked by anything (confirmed by research — zero
 *   references in lib/passive-jobs.js, scripts/maintenance-phases.js,
 *   scripts/supervisor-maintenance-worker.mjs, config/background-routines.json).
 *   The ambient shard sat at 9 rows against a 410k-chunk corpus because nothing
 *   ever ran the bulk populate. `scripts/maintenance-phases.js` (phase
 *   AMBIENT_SHARD, routine maint_ambient_shard) now spawns this script as a
 *   bounded, gated child on the daily maintenance cadence — same pattern as
 *   RECLASSIFY_CHUNKS (phaseReclassifyChunks): gated on server activity + HID
 *   idle BEFORE spawn, then bounded by `--max-seconds` DURING the run.
 *
 *   `--max-seconds N` bounds one invocation to ~N seconds of wall clock,
 *   checked between prune batches and between write batches (never mid-batch —
 *   a started batch transaction always finishes). `--max-seconds` ALSO gates a
 *   same-process chat-app-active check (chatAppActiveDecision over the shared
 *   activity row lib/request-observer.js already maintains) so a slice releases
 *   the single SQLCipher writer the instant the chat app opens, mirroring
 *   scripts/ingest/05-reclassify-chunks.js's chatAppOpen() contract. Without
 *   `--max-seconds` (manual/owner-run mode) the script runs to convergence
 *   exactly as before — nothing changes for a direct operator invocation.
 *   A partial slice is always safe: the ambient sample + diff-against-existing
 *   design (see IDEMPOTENT above) means the next slice just continues the same
 *   convergence, never duplicates or corrupts rows.
 *
 *   The BULK POPULATE itself (bringing chunk_vec_general up to
 *   ROBOTDOJO_GENERAL_SHARD_MAX rows across the live 410k-chunk corpus) is
 *   OWNER-RUN or driven by the scheduled maint_ambient_shard routine on the
 *   always-on machine — this file only adds the bounded/gated MECHANISM; it
 *   does not itself decide when or how large a first live run should be.
 *
 * Usage:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/build-general-shard.js
 *   ROBOTDOJO_GENERAL_SHARD_MAX=20000 node scripts/build-general-shard.js
 *   node scripts/build-general-shard.js --max-seconds 240   # bounded slice
 *
 * INTELLIGENCE_TIER: extraction (no LLM — deterministic vector relocation).
 */

export const INTELLIGENCE_TIER = 'extraction';

import db from '../lib/db.js';
import * as sqliteVec from 'sqlite-vec';
import { EMBED_DIM } from '../lib/rag.js';
import { upsertVecRow } from '../lib/rag/embed.js';
import { getActivitySignal, chatAppActiveDecision } from '../lib/request-observer.js';

// sqlite-vec must be loaded on this connection to CREATE / write vec0 tables.
sqliteVec.load(db);

const GENERAL_TABLE = 'chunk_vec_general';

// Default ambient-shard size. Large enough to hold the whole current corpus
// (≈2.3k embedded and climbing) and scale to a useful first-turn breadth shard;
// bounded so the ambient table stays a fast breadth index, not the full corpus.
const DEFAULT_MAX = 50_000;
export function generalShardMax() {
  const raw = Number(process.env.ROBOTDOJO_GENERAL_SHARD_MAX);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_MAX;
}

// Per-row writes committed in batches of this size so the WAL writer is yielded
// to the daemon between batches (short transactions tolerate brief SQLITE_BUSY).
const WRITE_BATCH = Number(process.env.ROBOTDOJO_GENERAL_SHARD_WRITE_BATCH) || 200;

const log = (m) => console.log(`[build-general-shard] ${m}`);

/**
 * Run `fn` with a small bounded retry on SQLITE_BUSY (the daemon holds the
 * single writer briefly). Re-throws any non-BUSY error and gives up after the
 * retry budget so a genuinely stuck writer surfaces rather than spinning.
 */
function withBusyRetry(fn, { tries = 25, waitMs = 200 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      const busy = /SQLITE_BUSY|database is locked/i.test(err.message || '');
      if (!busy || attempt >= tries) throw err;
      // Tiny synchronous backoff. better-sqlite3 is synchronous; a short spin
      // is acceptable here and far simpler than going async for a build script.
      const until = Date.now() + waitMs;
      while (Date.now() < until) { /* busy-wait the backoff window */ }
    }
  }
}

/** Ensure the ambient vec0 table exists with the canonical shape. Idempotent. */
function ensureGeneralTable() {
  // Same shape as every other chunk_vec_{topic} shard so rag-search.js MATCH
  // queries and searchAll's fallback read it identically (TEXT PK chunk_id +
  // float[EMBED_DIM] embedding). See lib/rag/embed.js ensureVecTable for the WHY
  // on the TEXT primary key and the sqlite-vec DELETE+INSERT upsert contract.
  withBusyRetry(() => db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${GENERAL_TABLE}
    USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${EMBED_DIM}])
  `));
}

/**
 * Select the ambient sample: top-N embedded chunks across ALL topics by
 * content_rank (value) then recency. Returns rows of { id, topic }.
 */
function selectAmbientSample(maxRows) {
  return db.prepare(`
    SELECT id, topic
    FROM chunks
    WHERE embedded = 1
      AND topic IS NOT NULL
      AND LENGTH(content) > 0
    ORDER BY content_rank DESC, embedded_at DESC, id DESC
    LIMIT ?
  `).all(maxRows);
}

/** Sanitize a topic to its vec0 table name (mirrors rag-search.js safeTableName). */
function vecTableFor(topic) {
  return `chunk_vec_${String(topic).replace(/[^a-z0-9_]/g, '_')}`;
}

/**
 * Read one chunk's already-computed embedding blob from its per-topic vec table.
 * Returns a Buffer (raw float32 bytes) or null when the source row is absent
 * (the chunk is flagged embedded but its per-topic vec row was reclaimed) or the
 * source table does not exist.
 */
function readSourceEmbedding(perTopicTable, chunkId) {
  let stmt;
  try {
    stmt = db.prepare(`SELECT embedding FROM ${perTopicTable} WHERE chunk_id = ?`);
  } catch (err) {
    if (/no such table/i.test(err.message || '')) return null;
    throw err;
  }
  const row = stmt.get(String(chunkId));
  if (!row || !row.embedding) return null;
  // better-sqlite3 returns vec0 embedding as a Buffer; pass it straight through
  // to upsertVecRow which writes the identical bytes into the general shard.
  return row.embedding;
}

/**
 * Parse `--max-seconds N` from argv. Returns the positive integer seconds, or
 * null when absent/invalid (manual/owner-run mode — run to convergence).
 *
 * @param {string[]} [argv] defaults to the real process argv
 * @returns {number|null}
 */
export function parseMaxSecondsArg(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--max-seconds');
  if (i < 0) return null;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Build the cooperative yield gate for one bounded slice (st_2d941f89 gap 1).
 *
 * WHY a factory (not a module-level singleton): tests need a gate with an
 * injectable clock/database and no reliance on process.argv, mirroring the
 * dependency-injection shape lib/idle-gate.js and lib/request-observer.js
 * already use elsewhere in this file's sibling scripts.
 *
 * `expired()` is a pure wall-clock check. `chatOpen()` reads the SAME
 * cross-process activity row the embed daemon and the RECLASSIFY_CHUNKS
 * reclassifier yield on (getActivitySignal + chatAppActiveDecision) — the
 * instant the chat app opens, a bounded slice stops at the next batch boundary
 * so the single SQLCipher writer is free before the user's first turn. Both
 * checks are ALWAYS false when maxSeconds is null (manual/owner-run mode is
 * never gated — it has no maintenance worker yielding above it, matching the
 * exact contract scripts/ingest/05-reclassify-chunks.js already established).
 *
 * @param {object} [opts]
 * @param {number|null} [opts.maxSeconds]
 * @param {object} [opts.database] better-sqlite3 connection (defaults to db)
 * @param {() => number} [opts.now]
 */
export function createSliceGate({ maxSeconds = null, database = db, now = () => Date.now() } = {}) {
  const deadline = Number.isFinite(maxSeconds) && maxSeconds > 0 ? now() + maxSeconds * 1000 : null;
  return {
    expired: () => deadline !== null && now() >= deadline,
    chatOpen: () => deadline !== null && chatAppActiveDecision(getActivitySignal(database)),
    shouldStop() {
      return this.expired() || this.chatOpen();
    },
  };
}

/**
 * Run one bounded (or unbounded, when maxSeconds is null) ambient-shard build
 * pass. Extracted from main() so tests can drive it against a fixture DB
 * without spawning a child process or calling process.exit.
 *
 * @param {object} [opts]
 * @param {number|null} [opts.maxSeconds] bound one call to ~N seconds; null
 *   (default) runs to convergence, identical to the pre-st_2d941f89 behavior.
 * @param {() => number} [opts.now] injectable clock — tests only; production
 *   callers omit it and get the real wall clock.
 * @returns {{written:number, missingSource:number, pruned:number, finalCount:number,
 *   partial:boolean, stopReason:string|null}}
 */
export function runBuildGeneralShard({ maxSeconds = null, now = () => Date.now() } = {}) {
  // Match the daemon's yield-to-chat discipline: short busy_timeout so a
  // contended write surfaces as SQLITE_BUSY fast and our retry backs off,
  // rather than blocking the writer the daemon and server also need.
  db.pragma('busy_timeout = 2000');

  const gate = createSliceGate({ maxSeconds, now });
  const maxRows = generalShardMax();
  log(`start — ambient shard cap ${maxRows}${maxSeconds ? ` (bounded slice ${maxSeconds}s)` : ''}`);

  const totalEmbedded = db.prepare('SELECT COUNT(*) n FROM chunks WHERE embedded = 1').get().n;
  if (totalEmbedded === 0) {
    log('no embedded chunks yet — nothing to build (the daemon is still draining). exiting 0.');
    return { written: 0, missingSource: 0, pruned: 0, finalCount: 0, partial: false, stopReason: null };
  }

  ensureGeneralTable();

  const sample = selectAmbientSample(maxRows);
  const sampleIds = new Set(sample.map((r) => String(r.id)));
  log(`ambient sample: ${sample.length} chunks (of ${totalEmbedded} embedded)`);

  let partial = false;
  let stopReason = null;

  // ── Idempotent refresh step 1: drop rows no longer in the current sample so a
  //    re-run on a shifted corpus converges (no stale ambient rows linger).
  const existingIds = withBusyRetry(() =>
    db.prepare(`SELECT chunk_id FROM ${GENERAL_TABLE}`).all().map((r) => String(r.chunk_id)),
  );
  const toDelete = existingIds.filter((id) => !sampleIds.has(id));
  let deleted = 0;
  if (toDelete.length) {
    for (let i = 0; i < toDelete.length; i += WRITE_BATCH) {
      // Yield BEFORE opening the next batch transaction (never mid-transaction —
      // a started batch always finishes). The first batch always runs so a
      // slice always makes forward progress.
      if (i > 0 && gate.shouldStop()) {
        partial = true;
        stopReason = gate.expired() ? 'max-seconds deadline' : 'chat app open';
        log(`pruning stopped early (${stopReason}) — pruned ${deleted}/${toDelete.length} stale rows this slice`);
        break;
      }
      const batch = toDelete.slice(i, i + WRITE_BATCH);
      withBusyRetry(() => {
        const tx = db.transaction((ids) => {
          for (const id of ids) {
            db.prepare(`DELETE FROM ${GENERAL_TABLE} WHERE chunk_id = ?`).run(id);
          }
        });
        tx(batch);
      });
      deleted += batch.length;
    }
    if (!partial) log(`pruned ${deleted} stale ambient rows no longer in the sample`);
  }

  // ── Step 2: upsert every sampled chunk's vector, copied from its per-topic
  //    shard. Small batched transactions keep the writer yielded to the daemon.
  let written = 0;
  let missingSource = 0;
  if (!partial) {
    for (let i = 0; i < sample.length; i += WRITE_BATCH) {
      if (i > 0 && gate.shouldStop()) {
        partial = true;
        stopReason = gate.expired() ? 'max-seconds deadline' : 'chat app open';
        log(`writing stopped early (${stopReason}) — wrote ${written}/${sample.length} sampled rows this slice`);
        break;
      }
      const batch = sample.slice(i, i + WRITE_BATCH);
      // Read source embeddings OUTSIDE the write transaction (reads don't need the
      // writer); only the writes are transacted, so the writer is held minimally.
      const prepared = [];
      for (const { id, topic } of batch) {
        const buf = readSourceEmbedding(vecTableFor(topic), id);
        if (!buf) { missingSource++; continue; }
        prepared.push({ id, buf });
      }
      if (prepared.length) {
        withBusyRetry(() => {
          const tx = db.transaction((rows) => {
            for (const { id, buf } of rows) {
              // upsertVecRow = DELETE-then-INSERT (sqlite-vec 0.1.9 has no INSERT
              // OR REPLACE for vec0); reused so the general shard inherits the same
              // proven write contract as every per-topic shard.
              upsertVecRow(db, GENERAL_TABLE, String(id), buf);
            }
          });
          tx(prepared);
        });
        written += prepared.length;
      }
      if (i % (WRITE_BATCH * 10) === 0 && i > 0) {
        log(`progress: ${written} written / ${i} scanned`);
      }
    }
  }

  const finalCount = db.prepare(`SELECT COUNT(*) n FROM ${GENERAL_TABLE}`).get().n;
  log(`done${partial ? ' (partial slice)' : ''} — wrote ${written}, missing-source ${missingSource}, pruned ${deleted}, ${GENERAL_TABLE} now holds ${finalCount} rows`);
  return { written, missingSource, pruned: deleted, finalCount, partial, stopReason };
}

async function main() {
  const maxSeconds = parseMaxSecondsArg();
  runBuildGeneralShard({ maxSeconds });
  process.exit(0);
}

// Only auto-run when invoked directly (CLI / spawned child) — not on import,
// so tests can import the exported helpers above without triggering a real
// build against whatever DB lib/db.js resolves to.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[build-general-shard] fatal:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
