/**
 * xAI provider.
 *
 * xAI exposes an OpenAI-compatible chat-completions API. Grok model-family
 * IDs remain accepted by callers, but xAI is the canonical provider.
 */

import { resolveAvailableId } from '../config.js';
import { withXaiKey } from '../xai-keys.js';
import {
  extractText,
  normalizeUsage,
  postChatCompletion,
  readSseJson,
} from './openai-compatible.js';

const XAI_BASE_URL = 'https://api.x.ai/v1';

let _fetchImpl = null;

export function setClient(client) {
  _fetchImpl = typeof client === 'function' ? client : client?.fetch || null;
}

export function _resetClient() {
  _fetchImpl = null;
}

// Exported for behavioral testing of the provider-level retired-ID leg. The
// resolved concrete id is routed through resolveAvailableId so a retired xAI id
// (legacy/alias included) falls through to a currently-callable one (AC3).
export function resolveModel(tier) {
  let id;
  if (!tier) id = 'grok-4.3';
  else if (tier === 'fast') id = 'grok-4.20-0309-non-reasoning';
  else if (tier === 'balanced') id = 'grok-4.3';
  else if (tier === 'best') id = 'grok-4.20-0309-reasoning';
  else if (tier === 'grok' || tier === 'grok-3' || tier === 'grok-3-mini') id = 'grok-4.3';
  else if (tier === 'grok-4-0709') id = 'grok-4.3';
  else if (tier === 'grok-4-fast' || tier === 'grok-4-fast-non-reasoning' || tier === 'grok-4-fast-reasoning') id = 'grok-4.3';
  else if (tier === 'grok-4-1-fast' || tier === 'grok-4-1-fast-non-reasoning' || tier === 'grok-4-1-fast-reasoning') id = 'grok-4.3';
  else if (tier === 'grok-4.20-non-reasoning') id = 'grok-4.20-0309-non-reasoning';
  else if (tier === 'grok-4.20' || tier === 'grok-4.20-reasoning') id = 'grok-4.20-0309-reasoning';
  else id = tier;
  return resolveAvailableId('xai', id);
}

export async function* streamChat(args) {
  const { messages, system = '', model, signal, max_tokens = 4096 } = args;
  const resolvedModel = resolveModel(model);
  const res = await withXaiKey((apiKey) => postChatCompletion({
    fetchImpl: _fetchImpl || globalThis.fetch,
    baseUrl: XAI_BASE_URL,
    apiKey,
    model: resolvedModel,
    messages,
    system,
    maxTokens: max_tokens,
    signal,
    stream: true,
    includeStreamUsage: true,
  }));
  yield { type: 'connected' };

  let usage = null;
  let responseModel = resolvedModel;
  for await (const chunk of readSseJson(res.body)) {
    responseModel = chunk.model || responseModel;
    if (chunk.usage) usage = chunk.usage;
    const delta = extractText(chunk.choices?.[0]?.delta?.content);
    if (delta) yield { type: 'delta', text: delta };
  }

  yield {
    type: 'complete',
    content: [],
    usage: normalizeUsage(usage),
    model: responseModel,
    stop_reason: 'end_turn',
  };
}

export async function complete(args) {
  const { messages, system = '', model, signal, max_tokens = 4096 } = args;
  const resolvedModel = resolveModel(model);
  const res = await withXaiKey((apiKey) => postChatCompletion({
    fetchImpl: _fetchImpl || globalThis.fetch,
    baseUrl: XAI_BASE_URL,
    apiKey,
    model: resolvedModel,
    messages,
    system,
    maxTokens: max_tokens,
    signal,
  }));
  const data = await res.json();
  const text = extractText(data.choices?.[0]?.message?.content);
  return {
    content: text ? [{ type: 'text', text }] : [],
    usage: normalizeUsage(data.usage),
    model: data.model || resolvedModel,
    stop_reason: 'end_turn',
  };
}

export const name = 'xai';
