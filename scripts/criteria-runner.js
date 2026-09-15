#!/usr/bin/env node
/**
 * criteria-runner.js
 * Reads the active plan file, runs each verification criterion command, captures real output,
 * writes criteria-evidence.md to the story folder. Exits 1 if any criterion fails.
 *
 * Usage: node ~/robotdojo/scripts/criteria-runner.js [--plan <path>] [--story <dir>]
 *
 * Verification criteria format (in plan file under ## How ACs are satisfied):
 *   - description → `bash command`
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { ARTIFACTS } from './pipeline-schema.js';
import { parseCriteria, extractCriteriaSection } from '../lib/criteria-parser.js';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function argVal(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

function resolveStoryDir(override) {
  // PIPELINE_STORIES_DIR honors ROBOTDOJO_STORIES_DIR and resolves to the
  // canonical wk_robot_dojo workbench (the retired data-plane tree no longer
  // exists). Hardcoding the old path made story inference dead — it worked
  // only because every caller passes --story as an absolute path.
  if (override) {
    // If it's already an absolute path, return as-is
    if (override.startsWith('/')) return override;
    // If it looks like a story ID (st_XXXXXXXX), resolve to the stories dir
    return join(PIPELINE_STORIES_DIR, override);
  }
  // Infer active story from meta.json state — no .current file
  const storiesDir = PIPELINE_STORIES_DIR;
  if (!existsSync(storiesDir)) return null;
  const active = readdirSync(storiesDir)
    .filter(d => /^(st|df|wk)_/.test(d))
    .map(d => {
      try { return JSON.parse(readFileSync(join(storiesDir, d, 'meta.json'), 'utf8')); } catch { return null; }
    })
    .filter(m => m && m.stage && !['done', 'close-complete', 'cancelled', 'archived', 'absorbed'].includes(m.stage))
    .sort((a, b) => new Date(b.started) - new Date(a.started));
  if (active.length === 1) {
    return join(storiesDir, active[0].story_id);
  }
  if (active.length > 1) {
    console.error('CRITERIA RUNNER: multiple active stories — pass --story <dir> to specify.');
    return null;
  }
  return null;
}

// --dry-run: just confirm output filename and exit
const storyIdArg = argVal('--story');
if (dryRun) {
  const storyDir = resolveStoryDir(storyIdArg);
  const outputPath = storyDir ? join(storyDir, ARTIFACTS.criteria) : `<story-dir>/${ARTIFACTS.criteria}`;
  const explicitPlan = argVal('--plan');
  const storyPlan = storyDir ? join(storyDir, ARTIFACTS.plan) : null;
  const dryPlanPath = explicitPlan || (storyPlan && existsSync(storyPlan) ? storyPlan : null);
  console.log(`Dry-run: would write ${ARTIFACTS.criteria} → ${outputPath}`);
  if (!dryPlanPath) {
    console.error('CRITERIA RUNNER: no plan file found. Pass --plan <path> or --story <id>.');
    process.exit(1);
  }
  console.log(`Plan: ${dryPlanPath}`);
  process.exit(0);
}

// Resolve plan file — always from story dir or explicit --plan
const planPath = argVal('--plan') || (() => {
  const storyDir = resolveStoryDir(storyIdArg);
  if (storyDir) {
    const p = join(storyDir, ARTIFACTS.plan);
    if (existsSync(p)) return p;
  }
  return null;
})();
if (!planPath || !existsSync(planPath)) {
  console.error('CRITERIA RUNNER: no plan file found. Pass --plan <path> or --story <id>.');
  process.exit(1);
}
console.log(`Plan: ${planPath}`);

const planContent = readFileSync(planPath, 'utf8');

// Single-source parse via lib/criteria-parser.js. story-gate.js uses the same
// module — a plan that seals always parses here (st_6f81e248 AC16).
const criteriaSection = extractCriteriaSection(planContent);
if (!criteriaSection) {
  console.error('CRITERIA RUNNER: no ## How ACs are satisfied section found in plan.');
  process.exit(1);
}
const criteria = parseCriteria(criteriaSection);

if (criteria.length === 0) {
  console.error('CRITERIA RUNNER: no runnable criteria found. Each criterion must use → `command` format.');
  process.exit(1);
}

// Resolve story dir
const storyDir = resolveStoryDir(storyIdArg);
if (!storyDir || !existsSync(storyDir)) {
  console.error('CRITERIA RUNNER: no story directory found.');
  process.exit(1);
}
console.log(`Story: ${storyDir}`);

if (dryRun) {
  console.log(`Dry-run: would write ${ARTIFACTS.criteria} to ${storyDir}`);
  console.log(`Running ${criteria.length} criteria... [DRY RUN — not executing]`);
  process.exit(0);
}

console.log(`Running ${criteria.length} criteria...\n`);

// AC6 (st_862d73d1) — bind the evidence to THIS plan's bytes so the build seal
// can detect a stale 03b-criteria.md left over from a prior plan version. The
// build validation in story-gate.js recomputes sha256 of the sealed 02-plan.md
// and BLOCKS if it differs from this recorded PLAN_SHA256.
const planSha256 = createHash('sha256').update(planContent).digest('hex');

const evidencePath = join(storyDir, ARTIFACTS.criteria);
const lines = [
  '# Criteria Evidence',
  `Plan: ${planPath}`,
  `PLAN_SHA256: ${planSha256}`,
  `Story: ${storyDir}`,
  `Date: ${new Date().toISOString()}`,
  '',
];

let passCount = 0;
let failCount = 0;

for (const criterion of criteria) {
  let passed = false;
  let output = '';

  // Recursion guard (st_862d73d1 refinement): only reject commands that actually
  // EXECUTE criteria-runner (`node … criteria-runner.js`), not commands that
  // merely reference the filename — e.g. `rg "X" scripts/criteria-runner.js`,
  // a legitimate absence/presence probe of the source. The old `\bscripts/
  // criteria-runner\.js\b` regex false-positived on every grep of the file.
  if (/\bnode\b[^\n]*\bcriteria-runner\.js\b/.test(criterion.command)) {
    output = 'Recursive criteria-runner command is not valid evidence. Put concrete commands in the plan instead.';
    if (process.env.ROBOTDOJO_ALLOW_CRITERIA_RUNNER_RECURSION === '1') {
      output += ' Allowed only because ROBOTDOJO_ALLOW_CRITERIA_RUNNER_RECURSION=1 is set.';
      passed = true;
      passCount++;
    } else {
      passed = false;
      failCount++;
    }
  } else try {
    const result = execSync(criterion.command, {
      encoding: 'utf8',
      timeout: 540000, // 9 min — multi-call synthesis criteria (calibration with N=3 samples = 6 LLM round-trips) need longer than single-call /context/refresh
      maxBuffer: 128 * 1024 * 1024,
      shell: '/bin/bash',
      cwd: join(homedir(), 'robotdojo'),
      env: { ...process.env },
      stdio: 'pipe',
    });
    output = (result || '').trim();
    passed = true;
    passCount++;
  } catch (e) {
    output = [(e.stdout || '').trim(), (e.stderr || '').trim()].filter(Boolean).join('\n');
    passed = false;
    failCount++;
  }

  const marker = passed ? '[ PASS ]' : '[ FAIL ]';
  console.log(`${marker} ${criterion.description}`);
  if (!passed) {
    console.log(`  cmd: ${criterion.command}`);
    if (output) console.log(`  out: ${output.split('\n').slice(0, 3).join('\n       ')}`);
  }

  lines.push(`${marker} ${criterion.description}`);
  lines.push(`Command: \`${criterion.command}\``);
  if (output) {
    lines.push('```');
    lines.push(output.length > 1000 ? output.slice(0, 1000) + '\n[... truncated]' : output);
    lines.push('```');
  }
  lines.push('');
}

const verdict = failCount === 0 ? 'PASS' : 'FAIL';
lines.push('## Summary');
lines.push(`Criteria: ${passCount}/${criteria.length} passed`);
lines.push(`VERDICT: ${verdict}`);

writeFileSync(evidencePath, lines.join('\n'));
console.log(`\nEvidence: ${evidencePath}`);
console.log(`Summary: ${passCount}/${criteria.length} passed — ${verdict}`);

process.exit(failCount === 0 ? 0 : 1);
