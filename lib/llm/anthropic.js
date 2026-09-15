/**
 * Anthropic provider (st_74f45a1a R2 amendment).
 *
 * Implements the Provider interface (see lib/llm/provider.js). Translates
 * `cache: 'system'` hints into per-block `cache_control: {type:'ephemeral'}`
 * markers on the system prompt — the contract the @anthropic-ai/sdk@0.39.0
 * surface accepts.
 *
 * Two callable shapes per provider method:
 *   - streamChat(): yields delta/tool_start/tool_done events
 *   - complete():   awaits the full response object
 * Embeddings are not provider-owned; RAG uses the local embedding runtime.
 *
 * `model` is a logical tier resolved via MODELS (compute-tier.js). Callers
 * never see model strings. Future tier additions land in MODELS, not here.
 *
 * Cache surface:
 *   - String system → no caching (would have to chunk arbitrarily)
 *   - SystemBlock[] system → the LAST cacheable block carries cache_control.
 *     The caller decides which block is the cacheable boundary by
 *     authoring the array with at most one `{cache_control: {...}}`
 *     attached — typically the N-1 block (canonical context shards),
 *     leaving the final block (volatile RAG context) uncached.
 *
 * Why a wrapping module instead of inlining: tests mock this layer (not
 * the SDK) to assert cache-hint translation without an Anthropic key.
 */

// INTELLIGENCE_TIER: orchestration — the provider adapter that resolves
// tier names to model IDs and translates cache hints for the SDK call;
// coordinates the real call, decides no content itself.
export const INTELLIGENCE_TIER = 'orchestration';

import Anthropic from '@anthropic-ai/sdk';
import config, { resolveAvailableId } from '../config.js';
import { MODELS } from '../compute-tier.js';
import db from '../db.js';
import { recordLiveVerification } from '../integration-status.js';

let _client = null;

// Fast-fail SDK config (st_2cd1af73 Phase 6). The SDK default is
// maxRetries:2 with NO request timeout. When Anthropic's edge returns a 503
// "API key validation is temporarily unavailable" (observed in
// ~/.robotdojo/logs/*.err.log), the default client backs off exponentially
// across 2 retries — turning a transient overload into a 50–60s stall that
// the user experiences as a dead chat spinner (st_2cd1af73 research §5: a
// zero-context warmup ping measured a 53s tail with no retry surfaced to the
// caller). A 503 must FAIL FAST and surface as the chat stream's error frame,
// not silently back off. So the construction below pins a LITERAL
// maxRetries: 1 (one fast retry for a true blip, no exponential ladder) and a
// finite timeout: 15000 (15s hard per-request ceiling).
//
// WHY retries 1 not 0: a single immediate retry absorbs a one-off transient
// without a user-visible failure; the second+ retries are what build the
// multi-tens-of-seconds tail, so they are the ones we cut. The 15s timeout is
// the hard ceiling regardless — worst case is one 15s attempt + one 15s retry,
// still far under the old ~55s open-ended stall.
//
// Env override (ops tuning, no code change): ANTHROPIC_MAX_RETRIES and
// ANTHROPIC_TIMEOUT_MS replace the literals post-construct on the SDK's plain
// instance fields. The literals stay in the new Anthropic({...}) block so the
// real default is visible in source (and the AC gate that asserts a finite
// fast-fail default reads it there).
const ANTHROPIC_MAX_RETRIES_OVERRIDE = Number.isInteger(Number(process.env.ANTHROPIC_MAX_RETRIES))
  ? Number(process.env.ANTHROPIC_MAX_RETRIES)
  : null;
const ANTHROPIC_TIMEOUT_MS_OVERRIDE = Number.isFinite(Number(process.env.ANTHROPIC_TIMEOUT_MS))
  && Number(process.env.ANTHROPIC_TIMEOUT_MS) > 0
  ? Number(process.env.ANTHROPIC_TIMEOUT_MS)
  : null;

/**
 * Lazy SDK client. Cached per process — the Anthropic SDK keeps its
 * internal HTTP/2 pool, so a single client across the process is optimal.
 *
 * Client-level maxRetries + timeout apply to BOTH messages.create() and
 * messages.stream() (SDK 0.39.0: stream() inherits the client's request
 * options via `options.maxRetries ?? this.maxRetries` / `?? this.timeout`).
 * So the streaming chat path is covered by the same fast-fail bound without
 * per-call wiring.
 *
 * Tests inject a mock via setClient() and reset via _resetClient().
 */
function getClient() {
  if (_client) return _client;
  const apiKey = config.anthropicKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  _client = new Anthropic({ apiKey, maxRetries: 1, timeout: 15000 });
  // Apply ops overrides onto the SDK's settable instance fields (kept off the
  // constructor literal so the default stays legible in source).
  if (ANTHROPIC_MAX_RETRIES_OVERRIDE !== null) _client.maxRetries = ANTHROPIC_MAX_RETRIES_OVERRIDE;
  if (ANTHROPIC_TIMEOUT_MS_OVERRIDE !== null) _client.timeout = ANTHROPIC_TIMEOUT_MS_OVERRIDE;
  return _client;
}

export function setClient(client) {
  _client = client;
}

export function _resetClient() {
  _client = null;
}

/**
 * Resolve a logical tier to a model id. Pass-through for concrete ids so
 * callers can still override per-request (e.g., experiments). The final id —
 * whether from a tier (compute-tier MODELS.*, the synthesis path) or a concrete
 * pass-through — is routed through resolveAvailableId so a retired Anthropic id
 * (e.g. a sunset MODELS.sonnet) falls through to a currently-callable one
 * (df_a00a336b AC3). Exported for behavioral testing of the synthesis leg.
 */
