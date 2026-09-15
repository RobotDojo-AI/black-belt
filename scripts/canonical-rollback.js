#!/usr/bin/env node
// scripts/canonical-rollback.js — restore a canonical surface to a prior sha.
//
// Story st_a78848a0. Walks canonical_versions for the path; if the target sha
// is reachable, recovers content from canonical_versions_quarantine or the
// current on-disk file (when it already matches the target). Otherwise the
// caller must pipe content on stdin or supply --content-file.
//
// Usage:
//   node scripts/canonical-rollback.js <path> <target_content_sha256>
//   node scripts/canonical-rollback.js <path> <sha> --content-file=<file>
//   cat content.md | node scripts/canonical-rollback.js <path> <sha> --stdin
//
// The new row is regen_source='rollback' and allowShrink is enabled.

import { readFileSync } from 'node:fs';
import { canonicalRollback } from '../lib/canonical-write.js';

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const eq = a.indexOf('=');
    return eq < 0 ? [a.slice(2), true] : [a.slice(2, eq), a.slice(eq + 1)];
  }),
);

const [path, targetSha] = positional;
if (!path || !targetSha) {
  process.stderr.write('usage: canonical-rollback.js <path> <target_sha> [--content-file=<f>] [--stdin]\n');
  process.exit(2);
}

let content = null;
if (flags['content-file']) {
  content = readFileSync(flags['content-file'], 'utf8');
} else if (flags.stdin) {
  content = readFileSync(0, 'utf8');
}

const r = await canonicalRollback(path, targetSha, content);
if (!r.ok) {
  process.stderr.write(`rollback failed: ${r.reason}` + (r.hint ? `\nhint: ${r.hint}` : '') + '\n');
  process.exit(1);
}

process.stdout.write(`rolled back ${path} to ${targetSha}; new row sha ${r.newRowSha}\n`);
process.exit(0);
