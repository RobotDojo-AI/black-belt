#!/usr/bin/env node
/**
 * smart-quarantine-find-writer.js — CLI wrapper for the source-finder cascade.
 *
 * Given a misplaced file's current path (oldLiteral) and proposed canonical
 * path (newLiteral), find the source file that emits the old literal so a
 * caller (or human) can patch it.
 *
 * Usage:
 *   node scripts/smart-quarantine-find-writer.js --old <path> --new <path> [--file <path>]
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWriter } from '../lib/quarantine/source-finder/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function parseArgs(argv) {
  const opts = { oldLiteral: null, newLiteral: null, filePath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--old') opts.oldLiteral = argv[++i];
    else if (a === '--new') opts.newLiteral = argv[++i];
    else if (a === '--file') opts.filePath = argv[++i];
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.oldLiteral) {
  console.error('Usage: --old <path> [--new <path>] [--file <path>]');
  process.exit(2);
}

const result = findWriter({
  oldLiteral: opts.oldLiteral,
  newLiteral: opts.newLiteral,
  repoRoot: REPO_ROOT,
  filePath: opts.filePath || opts.oldLiteral,
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
