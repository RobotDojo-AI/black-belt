#!/usr/bin/env node
// scripts/check-canonical-mode.js — single-mode invariant gate for the canonical
// surfaces registry.
//
// Story st_5285c160 (canonical-doc-hybrid). Under the new regime, every entry in
// architecture/surfaces.json is hand-curated; no autonomous doc writer runs;
// no autonomous triggers fire. This gate prevents the OLD shape from sneaking back:
//
//   (a) owner_script that references a non-existent script   → REJECT
//   (b) trigger_config.events that is non-empty               → REJECT
//   (c) class === 'programmatically-generated'                → REJECT
//
// Pre-commit chain placement: between check-registry-schema.js (structural shape)
// and check-doc-budget.js (size measurement). Schema → policy → size.
//
// CLI: node scripts/check-canonical-mode.js [path-to-registry]
// Default registry path: architecture/surfaces.json
// Exit: 0 on valid, 1 on first violation (with per-clause error line).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INTELLIGENCE_TIER = 'extraction';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const registryPath = process.argv[2]
  ? (process.argv[2].startsWith('/') ? process.argv[2] : resolve(process.cwd(), process.argv[2]))
  : resolve(REPO_ROOT, 'architecture/surfaces.json');

let data;
try {
  data = JSON.parse(readFileSync(registryPath, 'utf8'));
} catch (err) {
  process.stderr.write(`[check-canonical-mode] FAIL: cannot read ${registryPath}: ${err.message}\n`);
  process.exit(1);
}

const surfaces = Array.isArray(data.surfaces) ? data.surfaces : [];
const errors = [];

for (const s of surfaces) {
  // (a) owner_script must be null OR resolve to an existing file under scripts/
  if (s.owner_script != null) {
    const scriptPath = resolve(REPO_ROOT, 'scripts', s.owner_script);
    if (!existsSync(scriptPath)) {
      errors.push(`owner_script: ${s.path} → references missing 'scripts/${s.owner_script}'`);
    }
  }
  // (b) trigger_config.events must be empty (no autonomous triggers)
  if (Array.isArray(s.trigger_config?.events) && s.trigger_config.events.length > 0) {
    errors.push(`trigger_config.events: ${s.path} → non-empty (${s.trigger_config.events.join(',')}); no autonomous triggers permitted`);
  }
  // (c) class must NOT be programmatically-generated (single hand-curated mode)
  if (s.class === 'programmatically-generated') {
    errors.push(`class: ${s.path} → 'programmatically-generated' rejected; use 'human-authored'`);
  }
}

if (errors.length) {
  process.stderr.write(`[check-canonical-mode] FAIL — ${errors.length} violation(s):\n`);
  for (const e of errors) process.stderr.write(`  ${e}\n`);
  process.stderr.write(`\n  Remedy: under st_5285c160's canonical-doc-hybrid regime, every surface is\n`);
  process.stderr.write(`  hand-curated (class:human-authored, owner_script:null, trigger_config.events:[]).\n`);
  process.exit(1);
}

process.stdout.write(`[check-canonical-mode] ok — ${surfaces.length} entries pass the single-mode invariant\n`);
process.exit(0);
