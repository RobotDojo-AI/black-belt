/**
 * book-volumes.js — chronology → even volumes.
 *
 * Compute tier: Tier 0 (local, deterministic — array partition + date parse).
 * No LLM; no DB writes.
 *
 * A resolved corpus is too large for one perfect-bound paperback (Paul Graham
 * is ~564k words ≈ ~1,810 pages, past Lulu's ~800-page limit), so it ships as a
 * k-volume set. splitIntoVolumes partitions the essay array — IN RESOLVED ORDER,
 * essays atomic (never split), boundaries always between whole essays — into k
 * contiguous parts that minimize the largest part's word count, so the volumes
 * come out as even as whole-essay boundaries allow. Dates never move a boundary;
 * they only label the era range of each volume.
 */

// Measured 561,526 words / ~1,800 pages on the flagship set → ~312 words/page at
// the interior's 6×9 / ~11pt / justified layout. The estimate feeds the k
// heuristic and the pre-render page guess; the real page count comes from the
// rendered PDF.
export const DEFAULT_WORDS_PER_PAGE = 312;
// Target pages per volume for the k heuristic (~450 target, comfortably inside
// the 400–600 guardrail after real typesetting).
const VOLUME_TARGET_PAGES = 550;

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

export function estimatePages(wordCount, wordsPerPage = DEFAULT_WORDS_PER_PAGE) {
  const words = Number(wordCount) || 0;
  const perPage = Number(wordsPerPage) || DEFAULT_WORDS_PER_PAGE;
  return Math.max(1, Math.round(words / perPage));
}

/**
 * Partition weights (word counts) into exactly k contiguous groups minimizing
 * the maximum group sum. DP over prefix sums; O(n·k·n) — fine at n=231, k=4.
 *
 * dp[j][i] = minimal achievable max-sum for the first i weights in j groups.
 * Documented tie-break: iterate the split point t ascending and keep it only on
 * a STRICT improvement, so on equal max the earliest boundary wins — a stable,
 * reproducible split. Returns k [start, end) index ranges over the input.
 */
function linearPartitionRanges(weights, k) {
  const n = weights.length;
  const parts = clamp(k, 1, n);
  const prefix = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + weights[i];
  const sum = (a, b) => prefix[b] - prefix[a]; // weights[a..b)

  // dp[j][i], choice[j][i] = the split point t where group j-1 ends.
  const INF = Number.POSITIVE_INFINITY;
  const dp = Array.from({ length: parts + 1 }, () => new Array(n + 1).fill(INF));
  const choice = Array.from({ length: parts + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= n; i += 1) dp[1][i] = sum(0, i);

  for (let j = 2; j <= parts; j += 1) {
    for (let i = j; i <= n; i += 1) {
      // last group is weights[t..i); previous j-1 groups cover weights[0..t).
      for (let t = j - 1; t < i; t += 1) {
        const candidate = Math.max(dp[j - 1][t], sum(t, i));
        if (candidate < dp[j][i]) { // strict → earliest boundary wins on ties
          dp[j][i] = candidate;
          choice[j][i] = t;
        }
      }
    }
  }

  const ranges = [];
  let end = n;
  for (let j = parts; j >= 1; j -= 1) {
    const start = j === 1 ? 0 : choice[j][end];
    ranges.unshift([start, end]);
    end = start;
  }
  return ranges;
}

function yearFromPublished(published) {
  const match = String(published || '').match(/\b(1[89]\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

/**
 * deriveEraLabel(volumeEssays) → { yearStart, yearEnd, label }.
 *
 * Years come from whatever dates parse within the volume (article.published is
 * the PG "Month YYYY" first line or an ISO short date). yearStart/yearEnd are
 * the min/max parseable year; if none parse, all three are null and the caller
 * fills from neighbouring volumes (index order is chronological). Labels never
 * move a boundary.
 */
export function deriveEraLabel(volumeEssays = []) {
  const years = volumeEssays
    .map((essay) => yearFromPublished(essay?.published))
    .filter((year) => Number.isFinite(year));
  if (!years.length) return { yearStart: null, yearEnd: null, label: null };
  const yearStart = Math.min(...years);
  const yearEnd = Math.max(...years);
  return {
    yearStart,
    yearEnd,
    label: yearStart === yearEnd ? String(yearStart) : `${yearStart}–${yearEnd}`,
  };
}

function labelFor(yearStart, yearEnd) {
  if (!Number.isFinite(yearStart) || !Number.isFinite(yearEnd)) return null;
  return yearStart === yearEnd ? String(yearStart) : `${yearStart}–${yearEnd}`;
}

/**
 * splitIntoVolumes(essays, { volumeCount, wordsPerPage }) → Volume[].
 *
 * Volume = { index, essays, wordCount, pageEstimate, yearStart, yearEnd,
 * eraLabel }. k defaults to ceil(totalPages / VOLUME_TARGET_PAGES) clamped to
 * [1, essays.length] (PG resolves to 4; a small second source resolves to 1).
 * The split is a linear partition of the essays IN RESOLVED ORDER, so every
 * boundary falls between whole essays, each essay is in exactly one volume, and
 * the flattened volumes reconstruct the corpus in unbroken order.
 */
export function splitIntoVolumes(essays = [], { volumeCount, wordsPerPage = DEFAULT_WORDS_PER_PAGE } = {}) {
  if (!Array.isArray(essays) || !essays.length) return [];
  const totalWords = essays.reduce((sum, essay) => sum + (essay.wordCount || 0), 0);
  const heuristicK = Math.ceil(totalWords / wordsPerPage / VOLUME_TARGET_PAGES) || 1;
  const k = clamp(volumeCount ?? heuristicK, 1, essays.length);

  const ranges = linearPartitionRanges(essays.map((essay) => essay.wordCount || 0), k);
  const volumes = ranges.map(([start, end], index) => {
    const volumeEssays = essays.slice(start, end);
    const wordCount = volumeEssays.reduce((sum, essay) => sum + (essay.wordCount || 0), 0);
    const era = deriveEraLabel(volumeEssays);
    return {
      index: index + 1,
      essays: volumeEssays,
      wordCount,
      pageEstimate: estimatePages(wordCount, wordsPerPage),
      yearStart: era.yearStart,
      yearEnd: era.yearEnd,
      eraLabel: era.label,
    };
  });

  // Neighbour fill for volumes with no parseable date. Index order is
  // chronological, so a dateless volume inherits the nearest known year.
  for (let i = 0; i < volumes.length; i += 1) {
    if (volumes[i].yearStart == null) {
      const prev = volumes.slice(0, i).reverse().find((v) => v.yearEnd != null);
      const next = volumes.slice(i + 1).find((v) => v.yearStart != null);
      const yearStart = prev?.yearEnd ?? next?.yearStart ?? null;
      const yearEnd = next?.yearStart ?? prev?.yearEnd ?? null;
      volumes[i].yearStart = yearStart;
      volumes[i].yearEnd = yearEnd;
      volumes[i].eraLabel = labelFor(yearStart, yearEnd);
    }
  }

  return volumes;
}
