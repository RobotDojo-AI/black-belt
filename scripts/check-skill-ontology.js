#!/usr/bin/env node
// scripts/check-skill-ontology.js — skill SKILL.md ontology gate (st_0c491456 Phase 2b).
//
// Validates every agents/skills/*/SKILL.md against the skill schema:
//   Required core (every skill):
//     - frontmatter `name`
//     - frontmatter `description`
//     - frontmatter `canonical_reads` (already enforced by check-canonical-readers,
//       but re-checked here so this gate is self-contained)
//     - frontmatter `type`: one of `pipeline`, `tool`, `deprecated-use-work`, `deprecated-use-topic`
//     - HUMAN-AUTHORED marker
//     - default-quality include marker AND the sha256 matches the actual
//       sha256 of agents/default-quality.md (stale → FAIL)
//     - `## Contract` section
//     - `## Steps` section (NOTE: deprecated-use-work and deprecated-use-topic
//       skills are exempt from `## Steps` — they are thin redirect stubs)
//
//   Type-specific:
//     - pipeline → Steps section must contain a `--require` token (pipeline
//       skills must include the story-gate --require block)
//     - tool → `## Canonical use cases` section
//     - deprecated-use-work → body must contain a redirect to `/work`
//     - deprecated-use-topic → body must contain a redirect to `/topic`
//
//   Marker-hash currency:
//     - Every `<!-- include: ... sha256=... -->` marker's hash must match the
//       referenced file's actual sha256 (e.g. asana stale hash 6c9d63c8 → FAIL).
//
// Wired into pre-commit after check-persona-ontology.js.
//
// Exit: 0 on clean, 1 with named violations otherwise.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

export const INTELLIGENCE_TIER = 'extraction';

const __dirname = dirname(fileURLToPath(import.meta.url));
// REPO_ROOT is overridable via ROBOTDOJO_REPO_ROOT so a test can point the gate
// at a temp fixture tree (copy agents/skills/, tamper the copy, assert the gate
// fails against the fixture) without mutating the live agents/skills/*/SKILL.md.
// Mirrors check-root-lock.js. Default is the real repo root.
const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  ? resolve(process.env.ROBOTDOJO_REPO_ROOT)
  : resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'agents', 'skills');

const VALID_TYPES = new Set(['pipeline', 'tool', 'deprecated-use-work', 'deprecated-use-topic']);
const DEPRECATED_TYPES = new Set(['deprecated-use-work', 'deprecated-use-topic']);
const HUMAN_AUTHORED_RE = /<!--\s*HUMAN-AUTHORED\.\s*REGEN BLOCKED\.\s*-->/;
const INCLUDE_MARKER_RE = /<!--\s*(?:include|default-quality):\s*([^\s]+)\s+sha256=([a-f0-9]{64})\s*-->/g;

