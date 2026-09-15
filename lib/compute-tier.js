/**
 * Compute Tier Protocol — canonical routing module for LLM cost discipline.
 *
 * Every pipeline that processes bulk data walks this ladder in order:
 *
 *   Tier 0 — Free (local): SQL, regex, heuristics, cosine sim, templates
 *             Always runs first. Removes noise, buckets structurally.
 *             Never call an LLM on data that hasn't passed Tier 0.
 *
 *   Tier 1 — Haiku: classify, score relevance, synthesize moderate signal
 *             Runs on the subset Tier 0 identifies as worth processing.
 *
 *   Tier 2 — Sonnet: synthesize, extract, summarize high-value content
 *             Runs only on what Tier 1 flags as high-value.
 *
 *   Tier 3 — Opus: critical decisions, health analysis, rare edge cases
 *             Never called inside automated pipelines.
 *
 * WHY this module exists: the tiering pattern appears in context file generation,
 * RAG synthesis, entity enrichment, email triage — everywhere bulk data meets LLMs.
 * Without a shared module each pipeline re-invents thresholds differently, causing
 * 10-100x cost overruns when someone adds a Sonnet call to a loop over 10K items.
 * This is the single enforcement point.
 *
 * Usage:
 *   import { entityTier, MODELS, TIER } from '../lib/compute-tier.js';
 *   const tier = entityTier(person, ragChunkCount);
 *   if (tier === TIER.FREE)   { ... write template ... }
 *   if (tier === TIER.HAIKU)  { ... call MODELS.haiku ... }
 *   if (tier === TIER.SONNET) { ... call MODELS.sonnet ... }
 */

// INTELLIGENCE_TIER: orchestration — the canonical model-ID/pricing/tier
// module every other tier's routing decision reads from; makes no LLM call
// itself.
export const INTELLIGENCE_TIER = 'orchestration';

// ── Model IDs ─────────────────────────────────────────────────────────────────
// Canonical model strings. Change here, updates everywhere.

export const MODELS = {
  haiku:    'claude-haiku-4-5-20251001',
  // haiku_v4: backward-compat short alias for the versioned haiku string.
  // Used in MODEL_TO_TIER reverse-maps where both the short and full IDs appear.
  haiku_v4: 'claude-haiku-4-5',
  sonnet:   'claude-sonnet-4-6',
  opus:     'claude-opus-4-8',
  // frontier = best available reasoning model. Use for all intelligence/synthesis
  // jobs (document synthesis, memory synthesis, persona generation). Never use
  // a hardcoded model string in synthesis scripts — always reference MODELS.frontier.
  // Update this one field when a new flagship ships.
  frontier: 'claude-opus-4-8',
};

// ── Pricing (USD per token) ───────────────────────────────────────────────────
// Used by tier helpers for cost logging and by estimateCostCents for client-side
// cost display. Canonical keys are the Anthropic API model IDs (haiku/sonnet/opus)
// plus frontend-facing aliases used in the chat UI model selector.
// Update when Anthropic or Google reprice.

