/**
 * lib/models-picker.js — model-picker selection logic (df_a00a336b AC4, Decision E).
 *
 * Extracted from routes/api.js so GET /api/models is a thin facade: the route
 * parses nothing, injects its dependencies, and returns selectableModels(...).
 * Everything here takes its inputs as arguments (no globals, no direct keychain
 * or config reads inside selectableModels) so it is unit-testable with no live
 * keys, no network, and no running server.
 *
 * The picker surfaces a model only when (a) its provider has a configured key,
 * (b) it is a production chat model, and (c) its resolved concrete id is in the
 * provider's live availability set — so a retired raw-ID entry drops out. When a
 * provider's availability set is empty (no refresh yet / fresh install) the
 * entry is shown (fail-open: never worse than today). Ollama is live-probed per
 * request and prepended when no cloud key is configured.
 */

import { CHAT_MODEL_LANES, DEFAULT_CHAT_MODEL_KEY, isProductionChatModel, resolveChatModelId } from './chat-models.js';
import { readKeychainSecret } from './keychain.js';

/** Flatten a chat-model lane descriptor into the picker entry shape. */
export function chatModelLane(lane, extra = {}) {
  return {
    tier: lane.tier,
    tierLabel: lane.label,
    laneLabel: lane.label,
    speedLabel: lane.speedLabel,
    speedIcon: lane.speedIcon,
    targetTtftMs: lane.targetTtftMs,
    slaLabel: lane.slaLabel,
    ...extra,
  };
}

// Provider → keychain service name(s). A key present in the environment or the
// macOS Keychain marks the provider as configured.
const PROVIDER_KEYCHAIN_MAP = {
  anthropic: 'ANTHROPIC_API_KEY',
  google:    ['GOOGLE_AI_API_KEY', 'GOOGLE_API_KEY'],
  openai:    'OPENAI_API_KEY',
  xai:       ['XAI_API_KEY', 'GROK_API_KEY'],
};

/** True when the provider has a configured API key (env or Keychain). */
export function keychainHasKey(provider) {
  const svc = PROVIDER_KEYCHAIN_MAP[provider];
  if (!svc) return false;
  const keys = Array.isArray(svc) ? svc : [svc];
  return keys.some((key) => {
    const envKey = String(key).replace(/^robotdojo-/, '').replace(/-/g, '_').toUpperCase();
    if (process.env[envKey]) return true;
    return Boolean(readKeychainSecret(key.startsWith('robotdojo-') ? key : `robotdojo-${key}`));
  });
}

// An entry is available when its resolved concrete id is in the provider's live
// set. Empty set → no availability data yet → show it (fail-open).
function passesAvailability(entry, availabilitySet) {
  const set = availabilitySet(entry.providerKey);
  if (!set || set.size === 0) return true;
  return set.has(resolveChatModelId(entry.key));
}

/**
 * Build the selectable-model list for the picker.
 *
 * @param {object} deps
 * @param {Array}  deps.allModels        - the full catalog of picker entries
 * @param {(provider:string)=>boolean} deps.hasKey          - provider has a configured key
 * @param {(provider:string)=>Set<string>} deps.availabilitySet - live callable-ID set per provider
 * @param {()=>Promise<boolean>} deps.ollamaReachable        - local Ollama server reachable
 * @param {()=>Promise<string[]>} deps.listOllama            - local Ollama model names
 * @returns {Promise<Array>} the models to surface, Ollama prepended when zero cloud keys
 */
export async function selectableModels({ allModels, hasKey, availabilitySet, ollamaReachable, listOllama }) {
  const models = Array.isArray(allModels) ? allModels : [];

  const configured = new Set();
  for (const providerKey of new Set(models.map(m => m.providerKey))) {
    if (hasKey(providerKey)) configured.add(providerKey);
  }

  const available = models.filter(m =>
    configured.has(m.providerKey)
    && isProductionChatModel(m.key)
    && passesAvailability(m, availabilitySet),
  );

  // Ollama models — surfaced only when no cloud key is configured and the local
  // server is reachable. PREPEND (not append) so the first entry IS the default
  // for a fresh-install zero-config user (the chat app picks modelsData[0] when
  // the selected model isn't in the returned set).
  if (configured.size === 0 && typeof ollamaReachable === 'function' && await ollamaReachable()) {
    const names = (typeof listOllama === 'function' ? await listOllama() : []) || [];
    const ollamaEntries = names.map((name, idx) => ({
      key: `ollama:${name}`,
      name,
      provider: 'Ollama (local)',
      providerKey: 'ollama',
      ...chatModelLane(CHAT_MODEL_LANES.ask),
      isDefault: idx === 0,
      pricing: { input_per_mtok: 0, output_per_mtok: 0 },
    }));
    available.unshift(...ollamaEntries);
  }

  // Catalog flags can go stale (Haiku leftover as isDefault). If the product
  // default is in the list, it is the only default — never first-in-list Haiku.
  if (available.some((m) => m.key === DEFAULT_CHAT_MODEL_KEY)) {
    return available.map((m) => ({ ...m, isDefault: m.key === DEFAULT_CHAT_MODEL_KEY }));
  }
  return available;
}
