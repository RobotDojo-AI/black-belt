/**
 * lib/rag/retrieve.js
 *
 * retrieve(query, options) — wraps rag-search.js with recency-bucket scoring.
 *
 * Why a separate module instead of patching rag-search.js:
 *   rag-search.js is the low-level search primitive (pure signal).
 *   retrieve.js is the RAG policy layer (recency, confidence gating).
 *   Keeping them separate lets us swap scoring without touching search.
 *
 * Recency buckets (multiply raw score × factor):
 *   0–7 days    → 1.0 (no penalty)
 *   7–30 days   → 0.9
 *   30–90 days  → 0.8
 *   90–180 days → 0.7
 *   180+ days   → 0.6
 *   no event_time → 1.0 (unknown age — do not penalize static docs)
 *
 * Confidence gate: if no results OR top result adjustedScore < 0.55,
 * returns { insufficient: true, results: [], rag_meta } so chat.js can inject
 * an honest "not enough context" note instead of hallucinating.
 *
 * WHY _searchFn/_searchAllFn options: injectable search functions enable
 * unit tests without requiring the sqlite-vec native extension or a real DB.
 * Production code always uses the defaults (search/searchAll from rag-search.js).
 */

import { search, searchAll } from '../rag-search.js';

export const CONFIDENCE_THRESHOLD = 0.55;

// Mode-aware confidence gate (st_b50005df Phase 5, AC-1c).
//
// WHY: adjustedScore = rawScore × recencyMultiplier, and recency multiplies an
// old hit DOWN (to 0.6 at 180+ days). FTS rank normalizes to modest raw scores
// (normalizeRank caps at 1 but typical keyword hits land ~0.3–0.6), so an
// exact-but-OLD keyword match — the user's literal words, just not recent —
// routinely falls under the single 0.55 gate and is discarded wholesale,
// replaced by a "no high-confidence evidence" note. That is the opposite of
// "knows your world": the strongest possible evidence (an exact match) is the
// evidence most easily aged out of the gate.
//
// FIX: gate each result by the threshold for the method that PRODUCED it.
//   - vector → CONFIDENCE_THRESHOLD (0.55), unchanged. Fuzzy similarity still
//     needs a real bar; a weak vector hit is genuinely low-signal.
//   - fts / hybrid → FTS_CONFIDENCE_THRESHOLD (0.30, env-overridable). An exact
//     keyword match is high-precision by construction, so a lower bar keeps the
//     old-but-exact hit instead of throwing the user's own words away.
//
// Env override (ROBOTDOJO_FTS_CONFIDENCE_THRESHOLD) so the bar is tunable
// without a code edit, per build conventions (no hardcoded tunables that can't
// be moved). Vector bar stays the existing exported constant.
export const FTS_CONFIDENCE_THRESHOLD = (() => {
  const raw = parseFloat(process.env.ROBOTDOJO_FTS_CONFIDENCE_THRESHOLD || '');
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.30;
})();

/**
 * Confidence threshold for a single result, keyed on its retrieval method.
 * Exact-match methods (fts, hybrid) clear a lower bar than fuzzy vector hits.
 * @param {string} [method] - 'vector' | 'fts' | 'hybrid' (default 'vector')
 * @returns {number}
 */
export function thresholdForMethod(method) {
  return (method === 'fts' || method === 'hybrid')
    ? FTS_CONFIDENCE_THRESHOLD
    : CONFIDENCE_THRESHOLD;
}

/**
 * Recency bucket multiplier.
 * @param {string|null} eventTime - ISO date string or empty/null
 * @returns {number} Score multiplier (0.6–1.0)
 */
