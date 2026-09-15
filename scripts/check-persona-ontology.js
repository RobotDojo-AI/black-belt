#!/usr/bin/env node
// scripts/check-persona-ontology.js — persona file ontology gate (st_0c491456 Phase 2a).
//
// Validates every agents/personas/*.md against the fixed persona schema:
//   (1) YAML frontmatter present with required fields:
//       name, kanji, role, description, model, tools|disallowedTools, canonical_reads
//   (2) Exactly 8 body sections in fixed order:
//       Identity → Mentor → North star → Capabilities → Failure modes →
//       Output contract → Quality bar → Stop rules
//       (matched against `### {Section}` headings, with exact text — no
//       "Mentor — the owner" variants, no extras like "How the owner reads ...")
//   (3) HUMAN-AUTHORED marker present
//   (4) default-quality include marker present and its sha256 matches the
//       actual sha256 of agents/default-quality.md (stale hash → FAIL)
//   (5) Other <!-- include: ... sha256=... --> markers must also match the
//       referenced file's actual sha256 (marker-hash currency)
//   (6) The roster is exactly the canonical six personas:
//       Miyagi, Tantei, Hakase, Ori, Katagami, Bunshin. No 7th unsanctioned
//       persona file in agents/personas/.
//
// Wired into pre-commit immediately after check-canonical-readers.js (each
// persona must already declare canonical_reads; this gate inspects the body).
//
// Exit: 0 if all personas pass, 1 with named violations otherwise.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { INCLUDE_MARKER_RE } from '../lib/agent-personas.js';

export const INTELLIGENCE_TIER = 'extraction';

const __dirname = dirname(fileURLToPath(import.meta.url));
// REPO_ROOT is overridable via ROBOTDOJO_REPO_ROOT so a test can point the gate
// at a temp fixture tree (copy agents/, tamper the copy, assert the gate fails
// against the fixture) without mutating the live agents/personas/*.md. Mirrors
// the existing check-root-lock.js ROBOTDOJO_REPO_ROOT pattern. Default is the
// real repo root resolved from this script's location. The include-marker
// sha256 currency check still resolves include paths against this same root, so
// a fixture that copies agents/ + agents/default-quality.md verifies coherently.
const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  ? resolve(process.env.ROBOTDOJO_REPO_ROOT)
  : resolve(__dirname, '..');
const PERSONAS_DIR = join(REPO_ROOT, 'agents', 'personas');

// Canonical roster — exactly these six files, no others.
const CANONICAL_PERSONAS = ['Miyagi', 'Tantei', 'Hakase', 'Ori', 'Katagami', 'Bunshin'];

// Required body sections in fixed order. Match `### <Section>` headings
// EXACTLY — no "Mentor — the owner" variants, no extras.
const REQUIRED_SECTIONS = [
  'Identity',
  'Mentor',
  'North star',
  'Capabilities',
  'Failure modes',
  'Output contract',
  'Quality bar',
  'Stop rules',
];

// Required frontmatter fields. tools|disallowedTools accepted as a pair
// (at least one of the two must appear).
const REQUIRED_FRONTMATTER_FIELDS = ['name', 'kanji', 'role', 'description', 'model', 'canonical_reads'];

const HUMAN_AUTHORED_RE = /<!--\s*HUMAN-AUTHORED\.\s*REGEN BLOCKED\.\s*-->/;
// INCLUDE_MARKER_RE now lives in lib/agent-personas.js (st_463b0bf6 — shared
// with resyncPersonaFragment/verifyFragmentConsistency, not re-derived here).

function expandTilde(p) {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function resolveIncludePath(includeRef) {
  // Includes may be tilde-prefixed (`~/robotdojo/...`) or repo-relative.
  // WHY: `~/robotdojo/...` refs re-root at REPO_ROOT — the tree under test —
  // not the operator's main checkout. The REPO_ROOT comment above already
  // promises this ("include paths against this same root"), but tilde refs
  // used to escape to the main checkout's WORKING TREE, so a parallel
  // session's uncommitted voice-fragment WIP could fail (or pass) this gate
  // from inside a worktree or fixture (st_16555ba1 failure class). In the
  // main checkout REPO_ROOT === ~/robotdojo, so behavior there is unchanged.
  const repoTilde = '~/robotdojo/';
  if (includeRef.startsWith(repoTilde)) return resolve(REPO_ROOT, includeRef.slice(repoTilde.length));
  const expanded = expandTilde(includeRef);
  if (expanded.startsWith('/')) return expanded;
  return resolve(REPO_ROOT, expanded);
}

function fileSha256(absPath) {
  if (!existsSync(absPath)) return null;
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function extractFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return null;
  return { raw: content.slice(4, end), body: content.slice(end + 5) };
}

function frontmatterField(raw, field) {
  // Match `field:` either as a single-line scalar, inline list `[...]`, or
  // block list with `-` items beneath. Returns truthy if any value is present.
  const re = new RegExp(`^${field}:\\s*(.*)$`, 'm');
  const m = raw.match(re);
  if (!m) return null;
  if (m[1].trim()) return m[1].trim();
  // Block list — look at the next non-blank line.
  const after = raw.slice(m.index + m[0].length);
  const next = after.split('\n').find((l) => l.trim() !== '');
  if (next && /^\s*-\s+/.test(next)) return 'list';
  return null;
}

function extractSections(body) {
  // Return the ordered list of `### <text>` headings in the body, with
  // trimmed text (no leading "###"). The fragment-include blocks contain
  // `## Style`, `## Anti-patterns` etc. which are `##` not `###` and so
  // are correctly excluded.
  const lines = body.split('\n');
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^###\s+(.+?)\s*$/);
    if (m) sections.push({ text: m[1].trim(), line: i + 1 });
  }
  return sections;
}

