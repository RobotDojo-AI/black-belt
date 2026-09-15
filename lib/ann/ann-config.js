/**
 * ANN tunables — all in one place so a future story can wire them through
 * env vars or config/defaults.json without hunting through call sites.
 *
 * st_566ad80b. WHY no hardcoded literals in application code: per the
 * project build conventions, any tunable threshold/timeout/limit must
 * live in a named export, not embedded as a string or number in lib/
 * or routes/. This file is the source of truth for everything the HNSW
 * path consumes.
 *
 * Calibration baselines from Phase 3 micro-bench (Mac mini M-class,
 * 100K-vector synthetic corpus). See the st_566ad80b story's
 * bench-result.json (under the wk_robot_dojo stories tree) for the run
 * that fixed these defaults.
 */

// ─── Cosine-distance fallback thresholds ────────────────────────────────────

/**
 * If the best (min) cosine distance from the hot-tier search exceeds this,
 * fall back to the full-tier (view-mapped) index. WHY 0.4: empirically the
 * crossover where 90%+ of "the answer is in the hot tier" queries have
 * min distance well below 0.4, and queries with min distance >0.4 almost
 * always benefit from the long-tail view-mapped search. Tighten if the
 * hot tier feels too aggressive; loosen if you see too many full-tier hits.
 *
 * Range: (0, 1). Smaller = MORE eager fallback (less confidence in hot).
 */
export const HOT_TIER_FALLBACK_THRESHOLD = 0.4;

/**
 * Minimum top-result score (1 - distance) for retrieve() to consider the
 * result set sufficient. Below this, retrieve returns insufficient:true
 * and chat surfaces an explicit "no relevant context" note. WHY 0.55:
 * matches the existing confidence gate in lib/rag/retrieve.js — kept as
 * a duplicate here so the ANN path applies the same standard before
 * crossing the layer boundary back to retrieve.
 *
 * Range: (0, 1). Should equal lib/rag/retrieve.js#CONFIDENCE_THRESHOLD.
 */
export const CONFIDENCE_THRESHOLD = 0.55;

// ─── Hot-tier sizing inputs (hot-tier-sizer.js consumes these) ─────────────

/**
 * Fraction of total RAM the entire hot tier (across all topics) is allowed
 * to consume. Set conservatively (5%) so the server + macOS + dev tools
 * fit comfortably even on an 8GB laptop. Production Mac mini (16GB) sees
 * ~820 MB hot tier under this fraction.
 */
export const HOT_TIER_RAM_FRACTION = 0.05;

/**
 * Per-vector RAM footprint in bytes for the local Snowflake 1024-dim index.
 * 1024 × float32 = 4096 B for the vector + ~1 KB usearch neighbor list at
 * M=16 ≈ 5 KB total.
 */
export const BYTES_PER_VECTOR_DEFAULT = 5 * 1024;

/**
 * Empirically measured p99 per-vector search cost on the hot tier.
 * Used by hot-tier-sizer to compute the latency-bound cap.
 *
 * Anchored by the ANN bench suite. Update only if a new bench run
 * consistently shows a different number — DO NOT chase noise.
 *
 * Calibrated 2026-05-12: N=5000, p99=3174 µs query →
 * 3174/5000 = 0.635 µs per vector. We round to 0.65 to give the latency
 * cap a small safety margin (the bench is small-N synthetic; real
 * production sees a larger N and graph cache effects that may shift
 * latency in either direction).
 */
export const HNSW_P99_PER_VEC_US = 0.65;

/**
 * Below this corpus size, HNSW is slower than brute-force scan and the
 * hot tier returns 0 (signaling sqlite-vec fallback). 500 is the
 * empirical crossover; tuning to 300 or 1000 didn't move TTFB.
 */
export const SMALL_TOPIC_THRESHOLD = 500;

/**
 * Default number of topics to share the RAM budget across. The live
 * corpus has 16–39 topics depending on user setup; 16 is the conservative
 * sizing default.
 */
export const TOPIC_COUNT_DEFAULT = 16;

/**
 * Default target p99 latency for the hot tier (milliseconds). The chat
 * RAG budget is ~50 ms total; we target ~5 ms for the hot-tier search so
 * sqlite-vec fallback + recency rescore + LLM dispatch fit comfortably.
 */
export const HOT_TIER_LATENCY_CAP_DEFAULT = 5;

// ─── ANN index storage ──────────────────────────────────────────────────────

/**
 * Base directory for persisted usearch indices. One subdir per topic;
 * each topic gets hot.usearch + full.usearch + sidecar.json.
 *
 * WHY ~/.robotdojo-ann/ (not robotdojo/user/databases/): ANN indices are derived
 * artifacts — fully rebuildable from chunks + chunk_vec_* tables. Keeping
 * them OUT of the DB tree avoids polluting backups with non-source data.
 */
export const ANN_BASE_DIR_NAME = '.robotdojo-ann';

/**
 * usearch index hyperparameters. M = graph connectivity; higher = better
 * recall, more RAM. ef_construction = build-time exploration; higher =
 * better graph quality, slower build. ef_search = query-time exploration;
 * higher = better recall, slower query.
 *
 * Defaults match usearch's "balanced" preset (the library's own
 * documented recommendation for similarity search on float32 vectors).
 */
export const USEARCH_M = 16;
export const USEARCH_EF_CONSTRUCTION = 128;
export const USEARCH_EF_SEARCH = 64;

/**
 * Backfill batch size — number of rows updated per transaction in
 * scripts/backfill-quality-scores.js. 10k is calibrated for the 1.2M-row
 * corpus: ~120 batches, ~3-5 minutes total wall-clock, no SQLITE_BUSY
 * with the WAL checkpoint guard. Lower if you see contention; higher
 * only after benching.
 */
export const BACKFILL_BATCH_SIZE = 10_000;

/**
 * Maximum embedded corpus size that chat retrieval may repair inline before
 * falling back to the detached HNSW builder. WHY bounded: a tiny launch/QA
 * corpus should self-heal deterministically before retrieval degrades, but a
 * 1M-vector customer corpus must never spend a chat request building a graph.
 * Set ROBOTDOJO_ANN_INLINE_REPAIR_MAX_CHUNKS=0 to force detached repair only.
 */
export const ANN_INLINE_REPAIR_MAX_CHUNKS = (() => {
  const raw = Number(process.env.ROBOTDOJO_ANN_INLINE_REPAIR_MAX_CHUNKS || '');
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2500;
})();

// ─── Unified HNSW (st_8c7b7a6b D4) ──────────────────────────────────────────
// Re-export HNSW_DIMS from matryoshka.js so ANN callers share one source of
// truth. WHY here (not only in matryoshka.js): historically ann-config.js was
// the lookup surface for "everything tunable about ANN" — keep the convention.
export { HNSW_DIMS, normalizeForHnsw } from './matryoshka.js';
