#!/usr/bin/env node
/**
 * claude.js — thin assembler for CLAUDE.md.
 *
 * WHY: CLAUDE.md is always-loaded into every Claude Code context turn. It must
 * stay ≤ 200 lines of project-specific content. This script strips accumulated
 * dynamic sections and enforces the registry char budget.
 *
 * st_ae536261: writes route through `canonicalWrite` so each regen produces a
 * `canonical_versions` row (admission control + version chain). Budget read
 * from canonical-surfaces.json (max_chars), not the retired budget manifest.
 *
 * Run is idempotent — safe to execute on an already-clean file.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalWrite } from '../lib/canonical-write.js';
import { maxCharsFor } from '../lib/canonical-budget.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CLAUDE_PATH = join(REPO_ROOT, 'CLAUDE.md');

let source;
try {
  source = readFileSync(CLAUDE_PATH, 'utf8');
} catch {
  process.stderr.write(`claude.js: cannot read ${CLAUDE_PATH}\n`);
  process.exit(1);
}

// Strip accumulated dynamic sections (heading through to next ## heading or EOF).
// Global replace — handles any number of accumulated copies.
// WHY: Use [\s\S]*? (non-greedy, dotall) instead of repeated single-line groups —
// the original line-by-line approach failed to consume all duplicates reliably.
const STRIP_PATTERN = /\n## (?:Belt Tiers|Build Personas|File Budget|Tests)\n[\s\S]*?(?=\n## |$)/g;
let output = source.replace(STRIP_PATTERN, '');

// Trim trailing blank lines, ensure single trailing newline.
output = output.trimEnd() + '\n';

const maxChars = maxCharsFor('CLAUDE.md');
if (maxChars != null && output.length > maxChars) {
  process.stderr.write(
    `claude.js: CLAUDE.md exceeds budget: ${output.length} chars > ${maxChars} limit. Aborting.\n`,
  );
  process.exit(1);
}

// Route through canonicalWrite — deterministic admission control + version chain.
// canonicalWrite resolves CLAUDE.md against the registry and persists a
// canonical_versions row on accept. There is no autonomous doc writer in the
// launch architecture.
const result = await canonicalWrite('CLAUDE.md', output, {
  source: 'claude.js',
  storyId: 'st_ae536261',
});

if (!result.accepted) {
  process.stderr.write(
    `claude.js: canonicalWrite rejected: reason=${result.reason} ${JSON.stringify(result.detail || {})}\n`,
  );
  process.exit(1);
}

console.log(
  `claude.js: wrote CLAUDE.md (${output.length} chars, ${output.split('\n').length - 1} lines) — version=${result.versionId}`,
);