export function resolveModel(tier) {
  let id;
  if (!tier) id = MODELS.haiku;
  else if (tier === 'fast') id = MODELS.haiku;
  else if (tier === 'balanced') id = MODELS.sonnet;
  else if (tier === 'best') id = MODELS.opus;
  else id = tier; // concrete id pass-through
  return resolveAvailableId('anthropic', id);
}

/**
 * Apply cache_control to the system prompt based on the hint.
 *
 * Anthropic accepts:
 *   - system: 'string'                              → no caching
 *   - system: [{type:'text', text, cache_control?}] → block-level caching
 *
 * When the caller passes a string and asks for caching, we wrap it in a
 * single block with cache_control. When the caller passes an array, we
 * trust their decision and DO NOT mutate (they already authored the boundary).
 */
function applyCacheToSystem(system, cacheHint) {
  if (!cacheHint) return system;
  if (Array.isArray(system)) return system; // caller-controlled
  if (typeof system !== 'string' || !system) return system;
  // Single-block fallback — the simplest cacheable shape. Useful for callers
  // that haven't yet migrated to block authoring (e.g., the @miyagi handler).
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

/**
 * Translate provider tools to Anthropic tool schemas.
 * Anthropic tools have `name`, `description`, `input_schema`. Tools entering
 * this layer should already match — but we pass through to keep the
 * abstraction lean. Future providers may rename fields here.
 */
function translateTools(tools) {
  return Array.isArray(tools) ? tools : undefined;
}

/**
 * Stream a chat completion. Yields delta/tool_start/tool_done events.
 *
 * @param {import('./provider.js').StreamChatArgs} args
 * @yields {import('./provider.js').StreamEvent}
 */
export async function* streamChat(args) {
  const {
    messages,
    system = '',
    tools,
    model,
    cache = null,
    signal,
    max_tokens = 4096,
  } = args;

  const apiParams = {
    model: resolveModel(model),
    max_tokens,
    messages,
  };
  if (system) apiParams.system = applyCacheToSystem(system, cache);
  const tt = translateTools(tools);
  if (tt && tt.length > 0) apiParams.tools = tt;

  const client = getClient();
  const stream = client.messages.stream(apiParams);
  // Wire abort. SDK 0.39.0 honors .abort() on the stream object.
  if (signal) {
    if (signal.aborted) {
      try { stream.abort(); } catch {}
    } else {
      signal.addEventListener('abort', () => { try { stream.abort(); } catch {} }, { once: true });
    }
  }

  let currentTool = null;
  for await (const ev of stream) {
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      currentTool = { id: ev.content_block.id, name: ev.content_block.name, args: '' };
    } else if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta' && ev.delta.text) {
        yield { type: 'delta', text: ev.delta.text };
      } else if (ev.delta?.type === 'input_json_delta' && currentTool) {
        currentTool.args += ev.delta.partial_json || '';
      }
    } else if (ev.type === 'content_block_stop') {
      if (currentTool) {
        let parsed = {};
        try { parsed = currentTool.args ? JSON.parse(currentTool.args) : {}; } catch {}
        yield { type: 'tool_start', name: currentTool.name, args: parsed, id: currentTool.id };
        currentTool = null;
      }
    }
  }

  // finalMessage gives canonical usage + content; emitted as a virtual
  // 'complete' event so the loop above (in anthropic-loop.js) can capture
  // it for observability without a second SDK call.
  const finalMessage = typeof stream.finalMessage === 'function'
    ? await stream.finalMessage().catch(() => null)
    : null;
  if (finalMessage) {
    // st_bf4978b0 AC5 — a completed stream IS a live verification of the
    // Anthropic key. Record it fire-and-forget AFTER the last token (this runs
    // once the stream is drained), no network, no TTFT cost (Chat Speed P0).
    queueMicrotask(() => { try { recordLiveVerification(db, 'anthropic'); } catch { /* best-effort */ } });
    yield {
      type: 'complete',
      content: finalMessage.content || [],
      usage: finalMessage.usage || null,
      model: finalMessage.model || apiParams.model,
      stop_reason: finalMessage.stop_reason || null,
    };
  }
}

/**
 * Non-streaming completion.
 *
 * @param {import('./provider.js').StreamChatArgs} args
 * @returns {Promise<import('./provider.js').CompleteResult>}
 */
export async function complete(args) {
  const {
    messages,
    system = '',
    tools,
    model,
    cache = null,
    signal,
    max_tokens = 4096,
    timeout_ms,
  } = args;

  const apiParams = {
    model: resolveModel(model),
    max_tokens,
    messages,
  };
  if (system) apiParams.system = applyCacheToSystem(system, cache);
  const tt = translateTools(tools);
  if (tt && tt.length > 0) apiParams.tools = tt;

  // Honor AbortSignal via SDK options. The SDK's create() accepts a 2nd
  // opts arg with {signal, timeout, maxRetries}.
  const opts = {};
  if (signal) opts.signal = signal;
  if (Number.isFinite(Number(timeout_ms)) && Number(timeout_ms) > 0) {
    opts.timeout = Number(timeout_ms);
  }

  const client = getClient();
  const resp = await client.messages.create(apiParams, opts);
  return {
    content: resp.content || [],
    usage: resp.usage || null,
    model: resp.model || apiParams.model,
    stop_reason: resp.stop_reason || null,
  };
}

export const name = 'anthropic';
