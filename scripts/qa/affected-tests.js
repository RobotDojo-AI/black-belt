#!/usr/bin/env node
/**
 * affected-tests.js — QA affected-test selector
 *
 * Reads the build report for a story, extracts changed file paths,
 * and outputs only the test files that cover those changes.
 *
 * Usage: node scripts/qa/affected-tests.js --story <story_id>
 * Env:   ROBOTDOJO_STORIES_DIR (default: ~/robotdojo/stories)
 * Output: one test file path per line (absolute)
 * Exit:  0 always (falls back to full suite on any error/empty result)
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACTS } from '../pipeline-schema.js';
import { PIPELINE_STORIES_DIR } from '../../lib/robotdojo-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

// Any of these changed → run the full test suite
const ALWAYS_RUN_SOURCES = new Set([
  'lib/db.js',
  'lib/utils.js',
  'lib/auth.js',
  'middleware.js',
  'index.js',
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--story');
  if (idx === -1 || !args[idx + 1]) {
    process.stderr.write('Usage: node scripts/qa/affected-tests.js --story <story_id>\n');
    process.exit(0);
  }
  return args[idx + 1];
}

function storiesDir() {
  return PIPELINE_STORIES_DIR;
}

/**
 * Parse changed file paths from build report content.
 * Handles three formats:
 *   1. Markdown table:  | `lib/foo.js` | ... |
 *   2. Bullet list:     - lib/foo.js — desc
 *                       - `lib/foo.js` — desc
 *   3. Commits-only:    no per-file section → returns []
 */
function parseBuildReport(content) {
  const files = new Set();

  // Locate the section
  const sectionRe = /^##\s+(?:Files changed(?: \(\d+\))?|Changes)\s*$/im;
  const sectionMatch = content.match(sectionRe);
  if (!sectionMatch) return [];

  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const rest = content.slice(sectionStart);
  const nextSection = rest.search(/\n##\s+/);
  const section = nextSection === -1 ? rest : rest.slice(0, nextSection);

  // Format 1: table cells — | `lib/foo.js` |
  const tableRe = /\|\s*`([^`]+)`\s*\|/g;
  let m;
  while ((m = tableRe.exec(section)) !== null) {
    const p = m[1].trim();
    if (isFilePath(p)) files.add(p);
  }

  // Format 2: bullet lines — - lib/foo.js or - `lib/foo.js`
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

/**
 * Scan full content of every test file for imported source paths.
 * Catches both static and dynamic imports:
 *   import x from '../lib/foo.js'
 *   const m = await import('../lib/foo.js')
 *
 * Returns Map<repoRelativeSourcePath, Set<testRelPath>>
 */
function buildImportMap(allTestFiles) {
  const map = new Map();
  const importRe = /['"](\.\.[/\w./-]+\.js)['"]/g;

  for (const tf of allTestFiles) {
    const abs = join(REPO, tf);
    if (!existsSync(abs)) continue;
    let content;
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }

    importRe.lastIndex = 0;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      // Resolve relative import from tests/ → repo-relative path
      // '../lib/foo.js' resolved from '<REPO>/tests' → '<REPO>/lib/foo.js'
      // then strip REPO prefix to get 'lib/foo.js'
      const abs2 = resolve(join(REPO, 'tests'), m[1]);
      const normalized = abs2.slice(REPO.length + 1).replace(/\\/g, '/');
      if (!map.has(normalized)) map.set(normalized, new Set());
      map.get(normalized).add(tf);
    }
  }

  return map;
}

function allTests() {
  return readdirSync(join(REPO, 'tests'))
    .filter(f => f.endsWith('.test.js'))
    .map(f => `tests/${f}`);
}

function emitFull(testFiles) {
  const set = new Set(testFiles.map(f => join(REPO, f)));
  for (const p of set) process.stdout.write(p + '\n');
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

  // Fallback: git diff when no files parsed from report
  if (changedFiles.length === 0) {
    try {
      const out = execSync('git diff HEAD~1 --name-only', {
        cwd: REPO, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      changedFiles = out.split('\n').map(l => l.trim()).filter(Boolean);
    } catch { changedFiles = []; }
  }

  const tests = allTests();

  // Normalize: strip leading ./
  const changed = changedFiles.map(f => f.replace(/^\.\//, ''));

  // Always-run source → full suite
  if (changed.some(f => ALWAYS_RUN_SOURCES.has(f))) {
    emitFull(tests);
    return;
  }

  const outputSet = new Set([join(REPO, 'tests/smoke.test.js')]);

  // Test files that were themselves modified during the build
  for (const f of changed) {
    if (/^tests\/[^/]+\.test\.js$/.test(f)) {
      outputSet.add(join(REPO, f));
    }
  }

  // Import map: changed source → covering tests
  const importMap = buildImportMap(tests);
  for (const f of changed) {
    const covers = importMap.get(f);
    if (covers) {
      for (const tf of covers) outputSet.add(join(REPO, tf));
    }
  }

  // Safe default: if nothing mapped beyond smoke, run full suite
  const nonSmoke = [...outputSet].filter(p => !p.endsWith('smoke.test.js'));
  if (nonSmoke.length === 0) {
    emitFull(tests);
    return;
  }

  for (const p of outputSet) process.stdout.write(p + '\n');
}

// Top-level — never exit non-zero
try {
  run();
} catch (err) {
  process.stderr.write(`[affected-tests] error: ${err.message}\n`);
  // Fall back to full suite
  try {
    emitFull(allTests());
  } catch {
    // nothing we can do
  }
}
