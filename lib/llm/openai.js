/**
 * OpenAI provider.
 *
 * Direct HTTPS implementation so chat does not depend on the optional
 * `openai` SDK being installed. Uses chat-completions for GPT-4o and o-series
 * models; o-series requests use `max_completion_tokens`.
 */

import { secret } from '../config.js';
import {
  extractText,
  normalizeUsage,
  postChatCompletion,
  readSseJson,
} from './openai-compatible.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

let _fetchImpl = null;

function getApiKey() {
  const apiKey = secret('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('provider_not_configured: OPENAI_API_KEY missing');
  return apiKey;
}

export function setClient(client) {
  _fetchImpl = typeof client === 'function' ? client : client?.fetch || null;
}

export function _resetClient() {
  _fetchImpl = null;
}

// Fallback only — callers that resolve a concrete id through getModel() pass it
// straight through. Kept in step with the lane heads in lib/model-allowlists.js.
function resolveModel(tier) {
  if (!tier) return 'gpt-5.4-nano';
  if (tier === 'fast') return 'gpt-5.4-nano';
  if (tier === 'balanced') return 'gpt-5.4';
  if (tier === 'best') return 'gpt-5.6-sol';
  return tier;
}

export async function* streamChat(args) {
  const { messages, system = '', model, signal, max_tokens = 4096 } = args;
  const resolvedModel = resolveModel(model);
  const res = await postChatCompletion({
    fetchImpl: _fetchImpl || globalThis.fetch,
    baseUrl: OPENAI_BASE_URL,
    apiKey: getApiKey(),
    model: resolvedModel,
    messages,
    system,
    maxTokens: max_tokens,
    signal,
    stream: true,
    includeStreamUsage: true,
  });
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
  const res = await postChatCompletion({
    fetchImpl: _fetchImpl || globalThis.fetch,
    baseUrl: OPENAI_BASE_URL,
    apiKey: getApiKey(),
    model: resolvedModel,
    messages,
    system,
    maxTokens: max_tokens,
    signal,
  });
  const data = await res.json();
  const text = extractText(data.choices?.[0]?.message?.content);
  return {
    content: text ? [{ type: 'text', text }] : [],
    usage: normalizeUsage(data.usage),
    model: data.model || resolvedModel,
    stop_reason: 'end_turn',
  };
}

export const name = 'openai';
