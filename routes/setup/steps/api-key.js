// Onboarding gate zero: user must paste an API key from ANY foundation-model
// provider (Anthropic, OpenAI, or Google) before
// any other step that touches a foundation model can proceed.
//
// Why first: subsequent steps (especially extraction-prompts) run LLM calls
// on the user's key — if we let the user extract from ChatGPT/Claude.ai etc
// on OUR hosted chat, we eat the cost AND see their full-life dumps. With
// the key in place, everything routes through the user's provider,
// end-to-end private.
//
// Keychain service convention: `robotdojo-<PROVIDER>_API_KEY`.

import { readKeychainSecret } from '../../../lib/keychain.js';

const SUPPORTED_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)',  keychain: 'robotdojo-ANTHROPIC_API_KEY',  url: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai',    label: 'OpenAI (GPT)',        keychain: 'robotdojo-OPENAI_API_KEY',     url: 'https://platform.openai.com/api-keys' },
  { id: 'google',    label: 'Google (Gemini)',     keychain: 'robotdojo-GOOGLE_AI_API_KEY',  aliases: ['robotdojo-GOOGLE_API_KEY'], url: 'https://aistudio.google.com/apikey' },
];

const KEYCHAIN_PRESENCE_TTL_MS = Number.parseInt(process.env.ROBOTDOJO_SETUP_KEYCHAIN_CACHE_MS || '60000', 10);
const KEYCHAIN_PRESENCE_TIMEOUT_MS = Number.parseInt(process.env.ROBOTDOJO_SETUP_KEYCHAIN_TIMEOUT_MS || '250', 10);
const _keychainPresenceCache = new Map();

function keychainHas(service, aliases = []) {
  const now = Date.now();
  return [service, ...aliases].some((name) => {
    const cached = _keychainPresenceCache.get(name);
    if (cached && cached.expiresAt > now) return cached.present;
    let present = false;
    try {
      present = Boolean(readKeychainSecret(name, { timeout: KEYCHAIN_PRESENCE_TIMEOUT_MS }));
    } catch {
      present = false;
    }
    _keychainPresenceCache.set(name, { present, expiresAt: now + KEYCHAIN_PRESENCE_TTL_MS });
    return present;
  });
}

function compute() {
  const configured = SUPPORTED_PROVIDERS.filter((p) => keychainHas(p.keychain, p.aliases));
  const count = configured.length;
  // st_fcdbe84f AC13 — a foundation-model key is NOT on the critical path.
  // Robot Dojo runs on a local model (Ollama, RAM-selected) with free local
  // embeddings for RAG, so a fresh user can chat and build context with no key.
  // A key is an optional upgrade, so this step never blocks onboarding; we just
  // surface whether one is configured.
  const complete = true;
  const preview = count > 0
    ? `${count} provider${count === 1 ? '' : 's'} configured: ${configured.map((p) => p.label.split(' ')[0]).join(', ')}`
    : 'Optional — Robot Dojo runs on a local model with free local RAG, no key needed. Add an Anthropic, OpenAI, or Google key any time to upgrade.';
  return { complete, preview, configured_count: count };
}

export default {
  id: 'api-key',
  title: 'Your API key (optional)',
  description: 'Optional — local model works with no key; add one to upgrade',
  icon: 'key',
  compute,
  chat_context: 'api-key-setup',
  chat_prompt: 'I want to set up Robot Dojo with my own API key. Walk me through it — my choices are Anthropic, OpenAI, or Google (Gemini). Pick whichever provider I already have an account with.',
  inline: false,
  category: 'foundation',
  providers: SUPPORTED_PROVIDERS,
};

export { SUPPORTED_PROVIDERS, keychainHas };
