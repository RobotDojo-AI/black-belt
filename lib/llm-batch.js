/**
 * lib/llm-batch.js — the half-price lane for work nothing is waiting on.
 *
 * st_4312c9c0 AC-7. Anthropic's Message Batches API bills at 50% of the
 * synchronous rate in exchange for asynchronous turnaround (typically minutes,
 * contractually up to 24 hours). That trade is correct for exactly one shape of
 * work: bulk iteration in a background job with no caller blocked on the
 * result. It is wrong everywhere else, which is why this is a separate module
 * rather than a flag on llmCreate — a batch call reached from a request path
 * would hang that request, and making it easy to do by accident is worse than
 * making it slightly harder to do on purpose.
 *
 * Spend is recorded per request with served_by='batch', so the discount shows
 * up in the ledger as the lever that produced it rather than as an unexplained
 * halving of the bill.
 *
 * NOT INTEGRATION-TESTED against the live API: the owner's key was revoked
 * while this was written. The shape follows the documented batches contract
 * (create → poll processing_status → stream results) and the unit-level
 * behaviour is covered, but the first real run should be watched.
 */

// INTELLIGENCE_TIER: orchestration — submits other tiers' calls to the batch
// lane and records their spend; makes no content decision of its own.
export const INTELLIGENCE_TIER = 'orchestration';

import { getAnthropicClient } from './anthropic-client.js';
import { recordPipelineSpend } from './llm-gateway.js';
import { assertWithinBudget } from './spend-guard.js';
import { MODELS } from './compute-tier.js';

// Poll cadence. Batches usually finish in minutes; polling harder does not make
// them finish sooner and every poll is a round trip.
const POLL_INTERVAL_MS = 15_000;

// Default ceiling on how long a caller will wait before giving up on the poll.
// Giving up does NOT cancel the batch and does NOT re-run the work
// synchronously — that would bill twice for one result. It returns what has
// arrived and leaves the rest for the next pass.
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;

const MODEL_TO_TIER = {
  [MODELS.haiku]: 'haiku',
  [MODELS.haiku_v4]: 'haiku',
  [MODELS.sonnet]: 'sonnet',
  [MODELS.opus]: 'opus',
};

/**
 * llmBatch — run many prompts through the batch lane at half price.
 *
 * @param {Array<{custom_id: string, params: object}>} requests
 *   Each params is a normal messages.create body (model, max_tokens, messages).
 * @param {string} label — call-site label, recorded against every row.
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxWaitMs]
 * @returns {Promise<Map<string, {text: string}|{error: string}>>}
 *   Keyed by custom_id. A custom_id absent from the map did not complete in
 *   time; the caller decides whether that is retryable.
 */
export async function llmBatch(requests, label, { signal = null, maxWaitMs = DEFAULT_MAX_WAIT_MS } = {}) {
  const out = new Map();
  if (!Array.isArray(requests) || requests.length === 0) return out;

  // st_4312c9c0 — the brake applies here too, and matters MORE than on the
  // synchronous path: a batch submits hundreds of requests in one call, so an
  // unchecked batch is the single largest way to blow a ceiling. Never
  // interactive by construction — batch turnaround is minutes to hours.
  assertWithinBudget({ label, interactive: false });

  const client = getAnthropicClient();
  const batch = await client.messages.batches.create({ requests });

  const deadline = Date.now() + maxWaitMs;
  let status = batch.processing_status;

  while (status !== 'ended') {
    if (signal?.aborted) throw new DOMException('batch wait aborted', 'AbortError');
    if (Date.now() > deadline) {
      // eslint-disable-next-line no-console
      console.warn(`[llm-batch] ${label}: batch ${batch.id} still running at the wait ceiling — leaving it to finish, returning nothing this pass`);
      return out;
    }
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, POLL_INTERVAL_MS);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('batch wait aborted', 'AbortError')); }, { once: true });
    });
    const current = await client.messages.batches.retrieve(batch.id);
    status = current.processing_status;
  }

  for await (const entry of await client.messages.batches.results(batch.id)) {
    const id = entry.custom_id;
    const result = entry.result;
    if (result?.type !== 'succeeded') {
      out.set(id, { error: result?.type || 'unknown' });
      continue;
    }
    const message = result.message;
    const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    out.set(id, { text });

    recordPipelineSpend({
      label,
      model: message.model,
      tier: MODEL_TO_TIER[message.model] || null,
      usage: message.usage,
      servedBy: 'batch',
    });
  }

  return out;
}
