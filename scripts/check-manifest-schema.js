#!/usr/bin/env node
/**
 * check-manifest-schema.js — validate the JSONL manifest.
 *
 * Reads the manifest, verifies every line has all required fields, exits 0 on
 * success or non-zero with the offending line.
 *
 * Usage:
 *   node scripts/check-manifest-schema.js <path> [--min-entries N]
 */

import { readEntries, REQUIRED_FIELDS } from '../lib/quarantine/manifest.js';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function parseArgs(argv) {
  const opts = { path: null, minEntries: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-entries') opts.minEntries = parseInt(argv[++i], 10);
    else if (!a.startsWith('--')) opts.path = a;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.path) {
  console.error('Usage: check-manifest-schema.js <path> [--min-entries N]');
  process.exit(2);
}

// Allow a missing manifest at min-entries 0 (live system not yet populated).
if (!existsSync(opts.path)) {
  if (opts.minEntries === null || opts.minEntries === 0) {
    // Touch the file (create empty)
    try {
      mkdirSync(dirname(opts.path), { recursive: true });
      writeFileSync(opts.path, '', 'utf8');
    } catch {}
    console.log(`check-manifest-schema: ok (0 entries, accepted: --min-entries=${opts.minEntries ?? 0})`);
    process.exit(0);
  }
  console.error(`manifest not found: ${opts.path}`);
  process.exit(1);
}

let entries;
try {
  entries = readEntries(opts.path);
} catch (err) {
  console.error(`manifest unreadable: ${err.message}`);
  process.exit(1);
}

if (opts.minEntries !== null && entries.length < opts.minEntries) {
  console.error(`manifest has ${entries.length} entries; expected ≥ ${opts.minEntries}`);
  process.exit(1);
}

let bad = 0;
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  for (const f of REQUIRED_FIELDS) {
    if (!(f in e)) {
      console.error(`line ${i + 1}: missing field "${f}"`);
      bad++;
    }
  }
}

if (bad > 0) {
  console.error(`manifest schema check failed: ${bad} missing fields`);
  process.exit(1);
}

console.log(`check-manifest-schema: ok (${entries.length} entries)`);
process.exit(0);
