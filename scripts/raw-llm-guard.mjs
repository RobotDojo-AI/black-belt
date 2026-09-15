#!/usr/bin/env node
/**
 * raw-llm-guard.mjs — PreToolUse hook on Write, Edit, MultiEdit, Bash.
 *
 * Blocks an agent from writing or running an unmetered Anthropic client:
 * raw fetch to api.anthropic.com, or `security find-generic-password` for
 * the Anthropic key. That path billed $150 of Opus on Aug 13 and never
 * touched spend-guard.
 *
 * Exit 2 blocks the tool call. Stdin parse failure exits 0 so a broken
 * hook payload cannot freeze the session; a detected raw client always blocks.
 */

// INTELLIGENCE_TIER: extraction — deterministic. Makes no model call.
export const INTELLIGENCE_TIER = 'extraction';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DETECTOR = resolve(HERE, '../lib/raw-llm-client.js');

function payloadFromStdin() {
  try {
    return JSON.parse(readFileSync('/dev/stdin', 'utf8'));
  } catch {
    return null;
  }
}

function contentsOf(input) {
  if (!input || typeof input !== 'object') return '';
  return [
    input.contents,
    input.content,
    input.new_string,
    input.new_str,
    Array.isArray(input.edits)
      ? input.edits.map((e) => e?.new_string || e?.contents || '').join('\n')
      : '',
  ].filter(Boolean).join('\n');
}

async function main() {
  const { detectRawClientWrite, detectRawClientInCommand } = await import(pathToFileURL(DETECTOR).href);
  const payload = payloadFromStdin();
  if (!payload) process.exit(0);

  const tool = payload.tool_name || payload.toolName || '';
  const input = payload.tool_input || payload.toolInput || {};

  if (/^(Write|Edit|MultiEdit)$/i.test(tool)) {
    const filePath = input.file_path || input.filePath || input.path || '';
    const hit = detectRawClientWrite(filePath, contentsOf(input));
    if (hit) {
      process.stderr.write(
        `[raw-llm-guard] BLOCKED: ${hit.reason}\n` +
        `All model calls go through llmCreate (lib/llm-gateway.js) so spend-guard can refuse them.\n`,
      );
      process.exit(2);
    }
  }

  if (/^Bash$/i.test(tool)) {
    const cmd = input.command || input.cmd || '';
    const hit = detectRawClientInCommand(cmd);
    if (hit) {
      process.stderr.write(
        `[raw-llm-guard] BLOCKED: ${hit.reason}\n` +
        `All model calls go through llmCreate (lib/llm-gateway.js) so spend-guard can refuse them.\n`,
      );
      process.exit(2);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[raw-llm-guard] ${err.message}\n`);
  process.exit(2);
});