export function recencyMultiplier(eventTime) {
  // WHY: missing/invalid event_time means unknown age, not old age. Many
  // canonical docs and imported emails are undated at the chunk level; applying
  // a recency haircut before the confidence gate turns healthy ANN hits into
  // "no context" even when the vector score is strong.
  if (!eventTime) return 1.0;
  const parsed = new Date(eventTime);
  if (isNaN(parsed.getTime())) return 1.0;

  const age_days = (Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24);

  // WHY buckets not linear decay: stable, predictable, easy to reason about
  if (age_days <= 7)   return 1.0;
  if (age_days <= 30)  return 0.9;
  if (age_days <= 90)  return 0.8;
  if (age_days <= 180) return 0.7;
  return 0.6;
}

/**
 * Apply recency scoring to a list of raw search results.
 * Exported for unit testing without DB dependency.
 *
 * @param {Array} raw - Results from search/searchAll
 * @returns {Array} Results with eventTime, bucket, adjustedScore added
 */
export function applyRecencyScoring(raw) {
  return raw.map(result => {
    // WHY: prefer metadata.event_time (per-chunk granularity) over metadata.date
    // (summary-level). Fall back to metadata.date if event_time absent.
    const eventTime = result.metadata?.event_time
      || result.metadata?.date
      || null;

    const bucket = recencyMultiplier(eventTime);
    const adjustedScore = result.score * bucket;

    return {
      ...result,
      eventTime,
      bucket,
      adjustedScore,
    };
  });
}

/**
 * Retrieve semantically relevant chunks for a query, with recency re-scoring.
 *
 * @param {string} query - User query text
 * @param {object} [options]
 * @param {string|null} [options.topic] - Restrict to a topic (null = all topics)
 * @param {string[]|null} [options.topicScope] - Restrict the fan-out to a
 *   subset of topics (st_74f45a1a R2 speed amendment). Threaded through to
 *   searchAll's inner loop. null preserves prior all-topics behavior.
 * @param {number} [options.limit] - Initial fetch limit before re-sort (default 20)
 * @param {Function} [options._searchFn] - Override search() for testing
 * @param {Function} [options._searchAllFn] - Override searchAll() for testing
 * @param {Function} [options.onTiming] - Optional observer: ({phase, ms}) => void
 * @param {boolean} [options.forceSemanticSearch=false] - Require the semantic
 *   search leg to run even when FTS has a fast exact hit.
 * @returns {Promise<{insufficient: boolean, results: Array, rag_meta: object}>}
 */
