import config, { getModel } from './config.js';
import {
  CONTEXT_TTFT_MS,
  DEEP_TTFT_MS,
  WARM_TTFT_MS,
  formatDurationSeconds,
} from '../config/sla.js';

export const DEFAULT_CHAT_MODEL_KEY = 'grok-4.3';

export const CHAT_MODEL_LANES = Object.freeze({
  ask: {
    tier: 0,
    label: 'Ask Questions',
    speedLabel: 'Fast',
    speedIcon: 'bolt',
    targetTtftMs: WARM_TTFT_MS,
    slaLabel: formatDurationSeconds(WARM_TTFT_MS),
  },
  work: {
    tier: 1,
    label: 'Do Work',
    speedLabel: 'Normal',
    speedIcon: 'speed',
    targetTtftMs: CONTEXT_TTFT_MS,
    slaLabel: formatDurationSeconds(CONTEXT_TTFT_MS),
  },
  think: {
    tier: 2,
    label: 'Think Hard',
    speedLabel: 'Slow',
    speedIcon: 'hourglass_empty',
    targetTtftMs: DEEP_TTFT_MS,
    slaLabel: formatDurationSeconds(DEEP_TTFT_MS),
  },
});

const MODEL_LANE_BY_KEY = Object.freeze({
  'claude-haiku': 'ask',
  'claude-sonnet': 'work',
  'claude-opus': 'think',
  'gpt-4o-mini': 'ask',
  'gpt-4o': 'work',
  'o3-mini': 'think',
  'gemini-flash': 'work',
  'grok-4.20-0309-non-reasoning': 'ask',
  'grok-4.3': 'work',
  'grok-4.20-0309-reasoning': 'think',
});

const MODEL_MODE_CERTIFICATION = Object.freeze({
  'claude-haiku': new Set(['fast', 'context', 'deep']),
  'claude-sonnet': new Set(['fast', 'context', 'deep']),
  'claude-opus': new Set(['context', 'deep']),
  'gpt-4o-mini': new Set(['fast', 'context', 'deep']),
  'gpt-4o': new Set(['fast', 'context', 'deep']),
  'o3-mini': new Set(['context', 'deep']),
  'gemini-flash': new Set(['fast', 'context', 'deep']),
  'grok-4.20-0309-non-reasoning': new Set(['fast', 'context', 'deep']),
  'grok-4.3': new Set(['fast', 'context', 'deep']),
  'grok-4.20-0309-reasoning': new Set(['context', 'deep']),
});

const MODEL_KEY_PREFIXES = Object.freeze([
  ['claude-haiku', 'claude-haiku'],
  ['claude-sonnet', 'claude-sonnet'],
  ['claude-opus', 'claude-opus'],
  ['gpt-4o-mini', 'gpt-4o-mini'],
  ['gpt-4o', 'gpt-4o'],
  ['o3-mini', 'o3-mini'],
  ['gemini-2.5-flash', 'gemini-flash'],
  ['gemini-flash', 'gemini-flash'],
  ['grok-4.20-0309-non-reasoning', 'grok-4.20-0309-non-reasoning'],
  ['grok-4.20-non-reasoning', 'grok-4.20-0309-non-reasoning'],
  ['grok-4.20-0309-reasoning', 'grok-4.20-0309-reasoning'],
  ['grok-4.3', 'grok-4.3'],
]);

const FALLBACK_BY_PROVIDER_AND_MODE = Object.freeze({
  anthropic: { fast: 'claude-haiku', context: 'claude-sonnet', deep: 'claude-sonnet' },
  openai: { fast: 'gpt-4o-mini', context: 'gpt-4o', deep: 'gpt-4o' },
  google: { fast: 'gemini-flash', context: 'gemini-flash', deep: 'gemini-flash' },
  xai: { fast: 'grok-4.20-0309-non-reasoning', context: 'grok-4.3', deep: 'grok-4.20-0309-reasoning' },
  ollama: { fast: null, context: null, deep: null },
});

