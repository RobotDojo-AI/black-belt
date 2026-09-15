#!/usr/bin/env node
/**
 * generate-ontology.js — deterministic generator for architecture/ontology.md.
 *
 * Same pattern as scripts/generate-sitemap.js: Tier 0 (no LLM, no network I/O),
 * hard cap, --check / --write / default-print modes, refuses to write on overflow.
 *
 * Data source: config/root-allowlist.lock.json (human-approved root lock).
 * Filesystem source: walks the repo root only to validate against the lock.
 *
 * Drift detection at generate time:
 *   - Directory on disk NOT declared in root lock → ERROR
 *   - Required directory in root lock NOT on disk → ERROR
 *
 * Run:
 *   node scripts/generate-ontology.js              # print to stdout
 *   node scripts/generate-ontology.js --check      # report size + drift
 *   node scripts/generate-ontology.js --write      # write architecture/ontology.md if under cap and no drift
 *
 * Replaces the old generated structure map.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRootLock } from './root-lock-lib.js';
import { maxCharsFor } from '../lib/canonical-budget.js';

export const INTELLIGENCE_TIER = 'extraction';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
// Same single-source rule as generate-sitemap.js (st_dd0e19d8): the cap comes
// from architecture/surfaces.json, the registry check-doc-budget.js enforces at
// pre-commit. The literal that used to live here read 14000 while the enforced
// budget was 10000 — the identical drift, one file over.
const MAX_CHARS = (() => {
  const env = parseInt(process.env.GENERATE_ONTOLOGY_MAX_CHARS || '', 10);
  if (Number.isFinite(env) && env > 0) return env;
  const registered = maxCharsFor('architecture/ontology.md');
  if (registered == null) {
    process.stderr.write(
      'FAIL: architecture/ontology.md has no max_chars in architecture/surfaces.json, so no cap is enforced '
        + 'at pre-commit. Register it there (a raise needs the owner countersign — scripts/check-doc-budget-raise.js) '
        + 'or set GENERATE_ONTOLOGY_MAX_CHARS for a one-off run.\n'
    );
    process.exit(1);
  }
  return registered;
})();
const OUTPUT = join(REPO_ROOT, 'architecture/ontology.md');
const args = process.argv.slice(2);
const mode = args.includes('--write') ? 'write' : args.includes('--check') ? 'check' : 'print';

const rootLock = loadRootLock(REPO_ROOT);

// ── Drift detection ─────────────────────────────────────────────────────────
function detectDrift() {
  const onDisk = readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map(e => e.name + '/')
    .sort();
  const declared = new Set(Object.entries(rootLock.entries || {})
    .filter(([, entry]) => entry.type === 'dir' && !entry.hidden && entry.class !== 'regenerable')
    .map(([name]) => `${name}/`));
  const undeclared = onDisk.filter(d => !declared.has(d));
  const requiredMissing = Object.entries(rootLock.entries || {})
    .filter(([name, entry]) => entry.type === 'dir' && entry.required && entry.class !== 'regenerable' && !existsSync(join(REPO_ROOT, name)));
  return { onDisk, undeclared, requiredMissing: requiredMissing.map(([name]) => `${name}/`) };
}

// ── Render ──────────────────────────────────────────────────────────────────
function render() {
  const date = new Date().toISOString().slice(0, 10);
  const entries = rootLock.entries || {};
  const { requiredMissing } = detectDrift();

  const parts = [];

  parts.push(`# Repository Ontology`);
  parts.push('');
  parts.push(`_Generated ${date} by \`scripts/generate-ontology.js\` (deterministic; no LLM). Source of truth: \`config/root-allowlist.lock.json\`._`);
  parts.push('');
  parts.push(`Every top-level directory has a single defined purpose. \`scripts/check-root-lock.js\` and \`scripts/gate.js\` enforce this pre-commit. To add a new top-level directory, the owner must approve an exact edit to \`config/root-allowlist.lock.json\`.`);
  parts.push('');
  parts.push(`**Quarantine rule:** Any file or directory that lands at root outside the allowlist auto-moves to \`quarantine/\` and the build breaks. Resolve by routing to correct location — quarantine is a stop-the-line signal, not a parking lot.`);
  parts.push('');

  // Directory table
  parts.push(`## Top-Level Directories`);
  parts.push('');
  parts.push(`| Directory | Purpose | Belongs | Does NOT belong |`);
  parts.push(`|-----------|---------|---------|-----------------|`);
  const dirKeys = Object.entries(entries)
    .filter(([, entry]) => entry.type === 'dir' && !entry.hidden && entry.class !== 'regenerable')
    .map(([name]) => `${name}/`)
    .filter(d => !requiredMissing.includes(d))
    .sort();
  for (const d of dirKeys) {
    const e = entries[d.replace(/\/$/, '')];
    parts.push(`| \`${d}\` | ${e.purpose} | ${e.belongs} | ${e.doesNotBelong} |`);
  }
  parts.push('');

  // Top-level files
  parts.push(`## Top-Level Files`);
  parts.push('');
  parts.push(`Files approved at root by Node.js, npm, Vercel, GitHub, install, test, or lock conventions. Nothing else.`);
  parts.push('');
  parts.push(`| File | Purpose | Required |`);
  parts.push(`|------|---------|----------|`);
  const files = Object.entries(entries)
    .filter(([name, entry]) => entry.type === 'file' && entry.class === 'github' && (entry.required || existsSync(join(REPO_ROOT, name))))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); // code-point, OS-stable (not locale-sensitive)
  for (const [file, entry] of files) {
    parts.push(`| \`${file}\` | ${entry.purpose} | ${entry.required ? 'Yes' : 'No'} |`);
  }
  parts.push('');

  // Rules (static prose — embedded; rare to change)
  parts.push(`## Rules`);
  parts.push('');
  parts.push(`1. No planning docs at root. Plans live inside the owning story, defect, or workbench.`);
  parts.push(`2. No catch-all directories. A directory named \`misc/\`, \`tmp/\`, \`stuff/\` accumulates entropy. Name directories by what they contain.`);
  parts.push(`3. No loose scripts at root. One-off scripts go in \`scripts/\`. Subsystem-owned scripts live inside that subsystem.`);
  parts.push(`4. \`scripts/\` subdirs are action-named: \`scripts/ingest/\`, \`scripts/qa/\` — not \`scripts/pipeline/\` (ambiguous with \`pipeline/\`).`);
  parts.push(`5. Adding a new top-level directory requires owner approval and an exact edit to \`config/root-allowlist.lock.json\`.`);
  parts.push(`6. Quarantine is a stop-the-line signal, not a parking lot. A file in \`quarantine/\` means the architecture is violated.`);
  parts.push(`7. Private user substrate lives under \`user/\`: \`user/files/\` for source evidence, \`user/contexts/\` for compact context packages, and \`user/workbenches/\` for deep working sets.`);

  return parts.join('\n') + '\n';
}

// ── Main ────────────────────────────────────────────────────────────────────
const drift = detectDrift();
const out = render();
const size = Buffer.byteLength(out, 'utf8');

function normalizeForFreshness(text) {
  return String(text)
    .replace(/^_Generated \d{4}-\d{2}-\d{2} by `scripts\/generate-ontology\.js`/m,
      '_Generated <date> by `scripts/generate-ontology.js`');
}

if (mode === 'check') {
  process.stdout.write(`generate-ontology: would-be size ${size} bytes (max ${MAX_CHARS})\n`);
  if (drift.undeclared.length > 0) {
    process.stderr.write(`\nFAIL: ${drift.undeclared.length} top-level directories on disk are NOT declared in config/root-allowlist.lock.json:\n`);
    for (const d of drift.undeclared) process.stderr.write(`  ${d}\n`);
    process.stderr.write(`  Remedy: move/remove the directory, or get owner approval for a root-lock edit.\n`);
    process.exit(1);
  }
  if (drift.requiredMissing.length > 0) {
    process.stderr.write(`\nFAIL: ${drift.requiredMissing.length} required root directories are missing:\n`);
    for (const d of drift.requiredMissing) process.stderr.write(`  ${d}\n`);
    process.exit(1);
  }
  if (size > MAX_CHARS) {
    process.stderr.write(`\nFAIL: ${size} exceeds ${MAX_CHARS} by ${size - MAX_CHARS}. Trim purposes/belongs in config/root-allowlist.lock.json.\n`);
    process.exit(1);
  }
  let current = '';
  try { current = readFileSync(OUTPUT, 'utf8'); } catch (e) {
    process.stderr.write(`\nFAIL: cannot read architecture/ontology.md for freshness check: ${e.message}\n`);
    process.exit(1);
  }
  if (normalizeForFreshness(current) !== normalizeForFreshness(out)) {
    process.stderr.write(`\nFAIL: architecture/ontology.md is stale. Run: node scripts/generate-ontology.js --write\n`);
    process.exit(1);
  }
  process.stdout.write(`ok: within cap (${MAX_CHARS - size} bytes headroom); ${drift.requiredMissing.length} required-missing, ${drift.undeclared.length} undeclared\n`);
  process.exit(0);
}

if (drift.undeclared.length > 0) {
  process.stderr.write(`FAIL: ${drift.undeclared.length} undeclared top-level directories. Re-run with --check for details.\n`);
  process.exit(1);
}
if (drift.requiredMissing.length > 0) {
  process.stderr.write(`FAIL: ${drift.requiredMissing.length} required root directories missing. Re-run with --check for details.\n`);
  process.exit(1);
}
if (size > MAX_CHARS) {
  process.stderr.write(`FAIL: would-be size ${size} exceeds cap ${MAX_CHARS} by ${size - MAX_CHARS}. Did not write architecture/ontology.md.\n`);
  process.exit(1);
}

if (mode === 'write') {
  writeFileSync(OUTPUT, out);
  process.stdout.write(`architecture/ontology.md written: ${size} bytes (${MAX_CHARS - size} bytes headroom)\n`);
  process.exit(0);
}

process.stdout.write(out);
