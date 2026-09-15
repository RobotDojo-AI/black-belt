/**
 * lib/llm-gateway.js — Single choke point for all LLM calls.
 *
 * WHY this exists: before this module, every call site set its own timeout (or
 * none). A single slow model response could hang a request forever. This gateway
 * enforces a 120s hard deadline and fail-fast (no retries) on every call.
 *
 * Callers pass standard messages.create params (model, system, messages,
 * max_tokens, tools, signal, etc.) — the gateway adds a hard timeout and
 * composes it with caller cancellation when provided.
 *
 * Cost logging matches the compute-tier.js pattern: total_tokens, model, label.
 *
 * Usage:
 *   import { llmCreate } from './llm-gateway.js';
 *   const resp = await llmCreate({ model: MODELS.haiku, max_tokens: 300, ... }, 'my-label');
 */

// INTELLIGENCE_TIER: orchestration — this is the single choke point every
// other tier's LLM call routes through (timeout enforcement + cost logging);
// it does not itself decide content or write to a DB row or canonical doc —
// callers own that.
export const INTELLIGENCE_TIER = 'orchestration';

// st_74f45a1a R2 amendment — route through lib/llm/ provider abstraction.
// The Anthropic SDK client is now owned by lib/llm/anthropic.js; this gateway
// keeps its cost-logging and timeout contract but uses the provider for the
// actual API call. AC 10 grep gate prevents direct getAnthropicClient imports.
import { getProvider } from './llm/index.js';
import { providerNameForModelId } from './chat-models.js';
import { _logCost, MODELS, PRICING } from './compute-tier.js';
import db from './db.js';
import { recordLiveVerification } from './integration-status.js';
import { assertWithinBudget, invalidate as invalidateSpendCache } from './spend-guard.js';
import { classFor } from './api-key-class.js';
import { activeProvider, modelFor } from './model-lane.js';

// Hard default deadline for LLM calls. Callers with known long-form synthesis
// work can pass timeout_ms; chat remains on the default fast surface.
const TIMEOUT_MS = 120_000;

// Pricing map for cost logging — mirrors compute-tier.js PRICING.
// WHY duplicate: _logCost takes a tierName ('haiku'/'sonnet'/'opus') but callers
// pass model strings. We derive the tier from the model string here.
// Keys come from MODELS constants — never hardcode model strings.
const MODEL_TO_TIER = {
  [MODELS.haiku]:    'haiku',
  [MODELS.haiku_v4]: 'haiku',
  [MODELS.sonnet]:   'sonnet',
  [MODELS.opus]:     'opus',
};

const LANE_FROM_ANTHROPIC_TIER = { haiku: 'fast', sonnet: 'balanced', opus: 'best' };

function resolveGatewayModel(requested) {
  const id = String(requested || '');
  const provider = activeProvider();
  if (provider === 'anthropic') return id;
  const tier = MODEL_TO_TIER[id];
  if (!tier) return id;
  try { return modelFor(LANE_FROM_ANTHROPIC_TIER[tier]); } catch { return id; }
}

/**
 * Resolve which provider and concrete model a product completion uses.
 * No network. Callers (and tests) inspect routing without issuing a live call.
 */
export function completionRoute(model) {
  const resolvedModel = resolveGatewayModel(model);
  return {
    model: resolvedModel,
    provider: providerNameForModelId(resolvedModel),
  };
}

// Cache-token price multipliers, relative to the tier's base input rate.
// Anthropic bills a 5-minute cache write at 1.25x input and a cache read at
// 0.1x. We assume the 5-minute TTL because that is what the SDK uses unless a
// caller asks for the 1-hour variant (2x); no site here does. If one ever
// does, this constant becomes wrong in the cheap direction and the batch/cache
// columns are what make that visible.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.10;

// A batch-served call bills at half the synchronous rate (AC-7).
const BATCH_DISCOUNT = 0.5;

/**
 * recordPipelineSpend — write one row per model call to pipeline_llm_calls.
 *
 * st_4312c9c0 AC-5. This is the only durable record of what the application
 * spends on itself; the console line _logCost writes is for a human watching a
 * tail, not for answering "what did last month cost."
 *
 * Best-effort by contract. A failure to record spend must never fail the call
 * that produced it — the caller already paid for the tokens, and throwing here
 * would turn a bookkeeping problem into a data-pipeline outage. Failures warn
 * once and return.
 *
 * @param {object} args
 * @param {string} args.label     — call-site label (the same one _logCost prints)
 * @param {string} args.model     — concrete model id as sent to the API
 * @param {string|null} args.tier — resolved tier name, or null if unrecognised
 * @param {object} args.usage     — the provider's usage block
 * @param {string} [args.servedBy] — 'sync' | 'batch'
 * @returns {number|null} cost in micro-dollars, or null if it could not be priced
 */
