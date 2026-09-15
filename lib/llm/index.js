/**
 * Provider registry (st_74f45a1a R2 amendment).
 *
 * Returns provider singletons by name. Every chat surface routes through
 * getProvider() — no callers import the SDK clients directly. This is the
 * choke point AC 10 enforces (grep gate over lib/ + routes/).
 *
 * Routing rules (selectProvider):
 *   - model family prefixes route to their configured provider
 *   - default → anthropic
 *
 * Adding a provider: write lib/llm/<name>.js exporting {name, streamChat,
 * complete} and register the lazy loader in PROVIDERS below.
 */
import { providerNameForModelId } from '../chat-models.js';

const PROVIDERS = {
  anthropic: () => import('./anthropic.js'),
  openai: () => import('./openai.js'),
  google: () => import('./google.js'),
  xai: () => import('./xai.js'),
  ollama: () => import('./ollama.js'),
};

const _instances = new Map();

/**
 * Get the provider object by name. Caches the loaded module so the second
 * call is synchronous (sort of — still returns a Promise for shape parity).
 *
 * For sync callers, see getProviderSync() below — but in practice every
 * chat path can await once at the top of the turn.
 */
export async function getProvider(name) {
  if (!name || !PROVIDERS[name]) {
    throw new Error(`unknown_provider: ${name} — known: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  if (_instances.has(name)) return _instances.get(name);
  const mod = await PROVIDERS[name]();
  const provider = {
    name: mod.name || name,
    streamChat: mod.streamChat,
    complete: mod.complete,
    // Test helpers — expose so tests can stub the underlying SDK client.
    setClient: mod.setClient,
    _resetClient: mod._resetClient,
  };
  _instances.set(name, provider);
  return provider;
}

/**
 * Select a provider based on the requested model + belt.
 *
 * @param {object} args
 * @param {string} [args.model] - 'ollama:NAME' | 'gpt-*' | 'gemini-*' | etc.
 * @param {string} [args.belt]  - retained for future use; no current routing impact.
 * @returns {Promise<{name:string, streamChat, complete}>}
 */
export async function selectProvider({ model, belt } = {}) {
  return getProvider(providerNameForModelId(model));
}

/**
 * Reset all provider instances (test hook).
 */
export function _resetAllProviders() {
  for (const inst of _instances.values()) {
    try { inst._resetClient?.(); } catch {}
  }
  _instances.clear();
}
