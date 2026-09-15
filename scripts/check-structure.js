#!/usr/bin/env node
/**
 * check-structure.js — enforces filesystem structure (via gate.js) AND
 * the Intelligence Tier Protocol.
 *
 * Two checks, both must pass:
 *   1. gate.js zones 1-5 (repo allowlist, untracked, MECE, dotdir, quarantine grace)
 *   2. Intelligence tier — every .js under scripts/ (recursively — st_4312c9c0
 *      AC 13 defect: the prior scan was top-level only and silently skipped
 *      every scripts/ subdirectory, e.g. scripts/qa/, scripts/ingest/) OR
 *      under lib/ (recursively — st_4312c9c0 AC 13 defect: lib/ was never
 *      scanned at all) that calls getAnthropicClient() or references
 *      MODELS.* must declare export const INTELLIGENCE_TIER = '...'.
 *
 * WHY: The LLM write boundary (LLMs read from graph, write only to canonical docs)
 * must be structurally enforced — instructions alone degrade under context pressure.
 * The filesystem ontology must hold simultaneously — otherwise misplaced files
 * silently break canonical documents, drop-folder routing, and ingest pipelines.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const SCRIPTS_DIR = __dirname;
const LIB_DIR = join(REPO_ROOT, 'lib');
const GATE_SCRIPT = join(SCRIPTS_DIR, 'gate.js');

// ── 1. Delegate to gate.js for filesystem ontology checks ─────────────────────
const gateResult = spawnSync(process.execPath, [GATE_SCRIPT, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
if (gateResult.status !== 0) process.exit(gateResult.status);

// ── 2. Intelligence Tier Protocol ─────────────────────────────────────────────
// Recursive walk — the prior top-level-only readdirSync silently skipped every
// subdirectory in both trees (scripts/qa/, scripts/ingest/, lib/chat/, lib/llm/,
// etc.), so any LLM-using file placed one level deep never tripped this gate.
function walkJsFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory absent (e.g. lib/ in a stripped checkout) — nothing to scan
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(abs, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

const candidates = [
  ...walkJsFiles(SCRIPTS_DIR).filter((f) => f !== join(SCRIPTS_DIR, 'check-structure.js')),
  ...walkJsFiles(LIB_DIR),
];
const violations = [];
let llmCount = 0;

for (const abs of candidates) {
  const content = readFileSync(abs, 'utf8');
  const usesLLM = content.includes('getAnthropicClient') || /MODELS\.[a-z]/.test(content);
  const declaresTier = /export const INTELLIGENCE_TIER\s*=/.test(content);
  if (usesLLM) llmCount++;
  if (usesLLM && !declaresTier) violations.push(relative(REPO_ROOT, abs));
}

if (violations.length > 0) {
  process.stderr.write(`STOP-THE-LINE — INTELLIGENCE_TIER missing on ${violations.length} LLM-using file(s):\n`);
  violations.forEach(f => process.stderr.write(`  ${f}\n`));
  process.stderr.write(`Every .js in scripts/ or lib/ that calls getAnthropicClient() or MODELS.* must declare:\n`);
  process.stderr.write(`  export const INTELLIGENCE_TIER = 'synthesis'; // or 'extraction' or 'orchestration'\n`);
  process.exit(1);
}

console.log(`check-structure: INTELLIGENCE_TIER declared on all ${llmCount} LLM-using files (scripts/ + lib/, recursive)`);