export async function retrieve(query, {
  topic = null,
  topicScope = null,
  limit = 20,
  _searchFn = null,
  _searchAllFn = null,
  onTiming = null,
  forceSemanticSearch = false,
} = {}) {
  const doSearch = _searchFn || search;
  const doSearchAll = _searchAllFn || searchAll;
  const started = Date.now();
  const timings = [];
  const emitTiming = (eventOrPhase, ms) => {
    const event = typeof eventOrPhase === 'object' && eventOrPhase
      ? { phase: eventOrPhase.phase, ms: eventOrPhase.ms }
      : { phase: eventOrPhase, ms };
    timings.push(event);
    if (typeof onTiming === 'function') {
      try { onTiming(event); } catch {}
    }
  };

  const emptyMeta = (reason) => ({
    mode: 'none',
    degraded: true,
    hit_count: 0,
    qualified_hit_count: 0,
    reason,
    phases: [...new Set(timings.map(t => t.phase).filter(Boolean))],
  });

  const metaForResults = (results, passingResults) => {
    const phases = [...new Set(timings.map(t => t.phase).filter(Boolean))];
    const usedSqliteVecFallback = phases.includes('rag.sqlite_vec_fallback');
    const usedAnn = phases.includes('rag.ann');
    const repairQueued = phases.includes('rag.ann_repair_queued');
    const repairDeferred = phases.includes('rag.ann_repair_deferred');
    const repairLocked = phases.includes('rag.ann_repair_locked');
    const annUnavailable = phases.includes('rag.ann_unavailable');
    const normalizeMethod = (method) => (
      method === 'fts' || method === 'hybrid' || method === 'vector'
        ? method
        : 'vector'
    );
    const methods = [...new Set(results.map(r => normalizeMethod(r.method)))];
    const passingMethods = [...new Set(passingResults.map(r => normalizeMethod(r.method)))];
    const mode = passingMethods.includes('hybrid') || (
      passingMethods.includes('vector') && passingMethods.includes('fts')
    )
      ? 'hybrid'
      : (passingMethods[0] || 'none');
    const degraded = mode === 'none'
      || mode === 'fts'
      || usedSqliteVecFallback
      || (mode === 'vector' && !usedAnn);
    return {
      mode,
      degraded,
      hit_count: results.length,
      qualified_hit_count: passingResults.length,
      top_method: normalizeMethod(results[0]?.method),
      methods,
      phases,
      reason: mode === 'none'
        ? 'no_qualified_hits'
        : usedSqliteVecFallback
          ? repairQueued
            ? `${mode}_via_sqlite_vec_fallback_ann_repair_queued`
            : repairDeferred
              ? `${mode}_via_sqlite_vec_fallback_ann_repair_deferred`
              : repairLocked
                ? `${mode}_via_sqlite_vec_fallback_ann_repair_locked`
                : annUnavailable
                  ? `${mode}_via_sqlite_vec_fallback_ann_unavailable`
                  : `${mode}_via_sqlite_vec_fallback`
          : mode === 'fts'
            ? repairQueued
              ? 'fts_hits_ann_repair_queued'
              : repairDeferred
                ? 'fts_hits_ann_repair_deferred'
                : repairLocked
                  ? 'fts_hits_ann_repair_locked'
                  : annUnavailable
                    ? 'fts_hits_ann_unavailable'
                    : 'fts_hits'
            : usedAnn
              ? `${mode}_ann_hits`
              : `${mode}_local_hits`,
    };
  };

  // Fetch candidates — hybrid FTS+vector across all topics (or one if specified).
  // topicScope only applies to the searchAll path; the single-topic search() is
  // already scoped to that topic by definition.
  let raw;
  try {
    raw = topic
      ? await doSearch(query, { topic, limit, mode: 'hybrid' })
      : await doSearchAll(query, { limit, topicScope, onTiming: emitTiming, forceSemanticSearch });
  } catch (err) {
    console.error('[retrieve] search failed:', err.message);
    emitTiming('rag.retrieve', Date.now() - started);
    return { insufficient: true, results: [], rag_meta: emptyMeta('search_error') };
  }

  if (!raw || !raw.length) {
    emitTiming('rag.retrieve', Date.now() - started);
    return { insufficient: true, results: [], rag_meta: emptyMeta('no_hits') };
  }

  // Apply recency-bucket scoring and re-sort. applyRecencyScoring spreads the
  // raw result, so each item's `method` tag (from rag-search formatResult)
  // carries through to the gate below.
  const reranked = applyRecencyScoring(raw);
  reranked.sort((a, b) => b.adjustedScore - a.adjustedScore);

  // Mode-aware confidence gate (st_b50005df Phase 5, AC-1c). The corpus is
  // sufficient if ANY result clears the threshold for its own retrieval
  // method — not only the top-by-adjustedScore result. This is the load-
  // bearing change: a weak vector hit can sort above an exact-but-old FTS hit,
  // and the old top-only gate would then drop the whole set on the vector
  // hit's score. Checking each result against its own method's bar lets the
  // exact keyword match (lower FTS bar) survive even when the vector hit fails
  // its (unchanged) 0.55 bar. A purely-vector result set behaves exactly as
  // before: every method is 'vector', so the gate is the old 0.55 on the top.
  const passing = reranked.filter(
    r => r.adjustedScore >= thresholdForMethod(r.method)
  );
  emitTiming('rag.retrieve', Date.now() - started);
  const rag_meta = metaForResults(reranked, passing);
  if (!passing.length) {
    return { insufficient: true, results: [], rag_meta };
  }

  return { insufficient: false, results: reranked, rag_meta };
}
