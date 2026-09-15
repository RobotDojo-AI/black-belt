#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failOrPass, parseArgs } from './check-final-structure-lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { repoRoot, story } = parseArgs();
const errors = [];

const checks = [
  ['check-root-lock.js'],
  ['check-final-structure-root-model.js'],
  ['check-agent-os-distribution.js'],
  ['check-user-root-boundary.js'],
  ['check-final-structure-pipeline-boundary.js'],
  ['check-import-flow-boundary.js'],
  ['check-structure-migration-manifest.js', '--story', story || 'st_608fe3ed'],
  ['check-final-structure-registries.js'],
  ['check-final-structure-docs.js'],
  ['check-final-structure-path-contract.js'],
  ['check-final-structure-no-legacy-paths.js'],
  ['check-final-structure-persisted-paths.js', '--story', story || 'st_608fe3ed'],
  ['check-agent-os-fresh-clone.js', '--story', story || 'st_608fe3ed'],
  ['check-backup-recoverability.js'],
  ['check-final-structure-product-copy.js'],
];

for (const args of checks) {
  const rel = `scripts/${args[0]}`;
  const result = spawnSync(process.execPath, [join(__dirname, args[0]), ...args.slice(1), '--repo', repoRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    errors.push(`${rel} failed${output ? `:\n${output}` : ''}`);
  }
}

failOrPass('check-final-structure', errors, 'ok - final structure check suite passed');
