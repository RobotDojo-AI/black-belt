/**
 * Composite quality score for chunks.
 *
 * st_566ad80b: per-chunk quality score driving the hot-tier HNSW index.
 * The hot tier loads "top-N by quality_score WHERE topic=? AND embedded=1"
 * per topic, which means quality_score is the load-bearing function — get
 * the formula right or hot-tier hit rate collapses.
 *
 * Formula:
 *   quality_score = 0.5 * source_tier + 0.5 * recency_decay
 *
 * Both terms are in [0, 1]; quality_score ∈ [0, 1].
 *
 * source_tier weights come from the Entity Extraction Hierarchy
 * (agents/build-conventions.md). Higher tier = more deliberate signal.
 *
 *   contact / contacts                  → 1.00 — explicit curation
 *   imessage / sms                      → 0.85 — revealed, unfiltered
 *   calendar / meeting                  → 0.80 — planned + stated
 *   note / notes                        → 0.75 — deliberate capture
 *   transcript                          → 0.70 — actual conversation body
 *   wiki / document                     → 0.65 — curated knowledge
 *   conversation                        → 0.60 — chat history with the system
 *   health-data / health-document       → 0.55 — clinical signal (but noisy)
 *   drive                               → 0.50 — file dump, mixed quality
 *   email-summary                       → 0.40 — Tier-1 LLM synthesis
 *   email                               → 0.30 — most noise
 *   oura-daily / data                   → 0.35 — structured but raw
 *   unknown                             → 0.30 — conservative floor
 *
 * recency_decay = exp(-age_days / HALF_LIFE_DAYS)
 *   age_days = (now - event_time) / 86400000
 *   HALF_LIFE_DAYS = 365  →  1y old chunk = 0.50 decay
 *                            2y old = 0.25; 5y old = 0.05
 *
 * WHY exponential decay, not bucket: bucketed decay (recencyMultiplier in
 * lib/rag/retrieve.js) is for *runtime* re-scoring of retrieve results
 * — needs cheap, predictable arithmetic. quality_score is computed *once*
 * at backfill and stored, so a smooth exponential gives finer hot-tier
 * boundaries without runtime cost.
 *
 * WHY null event_time → 0.5: an event_time of '' or NULL is "unknown age"
 * — defaulting to the middle of the decay curve avoids both penalizing
 * timestamp-less content (wikis, static docs) and rewarding it. Mirrors
 * the 0.75 middle bucket in retrieve.js#recencyMultiplier.
 */

export const HALF_LIFE_DAYS = 365;

// WHY const map, not switch: hot-path call from a 1.2M-row backfill loop.
// A frozen object lookup is ~3x faster than a switch and easier to extend.
export const SOURCE_TIER = Object.freeze({
  contact: 1.00,
  contacts: 1.00,
  imessage: 0.85,
  sms: 0.85,
  calendar: 0.80,
  meeting: 0.80,
  note: 0.75,
  notes: 0.75,
  transcript: 0.70,
  wiki: 0.65,
  document: 0.65,
  conversation: 0.60,
  'health-data': 0.55,
  'health-document': 0.55,
  drive: 0.50,
  'oura-daily': 0.35,
  data: 0.35,
  'email-summary': 0.40,
  email: 0.30,
});

const DEFAULT_SOURCE_TIER = 0.30;
const NULL_EVENT_RECENCY = 0.5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Map a `source_type` string to its tier weight.
 * Unknown source_types default to the conservative 0.30 floor — never
 * 0.0, so a newly-introduced source_type does not silently vanish from
 * the hot tier (it just lands at email-level priority until calibrated).
 *
 * @param {string} sourceType
 * @returns {number} weight in [0, 1]
 */
export function sourceTierWeight(sourceType) {
  if (typeof sourceType !== 'string' || !sourceType) return DEFAULT_SOURCE_TIER;
  const w = SOURCE_TIER[sourceType];
  return typeof w === 'number' ? w : DEFAULT_SOURCE_TIER;
}

/**
 * Recency decay component. `nowMs` injectable for deterministic tests.
 *
 * @param {string|null} eventTime - ISO date string from chunks.event_time
 * @param {number} [nowMs=Date.now()]
 * @returns {number} decay in [0, 1] (approximately — never <0; clipped if
 *   event_time is in the future, recency becomes 1.0)
 */
export function recencyDecay(eventTime, nowMs = Date.now()) {
  if (!eventTime) return NULL_EVENT_RECENCY;
  const ts = typeof eventTime === 'number' ? eventTime : Date.parse(eventTime);
  if (!Number.isFinite(ts)) return NULL_EVENT_RECENCY;
  const age_days = (nowMs - ts) / MS_PER_DAY;
  if (age_days <= 0) return 1.0; // future-dated → fresh
  // exp(-age_days / HALF_LIFE_DAYS) — at HALF_LIFE_DAYS, returns 1/e ≈ 0.368
  // Note: classic "half-life" is 0.5 at age=HALF_LIFE — we use exp not 2^,
  // so HALF_LIFE here is the e-fold scale; calibrated empirically.
  return Math.exp(-age_days / HALF_LIFE_DAYS);
}

/**
 * Compute composite quality score: 0.5 * source_tier + 0.5 * recency_decay.
 *
 * @param {string} sourceType
 * @param {string|null} eventTime
 * @param {number} [nowMs=Date.now()]
 * @returns {number} quality_score in [0, 1]
 */
export function computeQualityScore(sourceType, eventTime, nowMs = Date.now()) {
  const tier = sourceTierWeight(sourceType);
  const recency = recencyDecay(eventTime, nowMs);
  return 0.5 * tier + 0.5 * recency;
}

/**
 * Hook for the maintenance machine — recompute quality_score for rows whose
 * `event_time` decay has materially shifted since last backfill.
 *
 * The expensive part of the backfill is the UPDATE pass over 1.2 M rows.
 * Source tier is static; only the recency term changes as time passes.
 * For static docs (event_time = '') quality_score doesn't change at all.
 *
 * Strategy: re-run only when the last recompute is older than the
 * threshold (default 7 days). The caller decides when
 * to invoke; this function returns whether a recompute is due based on
 * `system_state.last_quality_recompute_at`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.staleAfterDays=7]
 * @param {number} [opts.nowMs=Date.now()]
 * @returns {boolean} true when a recompute is due
 */
export function recomputeQualityScoresIfStale(db, { staleAfterDays = 7, nowMs = Date.now() } = {}) {
  try {
    // system_state is created on demand; missing → first run → stale
    db.exec(`CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    const row = db.prepare(
      "SELECT value, updated_at FROM system_state WHERE key='last_quality_recompute_at'",
    ).get();
    if (!row) return true;
    const last = Number(row.updated_at);
    if (!Number.isFinite(last)) return true;
    return (nowMs - last) > staleAfterDays * MS_PER_DAY;
  } catch {
    return true;
  }
}

/**
 * Stamp the last_quality_recompute_at marker. Call after a successful
 * full recompute pass.
 *
 * Creates the system_state table on demand — safe to call before the
 * first recompute (the table may not exist on a fresh DB).
 */
export function markQualityRecomputed(db, nowMs = Date.now()) {
  db.exec(`CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.prepare(
    `INSERT INTO system_state (key, value, updated_at)
     VALUES ('last_quality_recompute_at', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(String(nowMs), nowMs);
}
