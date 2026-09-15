/**
 * fanout/fan.js — parallel fan of one task across the four providers.
 *
 * Generalizes the warmProvider prior art (lib/warmup.js:727 — getProvider then
 * client.complete) to four providers via Promise.allSettled, with two hard
 * requirements:
 *
 *   1. Resolve the CONCRETE model id first (getModel(provider, tier)) and pass
 *      THAT to complete(). Passing the logical tier lets a provider's own
 *      resolveModel diverge from getModel/cost reporting (xai.js:37 resolves
 *      'balanced'→grok-4.3 but a future divergence would silently call a
 *      different model than cost.js prices).
 *   2. Per-call AbortSignal.timeout on every complete(). openai/google/xai
 *      honor only the caller's signal — without a deadline a hung model hangs
 *      the whole fan. allSettled then drops the failed/slow provider and the
 *      run continues on the survivors (graceful degradation).
 */
import { getModel } from '../config.js';

// Sized for REASONING models, where thinking tokens are billed against
// max_tokens before a single answer token is emitted. Opus 5 spends ~3,500 of a
// 4,096 budget thinking on a prompt this size, so the old 4,096 either truncated
// its answer mid-sentence or left no text block at all — the fan logged ok:true,
// the receipts held no raw-anthropic.md, and the panel silently ranked three
// models while reporting four. Headroom here is near-free: only tokens actually
// generated are billed.
const FAN_MAX_TOKENS = 16000;
const FAN_TIMEOUT_MS = 120000;

/**
 * Fan the task to every provider in parallel.
 *
 * @param {object} args
 * @param {string} args.task
 * @param {string[]} args.providers - e.g. ['anthropic','openai','google','xai']
 * @param {string} args.tier - logical tier ('fast'|'balanced'|'best')
 * @param {(provider:string, completeArgs:object)=>Promise<object>} args.complete - injected seam
 * @param {number} [args.timeoutMs]
 * @returns {Promise<Array<{provider:string, model:string, ok:boolean, text:string, usage:object, latencyMs:number, error:string|null}>>}
 */
export async function fanTask({ task, providers, tier, complete, timeoutMs = FAN_TIMEOUT_MS }) {
  const messages = [{ role: 'user', content: task }];

  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const model = getModel(provider, tier);
      const started = Date.now();
      // Per-call deadline — a bare timeout signal suffices; the fan needs no
      // caller-signal composition (each provider call is independent).
      const res = await complete(provider, {
        model,
        messages,
        max_tokens: FAN_MAX_TOKENS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = res?.content?.find?.((b) => b.type === 'text')?.text
        ?? res?.content?.[0]?.text
        ?? '';
      return {
        provider,
        model: res?.model || model,
        ok: true,
        text,
        usage: res?.usage || { input_tokens: 0, output_tokens: 0 },
        latencyMs: Date.now() - started,
        error: null,
      };
    }),
  );

  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const err = s.reason;
    return {
      provider: providers[i],
      model: getModel(providers[i], tier),
      ok: false,
      text: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      latencyMs: 0,
      error: err?.message || String(err),
    };
  });
}
