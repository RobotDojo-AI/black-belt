#!/usr/bin/env node
/**
 * scripts/check-backup-recoverability.js — the pre-commit tripwire.
 *
 * Every non-tracked file must be GCP-backed or explicitly regenerable. The
 * classification rule itself lives in lib/backup-coverage.js so this gate, the
 * MECE audit, and the running backup guardian cannot drift apart — the drift
 * between two hand-maintained copies is what produced the live false positive
 * on `config/source-topic-routing.user.json`.
 *
 * This stays an INDEPENDENT tripwire, not verification of whatever rule the
 * backup implements: it derives its expected set from git and the filesystem at
 * run time and holds no list of its own.
 *
 * Compute tier 0 — `git` and bounded file reads. No LLM call.
 */
export const INTELLIGENCE_TIER = 'extraction';

import { resolve } from 'node:path';
import { auditCoverage, discoverPrivateConfigFiles } from '../lib/backup-coverage.js';
import { PRIVATE_DATA_FILES, PRIVATE_DATA_ROOTS } from '../lib/private-data-roots.js';

function parseArgs(argv = process.argv) {
  const out = { repoRoot: process.env.ROBOTDOJO_REPO_ROOT ? resolve(process.env.ROBOTDOJO_REPO_ROOT) : resolve(import.meta.dirname, '..') };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--repo') out.repoRoot = resolve(argv[++i]);
  }
  return out;
}

// Whole-directory GCP roots. config/docs/.backup/quarantine were removed here
// (st_e0776b46): config/'s secrets are DERIVED now (df_3df1f108 — every
// gitignored file directly under config/ is bucket-covered by pattern, so the
// enumeration cannot go stale); .backup/quarantine never existed on disk.
// Keep this list in lockstep with PRIVATE_DATA_ROOTS in lib/private-data-roots.js.
const REQUIRED_GCP_ROOTS = [
  '.claude',
  'user',
  'pipeline',
  'code',
];

const REQUIRED_GCP_FILES = [
  '.env',
  '.env.local',
  'identity.json',
  'identity.local.json',
  'lib/migrations/024_topic_hierarchy.sql',
  'lib/migrations/025_topic_sort_order.sql',
  'scripts/asana-sync.py',
  'scripts/import-oura-json.js',
  'scripts/import-pdf-labs-batch.js',
  'scripts/qa/diag-chat-live.mjs',
  'gateway/infra/terraform.tfvars',
  'gateway/infra/tfplan',
  'gateway/infra/.terraform/terraform.tfstate',
];

function validateBackupPolicy(errors) {
  const roots = new Set(PRIVATE_DATA_ROOTS.map((root) => root.local.replace(/\/$/, '')));
  for (const root of REQUIRED_GCP_ROOTS) {
    if (!roots.has(root)) errors.push(`GCP root missing from PRIVATE_DATA_ROOTS: ${root}`);
  }

  const files = new Set(PRIVATE_DATA_FILES.map((file) => file.local));
  for (const file of REQUIRED_GCP_FILES) {
    if (!files.has(file)) errors.push(`GCP file missing from PRIVATE_DATA_FILES: ${file}`);
  }
}

function main() {
  const { repoRoot } = parseArgs();
  const errors = [];
  validateBackupPolicy(errors);

  const audit = auditCoverage(repoRoot);
  if (audit.uncovered.length) {
    const named = audit.uncovered.slice(0, 80)
      .map((p) => `  ${p}${audit.reasons.get(p) ? ` — ${audit.reasons.get(p)}` : ''}`)
      .join('\n');
    errors.push(`unrecoverable ignored files (${audit.uncovered.length}):\n${named}`);
    if (audit.uncovered.length > 80) errors.push(`  ... ${audit.uncovered.length - 80} more`);
  }

  if (errors.length) {
    process.stderr.write('STOP-THE-LINE — backup recoverability is not MECE:\n');
    for (const error of errors) process.stderr.write(`- ${error}\n`);
    process.stderr.write('\nEvery non-tracked file must be GCP-backed or explicitly regenerable.\n');
    process.exit(1);
  }

  const discovered = discoverPrivateConfigFiles(repoRoot).length;
  const summary = [...audit.covered.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, count]) => `${owner}:${count}`)
    .join(' ');
  process.stdout.write(`check-backup-recoverability: clean (${audit.ignoredCount} ignored files; ${summary}; ${discovered} discovered config secret(s))\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { parseArgs, validateBackupPolicy };
