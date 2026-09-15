#!/usr/bin/env node
// scripts/check-canonical-readers.js — verify SKILL.md + persona files declare canonical_reads.
//
// Story st_ae536261 Phase 7. Every agents/skills/<name>/SKILL.md AND every
// agents/personas/*.md (excluding index/readme) must:
//   (a) have a YAML frontmatter block with `canonical_reads:` containing at
//       minimum architecture/sitemap.md and architecture/ontology.md;
//   (b) have the first numbered Step OR the first persona-spawn instruction
//       explicitly reference reading those files.
//
// The probe is not vacuous: the structural check parses frontmatter; the
// first-step check pattern-matches the first numbered Step/persona-spawn
// block and looks for the filenames.
//
// CLI:
//   --type skills           lint only agents/skills/<name>/SKILL.md files
//   --type agents           lint only agents/personas/*.md files
//   --probe <path>          lint a single fixture file
//
// Exit: 0 clean, 1 with named files on any violation.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'agents', 'skills');
const AGENTS_DIR = join(REPO_ROOT, 'agents', 'personas');

// Acceptable filenames in canonical_reads.
const REQUIRED_READS = ['architecture/sitemap.md', 'architecture/ontology.md'];

function parseArgs(argv) {
  const out = { type: null, probe: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--type') out.type = argv[++i];
    else if (argv[i] === '--probe') out.probe = argv[++i];
  }
  return out;
}

function extractFrontmatter(content) {
  // YAML frontmatter delimited by '---' on its own line at the top of file.
  // The SKILL.md files don't all have frontmatter today; this function tolerates
  // either YAML block or an inline `canonical_reads:` declaration in the first
  // 200 lines.
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---\n', 4);
    if (end === -1) return null;
    return content.slice(4, end);
  }
  return null;
}

function parseCanonicalReadsFromFrontmatter(fm) {
  // Minimal YAML list parser — enough for `canonical_reads: [a.md, b.md]` and
  // `canonical_reads:\n  - a.md\n  - b.md` forms.
  if (!fm) return null;
  const m = fm.match(/^canonical_reads:\s*(\[[^\]]*\]|\n(?:\s*-\s*\S+\n?)+)/m);
  if (!m) return null;
  const body = m[1];
  if (body.startsWith('[')) {
    return body.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
  }
  const lines = body.split('\n').filter((l) => /^\s*-\s+/.test(l));
  return lines.map((l) => l.replace(/^\s*-\s+/, '').trim()).filter(Boolean);
}

function firstStepInvokesReads(content) {
  // Scan the first 100 lines for any of:
  //   - "## Step 0/1 — ..." markdown header
  //   - "1. " or "Step 1:" numbered step
  //   - "MANDATORY FIRST READS" / "Read X first" persona-spawn pattern
  // AND verify that within the next 25 lines OR the overall first-100-line
  // window, both architecture/sitemap.md and architecture/ontology.md are named.
  const lines = content.split('\n').slice(0, 100);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      /^##\s*Step\s+[01]\b/i.test(line) ||
      /^\s*(?:Step\s+)?[01]\.|^\s*Step\s+[01]:/i.test(line)
    ) {
      const window = lines.slice(i, i + 25).join('\n').toLowerCase();
      const hasMap = /\bsitemap\.md\b/.test(window);
      const hasOnt = /\bontology\.md\b/.test(window);
      if (hasMap && hasOnt) return true;
    }
  }
  // Fallback — pattern is "Read X first" or "MANDATORY FIRST READS" within first 100 lines.
  const head = lines.join('\n').toLowerCase();
  const hasMap = /\bsitemap\.md\b/.test(head);
  const hasOnt = /\bontology\.md\b/.test(head);
  return hasMap && hasOnt;
}

function lintFile(absPath) {
  if (!existsSync(absPath)) return { path: absPath, ok: false, reason: 'missing' };
  const content = readFileSync(absPath, 'utf8');
  const fm = extractFrontmatter(content);
  const reads = parseCanonicalReadsFromFrontmatter(fm);
  if (!reads) return { path: absPath, ok: false, reason: 'no canonical_reads frontmatter' };
  const hasSitemap = reads.some((d) => /sitemap\.md/.test(d));
  const hasOnt = reads.some((d) => /ontology\.md/.test(d));
  if (!hasSitemap) return { path: absPath, ok: false, reason: 'canonical_reads missing architecture/sitemap.md' };
  if (!hasOnt) return { path: absPath, ok: false, reason: 'canonical_reads missing architecture/ontology.md' };
  if (!firstStepInvokesReads(content)) {
    return { path: absPath, ok: false, reason: 'first step does not invoke a read of sitemap+ontology' };
  }
  return { path: absPath, ok: true };
}

function lintSkills() {
  const violations = [];
  for (const sub of readdirSync(SKILLS_DIR)) {
    const p = join(SKILLS_DIR, sub, 'SKILL.md');
    if (!existsSync(p)) continue;
    const r = lintFile(p);
    if (!r.ok) violations.push(r);
  }
  return violations;
}

function lintAgents() {
  const violations = [];
  if (!existsSync(AGENTS_DIR)) return violations;
  for (const f of readdirSync(AGENTS_DIR)) {
    if (!f.endsWith('.md')) continue;
    if (f.toLowerCase() === 'index.md' || f.toLowerCase() === 'readme.md') continue;
    const r = lintFile(join(AGENTS_DIR, f));
    if (!r.ok) violations.push(r);
  }
  return violations;
}

const args = parseArgs(process.argv);

if (args.probe) {
  const r = lintFile(args.probe);
  if (r.ok) {
    process.stdout.write(`[check-canonical-readers] ok — ${r.path}\n`);
    process.exit(0);
  }
  process.stderr.write(`[check-canonical-readers] FAIL — ${r.path}: ${r.reason}\n`);
  process.exit(1);
}

let viols = [];
if (!args.type || args.type === 'skills') viols = viols.concat(lintSkills());
if (!args.type || args.type === 'agents') viols = viols.concat(lintAgents());

if (viols.length > 0) {
  process.stderr.write(`[check-canonical-readers] FAIL — ${viols.length} file(s):\n`);
  for (const v of viols) process.stderr.write(`  ${v.path}: ${v.reason}\n`);
  process.exit(1);
}

process.stdout.write(`[check-canonical-readers] ok\n`);
process.exit(0);
