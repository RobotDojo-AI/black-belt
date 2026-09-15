/**
 * Shared Anthropic SDK client factory.
 *
 * One cached `Anthropic` instance per process. Reads the API key from the
 * macOS Keychain via `config.anthropicKey` (env override supported).
 *
 * All callers must go through this helper so we have exactly one source of
 * truth for key lookup and SDK construction.
 */
// INTELLIGENCE_TIER: orchestration — creates/caches the raw SDK client for
// other modules to call through; makes no content decision itself.
export const INTELLIGENCE_TIER = 'orchestration';

import Anthropic from '@anthropic-ai/sdk';
import config from './config.js';

let _client = null;

/**
 * Returns the cached Anthropic client, constructing it on first call.
 * Throws if no API key is configured — callers that need a non-throwing
 * probe should check `config.anthropicKey` first.
 */
export function getAnthropicClient() {
  if (_client) return _client;
  const apiKey = config.anthropicKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  _client = new Anthropic({ apiKey });
  return _client;
}