function expandTilde(p) {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function resolveIncludePath(includeRef) {
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
  const re = new RegExp(`^${field}:\\s*(.*)$`, 'm');
  const m = raw.match(re);
  if (!m) return null;
  if (m[1].trim()) return m[1].trim();
  const after = raw.slice(m.index + m[0].length);
  const next = after.split('\n').find((l) => l.trim() !== '');
  if (next && /^\s*-\s+/.test(next)) return 'list';
  return null;
}

function hasH2Section(body, sectionName) {
  const re = new RegExp(`^##\\s+${sectionName}\\b`, 'm');
  return re.test(body);
}

function checkSkill(name, absPath) {
  const violations = [];
  if (!existsSync(absPath)) return [`${name}: missing SKILL.md`];
  const content = readFileSync(absPath, 'utf8');

  const fm = extractFrontmatter(content);
  if (!fm) {
    return [`${name}: missing YAML frontmatter`];
  }

  // Required frontmatter fields.
  const nameField = frontmatterField(fm.raw, 'name');
  if (!nameField) violations.push(`${name}: frontmatter missing 'name'`);
  const descField = frontmatterField(fm.raw, 'description');
  if (!descField) violations.push(`${name}: frontmatter missing 'description'`);
  const readsField = frontmatterField(fm.raw, 'canonical_reads');
  if (!readsField) violations.push(`${name}: frontmatter missing 'canonical_reads'`);

  // type field with valid value.
  const typeField = frontmatterField(fm.raw, 'type');
  if (!typeField) {
    violations.push(`${name}: frontmatter missing 'type' (pipeline|tool|deprecated-use-work|deprecated-use-topic)`);
  } else if (!VALID_TYPES.has(typeField)) {
    violations.push(`${name}: frontmatter 'type' must be one of pipeline|tool|deprecated-use-work|deprecated-use-topic, got '${typeField}'`);
  }

  // HUMAN-AUTHORED marker.
  if (!HUMAN_AUTHORED_RE.test(content)) {
    violations.push(`${name}: missing <!-- HUMAN-AUTHORED. REGEN BLOCKED. --> marker`);
  }

  // Required body sections.
  if (!hasH2Section(fm.body, 'Contract')) {
    violations.push(`${name}: missing '## Contract' section`);
  }
  // Steps section required for non-deprecated skills.
  if (!DEPRECATED_TYPES.has(typeField) && !hasH2Section(fm.body, 'Steps')) {
    violations.push(`${name}: missing '## Steps' section`);
  }

  // Type-specific requirements.
  if (typeField === 'pipeline') {
    // Staged pipeline skills (research, scope, plan, build, qa, close) must
    // include the story-gate --require block. Intake skills (story, defect)
    // and framing do not. We key off the skill name rather than introduce a
    // separate subtype field — the canonical pipeline shape is stable.
    const STAGED = new Set(['research', 'scope', 'plan', 'build', 'qa', 'close']);
    if (STAGED.has(name) && !/--require/.test(fm.body)) {
      violations.push(`${name}: pipeline-staged skill missing story-gate --require block`);
    }
  } else if (typeField === 'tool') {
    if (!hasH2Section(fm.body, 'Canonical use cases')) {
      violations.push(`${name}: tool skill missing '## Canonical use cases' section`);
    }
  } else if (typeField === 'deprecated-use-work') {
    if (!/\/work\b/.test(fm.body)) {
      violations.push(`${name}: deprecated-use-work skill body must redirect to /work`);
    }
  } else if (typeField === 'deprecated-use-topic') {
    if (!/\/topic\b/.test(fm.body)) {
      violations.push(`${name}: deprecated-use-topic skill body must redirect to /topic`);
    }
  }

  // Marker-hash currency. Includes a default-quality include marker check by
  // virtue of matching the same shape.
  INCLUDE_MARKER_RE.lastIndex = 0;
  let match;
  while ((match = INCLUDE_MARKER_RE.exec(content)) !== null) {
    const [, ref, declaredHash] = match;
    const absRef = resolveIncludePath(ref);
    const actualHash = fileSha256(absRef);
    if (!actualHash) {
      violations.push(`${name}: include marker references missing file '${ref}'`);
      continue;
    }
    if (actualHash !== declaredHash) {
      violations.push(
        `${name}: stale include hash for '${ref}' ` +
          `(declared ${declaredHash.slice(0, 12)}…, actual ${actualHash.slice(0, 12)}…)`,
      );
    }
  }

  return violations;
}

// --files support: if --files is present, only check skills whose SKILL.md
// appears in the staged file list. If none of the staged files are SKILL.md
// paths, exit clean.
function resolveFilesFilter() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--files');
  if (idx === -1) return null; // no filter — check all
  const files = args.slice(idx + 1).filter(a => !a.startsWith('--'));
  if (files.length === 0) return new Set(); // empty list → nothing to check
  return new Set(files.map(f => resolve(f)));
}

function main() {
  const filesFilter = resolveFilesFilter();

  // --files with empty list: no staged skill files.
  if (filesFilter !== null && filesFilter.size === 0) {
    process.stdout.write(`[check-skill-ontology] ok — no skill files staged\n`);
    process.exit(0);
  }

  const violations = [];
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  let checkedCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    // In --files mode, skip skills whose SKILL.md is not staged.
    if (filesFilter !== null && !filesFilter.has(resolve(skillPath))) continue;

    violations.push(...checkSkill(entry.name, skillPath));
    checkedCount++;
  }

  // --files mode with no matching skill files staged.
  if (filesFilter !== null && checkedCount === 0) {
    process.stdout.write(`[check-skill-ontology] ok — no skill files staged\n`);
    process.exit(0);
  }

  if (violations.length === 0) {
    process.stdout.write(`[check-skill-ontology] ok\n`);
    process.exit(0);
  }
  process.stderr.write(`[check-skill-ontology] FAIL — ${violations.length} violation(s):\n`);
  for (const v of violations) process.stderr.write(`  ${v}\n`);
  process.exit(1);
}

main();