export function normalizeChatModelKey(model) {
  const raw = String(model || '').trim();
  if (!raw) return DEFAULT_CHAT_MODEL_KEY;
  if (MODEL_LANE_BY_KEY[raw] || MODEL_MODE_CERTIFICATION[raw]) return raw;
  if (raw === 'gemini-flash-lite' || raw.startsWith('gemini-2.5-flash-lite')) return null;
  if (raw === 'gemini-2.5-pro' || raw.startsWith('gemini-2.5-pro')) return null;
  if (raw === 'grok' || raw === 'grok-fast') return 'grok-4.20-0309-non-reasoning';
  for (const [prefix, key] of MODEL_KEY_PREFIXES) {
    if (raw.startsWith(prefix)) return key;
  }
  return raw;
}

export function chatModelLaneKey(model) {
  const key = normalizeChatModelKey(model);
  return MODEL_LANE_BY_KEY[key] || 'ask';
}

export function isProductionChatModel(model) {
  const key = normalizeChatModelKey(model);
  return Boolean(key && MODEL_MODE_CERTIFICATION[key]);
}

export function chatModelSupportsMode(model, mode) {
  const key = normalizeChatModelKey(model);
  const modes = key ? MODEL_MODE_CERTIFICATION[key] : null;
  return Boolean(modes?.has(mode));
}

export function productizedChatModelForMode(model, mode) {
  const requested = String(model || DEFAULT_CHAT_MODEL_KEY);
  if (chatModelSupportsMode(requested, mode)) {
    return { model: requested, changed: false, reason: 'certified' };
  }
  const provider = providerNameForChatModel(requested);
  const fallback = FALLBACK_BY_PROVIDER_AND_MODE[provider]?.[mode]
    || FALLBACK_BY_PROVIDER_AND_MODE.anthropic[mode]
    || DEFAULT_CHAT_MODEL_KEY;
  if (!fallback) return { model: requested, changed: false, reason: 'local_unmanaged' };
  return { model: fallback, changed: fallback !== requested, reason: 'uncertified_model_mode', requested };
}

export function resolveChatModelId(key) {
  const requested = key || DEFAULT_CHAT_MODEL_KEY;
  const aliases = {
    'claude-haiku': getModel('anthropic', 'fast'),
    'claude-sonnet': getModel('anthropic', 'balanced'),
    'claude-opus': getModel('anthropic', 'best'),

    'gemini-flash-lite': getModel('google', 'fast'),
    'gemini-flash': getModel('google', 'balanced'),
    'gemini-2.5-pro': getModel('google', 'best'),

    'gpt-4o-mini': getModel('openai', 'fast'),
    'gpt-4o': getModel('openai', 'balanced'),
    'o3-mini': getModel('openai', 'best'),

    grok: getModel('xai', 'balanced'),
    'grok-3': getModel('xai', 'balanced'),
    'grok-3-mini': getModel('xai', 'balanced'),
    'grok-4.3': getModel('xai', 'balanced'),
    'grok-4-0709': getModel('xai', 'balanced'),
    'grok-4-fast': getModel('xai', 'balanced'),
    'grok-4-fast-non-reasoning': getModel('xai', 'balanced'),
    'grok-4-fast-reasoning': getModel('xai', 'balanced'),
    'grok-4-1-fast': getModel('xai', 'balanced'),
    'grok-4-1-fast-non-reasoning': getModel('xai', 'balanced'),
    'grok-4-1-fast-reasoning': getModel('xai', 'balanced'),
    'grok-4.20-0309-non-reasoning': getModel('xai', 'fast'),
    'grok-4.20-non-reasoning': getModel('xai', 'fast'),
    'grok-4.20-0309-reasoning': getModel('xai', 'best'),
    'grok-4.20': getModel('xai', 'best'),
    'grok-4.20-reasoning': getModel('xai', 'best'),
  };
  return aliases[requested] ?? requested;
}

export function providerNameForModelId(modelId) {
  if (typeof modelId !== 'string') return 'anthropic';
  const s = modelId.toLowerCase();
  if (s.startsWith('ollama:')) return 'ollama';
  if (s.startsWith('claude-')) return 'anthropic';
  if (s.startsWith('gemini-')) return 'google';
  if (s.startsWith('gpt-') || /^o\d/i.test(s)) return 'openai';
  if (s === 'grok' || s.startsWith('grok-')) return 'xai';
  // Mistral is not shipped (no lib/llm/mistral.js); any stray mistral id falls
  // back to the default working provider rather than throwing unknown_provider.
  return 'anthropic';
}

export function providerNameForChatModel(key) {
  return providerNameForModelId(resolveChatModelId(key));
}
