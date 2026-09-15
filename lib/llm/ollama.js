/**
 * Ollama provider adapter (st_74f45a1a R2 amendment).
 *
 * Thin wrapper over lib/chat/ollama.js — the existing module owns the
 * NDJSON parsing and reachability probe. This file adapts that surface
 * to the unified Provider interface so callers can dispatch via
 * getProvider('ollama').streamChat(...).
 *
 * Cache hint: no-op. Ollama has no native prompt cache; the OS page cache
 * provides similar benefit transparently.
 */

import { streamOllama, ollamaReachable } from '../chat/ollama.js';

function resolveModel(tier) {
  // No tier mapping for Ollama — the caller passes whatever local model
  // they have pulled (`llama3.2:1b`, `gemma3:4b`, etc.). Fall back to a
  // common small model when nothing was specified.
  if (!tier || tier === 'fast' || tier === 'balanced' || tier === 'best') {
    return 'llama3.2:1b';
  }
  return tier;
}

function systemToString(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map(b => b.text || '').join('\n');
}

export async function* streamChat(args) {
  const { messages, system = '', model } = args;
  const modelName = resolveModel(model);
  const sys = systemToString(system);

  // Reachability probe — if Ollama isn't running, fail fast with a clear
  // error message so the caller can fall back to a different provider.
  if (!(await ollamaReachable())) {
    throw new Error('provider_not_configured: ollama server not reachable at OLLAMA_HOST');
  }

  let yielded = false;
  for await (const ev of streamOllama(modelName, sys, messages)) {
    if (ev.type === 'delta') {
      yielded = true;
      yield ev;
    }
  }
  yield {
    type: 'complete',
    content: [],
    usage: null, // Ollama exposes counts on the last NDJSON line; not threaded today
    model: modelName,
    stop_reason: yielded ? 'end_turn' : 'no_content',
  };
}

export async function complete(args) {
  // Accumulate the stream into a single text response.
  let text = '';
  let model = null;
  let stop_reason = 'end_turn';
  for await (const ev of streamChat(args)) {
    if (ev.type === 'delta') text += ev.text;
    if (ev.type === 'complete') {
      model = ev.model;
      stop_reason = ev.stop_reason;
    }
  }
  return {
    content: text ? [{ type: 'text', text }] : [],
    usage: null,
    model,
    stop_reason,
  };
}

export const name = 'ollama';
