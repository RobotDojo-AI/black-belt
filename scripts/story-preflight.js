#!/usr/bin/env node
/**
 * story-preflight.js
 * Detects three classes of conformance issues in story directories:
 *   1. Stale files (not in canonical artifact list)
 *   2. Missing required meta fields (type)
 *   3. Stage/artifact forward-consistency drift
 *
 * Usage:
 *   story-preflight.js <story-dir-path>
 *   story-preflight.js --all-incomplete
 *
 * Output:
 *   FINDING: <message>  → stderr, exit 1 when issues found
 *   OK: <id> — clean   → stdout, exit 0 when clean
 *   SKIPPING: <reason>  → stdout, exit 0 for terminal stories
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { PIPELINE_SCHEMA_PATH, PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

// ── Canonical artifact list ────────────────────────────────────────────────

const HOME = homedir();
const SCHEMA_PATH = PIPELINE_SCHEMA_PATH;
const STORIES_BASE = PIPELINE_STORIES_DIR;

function loadCanonicalFiles() {
  try {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const stageFiles = Object.values(schema.stages ?? {}).map(s => s.file);
    // Always-valid infrastructure files
    const infra = ['meta.json', 'stage-hashes.json'];
    return new Set([...infra, ...stageFiles]);
  } catch {
    // Fallback if schema is missing
    return new Set([
      'meta.json', 'stage-hashes.json',
      '00-scope.md', '00-repro.md',
      '01-research.md', '02-plan.md', '03-build.md', '03b-criteria.md',
      '04-qa.md', '05-close.md',
    ]);
  }
}

const CANONICAL_FILES = loadCanonicalFiles();

// Terminal stages and kanbans — skip all checks
const TERMINAL_STAGES = new Set(['close-complete', 'done', 'cancelled', 'closed', 'closed-superseded', 'archived', 'absorbed', 'superseded']);
const TERMINAL_KANBANS = new Set(['done', 'cancelled', 'closed', 'closed-superseded', 'archived', 'absorbed']);

// Stage order for drift detection (most to least advanced)
// Each artifact implies the story is AT LEAST at the named stage
const ARTIFACT_STAGE_IMPLICATIONS = [
  { file: '05-close.md',    impliesAtLeast: 'close-sealed' },
  { file: '04-qa.md',       impliesAtLeast: 'qa-sealed' },
  { file: '03-build.md',    impliesAtLeast: 'build-sealed' },
  { file: '02-plan.md',     impliesAtLeast: 'plan-sealed' },
  { file: '01-research.md', impliesAtLeast: 'research-sealed' },
];

// Numeric rank for each stage (higher = more advanced)
const STAGE_RANK = {
  'init': 0,
  'work-open': 0,
  'framing-sealed': 1,
  'framing-complete': 1,
  'research-sealed': 2,
  'research-complete': 2,
  'scope-sealed': 3,
  'scope-complete': 3,
  'plan-sealed': 4,
  'plan-approved': 4,
  'build-sealed': 5,
  'build-complete': 5,
  'qa-sealed': 6,
  'qa-complete': 6,
  'close-sealed': 7,
  'close-complete': 8,
  'done': 9,
  'cancelled': 9,
  'closed': 9,
  'archived': 9,
};

function stageRank(stage) {
  return STAGE_RANK[stage] ?? -1;
}

// ── Core check logic ────────────────────────────────────────────────────────

/**
 * Run preflight checks on a single directory.
 * @returns {{ status: 'skip'|'terminal'|'ok'|'findings', reason?: string, findings?: string[], storyId: string }}
 */
