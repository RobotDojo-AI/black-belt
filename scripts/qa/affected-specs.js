#!/usr/bin/env node
/**
 * affected-specs.js — QA Playwright spec selector
 *
 * Reads the build report for a story and outputs the subset of Playwright
 * spec files that cover the changed code. Always includes health.spec.js
 * and error-paths.spec.js.
 *
 * Usage: node scripts/qa/affected-specs.js --story <story_id>
 * Env:   ROBOTDOJO_STORIES_DIR (default: ~/robotdojo/stories)
 * Output: space-separated spec file names (basename only)
 * Exit:  0 always
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACTS } from '../pipeline-schema.js';
import { PIPELINE_STORIES_DIR } from '../../lib/robotdojo-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--story');
  if (idx === -1 || !args[idx + 1]) {
    process.stderr.write('Usage: node scripts/qa/affected-specs.js --story <story_id>\n');
    process.exit(0);
  }
  return args[idx + 1];
}

function storiesDir() {
  return PIPELINE_STORIES_DIR;
}

/**
 * Parse changed file paths from build report content.
 * Same multi-format parser as affected-tests.js.
 */
function parseBuildReport(content) {
  const files = new Set();

  const sectionRe = /^##\s+(?:Files changed(?: \(\d+\))?|Changes)\s*$/im;
  const sectionMatch = content.match(sectionRe);
  if (!sectionMatch) return [];

  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const rest = content.slice(sectionStart);
  const nextSection = rest.search(/\n##\s+/);
  const section = nextSection === -1 ? rest : rest.slice(0, nextSection);

  // Table format
  const tableRe = /\|\s*`([^`]+)`\s*\|/g;
  let m;
  while ((m = tableRe.exec(section)) !== null) {
    const p = m[1].trim();
    if (isFilePath(p)) files.add(p);
  }

  // Bullet format
  const bulletRe = /^[ \t]*[-*]\s+`?([^\s`|→—–\n]+)`?/gm;
  while ((m = bulletRe.exec(section)) !== null) {
    const p = m[1].trim();
    if (isFilePath(p)) files.add(p);
  }

  return [...files];
}

function isFilePath(s) {
  if (!s || s.startsWith('http') || s.startsWith('#') || s.startsWith('|')) return false;
  return /\.(js|ts|json|md|html|css|mjs|cjs)$/.test(s);
}

function run() {
  const storyId = parseArgs();
  const buildReportPath = join(storiesDir(), storyId, ARTIFACTS.build);

  let changedFiles = [];

  if (existsSync(buildReportPath)) {
    try {
      changedFiles = parseBuildReport(readFileSync(buildReportPath, 'utf8'));
    } catch { changedFiles = []; }
  }

  // Fallback: git diff
  if (changedFiles.length === 0) {
    try {
      const out = execSync('git diff HEAD~1 --name-only', {
        cwd: REPO, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      changedFiles = out.split('\n').map(l => l.trim()).filter(Boolean);
    } catch { changedFiles = []; }
  }

  // Load spec map
  const specMapPath = join(__dirname, 'affected-specs.json');
  let specMap = {};
  try {
    specMap = JSON.parse(readFileSync(specMapPath, 'utf8'));
  } catch {
    specMap = {};
  }

  const output = new Set(specMap.always || ['health.spec.js', 'error-paths.spec.js']);

  const changed = changedFiles.map(f => f.replace(/^\.\//, ''));

  for (const f of changed) {
    for (const [prefix, specs] of Object.entries(specMap)) {
      if (prefix === 'always') continue;
      // A prefix matches if the changed file path starts with it (or equals it)
      if (f === prefix || f.startsWith(prefix)) {
        for (const spec of specs) output.add(spec);
      }
    }
  }

  process.stdout.write([...output].join(' ') + '\n');
}

try {
  run();
} catch (err) {
  process.stderr.write(`[affected-specs] error: ${err.message}\n`);
  // Fallback: always-runs only
  process.stdout.write('health.spec.js error-paths.spec.js\n');
}
