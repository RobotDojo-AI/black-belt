/**
 * Chat orchestrator — picks the right backend, threads phase + metric
 * callbacks through, and returns an async-generator stream.
 *
 * Decomposed in st_74f45a1a Phase 2. The inline phases of the prior
 * monolithic streamChat now live as discrete named modules:
 *
 *   lib/chat/system-prompt.js — assembleSystemPrompt(opts, db) → string
 *   lib/chat/anthropic-loop.js — streamAnthropicToolLoop(args) → AsyncGenerator
 *   lib/chat/ollama.js — streamOllama / ollamaReachable
 *
 * This file orchestrates: assemble prompt → optionally inject RAG/context →
 * pick the backend (ollama > anthropic) → yield events. Tests live
 * alongside each module under tests/chat/*.test.js.
 *
 * Local model backend removed by st_bc949e7c; it is not a launch runtime.
 */

// INTELLIGENCE_TIER: orchestration — this module coordinates RAG/context
// assembly, tool execution, and backend selection around the LLM call; it
// contains no db.prepare/INSERT of its own — the response streams to the
// user, and deterministic callers persist the conversation separately.
export const INTELLIGENCE_TIER = 'orchestration';

import config from './config.js';
import { getFile } from './upload-store.js';
import { search, searchAll } from './rag-search.js';
import {
  cachedBuildLayeredContext,
  detectEntitiesInWindow,
  peekCachedLayeredContext,
  peekAmbientLayeredContext,
} from './chat-context.js';
// st_df0a8d71 D5 — the volatile-tail builds run on a worker thread so their
// sync SQL cannot block the main event loop and the budgets actually bind.
// Kill-switch ROBOTDOJO_CONTEXT_WORKER=0 restores the inline path.
import {
  buildFastTimeoutContextSmart,
  buildDirectEntityAnswerSmart,
} from './chat/context-worker.js';
import { getToolSchemas, executeTool } from './chat-tools.js';
import { formatTopicResumeBlock } from './topic-live-thread.js';
import { mentionedTopicSlugs, shouldAttachTopicCorpus } from './topic-session.js';
import db from './db.js';
import { recordLiveVerification } from './integration-status.js';
// st_74f45a1a R2 — provider abstraction. No direct Anthropic SDK imports.
import { selectProvider } from './llm/index.js';
import { llmCreate } from './llm-gateway.js';
import { logTurn } from './session-log.js';
import { route as routeContext } from './context-router.js';
import { ROBOTDOJO_BRAND_PROMPT } from './brand-persona.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assembleCachedSystemBlocks,
  withVolatileContext,
  flattenSystemBlocks,
} from './chat/system-prompt.js';
import { streamAnthropicToolLoop } from './chat/anthropic-loop.js';
import { streamFrozenTurn } from './writing-freeze.js';
import { streamOllama, ollamaReachable } from './chat/ollama.js';
import { appEvents } from './app-events.js';
import { EGO_BLOCK_HEADER, getEgoBlockInfo } from './ego-render.js';
import { parseRelationshipQuestion, answerRelationshipQuestion } from './chat/relationship-intent.js';
import { detectProductQuestion, buildProductGuideBlock } from './product-guide.js';
import {
  CHAT_MODEL_LANES,
  chatModelLaneKey,
  normalizeChatModelKey,
  productizedChatModelForMode,
  providerNameForModelId,
  resolveChatModelId,
} from './chat-models.js';
import { computeWorkOrder } from './rag/work-order.js';
import { NEEDS_ROUTING_TOPIC } from './topic-routing-policy.js';
import { getTopicLiveConfig } from './topic-live-thread.js';

const RAG_TOKEN_CAP = 8000;
const CHARS_PER_TOKEN = 4;
const MAX_TOOL_ROUNDS = 5;
const VALUE_RANK_ENTITY_FLOOR = 1_000_000_000_000;
const EMBED_LONG_INPUT_CHARS = (() => {
  const raw = Number(process.env.ROBOTDOJO_EMBED_LONG_INPUT_CHARS || '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000;
})();
const CHAT_CONTEXT_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_CHAT_CONTEXT_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 700;
})();
const CHAT_CONTEXT_RICH_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_CHAT_CONTEXT_RICH_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw >= CHAT_CONTEXT_TIMEOUT_MS ? raw : 3_000;
})();
const SOURCE_BOUND_CONTEXT_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_SOURCE_BOUND_CONTEXT_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw >= CHAT_CONTEXT_RICH_TIMEOUT_MS ? raw : 8_000;
})();
const DIRECT_ENTITY_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_CHAT_DIRECT_ENTITY_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 1_800;
})();
const ROUTER_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_CHAT_ROUTER_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 500;
})();
const INLINE_RECOGNITION_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_CHAT_INLINE_RECOGNITION_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 300;
})();
const CHAT_ROUTER_FOREGROUND_ENABLED = process.env.ROBOTDOJO_ENABLE_CHAT_ROUTER === '1';
const CHAT_DEEP_INLINE_RAG_ENABLED = process.env.ROBOTDOJO_CHAT_DEEP_INLINE_RAG === '1';