export function recordPipelineSpend({ label, model, tier, usage, servedBy = 'sync', provider = 'anthropic', spendClass = null }) {
  if (!usage) return null;

  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;

  // Price by tier first, then by the literal model id — the PRICING table
  // carries both canonical tier keys and the frontend model aliases, and a
  // caller passing an unmapped model should still be priced when possible
  // rather than silently recorded at zero.
  const price = (tier && PRICING[tier]) || PRICING[model] || null;

  let costMicros = 0;
  if (price) {
    const usd =
      price.input * input +
      price.output * output +
      price.input * CACHE_WRITE_MULTIPLIER * cacheWrite +
      price.input * CACHE_READ_MULTIPLIER * cacheRead;
    costMicros = Math.round(usd * (servedBy === 'batch' ? BATCH_DISCOUNT : 1) * 1_000_000);
  }

  try {
    db.prepare(`
      INSERT INTO pipeline_llm_calls
        (label, model, tier, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, cost_micros, served_by,
         provider, spend_class)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(label, model, tier || null, input, output, cacheWrite, cacheRead, costMicros, servedBy,
      provider, spendClass);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[llm] could not record spend for ${label}: ${err.message}`);
    return null;
  }

  // An unpriced call is worse than an expensive one: it is spend the report
  // will under-count without saying so. Surface it rather than record a zero.
  if (!price) {
    // eslint-disable-next-line no-console
    console.warn(`[llm] ${label} recorded with no price for model ${model} — spend under-counted`);
  }

  // Drop the guard's cached window total so a burst is seen on the next call
  // rather than up to CACHE_TTL_MS later. Cheap: clears two numbers.
  invalidateSpendCache();

  return costMicros;
}

function composeSignalWithTimeout(callerSignal, timeoutMs = TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  const ac = new AbortController();
  const abort = () => {
    try { ac.abort(callerSignal.reason || timeoutSignal.reason); } catch { ac.abort(); }
  };
  if (callerSignal.aborted || timeoutSignal.aborted) {
    abort();
  } else {
    callerSignal.addEventListener('abort', abort, { once: true });
    timeoutSignal.addEventListener('abort', abort, { once: true });
  }
  return ac.signal;
}

/**
 * llmCreate — enforced gateway for all Anthropic messages.create calls.
 *
 * @param {object} params   — standard messages.create params (must include model)
 * @param {string} [label]  — label for cost logging (defaults to model name)
 * @returns {Promise<import('@anthropic-ai/sdk').Message>}
 * @throws {import('@anthropic-ai/sdk').APIConnectionTimeoutError} on timeout
 */
export async function llmCreate(params, label = '') {
  const effectiveLabel = label || params.model || 'unknown';

  // st_4312c9c0 — the brake, BEFORE the network call. Throws SpendLimitError
  // when a ceiling is crossed. `interactive` exempts a call from the pipeline
  // ceiling (not the total): a turn with a human waiting should be the last
  // thing to stop, not the first. Callers on a user-facing path pass it.
  assertWithinBudget({ label: effectiveLabel, interactive: params.interactive === true });

  // Resolve through the Anthropic provider — the provider's complete()
  // returns {content, usage, model, stop_reason}. Existing callers expect
  // the SDK-shaped Message object (resp.content + resp.usage + resp.model
  // + resp.stop_reason), which matches the provider contract exactly.
  //
  // We honor TIMEOUT_MS via AbortSignal.timeout so failed/hung calls
  // surface inside 120 s, while preserving caller cancellation. This is
  // load-bearing for launchd enrichment: when chat opens mid-job, the worker's
  // AbortController must be able to cancel an in-flight model call instead of
  // waiting behind the full timeout.
  const { model: resolvedModel, provider: providerName } = completionRoute(params.model);
  const provider = await getProvider(providerName);
  // st_4312c9c0 AC-6 — `cache` is forwarded. It used to be destructured away
  // here and silently dropped: a caller could ask for prompt caching, get a
  // normal full-price call, and have no way to tell. The provider has honored
  // this hint since it was written; only the gateway was swallowing it.
  const { messages, system, tools, max_tokens, cache, signal: callerSignal, timeout_ms } = params;
  const requestTimeoutMs = Number.isFinite(Number(timeout_ms)) && Number(timeout_ms) > 0
    ? Number(timeout_ms)
    : TIMEOUT_MS;
  const signal = composeSignalWithTimeout(callerSignal, requestTimeoutMs);
  const resp = await provider.complete({
    messages,
    system,
    tools,
    max_tokens,
    model: resolvedModel,
    cache, // 'system' → provider marks the system prompt cacheable
    timeout_ms: requestTimeoutMs,
    signal,
  });

  // A real successful call IS a live verification for whichever provider billed.
  queueMicrotask(() => { try { recordLiveVerification(db, providerName); } catch { /* best-effort */ } });

  // Log cost if we can resolve the model to a known tier.
  const tier = MODEL_TO_TIER[params.model] || MODEL_TO_TIER[resolvedModel];
  if (tier && resp.usage) {
    _logCost(tier, effectiveLabel, resp.usage);
  } else if (resp.usage) {
    // Unknown model — log raw tokens without pricing.
    // eslint-disable-next-line no-console
    console.info(`[llm] ${effectiveLabel} — ${resp.usage.input_tokens}in/${resp.usage.output_tokens}out (model: ${resolvedModel})`);
  }

  // st_4312c9c0 AC-5 — durable spend row. Runs for every call, including the
  // unknown-model branch above: an unrecognised model is exactly the case where
  // a console line disappears on restart and the money becomes unattributable.
  // Deliberately NOT inside queueMicrotask — unlike the liveness ping this is
  // the record of what was spent, and dropping it on a process exit that
  // happens between the response and the next tick would lose the row that
  // proves the call happened.
  recordPipelineSpend({
    label: effectiveLabel,
    model: resolvedModel,
    tier: tier || null,
    usage: resp.usage,
    servedBy: params.served_by || 'sync',
    provider: providerName,
    // Same signal the guard used above, so a call cannot be interactive for the
    // ceiling and autonomous for billing.
    spendClass: classFor({ interactive: params.interactive === true }),
  });

  return resp;
}