function checkStoryDir(dir) {
  const dirName = basename(dir);
  const metaPath = join(dir, 'meta.json');

  // Missing meta.json — skip all checks
  if (!existsSync(metaPath)) {
    return { status: 'skip', reason: `no meta.json in ${dirName}`, storyId: dirName };
  }

  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return { status: 'findings', findings: [`meta.json is invalid JSON`], storyId: dirName };
  }

  const stage = meta.stage ?? '';
  const kanban = meta.kanban ?? '';
  const storyId = meta.story_id ?? dirName;

  // Terminal story — skip silently
  if (TERMINAL_STAGES.has(stage) || TERMINAL_KANBANS.has(kanban)) {
    return { status: 'terminal', reason: `terminal story (${stage})`, storyId };
  }

  const findings = [];

  // ── Check 1: Stale files ─────────────────────────────────────────────────
  let diskFiles = [];
  try {
    diskFiles = readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile())
      .map(d => d.name);
  } catch {
    // Cannot read dir — skip
  }

  // Glob patterns permitted alongside the explicit CANONICAL_FILES list.
  // bunshin-*.md transcripts are stage-scoped Bunshin question-presenter
  // outputs (st_44533f78). bunshin-*-findings.json files are convergence
  // detection inputs written by Bunshin retries (st_c5e0de43 AC 19).
  // Both classes are legitimate artifacts produced under the Bunshin
  // pipeline and must not trip the stale-file finding (absorbs df_b671fb73).
  const STALE_FILE_EXEMPT = (name) =>
    /^bunshin-.+\.md$/.test(name) || /^bunshin-.+\.json$/.test(name);

  for (const name of diskFiles) {
    if (!CANONICAL_FILES.has(name) && !STALE_FILE_EXEMPT(name)) {
      findings.push(`stale file: ${name}`);
    }
  }

  // ── Check 2: Missing required meta fields ────────────────────────────────
  if (meta.type == null) {
    findings.push(`meta.json missing required field: type`);
  }

  // ── Check 3: Stage/artifact forward-consistency (drift) ──────────────────
  const currentRank = stageRank(stage);

  if (diskFiles.includes('00-scope.md')) {
    try {
      const scopeText = readFileSync(join(dir, '00-scope.md'), 'utf8');
      if (scopeText.includes('## Framing') && stageRank('framing-sealed') > currentRank) {
        findings.push(`stage drift — meta.stage is '${stage}' but 00-scope.md contains sealed framing content`);
      }
    } catch {}
  }

  for (const { file, impliesAtLeast } of ARTIFACT_STAGE_IMPLICATIONS) {
    if (diskFiles.includes(file)) {
      const impliedRank = stageRank(impliesAtLeast);
      if (impliedRank > currentRank) {
        findings.push(`stage drift — meta.stage is '${stage}' but ${file} is present on disk`);
        break; // Report only the most advanced drift (first match is most advanced)
      }
    }
  }

  if (findings.length === 0) {
    return { status: 'ok', findings: [], storyId };
  }
  return { status: 'findings', findings, storyId };
}

// ── Single-dir mode ─────────────────────────────────────────────────────────

function runSingleDir(dir) {
  const result = checkStoryDir(dir);
  const { status, reason, findings, storyId } = result;

  if (status === 'skip' || status === 'terminal') {
    process.stdout.write(`SKIPPING: ${reason}\n`);
    process.exit(0);
  }

  if (status === 'ok') {
    // Include stage in OK output so grep-based checks can confirm stage was evaluated
    const stage = (() => { try { return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).stage ?? ''; } catch { return ''; } })();
    process.stdout.write(`OK: ${storyId} — clean (stage: ${stage})\n`);
    process.exit(0);
  }

  // status === 'findings'
  for (const f of findings) {
    process.stderr.write(`FINDING: ${f}\n`);
  }
  process.exit(1);
}

// ── --all-incomplete mode ───────────────────────────────────────────────────

function runAllIncomplete() {
  let dirs = [];
  try {
    dirs = readdirSync(STORIES_BASE).filter(d => /^(st|df|wk)_/.test(d));
  } catch (e) {
    if (!process.env.ROBOTDOJO_STORIES_DIR) {
      process.stdout.write('Summary: 0 stories checked, 0 findings\n');
      process.exit(0);
    }
    process.stderr.write(`Error: cannot read stories dir: ${e.message}\n`);
    process.exit(1);
  }

  let checked = 0;
  let totalFindings = 0;

  for (const d of dirs) {
    const dir = join(STORIES_BASE, d);
    const result = checkStoryDir(dir);
    const { status, findings, storyId } = result;

    if (status === 'skip' || status === 'terminal') {
      // Silently skip — no per-story output in --all-incomplete mode
      continue;
    }

    checked++;

    if (status === 'findings' && findings.length > 0) {
      totalFindings += findings.length;
      for (const f of findings) {
        process.stderr.write(`FINDING [${storyId}]: ${f}\n`);
      }
    }
  }

  process.stdout.write(`Summary: ${checked} stories checked, ${totalFindings} findings\n`);
  process.exit(totalFindings > 0 ? 1 : 0);
}

// ── Entry point ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0) {
  process.stderr.write('Usage: story-preflight.js <story-dir-path>\n');
  process.stderr.write('       story-preflight.js --all-incomplete\n');
  process.exit(1);
}

if (args[0] === '--all-incomplete') {
  runAllIncomplete();
} else {
  runSingleDir(args[0]);
}