// st_f1a40461 AC9 — inline recognition rolling window. We scan the last few
// user+assistant turns (char-capped) so a contact named in an earlier turn
// still surfaces as a chip in a later turn without an @-mention.
const RECOGNITION_WINDOW_TURNS = 6;
const RECOGNITION_WINDOW_CHARS = 4000;
const LOCAL_ANSWER_CHUNK_CHARS = 180;
const MODEL_PRELUDE_MS = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_MODEL_PRELUDE_MS || '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 1_200;
})();
const MODEL_PRELUDE_TEXT = 'Thinking it through.';
const CHAT_PROVIDER_FIRST_DELTA_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_CHAT_PROVIDER_FIRST_DELTA_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 3_500;
})();
const CHAT_PROVIDER_CONTEXT_FIRST_DELTA_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_CHAT_PROVIDER_CONTEXT_FIRST_DELTA_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw >= CHAT_PROVIDER_FIRST_DELTA_TIMEOUT_MS ? raw : 6_000;
})();
const CHAT_PROVIDER_DEEP_FIRST_DELTA_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_CHAT_PROVIDER_DEEP_FIRST_DELTA_TIMEOUT_MS || '', 10);
  return Number.isInteger(raw) && raw >= CHAT_PROVIDER_CONTEXT_FIRST_DELTA_TIMEOUT_MS ? raw : 10_000;
})();
const CHAT_STREAM_FALLBACK_MODEL_KEYS = (() => {
  const raw = process.env.ROBOTDOJO_CHAT_STREAM_FALLBACK_MODELS || 'gemini-flash-lite,gpt-4o-mini,grok-4.20-0309-non-reasoning';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
})();
const RESPONSE_MODE_LABELS = {
  fast: 'Answering fast…',
  context: 'Gathering your context…',
  deep: 'Deep context pass…',
};
const RESPONSE_MODE_TIER = { fast: 0, context: 1, deep: 2 };
const MODEL_LANE_RESPONSE_MODE = { ask: 'fast', work: 'context', think: 'deep' };
const RESPONSE_MODE_LANE = { fast: 'ask', context: 'work', deep: 'think' };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepUnref(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function firstDeltaTimeoutForMode(mode) {
  if (mode === 'deep') return CHAT_PROVIDER_DEEP_FIRST_DELTA_TIMEOUT_MS;
  if (mode === 'context') return CHAT_PROVIDER_CONTEXT_FIRST_DELTA_TIMEOUT_MS;
  return CHAT_PROVIDER_FIRST_DELTA_TIMEOUT_MS;
}

const DEEP_THINK_MODEL_BY_KEY = Object.freeze({
  'grok-4.3': 'grok-4.20-0309-reasoning',
  'grok-4.20-0309-non-reasoning': 'grok-4.20-0309-reasoning',
  'claude-sonnet': 'claude-opus',
  'claude-haiku': 'claude-opus',
  'gpt-4o': 'o3-mini',
  'gpt-4o-mini': 'o3-mini',
  'gemini-flash': 'gemini-flash',
});

export function resolveChatStreamPolicy({ mode, toolsLength = 0, model } = {}) {
  const lane = RESPONSE_MODE_LANE[mode] || 'ask';
  const allowProviderFallback = mode !== 'deep' && Number(toolsLength) === 0;
  const modelPolicy = productizedChatModelForMode(model, mode);
  let resolvedModel = modelPolicy.model || model;
  if (mode === 'deep' && chatModelLaneKey(resolvedModel) !== 'think') {
    resolvedModel = DEEP_THINK_MODEL_BY_KEY[normalizeChatModelKey(resolvedModel)] || resolvedModel;
  }
  const deepFloor = getTopicLiveConfig().deepFirstDeltaTimeoutMs;
  const firstDeltaTimeoutMs = mode === 'deep'
    ? Math.max(firstDeltaTimeoutForMode('deep'), deepFloor)
    : firstDeltaTimeoutForMode(mode);
  return {
    allowProviderFallback,
    inlineRag: mode === 'deep',
    lane,
    model: resolvedModel,
    firstDeltaTimeoutMs,
    providerModels: chatStreamFallbackModels(resolvedModel, { allowFallback: allowProviderFallback }),
  };
}

function chatStreamFallbackModels(primaryModel, { allowFallback = true } = {}) {
  const models = [];
  const seen = new Set();
  const add = (candidate) => {
    const resolved = resolveChatModelId(candidate);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    models.push(resolved);
  };
  add(primaryModel);
  if (allowFallback) {
    for (const key of CHAT_STREAM_FALLBACK_MODEL_KEYS) add(key);
  }
  return models;
}

function providerErrorCode(err) {
  if (!err) return 'provider_error';
  const cause = err.cause?.code || err.cause?.name || err.cause?.message;
  const head = err.code || err.name || err.type || err.message || 'provider_error';
  return cause ? `${head}:${cause}` : head;
}

function normalizeEnrichmentFaults(value) {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  const raw = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  return new Set(raw.map((v) => String(v || '').trim()).filter(Boolean));
}

function hasEnrichmentFault(faults, name) {
  return faults.has('all')
    || faults.has(name)
    || faults.has(`${name}_error`)
    || faults.has(`${name}.error`);
}

function hasSlowEnrichmentFault(faults, name) {
  return faults.has('all_slow')
    || faults.has(`${name}_slow`)
    || faults.has(`${name}.slow`);
}

function emitTiming(onTiming, phase, ms) {
  if (typeof onTiming !== 'function') return;
  try { onTiming({ phase, ms }); } catch {}
}

function emitEnrichment(onEnrichment, event) {
  if (typeof onEnrichment !== 'function') return;
  try { onEnrichment(event); } catch {}
}

function modeBudget(mode) {
  if (mode === 'deep') return SOURCE_BOUND_CONTEXT_TIMEOUT_MS;
  if (mode === 'context') return CHAT_CONTEXT_RICH_TIMEOUT_MS;
  return CHAT_CONTEXT_TIMEOUT_MS;
}

function attachTopicResume(systemBlocks, topic, layeredCtx, opts = {}) {
  const current = Array.isArray(topic) ? topic : (topic ? [topic] : []);
  const currentSlugs = current.map((slug) => topicSlugValue(slug) || slug).filter(Boolean);
  const mentioned = mentionedTopicSlugs(db, opts.query, currentSlugs[0]);
  const attachCurrent = shouldAttachTopicCorpus({
    sessionUserTurn: opts.sessionUserTurn,
    query: opts.query,
    responseMode: opts.responseMode,
  });
  const slugs = [
    ...(attachCurrent ? currentSlugs : []),
    ...mentioned.filter((slug) => !currentSlugs.includes(slug)),
  ];
  const resume = slugs
    .map((slug) => formatTopicResumeBlock(db, slug, opts))
    .filter(Boolean)
    .join('\n\n');
  const volatile = [resume, layeredCtx].filter(Boolean).join('\n\n');
  return volatile ? withVolatileContext(systemBlocks, volatile) : systemBlocks;
}

function topicSlugValue(topic) {
  if (topic && typeof topic === 'object') {
    for (const key of ['slug', 'topic_slug', 'topicSlug', 'id', 'value']) {
      const value = topic[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
  }
  return topic;
}

function isContextBearingTopic(topic) {
  const value = String(topicSlugValue(topic) || '').trim().toLowerCase();
  if (!value) return false;
  return !new Set([
    'all',
    'general',
    'needs-routing',
    'uncategorized',
    NEEDS_ROUTING_TOPIC,
  ].map((v) => String(v).toLowerCase())).has(value);
}

export function classifyChatResponseMode({
  query = '',
  topic = null,
  files = [],
  injectedContext = null,
  sourceBound = null,
  requestedMode = null,
} = {}) {
  if (requestedMode === 'deep') {
    return {
      mode: 'deep',
      label: RESPONSE_MODE_LABELS.deep,
      contextTimeoutMs: SOURCE_BOUND_CONTEXT_TIMEOUT_MS,
      reason: 'client_deep',
    };
  }
  const text = String(query || '').toLowerCase();
  const hasTopic = Array.isArray(topic)
    ? topic.some(isContextBearingTopic)
    : isContextBearingTopic(topic);
  const hasFiles = Array.isArray(files) && files.length > 0;
  const wantsSourceBound = sourceBound ?? requiresSourceBoundContext(query);
  const explicitDeep = requestedMode !== 'fast' && (wantsSourceBound
    || /\b(deep|deeper|thorough|comprehensive|source[- ]?backed|cite|citation|evidence|exact|audit|verify|ground(?:ed)?|from my (?:data|notes|docs|documents|sources|emails|calendar|memory))\b/i.test(text));
  if (explicitDeep) {
    return {
      mode: 'deep',
      label: RESPONSE_MODE_LABELS.deep,
      contextTimeoutMs: SOURCE_BOUND_CONTEXT_TIMEOUT_MS,
      reason: wantsSourceBound ? 'source_bound' : 'explicit_deep',
    };
  }

  // Identity / who-is-who / family questions are personal context even when
  // they do not name email/calendar. Fast mode with empty volatile context
  // was greenwashing "chat works" while the product felt like a stock model.
  const identityContextSignal = /\b(who am i|what(?:'s| is) my name|about me|my (?:name|family|wife|husband|spouse|kids?|children|son|daughter|dog|pet|employer|job|company|background|bio)|tell me about myself|do you know (?:me|who i am)|who is (?:my )?(?:wife|husband|spouse|son|daughter|mother|father|mom|dad))\b/i.test(text)
    || /\bwho(?:'s| is)\b.{0,40}\b(?:to me|my)\b/i.test(text);
  const privateContextSignal = hasTopic
    || hasFiles
    || Boolean(injectedContext)
    || identityContextSignal
    || /\b(my|me|mine|our|we|us)\b.{0,80}\b(calendar|email|emails|message|messages|notes|docs|documents|memory|memories|data|person|people|contact|contacts|network|relationship|relationships|company|companies|history|follow[- ]?up|meeting|meetings)\b/i.test(text)
    || /\b(calendar|email|emails|message|messages|notes|docs|documents|memory|memories|contacts|network|relationship|follow[- ]?up|meeting|meetings)\b.{0,80}\b(my|me|mine|our|we|us)\b/i.test(text)
    || /\b(who should i|what should i|what's on my|what is on my|when did i|why did i|how do i know|how do we know|history with|latest messages|last message|last email|follow up with)\b/i.test(text)
    || /\b(what did we (conclude|decide|agree|say)|where did we leave|can i resume|last (decision|state|session)|pick up where)\b/i.test(text);
  if (privateContextSignal) {
    return {
      mode: 'context',
      label: RESPONSE_MODE_LABELS.context,
      contextTimeoutMs: CHAT_CONTEXT_RICH_TIMEOUT_MS,
      reason: hasFiles ? 'attachment' : hasTopic ? 'topic' : identityContextSignal ? 'identity_context' : 'private_context',
    };
  }

  return {
    mode: 'fast',
    label: RESPONSE_MODE_LABELS.fast,
    contextTimeoutMs: CHAT_CONTEXT_TIMEOUT_MS,
    reason: 'default',
  };
}

function applyModelLaneFloor(responseMode, modelKey) {
  const modelMode = MODEL_LANE_RESPONSE_MODE[chatModelLaneKey(modelKey)] || 'fast';
  if ((RESPONSE_MODE_TIER[modelMode] || 0) <= (RESPONSE_MODE_TIER[responseMode.mode] || 0)) {
    return responseMode;
  }
  return {
    ...responseMode,
    mode: modelMode,
    label: RESPONSE_MODE_LABELS[modelMode],
    contextTimeoutMs: modeBudget(modelMode),
    reason: `${responseMode.reason || 'default'}+model_${modelMode}`,
  };
}

async function optionalEnrichment(name, {
  faults = new Set(),
  timeoutMs = 0,
  fallback = null,
  onTiming = null,
  onEnrichment = null,
} = {}, fn) {
  const started = Date.now();
  if (hasEnrichmentFault(faults, name)) {
    emitTiming(onTiming, `enrichment.${name}.fault`, 0);
    emitEnrichment(onEnrichment, { layer: name, status: 'fault', ms: 0 });
    return fallback;
  }

  let task;
  if (hasSlowEnrichmentFault(faults, name)) {
    const delay = timeoutMs > 0 ? timeoutMs + 1_000 : 60_000;
    task = sleepUnref(delay).then(() => fallback);
  } else {
    task = Promise.resolve().then(fn);
  }
  task.catch(() => {});

  try {
    if (timeoutMs > 0) {
      const timedOut = Symbol(`${name}:timeout`);
      const timeout = sleep(timeoutMs).then(() => timedOut);
      const value = await Promise.race([task, timeout]);
      if (value === timedOut) {
        const ms = Date.now() - started;
        emitTiming(onTiming, `enrichment.${name}.timeout`, ms);
        emitEnrichment(onEnrichment, { layer: name, status: 'timeout', ms });
        return fallback;
      }
      const ms = Date.now() - started;
      if (ms > timeoutMs) {
        emitTiming(onTiming, `enrichment.${name}.timeout`, ms);
        emitEnrichment(onEnrichment, { layer: name, status: 'timeout', ms });
        return fallback;
      }
      emitTiming(onTiming, `enrichment.${name}.ok`, ms);
      emitEnrichment(onEnrichment, { layer: name, status: 'ok', ms });
      return value;
    }

    const value = await task;
    const ms = Date.now() - started;
    emitTiming(onTiming, `enrichment.${name}.ok`, ms);
    emitEnrichment(onEnrichment, { layer: name, status: 'ok', ms });
    return value;
  } catch (err) {
    console.warn(`[chat] optional enrichment ${name} failed:`, err.message);
    const ms = Date.now() - started;
    emitTiming(onTiming, `enrichment.${name}.error`, ms);
    emitEnrichment(onEnrichment, { layer: name, status: 'error', ms });
    return fallback;
  }
}

function minimalSystemBlocks({ systemPrompt = null, belt = 'white', useTools = false } = {}) {
  let system = systemPrompt || ROBOTDOJO_BRAND_PROMPT;
  // st_df0a8d71 AC-7 — honest degradation, replacing the old instruction that
  // told the model to HIDE context failures ("never explain retrieval or
  // internal context failures"). This path only runs when the cached personal
  // context failed to assemble; the model must say so when personal facts are
  // requested, not improvise them.
  system += '\n\nEvery answer should be at least as useful as sending the user message directly to the model. Robot Dojo context is additive: use it when present. This turn is running WITHOUT the usual personal context layers. If the user asks about personal, family, or private-world facts, say plainly that their personal context did not load this turn and offer to retry — never guess or invent personal facts.';
  if (useTools) {
    system += '\n\nTools are available on this request. Use them only when the user clearly asks for an action.';
  } else {
    system += '\n\nYou have no tools available on this request. Answer directly. Never invent tool calls or write fake tool-use markup.';
  }
  system += belt === 'black'
    ? '\n\nCURRENT BELT: Black.'
    : '\n\nCURRENT BELT: White.';
  return [{ type: 'text', text: system }];
}

// st_df0a8d71 AC-7 — per-turn who-is-who presence. Presence is judged against
// the ACTUAL assembled blocks (the header marker must be in the bytes going to
// the model), never against the memo state — a warm memo that failed to land
// in the prompt is still an absence. Absence warns loudly AND emits an
// `ego_block` enrichment event the route persists to chat_turn_metrics.
function reportEgoPresence(blocks, onEnrichment) {
  let present = false;
  try {
    present = (blocks || []).some((b) => String(b?.text || '').includes(EGO_BLOCK_HEADER));
  } catch { /* presence check must never break assembly */ }
  const chars = present ? getEgoBlockInfo().chars : 0;
  emitEnrichment(onEnrichment, { layer: 'ego_block', status: present ? 'ok' : 'missing', ms: 0, chars });
  if (!present) {
    console.warn('[chat] who-is-who ego block ABSENT from the system prompt this turn — graph truth is not riding the cached prefix');
  }
  return blocks;
}

function assembleChatSystemBlocks(opts, { faults = new Set(), onTiming = null, onEnrichment = null } = {}) {
  const started = Date.now();
  if (hasEnrichmentFault(faults, 'stable_context')) {
    emitTiming(onTiming, 'enrichment.stable_context.fault', 0);
    emitEnrichment(onEnrichment, { layer: 'stable_context', status: 'fault', ms: 0 });
    return reportEgoPresence(minimalSystemBlocks(opts), onEnrichment);
  }
  try {
    const blocks = assembleCachedSystemBlocks(opts, db);
    const ms = Date.now() - started;
    emitTiming(onTiming, 'enrichment.stable_context.ok', ms);
    emitEnrichment(onEnrichment, { layer: 'stable_context', status: 'ok', ms });
    return reportEgoPresence(blocks, onEnrichment);
  } catch (err) {
    console.warn('[chat] cached system context failed:', err.message);
    const ms = Date.now() - started;
    emitTiming(onTiming, 'enrichment.stable_context.error', ms);
    emitEnrichment(onEnrichment, { layer: 'stable_context', status: 'error', ms });
    return reportEgoPresence(minimalSystemBlocks(opts), onEnrichment);
  }
}

/**
 * Assemble a char-capped rolling text window from the trailing conversation
 * turns. Concatenates the textual content of the last N user/assistant turns,
 * newest-last, capping total length so recognition stays cheap.
 */
function buildRecognitionWindow(messages) {
  const tail = messages.slice(-RECOGNITION_WINDOW_TURNS);
  const parts = [];
  for (const m of tail) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter(b => b?.type === 'text').map(b => b.text || '').join(' ')
        : '';
    if (text.trim()) parts.push(text);
  }
  return parts.join('\n').slice(-RECOGNITION_WINDOW_CHARS);
}

export function requiresSourceBoundContext(query) {
  const text = String(query || '').toLowerCase();
  if (!text.trim()) return false;
  return /\b(use|using|from|based on|according to|ground(ed)? in)\b.{0,80}\b(source|sources|context|my data|memory|notes|documents|docs)\b/.test(text)
    || /\b(source|sources|cite|citation|citations|evidence|retrieval|rag|ann|vector search|launch stoplight|retrieval sentinel)\b/.test(text)
    || /\bwhat does (my|the|current)\b.{0,80}\b(context|memory|sources|stoplight)\b/.test(text);
}

export function requiresOperationalStatusContext(query) {
  const text = String(query || '').toLowerCase();
  if (!text.trim()) return false;
  return /\b(data pipeline|pipeline status|embedding|embeddings|embedder|embed daemon|embedding drain|post[- ]?drain|drain backlog|work[- ]?order|vector search|global ann|ann|hnsw|retrieval degraded|degraded retrieval|retrieval status|launch stoplight|retrieval sentinel)\b/.test(text);
}

function sourceBoundEvidenceGuard() {
  return [
    '## Source-bound answer rule',
    'The user explicitly asked for Robot Dojo sources, context, retrieval, evidence, or current source-backed state.',
    'Answer only from high-confidence retrieved chunks, Memory continuity, Topic context, Entity profile/interaction sections, Live operational status, or explicit conversation text.',
    'Entity profile/interaction sections are evidence only for the facts they directly state: local entity existence, relationship tier, identifiers, interaction counts, recency, and generated entity summaries.',
    'Do not use an entity/profile card as evidence for a source/status/process question unless that card directly contains the requested fact.',
    'If the context below does not contain the requested fact, say that source retrieval did not return evidence for it instead of guessing.',
  ].join('\n');
}

function sourceBoundTimeoutContext(query) {
  return [
    '## Source-bound context status',
    `Full source retrieval was not available inline for: ${String(query || '').slice(0, 240)}`,
    'Do not answer from fast entity fallback, general knowledge, or a similarly named entity. State that source retrieval did not return evidence. If the user wants a deeper pass, say a deep context pass can be retried.',
  ].join('\n\n');
}

function sourceBoundLocalContextStatus(query) {
  return [
    '## Source-bound context status',
    `Full document/vector retrieval was not available inline for: ${String(query || '').slice(0, 240)}`,
    'A bounded local entity/memory pass did return high-confidence local context below. Use it for facts it directly states. If the requested detail requires documents/messages/chunks not shown below, say source retrieval did not return that detail.',
    'If the bounded local context names the exact person, company, or place the user asked about, do not deny that entity exists because full document/vector retrieval was degraded or a prior turn mentioned a similarly named entity.',
  ].join('\n\n');
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function countValue(database, sql, params = []) {
  try {
    return Number(database.prepare(sql).get(...params)?.n || 0);
  } catch {
    return null;
  }
}

function annOperationalStatus(database) {
  const annDir = process.env.ROBOTDOJO_ANN_DIR || join(homedir(), '.robotdojo-ann');
  const sidecarPath = join(annDir, 'sidecar.json');
  const hotPath = join(annDir, 'hot.usearch');
  const fullPath = join(annDir, 'full.usearch');
  const lockPath = join(annDir, 'sidecar.json.building');
  const sidecar = readJsonSafe(sidecarPath);
  const hotRequired = Number(sidecar?.hot_size || 0) > 0;
  const fullExists = existsSync(fullPath);
  const hotExists = existsSync(hotPath);
  const lockExists = existsSync(lockPath);
  const liveEmbedded = countValue(database, `
    SELECT COUNT(*) AS n
    FROM chunks
    WHERE COALESCE(embedded, 0) = 1
  `);
  const builtFrom = Number(sidecar?.built_from_count || 0);
  const fullSize = Number(sidecar?.full_size || 0);
  const dim = Number(sidecar?.dim || 0);
  let reason = 'ready';
  if (!sidecar) reason = 'missing_sidecar';
  else if (!fullExists) reason = 'missing_full_index';
  else if (hotRequired && !hotExists) reason = 'missing_hot_index';
  else if (dim !== 1024) reason = 'dimension_mismatch';
  else if (fullSize <= 0 || builtFrom <= 0) reason = 'empty_or_unbuilt_sidecar';
  else if (Number.isFinite(liveEmbedded) && liveEmbedded !== builtFrom) reason = 'ann_corpus_drift';
  const ready = reason === 'ready';
  return {
    ready,
    state: ready ? 'ready' : (lockExists ? 'repairing' : 'degraded'),
    reason,
    liveEmbedded,
    builtFrom: builtFrom || null,
  };
}

export function buildOperationalStatusContext(query, database = db) {
  if (!requiresOperationalStatusContext(query)) return '';
  const pending = countValue(database, `
    SELECT COUNT(*) AS n
    FROM chunks
    WHERE COALESCE(embedded, 0) = 0
      AND COALESCE(skip_embed, 0) = 0
  `);
  const personalPending = countValue(database, `
    SELECT COUNT(*) AS n
    FROM chunks
    WHERE topic = 'personal'
      AND COALESCE(embedded, 0) = 0
      AND COALESCE(skip_embed, 0) = 0
  `);
  const nonPersonalPending = countValue(database, `
    SELECT COUNT(*) AS n
    FROM chunks
    WHERE COALESCE(topic, '') != 'personal'
      AND COALESCE(embedded, 0) = 0
      AND COALESCE(skip_embed, 0) = 0
  `);
  const needsRoutingMemory = countValue(database, `
    SELECT COUNT(*) AS n
    FROM memory_event_links
    WHERE target_type = 'topic'
      AND target_id = ?
      AND role IN ('needs-routing', 'scope')
  `, [NEEDS_ROUTING_TOPIC]);
  let head = [];
  try {
    head = computeWorkOrder(database, {
      longInputChars: EMBED_LONG_INPUT_CHARS,
      valueRankFloor: VALUE_RANK_ENTITY_FLOOR,
    }).slice(0, 3);
  } catch {
    head = [];
  }
  const postDrain = readJsonSafe(resolve(process.env.ROBOTDOJO_CONFIG || join(homedir(), '.robotdojo'), 'runtime', 'post-embedding-drain-pipeline.json'));
  const ann = annOperationalStatus(database);
  const phase = pending === 0
    ? (postDrain?.status === 'complete' ? 'complete' : `post-drain ${postDrain?.status || 'waiting'}`)
    : 'draining';
  const headLine = head.length
    ? head.map((entry) => `${entry.topic}: pending=${entry.pending}, priority=${entry.priority}, short=${entry.shortPending}, long=${entry.longPending}`).join('; ')
    : 'no ordered head available';
  const retrievalLine = ann.ready
    ? `Global ANN fast path is ready against ${ann.builtFrom} embedded chunks.`
    : `Retrieval is degraded: global ANN fast path is ${ann.state} (${ann.reason}); chat may still answer through local sqlite-vec/FTS/topic/entity fallback, but must not claim ANN/global vector retrieval is nominal.`;
  return [
    '## Live Robot Dojo operational status',
    'Use this live local status over older topic/workbench context when the user asks about embeddings, retrieval, degradation, or the data pipeline.',
    `Checked at: ${new Date().toISOString()}`,
    'Chat foreground dependency on embedding drain: n/a. Chat must answer during any embedding/import process; background work may improve later context, but it must not block the turn.',
    `Data pipeline phase: ${phase}`,
    `Pending embeddable chunks: ${pending ?? 'unknown'} total; Personal pending: ${personalPending ?? 'unknown'}; non-Personal pending: ${nonPersonalPending ?? 'unknown'}.`,
    `Embedding work-order head: ${headLine}.`,
    `Needs-routing current memory links: ${needsRoutingMemory ?? 'unknown'}; post-drain memory refocus/recalc is still required while this remains high.`,
    retrievalLine,
  ].join('\n');
}

function* chunkLocalAnswer(text) {
  const body = String(text || '');
  for (let i = 0; i < body.length; i += LOCAL_ANSWER_CHUNK_CHARS) {
    yield body.slice(i, i + LOCAL_ANSWER_CHUNK_CHARS);
  }
}

async function* withFirstDeltaPrelude(source, {
  delayMs = MODEL_PRELUDE_MS,
  text = MODEL_PRELUDE_TEXT,
} = {}) {
  const iterator = source[Symbol.asyncIterator]();
  const deadline = Date.now() + Math.max(0, delayMs);
  let firstDeltaSeen = false;
  let preludeSent = false;

  while (true) {
    if (!firstDeltaSeen && !preludeSent && Date.now() >= deadline) {
      preludeSent = true;
      yield { type: 'prelude', text };
    }

    let result;
    if (!firstDeltaSeen && !preludeSent) {
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        const preludePromise = sleep(remaining).then(() => ({ prelude: true }));
        const nextPromise = iterator.next();
        const raced = await Promise.race([
          nextPromise.then((value) => ({ value })),
          preludePromise,
        ]);
        if (raced.prelude) {
          preludeSent = true;
          yield { type: 'prelude', text };
          result = await nextPromise;
        } else {
          result = raced.value;
        }
      } else {
        result = await iterator.next();
      }
    } else {
      result = await iterator.next();
    }

    if (result.done) return;
    if (result.value?.type === 'delta') firstDeltaSeen = true;
    yield result.value;
  }
}

function composeWithAmbientFloor(belt, overlayContext, overlayTrace) {
  const ambient = peekAmbientLayeredContext(belt);
  if (!ambient) {
    return { context: overlayContext || '', trace: overlayTrace || null };
  }
  const context = [ambient, overlayContext].filter(Boolean).join('\n\n');
  return {
    context,
    trace: {
      ...(overlayTrace || {}),
      present: true,
      cache_hit: true,
      timeout: false,
      tier: 'ambient_prewarm',
      chars: context.length,
      sections: ['ambient_prewarm', ...((overlayTrace && overlayTrace.sections) || [])],
    },
  };
}

async function loadLayeredContextForChat(query, opts = {}) {
  const faults = normalizeEnrichmentFaults(opts.enrichmentFaults);
  const sourceBound = opts.sourceBoundContext ?? requiresSourceBoundContext(query);
  const responseMode = opts.responseMode || (sourceBound ? 'deep' : 'fast');
  const responseModeReason = opts.responseModeReason || null;
  const contextTimeoutMs = Number.isFinite(Number(opts.contextTimeoutMs))
    ? Math.max(0, Math.round(Number(opts.contextTimeoutMs)))
    : modeBudget(responseMode);
  const operationalContext = buildOperationalStatusContext(query);
  let cached = null;
  if (!hasEnrichmentFault(faults, 'cache') && !hasEnrichmentFault(faults, 'rag')) {
    try {
      cached = peekCachedLayeredContext(query, opts);
      emitEnrichment(opts.onEnrichment, { layer: 'cache', status: cached !== null ? 'ok' : 'miss', ms: 0 });
    } catch (err) {
      console.warn('[chat] cached layered context failed:', err.message);
      emitEnrichment(opts.onEnrichment, { layer: 'cache', status: 'error', ms: 0 });
      cached = null;
    }
  } else if (hasEnrichmentFault(faults, 'cache')) {
    emitEnrichment(opts.onEnrichment, { layer: 'cache', status: 'fault', ms: 0 });
  }
  if (cached !== null) {
    if (typeof opts.onHits === 'function') {
      try { opts.onHits(0); } catch {}
    }
    return [
      sourceBound ? sourceBoundEvidenceGuard() : '',
      operationalContext,
      cached,
    ].filter(Boolean).join('\n\n');
  }

  if (hasEnrichmentFault(faults, 'rag')) {
    emitEnrichment(opts.onEnrichment, { layer: 'rag', status: 'fault', ms: 0 });
    if (typeof opts.onContextTrace === 'function') {
      try {
        opts.onContextTrace({
          present: false,
          cache_hit: false,
          timeout: true,
          tier: null,
          chars: 0,
          sections: [],
          source_types: [],
          target_types: [],
          event_types: [],
        });
      } catch {}
    }
    if (typeof opts.onHits === 'function') {
      try { opts.onHits(0); } catch {}
    }
    return operationalContext;
  }

  // Context mode may use already-hot full context from the cache above, but it
  // must not start cold full RAG inline. Some retrieval paths do synchronous DB
  // work, so a JS timeout cannot reliably interrupt them once started. Reserve
  // cold full RAG for explicit deep/source turns; normal context turns fall back
  // to bounded fast memory/entity context when the rich layer is not ready.
  const canAttemptFullContext = !hasEnrichmentFault(faults, 'rag')
    && !hasSlowEnrichmentFault(faults, 'rag')
    && responseMode === 'deep'
    && (opts.allowInlineDeepRag === true || CHAT_DEEP_INLINE_RAG_ENABLED);
  if (canAttemptFullContext) {
    const fullContext = await optionalEnrichment(
      'rag',
      {
        faults,
        timeoutMs: contextTimeoutMs,
        fallback: '',
        onTiming: opts.onTiming,
        onEnrichment: opts.onEnrichment,
      },
      () => cachedBuildLayeredContext(query, opts),
    );
    if (fullContext) {
      if (typeof opts.onHits === 'function') {
        try { opts.onHits(0); } catch {}
      }
      return [
        sourceBound ? sourceBoundEvidenceGuard() : '',
        operationalContext,
        fullContext,
      ].filter(Boolean).join('\n\n');
    }
  } else if (responseMode === 'deep') {
    emitTiming(opts.onTiming, 'enrichment.rag.skip', 0);
    emitEnrichment(opts.onEnrichment, { layer: 'rag', status: 'skip', ms: 0 });
  }

  if (sourceBound) {
    if (typeof opts.onTiming === 'function') {
      try { opts.onTiming({ phase: 'context.source_bound_cache_miss', ms: 0 }); } catch {}
    }
    const fastContextFault = hasEnrichmentFault(faults, 'fast_context')
      || hasEnrichmentFault(faults, 'rag');
    const emptyFallback = {
      context: '',
      trace: {
        present: false,
        cache_hit: false,
        timeout: fastContextFault,
        tier: null,
        chars: 0,
        sections: [],
        source_types: [],
        target_types: [],
        event_types: [],
      },
    };
    const fallback = await optionalEnrichment(
      'fast_context',
      {
        faults,
        timeoutMs: contextTimeoutMs,
        fallback: emptyFallback,
        onTiming: opts.onTiming,
        onEnrichment: opts.onEnrichment,
      },
      () => fastContextFault
        ? sleepUnref(contextTimeoutMs + 1_000).then(() => emptyFallback)
        : buildFastTimeoutContextSmart(query, {
          belt: opts.belt,
          onTiming: opts.onTiming,
          entityDetectionText: opts.entityDetectionText,
          enrichmentFaults: faults,
          layerTimeoutMs: Math.max(10, Math.min(contextTimeoutMs - 50, responseMode === 'fast' ? 250 : 600)),
        }, { budgetMs: contextTimeoutMs }),
    );
    if (fallback?.trace?.sections?.includes('fast_memory_facts')) {
      emitEnrichment(opts.onEnrichment, { layer: 'fast_memory', status: 'ok', ms: 0 });
    }
    if (fallback?.trace?.sections?.includes('fast_entities')) {
      emitEnrichment(opts.onEnrichment, { layer: 'fast_entities', status: 'ok', ms: 0 });
    }
    const packed = composeWithAmbientFloor(opts.belt, fallback?.context, fallback?.trace);
    if (typeof opts.onContextTrace === 'function') {
      try { opts.onContextTrace(packed.trace); } catch {}
    }
    if (typeof opts.onHits === 'function') {
      try { opts.onHits(0); } catch {}
    }
    return [
      sourceBoundEvidenceGuard(),
      operationalContext,
      packed.context ? sourceBoundLocalContextStatus(query) : sourceBoundTimeoutContext(query),
      packed.context || '',
    ].filter(Boolean).join('\n\n');
  }

  const fastContextFault = hasEnrichmentFault(faults, 'fast_context')
    || hasEnrichmentFault(faults, 'rag');
  const emptyFallback = {
    context: '',
    trace: {
      present: false,
      cache_hit: false,
      timeout: fastContextFault,
      tier: null,
      chars: 0,
      sections: [],
      source_types: [],
      target_types: [],
      event_types: [],
    },
  };
  const fallback = await optionalEnrichment(
    'fast_context',
    {
      faults,
      timeoutMs: contextTimeoutMs,
      fallback: emptyFallback,
      onTiming: opts.onTiming,
      onEnrichment: opts.onEnrichment,
    },
    () => fastContextFault
      ? sleepUnref(contextTimeoutMs + 1_000).then(() => emptyFallback)
      : buildFastTimeoutContextSmart(query, {
        belt: opts.belt,
        onTiming: opts.onTiming,
        entityDetectionText: opts.entityDetectionText,
        enrichmentFaults: faults,
        layerTimeoutMs: Math.max(10, Math.min(contextTimeoutMs - 50, responseMode === 'fast' ? 250 : 600)),
      }, { budgetMs: contextTimeoutMs }),
  );
  if (fallback?.trace?.sections?.includes('fast_memory_facts')) {
    emitEnrichment(opts.onEnrichment, { layer: 'fast_memory', status: 'ok', ms: 0 });
  } else if (hasEnrichmentFault(faults, 'fast_memory') || hasSlowEnrichmentFault(faults, 'fast_memory')) {
    emitEnrichment(opts.onEnrichment, {
      layer: 'fast_memory',
      status: hasSlowEnrichmentFault(faults, 'fast_memory') ? 'timeout' : 'fault',
      ms: contextTimeoutMs,
    });
  }
  if (fallback?.trace?.sections?.includes('fast_entities')) {
    emitEnrichment(opts.onEnrichment, { layer: 'fast_entities', status: 'ok', ms: 0 });
  } else if (hasEnrichmentFault(faults, 'fast_entities') || hasSlowEnrichmentFault(faults, 'fast_entities')) {
    emitEnrichment(opts.onEnrichment, {
      layer: 'fast_entities',
      status: hasSlowEnrichmentFault(faults, 'fast_entities') ? 'timeout' : 'fault',
      ms: contextTimeoutMs,
    });
  }
  const packed = composeWithAmbientFloor(opts.belt, fallback.context, fallback.trace);
  if (typeof opts.onContextTrace === 'function') {
    try { opts.onContextTrace(packed.trace); } catch {}
  }
  if (typeof opts.onHits === 'function') {
    try { opts.onHits(0); } catch {}
  }
  const result = packed.context;
  return [
    operationalContext,
    result,
  ].filter(Boolean).join('\n\n');
}

// Per-thread last-seen model. Used by emitModelChangeIfChanged to detect
// model switches without persisting state in the DB. A server restart
// resets this; the boot warmup re-primes the previously-active provider
// via the boot path, so a "lost" state here costs at most one warm
// handshake — acceptable.
const _lastModelByThread = new Map();

// Extract provider from a resolved model id. Anthropic ids start with
// 'claude-', Google with 'gemini-', OpenAI with 'gpt-' or 'o', xAI with
// 'grok-', Mistral with 'mistral-' or 'open-mistral'.
function _providerFromModel(modelId) {
  return providerNameForModelId(modelId);
}

/**
 * Emit `model-change` on appEvents when the model for this thread
 * differs from the prior turn. No-op for the first turn of a thread
 * (boot warmup already primed the default provider).
 *
 * WHY threadId-keyed: a single browser session can have many threads
 * (sidebar conversations), each with its own active model. Cross-thread
 * model switches deserve their own warmup; same-model continuations
 * across threads don't.
 *
 * @param {object} args
 * @param {string|null} args.threadId
 * @param {string} args.model
 */
function emitModelChangeIfChanged({ threadId, model }) {
  if (!threadId || !model) return;
  const prev = _lastModelByThread.get(threadId);
  _lastModelByThread.set(threadId, model);
  if (!prev || prev === model) return;
  try {
    appEvents.emit('model-change', {
      provider: _providerFromModel(model),
      model,
      prev_model: prev,
      source: 'chat-orchestrator',
    });
  } catch (err) {
    // Defensive — appEvents should not throw, but if a buggy subscriber
    // does we must not break chat.
    console.warn('[chat] model-change emit failed:', err.message);
  }
}

// Test hook — clear per-thread state between unit tests.
export function _resetModelChangeState() {
  _lastModelByThread.clear();
}

/**
 * Build legacy RAG context string for a query. Public for older callers
 * that need raw RAG text without the full layered chat context stack.
 */
export async function buildContext(query, topic = null) {
  const limit = 15;
  let results;

  try {
    results = topic
      ? await search(query, { topic, limit })
      : await searchAll(query, { limit });
  } catch (err) {
    console.error('[chat] RAG search failed:', err.message);
    return null;
  }

  if (!results.length) return null;

  const charCap = RAG_TOKEN_CAP * CHARS_PER_TOKEN;
  let context = '';
  let charBudget = charCap;
  const topics = new Set();
  let chunkCount = 0;

  for (const r of results) {
    if (charBudget <= 0) break;

    const meta = r.metadata;
    const header = meta.title
      ? `[${r.source_type}: ${meta.title}]`
      : `[${r.source_type}]`;
    const entry = `${header}\n${r.content}\n\n`;

    if (entry.length <= charBudget) {
      context += entry;
      charBudget -= entry.length;
      topics.add(r.topic);
      chunkCount++;
    }
  }

  if (!chunkCount) return null;

  const manifest = [
    `Here is relevant context from your personal data:`,
    `- ${chunkCount} chunks across ${topics.size} topic(s): ${[...topics].join(', ')}`,
    `- ~${Math.round((charCap - charBudget) / CHARS_PER_TOKEN)} tokens of context\n`,
  ].join('\n');

  return manifest + '\n' + context;
}

/**
 * Stream chat response with tool use support.
 *
 * Yields:
 *   { type: 'delta', text }
 *   { type: 'tool_start', name, args }
 *   { type: 'tool_done', name, result }
 *   { type: 'thinking', text } — context-router intermediate label
 *   { type: 'entity_recognized', entities } — inline recognition (Black Belt; st_f1a40461 AC9)
 *
 * @param {Array<{role: string, content: string|Array}>} messages
 * @param {object} options - see destructured list below
 */
export async function* streamChat(messages, options = {}) {
  const {
    topic = null,
    systemPrompt = null,
    injectedContext = null,
    maxTokens = 4096,
    useRag = true,
    belt = 'white',
    useTools = false,
    sessionId: _sessionId = null,
    threadId = null,
    source = 'robotdojo',
    // st_8c7b7a6b D1 — default OFF. Haiku context-router added ~1s to the
    // critical path with zero quality lift because topic is already known
    // from the active thread / UI selection. Callers that still want LLM
    // routing must pass `useRouter: true` explicitly.
    useRouter = false,
    files = [],
    // Server lifecycle hook (st_74f45a1a) — fired at meaningful moments so
    // routes/chat.js can forward as `phase` SSE frames to the indicator.
    onPhase = null,
    // Observability hook (st_74f45a1a R2) — fires at first delta + completion
    // so the route can persist real usage / cache_token counters in
    // chat_turn_metrics. firstToken() and completion({usage, response_model}).
    onMetric = null,
    // Diagnostic timing observer (st_fd14cdd4). Optional ({phase, ms}) => void
    // callback the route wires to the env-gated entry-trace stderr line. Lets a
    // measurement run attribute the per-layer / per-phase ms of a real warm turn
    // without changing behavior. Off in production (the route only passes it
    // when ROBOTDOJO_CHAT_ENTRY_TRACE=1), so this is zero-cost when disabled.
    onTiming = null,
    onEnrichment = null,
    onContextTrace = null,
    enrichmentFaults = null,
    // Conversation id — load-bearing for topic-scoped RAG (st_74f45a1a R2).
    // Null is still safe: layered context bounds no-topic chat to ambient
    // general rather than re-enabling broad topic fan-out.
    conversation_id = null,
    // Owner partition for the cached layered context (st_74f45a1a R2). null
    // → 'anon' bucket. Routes pass the authenticated user id.
    user_id = null,
    sessionUserTurn = 1,
    writingFreeze = false,
    writingGetClient = null,
  } = options;

  const faults = normalizeEnrichmentFaults(enrichmentFaults);
  let requestedModel = options.model || config.models.chat;
  let model = resolveChatModelId(requestedModel);
  const toolCtx = { belt, sessionId: _sessionId, conversation_id: options.conversation_id || null };

  // st_566ad80b — emit `model-change` when the model for this thread
  // differs from what we last saw. The warmup module subscribes and
  // fires a 1-token ping against the new provider within 100 ms (AC 10)
  // so the next turn doesn't pay the cold-handshake tax.
  //
  // WHY here (orchestration layer, not route): /api/chat/stream is a
  // thin facade — we want the trigger to fire regardless of which
  // route called us (chat.js, public-chat.js, threads endpoint, ...).
  // The per-thread last-model map is in-process (a server restart
  // resets it, but the boot warmup re-primes the previously-active
  // provider anyway).
  const emitPhase = (name, payload = null) => {
    if (typeof onPhase === 'function') {
      try { onPhase(name, payload); } catch { /* observability never breaks chat */ }
    }
  };

  // Session-log the latest user message. Fire-and-forget — logging must
  // never block chat response.
  const lastUserMessage = [...messages].reverse().find(m =>
    m.role === 'user' && typeof m.content === 'string',
  );
  if (threadId && lastUserMessage) {
    logTurn({ threadId, role: 'user', content: lastUserMessage.content, source })
      .catch((err) => console.warn('[session-log] user turn failed:', err.message));
  }

  // Accumulator for assistant text so we can log it after streaming.
  const assistantTextBuf = [];
  const responseMode = applyModelLaneFloor(classifyChatResponseMode({
    query: lastUserMessage?.content || '',
    topic,
    files,
    injectedContext,
    requestedMode: options.mode === 'deep' || options.mode === 'fast' ? options.mode : null,
  }), requestedModel);
  const modelPolicy = productizedChatModelForMode(requestedModel, responseMode.mode);
  if (modelPolicy.changed) {
    emitEnrichment(onEnrichment, {
      layer: 'model_policy',
      status: 'fallback',
      ms: 0,
    });
    requestedModel = modelPolicy.model;
    model = resolveChatModelId(requestedModel);
  }
  emitModelChangeIfChanged({ threadId, model });
  emitEnrichment(onEnrichment, {
    layer: 'response_mode',
    status: responseMode.mode,
    ms: 0,
  });

  // st_df0a8d71 QA fix — reverse-direction relationship questions ("Who is my
  // mother-in-law?") answer from the GRAPH deterministically, BEFORE the
  // direct-entity card path (which the live defect showed can surname-match
  // an unrelated contact and serve their card). Closed vocabulary; unmatched
  // questions flow onward. Mirrors the routes/chat.js branch so the sync and
  // thread paths carry the same guarantee.
  if (lastUserMessage) {
    const relationshipQuestion = parseRelationshipQuestion(lastUserMessage.content);
    const graphAnswer = relationshipQuestion ? answerRelationshipQuestion(db, relationshipQuestion) : null;
    // matched:'flow' = forward question about an untagged person — fall
    // through to the card/model paths (parity with routes/chat.js).
    if (relationshipQuestion && graphAnswer.matched !== 'flow') {
      yield { type: 'local_answer', model: 'local-graph-answer' };
      for (const text of chunkLocalAnswer(graphAnswer.text)) {
        if (threadId) assistantTextBuf.push(text);
        yield { type: 'delta', text };
      }
      if (threadId && assistantTextBuf.length) {
        logTurn({ threadId, role: 'assistant', content: assistantTextBuf.join(''), source })
          .catch((err) => console.warn('[session-log] assistant turn failed:', err.message));
      }
      return;
    }
  }

  if (lastUserMessage) {
    const direct = await optionalEnrichment(
      'direct_entity',
      {
        faults,
        timeoutMs: DIRECT_ENTITY_TIMEOUT_MS,
        fallback: null,
        onTiming,
        onEnrichment,
      },
      () => buildDirectEntityAnswerSmart(lastUserMessage.content, {
        belt,
        onTiming,
      }, { budgetMs: DIRECT_ENTITY_TIMEOUT_MS }),
    );
    if (direct?.text) {
      if (direct.entity) yield { type: 'entity_recognized', entities: [direct.entity] };
      yield { type: 'local_answer', model: 'local-entity-card' };
      for (const text of chunkLocalAnswer(direct.text)) {
        if (threadId) assistantTextBuf.push(text);
        yield { type: 'delta', text };
      }
      if (threadId && assistantTextBuf.length) {
        logTurn({ threadId, role: 'assistant', content: assistantTextBuf.join(''), source })
          .catch((err) => console.warn('[session-log] assistant turn failed:', err.message));
      }
      return;
    }
  }

  if (writingFreeze && lastUserMessage) {
    try {
      for await (const event of streamFrozenTurn({
        userText: lastUserMessage.content,
        surface: 'web',
        host: 'web',
        sessionKey: String(conversation_id || threadId || 'web'),
        getClient: writingGetClient,
        persist: false,
      })) {
        if (event.type === 'delta' && threadId) assistantTextBuf.push(event.text);
        yield event;
      }
      if (threadId && assistantTextBuf.length) {
        logTurn({ threadId, role: 'assistant', content: assistantTextBuf.join(''), source })
          .catch((err) => console.warn('[session-log] assistant turn failed:', err.message));
      }
      return;
    } catch (err) {
      console.warn('[writing-freeze] incomplete:', err.message);
      yield { type: 'error', error: 'incomplete', text: 'Writing did not complete.' };
      return;
    }
  }

  // Context router — runs once per user turn. Produces the identity + topic
  // block and emits a thinking-indicator string.
  let routerBlock = '';
  let thinkingText = null;
  if (useRouter && lastUserMessage && !CHAT_ROUTER_FOREGROUND_ENABLED) {
    emitTiming(onTiming, 'enrichment.router.skip', 0);
    emitEnrichment(onEnrichment, { layer: 'router', status: 'skip', ms: 0 });
  }
  if (useRouter && lastUserMessage && CHAT_ROUTER_FOREGROUND_ENABLED) {
    try {
      const history = messages.slice(-6).map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
      const routed = await optionalEnrichment(
        'router',
        {
          faults,
          timeoutMs: ROUTER_TIMEOUT_MS,
          fallback: null,
          onTiming,
          onEnrichment,
        },
        () => routeContext({
          userMessage: lastUserMessage.content,
          threadId,
          history,
          activeTopic: topic,
        }),
      );
      routerBlock = routed?.systemPrompt || '';
      thinkingText = routed?.thinkingText || null;
    } catch (err) {
      console.warn('[context-router] route failed:', err.message);
    }
  }
  if (thinkingText) {
    yield { type: 'thinking', text: thinkingText };
  }

  // Assemble the byte-stable CACHED prefix as ordered cache_control blocks
  // (st_2cd1af73 AC-1): Block A generic product prompt, Block B identity card,
  // Block C topic context. These are identical across every turn of a
  // conversation, so Anthropic writes one cache entry and later turns read it
  // (the chat model's 4096-token cache floor is cleared by A+B+C on a
  // topic-scoped Black turn). The VOLATILE layered RAG/entity/health tail is
  // appended below WITHOUT cache_control so it can vary per turn without
  // invalidating the cached prefix.
  emitPhase('assembling_context', {
    label: responseMode.label,
    mode: responseMode.mode,
    lane: RESPONSE_MODE_LANE[responseMode.mode] || 'ask',
    model: requestedModel,
    modelId: model,
    targetTtftMs: CHAT_MODEL_LANES[RESPONSE_MODE_LANE[responseMode.mode] || 'ask']?.targetTtftMs || 0,
  });
  let systemBlocks = assembleChatSystemBlocks(
    { systemPrompt, belt, topic, routerBlock, injectedContext, useTools },
    { faults, onTiming, onEnrichment },
  );

  // Layered RAG/health/calendar/entity context appended as a NON-cacheable
  // tail block. We pass skipIdentityLayer/skipTopicLayer because identity and
  // topic are already in the cached prefix above (Blocks B and C) — the layered
  // build emits the VOLATILE remainder only, so nothing is duplicated and the
  // stable content stays in the cached region. Basic/no-topic chat still gets
  // honest bounded RAG and Black Belt entity recognition from this path; the
  // no-topic fan-out guard still lives inside chat-context.js.
  if (useRag && messages.length > 0) {
    const lastUserMsg = [...messages].reverse().find(m =>
      m.role === 'user' && typeof m.content === 'string',
    );
    if (lastUserMsg) {
      emitPhase('searching_memory');
      // R2 Phase 1D — once retrieve() returns, refresh the indicator with
      // the actual hit count so the user sees "Searching 12 sources…"
      // instead of generic "Searching memory…".
      const onHits = (count) => {
        if (typeof onPhase === 'function' && typeof count === 'number') {
          try { onPhase('searching_memory', { count }); } catch {}
        }
      };
      const entityDetectionText = buildRecognitionWindow(messages);
      const layeredCtx = await loadLayeredContextForChat(lastUserMsg.content, {
        topic, belt,
        conversation_id, user_id, messages, onHits, onTiming, onContextTrace, entityDetectionText,
        skipIdentityLayer: true, skipTopicLayer: true,
        enrichmentFaults: faults,
        onEnrichment,
        responseMode: responseMode.mode,
        responseModeReason: responseMode.reason,
        allowInlineDeepRag: responseMode.mode === 'deep',
        contextTimeoutMs: responseMode.contextTimeoutMs,
      });
      systemBlocks = attachTopicResume(systemBlocks, topic, layeredCtx, {
        query: lastUserMsg.content,
        responseMode: responseMode.mode,
        sessionUserTurn,
      });
    }
  } else {
    systemBlocks = attachTopicResume(systemBlocks, topic, '', {
      query: lastUserMessage?.content || '',
      responseMode: responseMode.mode,
      sessionUserTurn,
    });
  }

  // st_f67bc2eb AC-8 — Miyagi-as-guide: a detected product-usage question
  // injects the grounded docs-projection block into the VOLATILE tail (cached
  // prefix untouched). Tier-0 in-memory keyword detection — no LLM on the
  // routing path, no new fetches. The block carries the answer contract:
  // answer only from the documented entries, name the source, and say plainly
  // when the docs do not cover it.
  if (lastUserMessage) {
    try {
      const detection = detectProductQuestion(lastUserMessage.content);
      if (detection) {
        systemBlocks = withVolatileContext(systemBlocks, buildProductGuideBlock(detection));
        emitEnrichment(onEnrichment, { layer: 'product_guide', status: detection.matches.length ? 'ok' : 'uncovered', ms: 0 });
      }
    } catch (err) {
      console.warn('[chat] product guide injection failed:', err?.message || err);
    }
  }

  // st_f1a40461 AC9 — inline entity recognition across the rolling window.
  // Black Belt only (entity recognition is a Black Belt capability, matching
  // the entity context layers). Yielded ONCE after context assembly so the
  // client (apps/chat/modules/inline-recognition.js) can highlight contacts
  // named in earlier turns without an @-mention. Best-effort: never breaks
  // the chat stream.
  if (belt === 'black' && messages.length > 0) {
    try {
      const windowText = buildRecognitionWindow(messages);
      if (windowText) {
        const _recogStarted = Date.now();
        const recognized = await optionalEnrichment(
          'inline_recognition',
          {
            faults,
            timeoutMs: INLINE_RECOGNITION_TIMEOUT_MS,
            fallback: [],
            onTiming,
            onEnrichment,
          },
          () => detectEntitiesInWindow(windowText),
        );
        if (typeof onTiming === 'function') {
          try { onTiming({ phase: 'inline_recognition', ms: Date.now() - _recogStarted }); } catch {}
        }
        const seen = new Set();
        const entities = [];
        for (const e of recognized || []) {
          const key = `${e.type}:${e.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          entities.push({ id: e.id, name: e.name, type: e.type, n2: e.n2 || null, score: e.score || 0 });
        }
        if (entities.length) {
          yield { type: 'entity_recognized', entities };
        }
      }
    } catch (err) {
      console.warn('[chat] inline recognition failed:', err.message);
    }
  }

  // Legacy callers expect a string `system`. Local providers (Ollama,
  // non-Anthropic providers flatten to string before sending; the Anthropic provider
  // consumes the block array directly so caching is preserved.
  const system = systemBlocks;
  const systemString = flattenSystemBlocks(systemBlocks);

  const tools = useTools ? getToolSchemas(belt) : [];

  // ── Ollama local-model gate ────────────────────────────────────────────
  if (typeof options.model === 'string' && options.model.startsWith('ollama:')) {
    const ollamaModelName = options.model.slice('ollama:'.length);
    if (await ollamaReachable()) {
      try {
        for await (const event of streamOllama(ollamaModelName, systemString, messages)) {
          if (threadId && event.type === 'delta') assistantTextBuf.push(event.text);
          yield event;
        }
        if (threadId && assistantTextBuf.length) {
          logTurn({ threadId, role: 'assistant', content: assistantTextBuf.join(''), source })
            .catch(err => console.warn('[session-log] ollama turn failed:', err.message));
        }
        return;
      } catch (err) {
        console.warn('[ollama] local server error, falling back to Anthropic:', err.message);
      }
    } else {
      console.warn('[ollama] local server not reachable, falling back to Anthropic');
    }
  }

  // ── Anthropic streaming + tool-use loop ────────────────────────────────
  // Build the working message array (may grow with tool results). Inject
  // image blocks from uploaded files into the last user message before the
  // first model call.
  const workingMessages = messages.map(m => ({ role: m.role, content: m.content }));

  if (files.length > 0 && !hasEnrichmentFault(faults, 'attachments')) {
    const attachmentsStarted = Date.now();
    let attachmentStatus = 'ok';
    const lastUserIdx = workingMessages.map(m => m.role).lastIndexOf('user');
    if (lastUserIdx !== -1) {
      const msg = workingMessages[lastUserIdx];
      const blocks = typeof msg.content === 'string' && msg.content
        ? [{ type: 'text', text: msg.content }]
        : [];
      for (const f of files) {
        if (f.mimeType?.startsWith('image/') && f.fileId) {
          try {
            if (hasSlowEnrichmentFault(faults, 'attachments')) {
              emitTiming(onTiming, 'enrichment.attachments.timeout', 0);
              attachmentStatus = 'timeout';
              break;
            }
            const stored = getFile(f.fileId);
            if (stored) {
              blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mimeType, data: stored.base64 } });
            }
          } catch (err) {
            console.warn('[chat] attachment enrichment failed:', err.message);
            attachmentStatus = 'error';
          }
        }
      }
      if (blocks.length > 1 || (blocks.length === 1 && blocks[0].type === 'image')) {
        workingMessages[lastUserIdx] = { ...msg, content: blocks };
      }
    }
    emitEnrichment(onEnrichment, { layer: 'attachments', status: attachmentStatus, ms: Date.now() - attachmentsStarted });
  } else if (files.length > 0) {
    emitEnrichment(onEnrichment, { layer: 'attachments', status: 'fault', ms: 0 });
  }

  // Hand off to the dedicated tool-loop module. onPhase + onMetric flow
  // through so the route can wire them into SSE / observability.
  //
  // Provider resolution: selectProvider() picks based on model+belt. Default
  // is Anthropic; ollama:* models route locally.
  // The cache hint enables prompt-cache on Anthropic (AC 11).
  //
  // Launch invariant: a provider that does not produce a first text delta inside
  // the mode-specific budget must not keep the user watching a live-but-dead
  // stream. Non-tool turns can retry through the configured fast fallback
  // providers. Tool turns do not retry because replaying tool side effects would
  // be worse than surfacing the provider error.
  const streamPolicy = resolveChatStreamPolicy({
    mode: responseMode.mode,
    toolsLength: tools.length,
    model,
  });
  const firstDeltaTimeoutMs = streamPolicy.firstDeltaTimeoutMs;
  const allowProviderFallback = responseMode.mode !== 'deep' && streamPolicy.allowProviderFallback;
  const providerModels = streamPolicy.providerModels;
  let _firstDeltaSeen = false;
  const _modelCallStarted = Date.now();
  let lastProviderError = null;

  for (let i = 0; i < providerModels.length; i++) {
    const attemptModel = providerModels[i];
    const attemptStarted = Date.now();
    let provider = null;
    let sawDeltaThisAttempt = false;
    try {
      provider = await selectProvider({ model: attemptModel, belt });
      if (typeof onTiming === 'function') {
        try {
          onTiming({
            phase: i === 0 ? 'select_provider' : `select_provider_retry_${i}`,
            ms: Date.now() - attemptStarted,
          });
        } catch {}
      }
      emitEnrichment(onEnrichment, {
        layer: 'provider_stream',
        status: i === 0 ? 'primary' : 'fallback',
        ms: 0,
        model: attemptModel,
        provider: provider.name || providerNameForModelId(attemptModel),
      });
      if (i > 0) {
        emitPhase('model_retry', {
          label: 'Retrying with another fast model…',
          model: attemptModel,
          provider: provider.name || providerNameForModelId(attemptModel),
        });
      }
      const providerStream = streamAnthropicToolLoop({
        messages: workingMessages,
        system,
        tools,
        model: attemptModel,
        maxTokens,
        provider,
        executeTool: (name, args, ctx) => executeTool(name, args, ctx),
        toolCtx,
        onPhase,
        onMetric,
        streamTimeoutMs: config.timeouts.stream,
        firstDeltaTimeoutMs: tools.length === 0 ? firstDeltaTimeoutMs : 0,
        cache: 'system',
      });
      for await (const event of withFirstDeltaPrelude(providerStream)) {
        if (event.type === 'delta') {
          sawDeltaThisAttempt = true;
          if (!_firstDeltaSeen) {
            _firstDeltaSeen = true;
            if (typeof onTiming === 'function') {
              try { onTiming({ phase: 'model_ttft', ms: Date.now() - _modelCallStarted }); } catch {}
            }
            const liveProvider = provider?.name || providerNameForModelId(attemptModel);
            queueMicrotask(() => { try { recordLiveVerification(db, liveProvider); } catch { /* best-effort */ } });
          }
        }
        if (threadId && event.type === 'delta') assistantTextBuf.push(event.text);
        yield event;
      }
      break;
    } catch (err) {
      lastProviderError = err;
      emitEnrichment(onEnrichment, {
        layer: 'provider_stream',
        status: 'error',
        ms: Date.now() - attemptStarted,
        model: attemptModel,
        provider: provider?.name || providerNameForModelId(attemptModel),
        error: providerErrorCode(err),
      });
      if (sawDeltaThisAttempt || !allowProviderFallback || i === providerModels.length - 1) {
        throw err;
      }
      const nextModel = providerModels[i + 1];
      const detail = err?.cause?.code || err?.cause?.message || err?.message || '';
      console.warn(`[chat] ${providerErrorCode(err)} on ${attemptModel} after ${Date.now() - attemptStarted}ms — trying ${nextModel}${detail ? ` (${detail})` : ''}`);
      continue;
    }
  }
  if (!_firstDeltaSeen && lastProviderError) throw lastProviderError;

  // Log the full assistant response as a single turn.
  if (threadId && assistantTextBuf.length) {
    const full = assistantTextBuf.join('');
    logTurn({ threadId, role: 'assistant', content: full, source })
      .catch((err) => console.warn('[session-log] assistant turn failed:', err.message));
  }
}

/**
 * Non-streaming chat with tool use support. Returns complete response with usage.
 * Used by /api/chat/sync — same backbone, no streaming.
 */
export async function chat(messages, options = {}) {
  const {
    topic = null,
    systemPrompt = null,
    maxTokens = 4096,
    useRag = true,
    belt = 'white',
    useTools = false,
    threadId = null,
    conversation_id = null,
    user_id = null,
    enrichmentFaults = null,
    // st_8c7b7a6b D1 — default OFF (see streamChat above).
    useRouter = false,
    sessionUserTurn = 1,
  } = options;
  const faults = normalizeEnrichmentFaults(enrichmentFaults);
  let requestedModel = options.model || config.models.chat;
  let model = resolveChatModelId(requestedModel);

  const lastUserMessage = [...messages].reverse().find(m =>
    m.role === 'user' && typeof m.content === 'string',
  );

  let routerBlock = '';
  if (useRouter && lastUserMessage && CHAT_ROUTER_FOREGROUND_ENABLED) {
    try {
      const history = messages.slice(-6).map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
      const routed = await optionalEnrichment(
        'router',
        {
          faults,
          timeoutMs: ROUTER_TIMEOUT_MS,
          fallback: null,
          onTiming: null,
        },
        () => routeContext({
          userMessage: lastUserMessage.content,
          threadId,
          history,
          activeTopic: topic,
        }),
      );
      routerBlock = routed?.systemPrompt || '';
    } catch (err) {
      console.warn('[context-router] route failed (syncChat):', err.message);
    }
  }

  // Same cached-prefix assembly as streamChat — single source of truth.
  // Sync path uses the block array shape: cached prefix (generic + identity +
  // topic) then a volatile uncached tail. llmCreate threads through the
  // Anthropic provider which preserves cache_control on the cached blocks.
  let systemBlocks = assembleChatSystemBlocks(
    { systemPrompt, belt, topic, routerBlock, useTools },
    { faults, onTiming: null },
  );
  const responseMode = applyModelLaneFloor(classifyChatResponseMode({
    query: lastUserMessage?.content || '',
    topic,
    requestedMode: options.mode === 'deep' || options.mode === 'fast' ? options.mode : null,
  }), requestedModel);
  const modelPolicy = productizedChatModelForMode(requestedModel, responseMode.mode);
  if (modelPolicy.changed) {
    requestedModel = modelPolicy.model;
    model = resolveChatModelId(requestedModel);
  }

  if (useRag && messages.length > 0) {
    const lastUserMsg = [...messages].reverse().find(m =>
      m.role === 'user' && typeof m.content === 'string',
    );
    if (lastUserMsg) {
      // Identity + topic are in the cached prefix above; the layered build
      // emits the volatile remainder only (st_2cd1af73 AC-1).
      const entityDetectionText = buildRecognitionWindow(messages);
      const context = await loadLayeredContextForChat(lastUserMsg.content, {
        topic, belt,
        conversation_id, user_id, messages, entityDetectionText,
        skipIdentityLayer: true, skipTopicLayer: true,
        enrichmentFaults: faults,
        responseMode: responseMode.mode,
        responseModeReason: responseMode.reason,
        allowInlineDeepRag: responseMode.mode === 'deep',
        contextTimeoutMs: responseMode.contextTimeoutMs,
      });
      systemBlocks = attachTopicResume(systemBlocks, topic, context, {
        query: lastUserMsg.content,
        responseMode: responseMode.mode,
        sessionUserTurn,
      });
    }
  } else {
    systemBlocks = attachTopicResume(systemBlocks, topic, '', {
      query: lastUserMessage?.content || '',
      responseMode: responseMode.mode,
      sessionUserTurn,
    });
  }
  const system = systemBlocks;

  const tools = useTools ? getToolSchemas(belt) : [];
  const workingMessages = messages.map(m => ({ role: m.role, content: m.content }));

  let totalUsage = { input_tokens: 0, output_tokens: 0 };
  let toolRounds = 0;

  while (toolRounds <= MAX_TOOL_ROUNDS) {
    const apiParams = {
      model,
      max_tokens: maxTokens,
      system,
      messages: workingMessages,
    };
    if (tools.length > 0 && toolRounds < MAX_TOOL_ROUNDS) {
      apiParams.tools = tools;
    }

    // st_4312c9c0 — the owner's own chat turn; a human is waiting.
    const response = await llmCreate({ ...apiParams, interactive: true }, 'chat-sync');
    totalUsage.input_tokens += response.usage.input_tokens;
    totalUsage.output_tokens += response.usage.output_tokens;

    const toolCalls = response.content.filter(b => b.type === 'tool_use');
    if (toolCalls.length === 0 || response.stop_reason !== 'tool_use') {
      const content = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
      return { content, usage: totalUsage };
    }

    workingMessages.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const call of toolCalls) {
      let result = await executeTool(call.name, call.input, { belt, sessionId: options.sessionId });
      if (result && typeof result._onResolved === 'function') {
        result = await result._onResolved();
      }
      // Mirror the underscore-prefix strip from anthropic-loop.js.
      const publicResult = result && typeof result === 'object'
        ? Object.fromEntries(Object.entries(result).filter(([k]) => !k.startsWith('_')))
        : result;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(publicResult),
      });
    }
    workingMessages.push({ role: 'user', content: toolResults });
    toolRounds++;
  }

  return { content: '[Tool execution limit reached]', usage: totalUsage };
}

// Re-export the brand prompt and module paths for any historical consumers.
export { ROBOTDOJO_BRAND_PROMPT };
