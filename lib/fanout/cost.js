/**
 * fanout/cost.js — per-run cost math (PURE).
 *
 * Prices every LLM call a fan-out run makes against the canonical PRICING
 * table (lib/compute-tier.js). Two functions, both pure and keyless:
 *
 *   costForCall({provider, model, usage}) → priced line for one call
 *   totalCost(lines)                      → summed dollars
 *
 * WHY a dedicated resolver instead of estimateCostCents(): estimateCostCents
 * falls back to PRICING.sonnet for any unknown model id (compute-tier.js:103),
 * which would silently mis-price a Grok or a newly-shipped model as Claude
 * Sonnet. A fan-out cost line the operator is asked to trust must never lie:
 * an unknown model is flagged `priced:false` with $0 rather than guessed.
 */
import { PRICING } from '../compute-tier.js';

/**
 * Resolve a concrete model id to its PRICING key via the same family prefixes
 * estimateCostCents uses (compute-tier.js:92-102), minus the sonnet fallback.
 * Returns a PRICING key or null when the family is unrecognized.
 */
function aliasFor(model) {
  const k = String(model || '');
  if (k.startsWith('claude-haiku')) return 'claude-haiku';
  if (k.startsWith('claude-sonnet')) return 'claude-sonnet';
  if (k.startsWith('claude-opus')) return 'claude-opus';
  if (k.startsWith('gemini-2.5-flash-lite')) return 'gemini-flash-lite';
  if (k.startsWith('gemini-2.5-flash')) return 'gemini-flash';
  if (k.startsWith('gemini-2.5-pro')) return 'gemini-2.5-pro';
  if (k.startsWith('gpt-4o-mini')) return 'gpt-4o-mini';
  if (k.startsWith('gpt-4o')) return 'gpt-4o';
  if (k.startsWith('o3-mini')) return 'o3-mini';
  // Dated siblings of a priced lane head (the API echoes back e.g.
  // 'gpt-5.4-2026-03-05' for 'gpt-5.4') resolve to the head's own price.
  // Longest-prefix first so '-mini'/'-nano'/'-lite' never fall through to the
  // base id and get priced as the far more expensive full model.
  for (const head of DATED_SIBLING_HEADS) {
    if (k.startsWith(head)) return head;
  }
  return null;
}

// Ordered longest-first; every entry must exist as a PRICING key.
const DATED_SIBLING_HEADS = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4',
  'gpt-5.6-sol',
  'gpt-5.5',
  'grok-4.5',
];

/**
 * Price a single LLM call.
 *
 * @param {{provider?:string, model:string, usage?:{input_tokens?:number, output_tokens?:number}}} call
 * @returns {{provider:string|null, model:string, input_tokens:number, output_tokens:number, dollars:number, priced:boolean}}
 *
 * Resolution order: exact PRICING id → family alias → unpriced. When neither
 * an exact id nor a family alias matches, `priced` is false and `dollars` is 0
 * (the honest zero). Callers surface the unpriced flag; this function stays
 * pure and never warns.
 */
export function costForCall({ provider = null, model, usage } = {}) {
  const input_tokens = Number(usage?.input_tokens) || 0;
  const output_tokens = Number(usage?.output_tokens) || 0;
  const entry = PRICING[model] ?? (aliasFor(model) ? PRICING[aliasFor(model)] : null);
  if (!entry) {
    return { provider, model: String(model ?? ''), input_tokens, output_tokens, dollars: 0, priced: false };
  }
  const dollars = entry.input * input_tokens + entry.output * output_tokens;
  return { provider, model: String(model), input_tokens, output_tokens, dollars, priced: true };
}

/**
 * Sum the dollar figures of an array of priced call lines.
 * Unpriced lines contribute 0 (they carry dollars:0), so the total is honest
 * about what could be priced without inflating from guesses.
 *
 * @param {Array<{dollars?:number}>} lines
 * @returns {number} total dollars
 */
export function totalCost(lines) {
  if (!Array.isArray(lines)) return 0;
  return lines.reduce((sum, line) => sum + (Number(line?.dollars) || 0), 0);
}
