/**
 * Google Gemini provider.
 *
 * Direct HTTPS implementation against the Generative Language API. This avoids
 * the optional `@google/generative-ai` SDK dependency and keeps model IDs in
 * sync with the live AI Studio API.
 */

import { secret, resolveAvailableId } from '../config.js';
import { flattenSystem, parseErrorResponse, readSseJson } from './openai-compatible.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

let _fetchImpl = null;

function getApiKey() {
  const apiKey = secret('GOOGLE_AI_API_KEY')
    || secret('GOOGLE_API_KEY')
    || process.env.GOOGLE_AI_API_KEY
    || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('provider_not_configured: GOOGLE_AI_API_KEY missing');
  return apiKey;
}

export function setClient(client) {
  _fetchImpl = typeof client === 'function' ? client : client?.fetch || null;
}

export function _resetClient() {
  _fetchImpl = null;
}

// Exported for behavioral testing of the provider-level retired-ID leg. The
// resolved concrete id is routed through resolveAvailableId so a retired Gemini
// id falls through to a currently-callable one (AC3).
export function resolveModel(tier) {
  let id;
  if (!tier) id = 'gemini-2.5-flash';
  else if (tier === 'fast') id = 'gemini-2.5-flash-lite';
  else if (tier === 'balanced') id = 'gemini-2.5-flash';
  else if (tier === 'best') id = 'gemini-2.5-pro';
  else id = String(tier).replace(/^models\//, '');
  return resolveAvailableId('google', id);
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => block?.text || block?.content || '').filter(Boolean).join('\n');
}

function translateMessages(messages) {
  return (messages || []).map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: textFromContent(message.content) }],
  }));
}

function buildBody({ model, messages, system, maxTokens }) {
  const resolvedMaxTokens = /gemini-2\.5-pro/i.test(model)
    ? Math.max(maxTokens || 4096, 2048)
    : (maxTokens || 4096);
  const body = {
    contents: translateMessages(messages),
    generationConfig: {
      maxOutputTokens: resolvedMaxTokens,
    },
  };
  if (/gemini-2\.5-flash/i.test(model)) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const systemText = flattenSystem(system);
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  return body;
}

function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.promptTokenCount || 0,
    output_tokens: usage.candidatesTokenCount || 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: usage.cachedContentTokenCount || null,
  };
}

function extractCandidateText(candidate) {
  return (candidate?.content?.parts || []).map((part) => part?.text || '').join('');
}

async function postGemini({ model, messages, system, maxTokens, signal, stream = false }) {
  const fetchImpl = _fetchImpl || globalThis.fetch;
  if (!fetchImpl) throw new Error('provider_not_configured: fetch unavailable');
  const apiKey = encodeURIComponent(getApiKey());
  const method = stream
    ? `streamGenerateContent?alt=sse&key=${apiKey}`
    : `generateContent?key=${apiKey}`;
  const res = await fetchImpl(`${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:${method}`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody({ model, messages, system, maxTokens })),
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return res;
}

export async function* streamChat(args) {
  const { messages, system = '', model, signal, max_tokens = 4096 } = args;
  const resolvedModel = resolveModel(model);
  const res = await postGemini({
    model: resolvedModel,
    messages,
    system,
    maxTokens: max_tokens,
    signal,
    stream: true,
  });
  yield { type: 'connected' };

  let usage = null;
  let responseModel = resolvedModel;
  for await (const chunk of readSseJson(res.body)) {
    usage = chunk.usageMetadata || usage;
    responseModel = chunk.modelVersion || responseModel;
    const text = extractCandidateText(chunk.candidates?.[0]);
    if (text) yield { type: 'delta', text };
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
  const res = await postGemini({ model: resolvedModel, messages, system, maxTokens: max_tokens, signal });
  const data = await res.json();
  const text = extractCandidateText(data.candidates?.[0]);
  return {
    content: text ? [{ type: 'text', text }] : [],
    usage: normalizeUsage(data.usageMetadata),
    model: data.modelVersion || resolvedModel,
    stop_reason: 'end_turn',
  };
}

export const name = 'google';