function checkPersona(absPath, displayName) {
  const violations = [];
  if (!existsSync(absPath)) {
    return [`${displayName}.md: missing file at ${absPath}`];
  }
  const content = readFileSync(absPath, 'utf8');

  // (1) Frontmatter
  const fm = extractFrontmatter(content);
  if (!fm) {
    violations.push(`${displayName}.md: missing YAML frontmatter`);
    return violations;
  }
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!frontmatterField(fm.raw, field)) {
      violations.push(`${displayName}.md: frontmatter missing '${field}'`);
    }
  }
  // tools OR disallowedTools must exist (both is fine).
  if (!frontmatterField(fm.raw, 'tools') && !frontmatterField(fm.raw, 'disallowedTools')) {
    violations.push(`${displayName}.md: frontmatter missing 'tools' or 'disallowedTools'`);
  }

  // (3) HUMAN-AUTHORED marker on the persona's own source header.
  // Included voice fragments also carry HUMAN-AUTHORED markers; those do not
  // satisfy the persona file's source marker contract.
  const firstInclude = fm.body.search(/<!--\s*(?:include|default-quality):|<!--\s*fragment:start|^###\s+Identity/m);
  const ownHeader = firstInclude >= 0 ? fm.body.slice(0, firstInclude) : fm.body;
  if (!HUMAN_AUTHORED_RE.test(ownHeader)) {
    violations.push(`${displayName}.md: missing <!-- HUMAN-AUTHORED. REGEN BLOCKED. --> marker`);
  }

  // (2) Body sections in fixed order
  const sections = extractSections(fm.body);
  const sectionTexts = sections.map((s) => s.text);
  if (sectionTexts.length !== REQUIRED_SECTIONS.length) {
    violations.push(
      `${displayName}.md: expected ${REQUIRED_SECTIONS.length} ### sections, found ${sectionTexts.length} ` +
        `(${sectionTexts.join(' | ') || 'none'})`,
    );
  } else {
    for (let i = 0; i < REQUIRED_SECTIONS.length; i++) {
      if (sectionTexts[i] !== REQUIRED_SECTIONS[i]) {
        violations.push(
          `${displayName}.md: section ${i + 1} must be '### ${REQUIRED_SECTIONS[i]}', found '### ${sectionTexts[i]}'`,
        );
      }
    }
  }

  // (4) + (5) include-marker hashes must match actual file sha256.
  INCLUDE_MARKER_RE.lastIndex = 0;
  let match;
  while ((match = INCLUDE_MARKER_RE.exec(content)) !== null) {
    const [, ref, declaredHash] = match;
    const absRef = resolveIncludePath(ref);
    const actualHash = fileSha256(absRef);
    if (!actualHash) {
      violations.push(`${displayName}.md: include marker references missing file '${ref}'`);
      continue;
    }
    if (actualHash !== declaredHash) {
      violations.push(
        `${displayName}.md: stale include hash for '${ref}' ` +
          `(declared ${declaredHash.slice(0, 12)}…, actual ${actualHash.slice(0, 12)}…)`,
      );
    }
  }

  return violations;
}

function checkRoster() {
  const present = readdirSync(PERSONAS_DIR)
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.replace(/\.md$/, ''))
    .sort();
  const canonical = [...CANONICAL_PERSONAS].sort();
  const violations = [];
  const missing = canonical.filter((n) => !present.includes(n));
  const extras = present.filter((n) => !canonical.includes(n));
  if (missing.length) violations.push(`personas/: missing canonical persona file(s): ${missing.join(', ')}`);
  if (extras.length) violations.push(`personas/: unsanctioned extra persona file(s): ${extras.join(', ')}`);
  return violations;
}

// --files support: if --files is present, only check persona files that appear
// in the staged file list. The roster check is still run (persona files could
// have been added or deleted). If no staged file maps to any persona path,
// exit clean — this session has no persona changes.
function resolveFilesFilter() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--files');
  if (idx === -1) return null; // no filter — check all
  const files = args.slice(idx + 1).filter(a => !a.startsWith('--'));
  if (files.length === 0) return new Set(); // --files with empty list → nothing to check
  // Resolve to absolute paths for comparison.
  return new Set(files.map(f => resolve(f)));
}

function main() {
  const filesFilter = resolveFilesFilter();

  // --files mode with empty list: no staged persona files, skip.
  if (filesFilter !== null && filesFilter.size === 0) {
    process.stdout.write(`[check-persona-ontology] ok — no persona files staged\n`);
    process.exit(0);
  }

  // Determine which personas to check.
  let personasToCheck = CANONICAL_PERSONAS;
  if (filesFilter !== null) {
    // Filter to only personas whose file appears in the staged set.
    personasToCheck = CANONICAL_PERSONAS.filter(name => {
      const absPath = join(PERSONAS_DIR, `${name}.md`);
      return filesFilter.has(absPath);
    });
    if (personasToCheck.length === 0) {
      // None of the staged files are persona files.
      process.stdout.write(`[check-persona-ontology] ok — no persona files staged\n`);
      process.exit(0);
    }
  }

  const violations = [];
  // Roster check: always run to catch unsanctioned additions/deletions.
  violations.push(...checkRoster());
  for (const name of personasToCheck) {
    const absPath = join(PERSONAS_DIR, `${name}.md`);
    violations.push(...checkPersona(absPath, name));
  }

  if (violations.length === 0) {
    process.stdout.write(`[check-persona-ontology] ok — ${personasToCheck.length} personas pass\n`);
    process.exit(0);
  }
  process.stderr.write(`[check-persona-ontology] FAIL — ${violations.length} violation(s):\n`);
  for (const v of violations) process.stderr.write(`  ${v}\n`);
  process.exit(1);
}

main();
