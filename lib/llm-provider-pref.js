/**
 * Default metered LLM provider. Install default is xAI (Grok).
 * Owner can switch from Account → Integrations with one button.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getModel } from './config.js';
import { readUserSetting, writeUserSetting } from './setup-queries.js';
import db from './db.js';

export const LLM_PROVIDER_SETTING = 'llm_provider';
export const LLM_PROVIDERS = Object.freeze(['xai', 'anthropic', 'openai', 'google']);
export const DEFAULT_LLM_PROVIDER = 'xai';

const POLICY_PATH = join(import.meta.dirname, '..', 'config', 'tier-policy.json');

export function policyProvider() {
  try {
    if (!existsSync(POLICY_PATH)) return DEFAULT_LLM_PROVIDER;
    const parsed = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
    const provider = String(parsed?.provider || '').trim().toLowerCase();
    return LLM_PROVIDERS.includes(provider) ? provider : DEFAULT_LLM_PROVIDER;
  } catch {
    return DEFAULT_LLM_PROVIDER;
  }
}

export function isLlmProvider(value) {
  return LLM_PROVIDERS.includes(String(value || '').trim().toLowerCase());
}

export function getLlmProvider(database = db) {
  if (database) {
    try {
      const stored = String(readUserSetting(database, LLM_PROVIDER_SETTING) || '').trim().toLowerCase();
      if (isLlmProvider(stored)) return stored;
    } catch { /* schema not ready */ }
  }
  return policyProvider();
}

export function setLlmProvider(db, provider) {
  const next = String(provider || '').trim().toLowerCase();
  if (!isLlmProvider(next)) {
    const err = new Error(`unknown_llm_provider:${next}`);
    err.code = 'unknown_llm_provider';
    throw err;
  }
  writeUserSetting(db, LLM_PROVIDER_SETTING, next);
  const chatModel = getModel(next, 'balanced');
  if (chatModel) writeUserSetting(db, 'chat_model', chatModel);
  return {
    provider: next,
    chat_model: chatModel || null,
  };
}
