#!/usr/bin/env node
// seed-canonical-genesis.js — bootstrap canonical_versions chain for every
// in-scope registry surface that does not yet have a genesis row.
//
// Story st_ae536261 follow-up: after a fresh DB or migration, every registered
// canonical surface needs a genesis row so subsequent canonicalWrite() calls
// don't reject with reason=no-prior-row.
//
// CLI:
//   node scripts/seed-canonical-genesis.js [--dry-run] [--skip-judge]
//
// Exit:
//   0 on success or already-seeded
//   1 on registry / file-read failure
//
// Tier: orchestration (delegates to canonicalGenesis which is admission-controlled).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { canonicalGenesis } from '../lib/canonical-write.js';

export const INTELLIGENCE_TIER = 'orchestration';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const REGISTRY_PATH = join(REPO_ROOT, 'architecture/surfaces.json');

function expandPath(p) {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p.startsWith('/')) return p;
  return join(REPO_ROOT, p);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipJudge = args.includes('--skip-judge');

const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));

let seeded = 0, skipped = 0, missing = 0, failed = 0;

for (const entry of registry.surfaces) {
  if (entry.class === 'log') { skipped++; continue; }

  const filePath = expandPath(entry.path);
  if (!existsSync(filePath)) {
    process.stdout.write(`[seed] MISSING  ${entry.path}\n`);
    missing++;
    continue;
  }

  const content = readFileSync(filePath, 'utf8');
  if (dryRun) {
    process.stdout.write(`[seed] DRY-RUN  ${entry.path} (${Buffer.byteLength(content, 'utf8')}B)\n`);
    continue;
  }

  const r = await canonicalGenesis(entry.path, content, 'seed-canonical-genesis', { skipJudge });
  if (r.ok) {
    process.stdout.write(`[seed] SEEDED   ${entry.path}\n`);
    seeded++;
  } else if (r.reason === 'genesis-exists') {
    process.stdout.write(`[seed] EXISTS   ${entry.path}\n`);
    skipped++;
  } else {
    process.stdout.write(`[seed] FAIL     ${entry.path} — ${r.reason}${r.error ? ': ' + r.error : ''}\n`);
    failed++;
  }
}

process.stdout.write(`\n[seed-canonical-genesis] seeded=${seeded} skipped=${skipped} missing=${missing} failed=${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
