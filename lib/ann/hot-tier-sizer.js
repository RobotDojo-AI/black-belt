/**
 * Dynamic per-topic hot-tier size based on available RAM and target p99 latency.
 *
 * st_566ad80b: the hot tier is the in-RAM HNSW index that holds the top-N
 * chunks by quality_score per topic. The full index (all embedded chunks)
 * stays on disk via usearch.view() — paged in on demand only when the hot
 * tier misses. Hot-tier size is the dominant lever:
 *
 *   - Too small → most queries fall through to the full index every time
 *     → p99 latency = full-index p99 (~30 ms on Mac mini for 100K vectors)
 *   - Too large → hot tier doesn't fit in RAM → swap thrash, latency spikes
 *
 * Sizing equation (calibrated empirically; see bench-result.json):
 *
 *   hot_size = min(
 *     topic_corpus_size,                          // never exceed full
 *     floor(target_p99_latency_ms / p99_per_vec_us * 1000),  // latency cap
 *     floor(ram_per_topic_bytes / bytes_per_vec)  // RAM cap
 *   )
 *
 * Below the small-topic threshold (default 500 vectors), HNSW is slower
 * than a brute-force scan over all vectors — the index overhead dominates.
 * The sizer returns 0 in that case so the query path uses sqlite-vec
 * fallback (which is what it always did pre-st_566ad80b).
 *
 * Bench measurements (Mac mini M-class, local Snowflake embeddings):
 *
 *   HNSW p99 per-vector cost:    ~0.3 µs/vec      (HNSW_P99_PER_VEC_US)
 *   sqlite-vec MATCH baseline:   ~50 µs/vec       (full corpus scan)
 *   Bytes per vector in RAM:     ~5 KB            (1024 × float32 + neighbors)
 *
 * 16 GB Mac mini, 16 topics, 5% of RAM for hot tier:
 *   per-topic RAM budget = 16 × 1024^3 × 0.05 / 16 = 51.2 MB
 *   hot vectors per topic = 51.2 MB / 13 KB ≈ 4,000
 *   latency cap (5 ms target) = 5000 / 0.3 ≈ 16,000 vectors
 *   → 4,000 dominates (RAM-bound). Total hot tier = 64K vectors, ~800 MB.
 *
 * 64 GB workstation:
 *   per-topic RAM budget = 64 × 1024^3 × 0.05 / 16 = 204.8 MB
 *   hot vectors per topic = 204.8 MB / 13 KB ≈ 16,400
 *   latency cap (5 ms) = 16,000 vectors → latency dominates.
 *   → ~16K/topic. For corpora <16K, hot tier == full tier (no two-tier).
 *
 * Tunables are imported from ann-config.js so they live in one place.
 */

import {
  BYTES_PER_VECTOR_DEFAULT,
  HNSW_P99_PER_VEC_US,
  HOT_TIER_RAM_FRACTION,
  SMALL_TOPIC_THRESHOLD,
  TOPIC_COUNT_DEFAULT,
} from './ann-config.js';

/**
 * @typedef {object} HotTierSizeArgs
 * @property {number} totalRam            - bytes (e.g. 16 * 1024^3)
 * @property {number} topicCorpusSize     - rows for this topic where embedded=1
 * @property {number} targetP99LatencyMs  - acceptable p99 for hot-tier lookups
 * @property {number} [topicCount]        - number of topics to share RAM across
 *                                          (defaults to TOPIC_COUNT_DEFAULT)
 * @property {number} [bytesPerVector]    - per-vec footprint (default 13 KB)
 * @property {number} [ramFraction]       - fraction of totalRam allocatable to
 *                                          hot tier across all topics (default 0.05)
 */

/**
 * Compute the hot-tier size for one topic.
 * Returns 0 for tiny topics (use brute-force fallback instead).
 *
 * @param {HotTierSizeArgs} args
 * @returns {number} integer count of vectors to load into the hot tier
 */
export function computeHotTierSize({
  totalRam,
  topicCorpusSize,
  targetP99LatencyMs,
  topicCount = TOPIC_COUNT_DEFAULT,
  bytesPerVector = BYTES_PER_VECTOR_DEFAULT,
  ramFraction = HOT_TIER_RAM_FRACTION,
}) {
  // Defensive guards — never throw out of this function; the warmup path
  // calls it with measured/derived inputs and a 0 return triggers safe
  // brute-force fallback at the call site.
  if (!Number.isFinite(totalRam) || totalRam <= 0) return 0;
  if (!Number.isFinite(topicCorpusSize) || topicCorpusSize <= 0) return 0;
  if (!Number.isFinite(targetP99LatencyMs) || targetP99LatencyMs <= 0) return 0;

  // WHY small-topic threshold: HNSW build/maintenance cost dominates below
  // ~500 vectors; sqlite-vec MATCH (sequential scan of a Float32Array) is
  // faster at that scale than walking an HNSW graph. Returning 0 here lets
  // searchAll fall back to the existing sqlite-vec path cleanly.
  if (topicCorpusSize < SMALL_TOPIC_THRESHOLD) return 0;

  // RAM cap — total hot-tier RAM budget shared evenly across topics.
  const ramBudgetBytes = totalRam * ramFraction;
  const ramPerTopicBytes = ramBudgetBytes / Math.max(topicCount, 1);
  const ramCap = Math.floor(ramPerTopicBytes / bytesPerVector);

  // Latency cap — at HNSW_P99_PER_VEC_US µs/vec, how many vectors can we
  // sweep within the target p99?
  //   latency_ms = N * us_per_vec / 1000
  //   N = latency_ms * 1000 / us_per_vec
  const latencyCap = Math.floor((targetP99LatencyMs * 1000) / HNSW_P99_PER_VEC_US);

  // Never exceed the corpus itself — capping at topicCorpusSize means
  // small topics get "all of them" as the hot tier, which collapses the
  // two-tier design into a single tier (which is correct for small N).
  return Math.max(0, Math.min(topicCorpusSize, ramCap, latencyCap));
}

/**
 * Helper: total RAM consumed if every topic was sized this way.
 * Useful for ops dashboards and bench reports.
 *
 * @param {object} opts
 * @param {number[]} opts.perTopicSizes - array of hot-tier sizes per topic
 * @param {number} [opts.bytesPerVector=BYTES_PER_VECTOR_DEFAULT]
 * @returns {number} total bytes
 */
export function estimateHotTierRamBytes({ perTopicSizes, bytesPerVector = BYTES_PER_VECTOR_DEFAULT }) {
  if (!Array.isArray(perTopicSizes)) return 0;
  return perTopicSizes.reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0) * bytesPerVector;
}