// Verified against platform.claude.com/docs/en/about-claude/pricing on 2026-07-27
export const PRICING = {
  // Canonical internal keys (match MODELS object above)
  haiku:  { input: 1.00  / 1_000_000, output: 5.00  / 1_000_000 },
  sonnet: { input: 3.00  / 1_000_000, output: 15.00 / 1_000_000 },
  opus:   { input: 5.00  / 1_000_000, output: 25.00 / 1_000_000 },
  // Frontend model key aliases — used by the chat UI model selector.
  // WHY: the frontend sends short keys ('claude-haiku', 'gemini-flash') while the
  // API uses full versioned IDs. estimateCostCents must resolve both forms.
  'claude-haiku':  { input: 1.00  / 1_000_000, output: 5.00  / 1_000_000 },
  'claude-sonnet': { input: 3.00  / 1_000_000, output: 15.00 / 1_000_000 },
  'claude-opus':   { input: 5.00  / 1_000_000, output: 25.00 / 1_000_000 },
  'gemini-flash-lite': { input: 0.075 / 1_000_000, output: 0.30 / 1_000_000 },
  'gemini-flash':  { input: 0.30  / 1_000_000, output: 2.50  / 1_000_000 },
  'gemini-2.5-pro': { input: 1.25 / 1_000_000, output: 10.00 / 1_000_000 },
  'gpt-4o-mini':   { input: 0.15  / 1_000_000, output: 0.60  / 1_000_000 },
  'gpt-4o':        { input: 2.50  / 1_000_000, output: 10.00 / 1_000_000 },
  'o3-mini':       { input: 1.10  / 1_000_000, output: 4.40  / 1_000_000 },
  'grok-4.20-0309-non-reasoning': { input: 1.25 / 1_000_000, output: 2.50 / 1_000_000 },
  'grok-4.3': { input: 1.25 / 1_000_000, output: 2.50 / 1_000_000 },
  'grok-4.20-0309-reasoning': { input: 1.25 / 1_000_000, output: 2.50 / 1_000_000 },
  // Current lane heads (see lib/model-allowlists.js). Sourced 2026-08-10:
  // xAI from its own /v1/language-models price fields (grok-4.5 = 20000/60000
  // in units of 1e-7 USD/token), OpenAI and Google from their published
  // per-million rates. Every fan, judge, and synthesis model must appear here or
  // the run's cost line silently under-reports (fanout/cost.js never guesses).
  'grok-4.5':               { input: 2.00 / 1_000_000, output: 6.00  / 1_000_000 },
  'gpt-5.6-sol':            { input: 5.00 / 1_000_000, output: 30.00 / 1_000_000 },
  'gpt-5.5':                { input: 5.00 / 1_000_000, output: 30.00 / 1_000_000 },
  'gpt-5.4':                { input: 2.50 / 1_000_000, output: 15.00 / 1_000_000 },
  'gpt-5.4-mini':           { input: 0.75 / 1_000_000, output: 4.50  / 1_000_000 },
  'gpt-5.4-nano':           { input: 0.20 / 1_000_000, output: 1.25  / 1_000_000 },
  'gemini-3.6-flash':       { input: 1.50 / 1_000_000, output: 7.50  / 1_000_000 },
  'gemini-3.5-flash':       { input: 1.50 / 1_000_000, output: 9.00  / 1_000_000 },
  'gemini-3.5-flash-lite':  { input: 0.30 / 1_000_000, output: 2.50  / 1_000_000 },
};

/**
 * Estimate chat cost in cents for a given model and token counts.
 *
 * WHY: The chat streaming endpoint needs a cost figure to surface in the
 * 'done' SSE event. Centralizing here means the route stays thin and the
 * cost logic is testable in isolation without spinning up a server.
 *
 * @param {string} model - Frontend model key (e.g. 'claude-sonnet') or canonical ID
 * @param {number} inputTokens - Approximate input token count
 * @param {number} outputTokens - Approximate output token count
 * @returns {number} Cost in cents, rounded to 2 decimal places
 */
export function estimateCostCents(model, inputTokens, outputTokens) {
  const key = String(model || '');
  const alias =
    key.startsWith('claude-haiku') ? 'claude-haiku'
    : key.startsWith('claude-sonnet') ? 'claude-sonnet'
    : key.startsWith('claude-opus') ? 'claude-opus'
    : key.startsWith('gemini-2.5-flash-lite') ? 'gemini-flash-lite'
    : key.startsWith('gemini-2.5-flash') ? 'gemini-flash'
    : key.startsWith('gemini-2.5-pro') ? 'gemini-2.5-pro'
    : key.startsWith('gpt-4o-mini') ? 'gpt-4o-mini'
    : key.startsWith('gpt-4o') ? 'gpt-4o'
    : key.startsWith('o3-mini') ? 'o3-mini'
    : null;
  const p = PRICING[model] ?? PRICING[alias] ?? PRICING.sonnet;
  return Math.round((p.input * inputTokens + p.output * outputTokens) * 100 * 100) / 100;
}

export function _logCost(tierName, label, usage) {
  const p = PRICING[tierName];
  const cost = p.input * usage.input_tokens + p.output * usage.output_tokens;
  // eslint-disable-next-line no-console
  console.info(`[${tierName}] ${label} — ${usage.input_tokens}in/${usage.output_tokens}out $${cost.toFixed(4)}`);
  return cost;
}

// ── Tier constants ────────────────────────────────────────────────────────────

export const TIER = Object.freeze({
  FREE:   'free',    // Tier 0 — local/deterministic only
  HAIKU:  'haiku',   // Tier 1 — cheap LLM synthesis
  SONNET: 'sonnet',  // Tier 2 — high-value synthesis
  OPUS:   'opus',    // Tier 3 — critical decisions, never in pipelines
});

