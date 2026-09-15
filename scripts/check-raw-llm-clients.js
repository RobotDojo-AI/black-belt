#!/usr/bin/env node
/**
 * scripts/check-raw-llm-clients.js — refuse committed unmetered Anthropic clients.
 *
 * Scans tracked first-party trees. Agent-written workbench scripts are
 * gitignored; the PreToolUse hook (scripts/raw-llm-guard.mjs) is the brake
 * for those. This gate is so the hole cannot be re-committed into lib/ or
 * scripts/ as "just a helper."
 *
 * Exit 0 = clean. Exit 1 = named files.
 */

// INTELLIGENCE_TIER: extraction — deterministic scan. Makes no model call.
export const INTELLIGENCE_TIER = 'extraction';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { detectRawClientInText, isAllowlistedPath } from '../lib/raw-llm-client.js';

const REPO_ROOT = resolve(process.argv.includes('--repo')
  ? process.argv[process.argv.indexOf('--repo') + 1]
  : join(import.meta.dirname, '..'));

const ROOTS = ['lib', 'scripts', 'routes', 'apps'];
const EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.html']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'qa']);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      yield* walk(abs);
    } else if ([...EXTENSIONS].some((e) => name.endsWith(e))) {
      yield abs;
    }
  }
}

function main() {
  const hits = [];
  for (const root of ROOTS) {
    for (const abs of walk(join(REPO_ROOT, root))) {
      if (isAllowlistedPath(abs, REPO_ROOT)) continue;
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      const hit = detectRawClientInText(text);
      if (hit) hits.push(`${relative(REPO_ROOT, abs)}: ${hit.reason}`);
    }
  }
  if (hits.length) {
    console.error('[check-raw-llm-clients] FAIL — unmetered Anthropic client:');
    for (const h of hits) console.error(`  - ${h}`);
    console.error('Use llmCreate from lib/llm-gateway.js. Do not fetch a provider API or read a provider Keychain item.');
    process.exit(1);
  }
  console.log('[check-raw-llm-clients] ok');
}

main();
