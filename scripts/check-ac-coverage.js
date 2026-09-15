#!/usr/bin/env node
/**
 * check-ac-coverage.js — verify every scope AC has at least one plan criterion.
 *
 * Usage:
 *   node scripts/check-ac-coverage.js --story <id>
 *   node scripts/check-ac-coverage.js --scope <path> --plan <path>
 *
 * Mechanism (st_0c491456 AC-36):
 *   Parses numbered ACs from 00-scope.md's `## Acceptance criteria` section
 *   (regex: leading-of-line `N.` or `N)`). For each AC number N, verifies
 *   02-plan.md's `## How ACs are satisfied` section contains a header that
 *   references AC-N (specifically `### AC-N:` per the plan's existing shape).
 *   Exits non-zero naming any AC number with no matching plan criterion.
 *
 * Why this matters: a plan that seals without coverage for every AC is the
 * silent-failure pattern AC-36 names — the build then ships incomplete and
 * the gap surfaces at QA. Catching it at plan seal is the cheap fix.
 *
 * Env:
 *   ROBOTDOJO_STORIES_DIR — override stories directory (tests).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_STORIES_DIR = process.env.ROBOTDOJO_STORIES_DIR
  || join(homedir(), 'robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--story') out.story = argv[++i];
    else if (a === '--scope') out.scope = argv[++i];
    else if (a === '--plan') out.plan = argv[++i];
    else if (a === '--stories-dir') out.storiesDir = argv[++i];
  }
  return out;
}

// Slice text from "## <heading>" up to the next "## " (or EOF).
function sliceSection(text, heading) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// Numbered AC: leading-of-line `N.` or `N)`. Returns array of numbers (deduped, sorted ascending).
function extractAcNumbers(section) {
  if (!section) return [];
  const nums = new Set();
  for (const line of section.split('\n')) {
    const m = line.match(/^(\d+)[.)]\s+/);
    if (m) nums.add(Number(m[1]));
  }
  return [...nums].sort((a, b) => a - b);
}

// A plan covers AC N if any line under `## How ACs are satisfied` contains a heading
// of the form `### AC-N:` (the canonical shape this codebase uses).
function planCoversAc(planSection, n) {
  if (!planSection) return false;
  const re = new RegExp(`^###\\s+AC-${n}(?:[:.\\s-]|$)`, 'm');
  return re.test(planSection);
}

const args = parseArgs(process.argv);

let scopePath;
let planPath;
if (args.scope && args.plan) {
  scopePath = args.scope;
  planPath = args.plan;
} else if (args.story) {
  const storiesDir = args.storiesDir || DEFAULT_STORIES_DIR;
  scopePath = join(storiesDir, args.story, '00-scope.md');
  planPath = join(storiesDir, args.story, '02-plan.md');
} else {
  process.stderr.write('Usage: check-ac-coverage.js (--story <id> | --scope <path> --plan <path>) [--stories-dir <dir>]\n');
  process.exit(1);
}

if (!existsSync(scopePath)) {
  process.stderr.write(`BLOCKED — scope file not found: ${scopePath}\n`);
  process.exit(1);
}
if (!existsSync(planPath)) {
  process.stderr.write(`BLOCKED — plan file not found: ${planPath}\n`);
  process.exit(1);
}

const scopeText = readFileSync(scopePath, 'utf8');
const planText = readFileSync(planPath, 'utf8');

const acSection = sliceSection(scopeText, '## Acceptance criteria')
  || sliceSection(scopeText, '## Acceptance Criteria');
if (acSection === null) {
  process.stderr.write(`BLOCKED — scope file has no "## Acceptance criteria" section: ${scopePath}\n`);
  process.exit(1);
}

const planSection = sliceSection(planText, '## How ACs are satisfied');
if (planSection === null) {
  process.stderr.write(`BLOCKED — plan file has no "## How ACs are satisfied" section: ${planPath}\n`);
  process.exit(1);
}

const acNumbers = extractAcNumbers(acSection);
if (acNumbers.length === 0) {
  process.stderr.write(`BLOCKED — scope file has zero numbered ACs under "## Acceptance criteria": ${scopePath}\n`);
  process.exit(1);
}

const uncovered = acNumbers.filter(n => !planCoversAc(planSection, n));
if (uncovered.length > 0) {
  process.stderr.write(
    `BLOCKED — ${uncovered.length} acceptance criteria lack a matching plan criterion (no "### AC-N:" header in 02-plan.md "## How ACs are satisfied"): ` +
    uncovered.map(n => `AC-${n}`).join(', ') + '\n'
  );
  process.exit(1);
}

process.stdout.write(`OK — all ${acNumbers.length} ACs have plan coverage.\n`);
process.exit(0);