// ── Entity context thresholds ─────────────────────────────────────────────────
// Tuning guide:
//   haiku_min_interactions — below this AND below haiku_min_chunks → Tier 0 template only.
//     Rationale: fewer than 5 interactions means we have almost nothing to say. A template
//     with name/company/score is more honest than an LLM bio padded from nothing.
//   sonnet_min_interactions — above this AND N2 is top-tier → Sonnet.
//     Rationale: 50+ interactions means real depth exists in the data. Sonnet can find
//     patterns across diverse signals that Haiku misses on dense, multi-source entities.

const ENTITY_THRESHOLDS = {
  haiku_min_interactions:  5,
  haiku_min_chunks:        3,
  sonnet_min_interactions: 50,
  // N2 values whose entities warrant Sonnet when signal is deep enough
  // WHY 'Partners' not 'Partner': N2 assignment in 05-score.js uses assignProfessionalN2
  // which returns 'Partners' (plural). A typo here would silently downgrade all Partners
  // to Haiku instead of Sonnet. The canonical N2 strings are defined in assignProfessionalN2.
  sonnet_n2: new Set(['Family', 'Core', 'Partners', 'Employer', 'Client']),
};

/**
 * Determine the compute tier for a person/company entity based on signal strength.
 *
 * Decision logic:
 *   1. If signal is thin (low interactions AND low RAG chunks) → FREE (template only)
 *   2. If entity is top-tier AND has deep signal → SONNET
 *   3. Otherwise → HAIKU
 *
 * @param {{ interaction_count?: number, n2?: string }} entity
 * @param {number} ragChunkCount - number of RAG chunks found for this entity
 * @returns {'free' | 'haiku' | 'sonnet'}
 */
export function entityTier(entity, ragChunkCount) {
  const interactions = entity.interaction_count || 0;
  const n2 = entity.n2 || '';

  // Tier 0: signal too thin for meaningful LLM synthesis
  if (
    interactions < ENTITY_THRESHOLDS.haiku_min_interactions &&
    ragChunkCount  < ENTITY_THRESHOLDS.haiku_min_chunks
  ) {
    return TIER.FREE;
  }

  // Tier 2: top-tier relationship with deep interaction history
  if (
    ENTITY_THRESHOLDS.sonnet_n2.has(n2) &&
    interactions >= ENTITY_THRESHOLDS.sonnet_min_interactions
  ) {
    return TIER.SONNET;
  }

  // Tier 1: default for anything with real signal but not top-tier
  return TIER.HAIKU;
}

/**
 * Determine the compute tier for a RAG synthesis task.
 *
 * Used when synthesizing an answer from retrieved chunks — the chunk count
 * and average relevance score together determine whether Haiku or Sonnet
 * should do the synthesis.
 *
 * @param {{ chunkCount: number, avgScore?: number, isRealtime?: boolean }} opts
 * @returns {'haiku' | 'sonnet'}
 */
export function ragTier({ chunkCount, avgScore = 0, isRealtime = false }) {
  // Real-time chat always uses at least Sonnet for quality (not called from pipelines)
  if (isRealtime) return TIER.SONNET;

  // High chunk count + high relevance score → dense signal worth Sonnet
  if (chunkCount >= 15 && avgScore >= 0.75) return TIER.SONNET;

  return TIER.HAIKU;
}

/**
 * Batch-route a list of items to their compute tiers.
 * Returns { free: [], haiku: [], sonnet: [] } — caller processes each bucket.
 *
 * @param {Array} items
 * @param {(item: any) => 'free'|'haiku'|'sonnet'} tierFn
 * @returns {{ free: Array, haiku: Array, sonnet: Array }}
 */
export function routeToBuckets(items, tierFn) {
  const buckets = { free: [], haiku: [], sonnet: [] };
  for (const item of items) {
    const t = tierFn(item);
    (buckets[t] || buckets.haiku).push(item);
  }
  return buckets;
}

// ── Call-site helpers ─────────────────────────────────────────────────────────

/**
 * Tier 0 — local/free compute. Wraps a synchronous fn, logs timing.
 * @param {() => any} fn
 * @param {string} [label]
 * @returns {any}
 */
export function tier0(fn, label = 'local') {
  const t0 = Date.now();
  const result = fn();
  // eslint-disable-next-line no-console
  console.info(`[tier0] ${label} — ${Date.now() - t0}ms (free)`);
  return result;
}

// tier1, tier2, tier3 removed — use llmCreate from lib/llm-gateway.js directly.
// Pass MODELS.haiku / MODELS.sonnet / MODELS.opus as the model param.
