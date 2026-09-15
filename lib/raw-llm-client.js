/**
 * lib/raw-llm-client.js — detect an unmetered provider call.
 *
 * The Aug 13 spend hole: agent-written scripts pulled the Anthropic key from
 * Keychain and POSTed api.anthropic.com with raw fetch. spend-guard only sees
 * llmCreate. A raw fetch never touches it.
 *
 * This module classifies text (a file being written) and shell (a command
 * about to run). Callers: the PreToolUse hook, the pre-commit gate.
 *
 * First-party files that hit the Anthropic *models* endpoint for probe/catalog
 * work are allowlisted. Completions must go through llmCreate.
 */

// INTELLIGENCE_TIER: extraction — deterministic pattern match. Makes no model call.

import { relative, isAbsolute, resolve } from 'node:path';

export const INTELLIGENCE_TIER = 'extraction';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** Relative paths that may mention api.anthropic.com without being a completion client. */
export const ALLOWLIST = new Set([
  'lib/raw-llm-client.js',
  'lib/api-key-probe.js',
  'scripts/check-raw-llm-clients.js',
  'scripts/raw-llm-guard.mjs',
  'scripts/update-models.js',
  'scripts/qa/external-provider-roundtrips.js',
  'scripts/install-claude-hook.js',
  'scripts/edit-avatar.js',
  'scripts/generate-avatar.js',
  'scripts/ingest/05-reclassify-chunks.js',
  'scripts/memory-synthesize.js',
  'tests/raw-llm-client.test.js',
  'tests/install-claude-hook.test.js',
]);

const PROVIDER_HOST = /api\.anthropic\.com|api\.openai\.com|api\.x\.ai|generativelanguage\.googleapis\.com/i;
const RAW_SECURITY = /find-generic-password[\s\S]{0,160}(ANTHROPIC|OPENAI|XAI|GOOGLE)_API_KEY/i;
const COMPLETION_PATH = /\/v1\/messages|\/v1\/chat\/completions|\/v1\/responses/i;

export function repoRelative(filePath, root = REPO_ROOT) {
  if (!filePath) return '';
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  return relative(root, abs).split('\\').join('/');
}

export function isAllowlistedPath(filePath, root = REPO_ROOT) {
  const rel = repoRelative(filePath, root);
  return ALLOWLIST.has(rel);
}

/**
 * @param {string} text
 * @returns {{ reason: string } | null}
 */
export function detectRawClientInText(text) {
  if (!text || typeof text !== 'string') return null;
  if (PROVIDER_HOST.test(text) && COMPLETION_PATH.test(text)) {
    return { reason: 'raw fetch to a provider API — completions must go through llmCreate' };
  }
  if (RAW_SECURITY.test(text)) {
    return { reason: 'pulls a provider API key via security(1) — that path is not metered' };
  }
  return null;
}

/**
 * @param {string} cmd
 * @returns {{ reason: string } | null}
 */
export function detectRawClientInCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  if (PROVIDER_HOST.test(cmd) && COMPLETION_PATH.test(cmd)) {
    return { reason: 'shell call to a provider API — completions must go through llmCreate' };
  }
  if (RAW_SECURITY.test(cmd)) {
    return { reason: 'shell read of a provider Keychain item — that path is not metered' };
  }
  return null;
}

/**
 * Combined check for a Write/Edit of `filePath` with `contents`.
 * Allowlisted first-party files pass even if they mention the host.
 */
export function detectRawClientWrite(filePath, contents, root = REPO_ROOT) {
  if (isAllowlistedPath(filePath, root)) return null;
  return detectRawClientInText(contents);
}
