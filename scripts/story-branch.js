#!/usr/bin/env node
/**
 * story-branch.js — one story maps to one branch (df_0bd64903).
 *
 * The single definition of "am I on THIS story's branch," shared by every commit
 * site. Two verbs:
 *
 *   --ensure --story <id>   Settle HEAD onto this story's own branch before any
 *                           build commit. No-op ONLY when HEAD is already this
 *                           story's branch (`story/<id>-*` or exactly
 *                           `story/<id>`). On main, a DIFFERENT story's branch,
 *                           or detached HEAD, create/switch to `story/<id>-<slug>`
 *                           off HEAD so this story's commits never pool onto
 *                           another story's branch. Records `story_branch` in
 *                           meta.json. Exit 0 on success, 1 on hard failure.
 *
 *   --assert --story <id>   Commit-time guard. Exit 0 iff HEAD is this story's
 *                           branch; else print a LOUD message to stderr and exit
 *                           non-zero so the caller refuses a wrong-branch commit.
 *                           This closes the window a branch-start guard alone
 *                           leaves open: a concurrent session that switches HEAD
 *                           between staging and commit.
 *
 * WHY a script and not inline SKILL bash: the branch-identity rule (D1 in the
 * plan) must be identical at build-start (--ensure), at the build commit
 * (--assert), and at the gate's auto-retry commit (--assert). One definition,
 * unit-testable against fixture repos, instead of three copies of a git guard
 * drifting across two protected SKILL files and the gate.
 *
 * No LLM, no DB — deterministic git only.
 */

// Tier: deterministic git-state helper. No model call, no structured-store write.
export const INTELLIGENCE_TIER = 'extraction';

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

function git(repoRoot, args) {
  return spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
}

function currentBranch(repoRoot) {
  const r = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // On a detached HEAD `--abbrev-ref HEAD` prints the literal string "HEAD".
  return r.status === 0 ? r.stdout.trim() : '';
}

/**
 * True iff `branch` is the branch that belongs to `storyId`. The pipeline names
 * branches `story/<id>-<slug>`; also accept the bare `story/<id>` for safety.
 * The load-bearing test is IDENTITY (this story's branch), not "am I off main" —
 * the exact assumption the old build 1b `else` no-op got wrong.
 */
export function isStoryBranch(branch, storyId) {
  if (!branch || !storyId) return false;
  return branch === `story/${storyId}` || branch.startsWith(`story/${storyId}-`);
}

function readMeta(storyDir) {
  const p = join(storyDir, 'meta.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function writeMetaField(storyDir, patch) {
  const p = join(storyDir, 'meta.json');
  if (!existsSync(p)) return;
  const m = JSON.parse(readFileSync(p, 'utf8'));
  Object.assign(m, patch);
  writeFileSync(p, JSON.stringify(m, null, 2));
}

function sanitizeSlug(slug) {
  return String(slug || 'story').replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * --ensure: put HEAD on this story's own branch. Returns the branch HEAD settled
 * on, or null on failure.
 */
export function ensureStoryBranch({ repoRoot, storiesDir, storyId }) {
  const cur = currentBranch(repoRoot);
  const storyDir = join(storiesDir, storyId);

  if (isStoryBranch(cur, storyId)) {
    // Already on this story's branch — the only legitimate no-op.
    writeMetaField(storyDir, { story_branch: cur });
    console.log(`story-branch: already on this story's branch ${cur} — no-op.`);
    return cur;
  }

  const meta = readMeta(storyDir);
  const slug = sanitizeSlug(meta && meta.slug);
  const branch = `story/${storyId}-${slug}`;

  // Off main, a foreign story branch, or detached HEAD: this story's work must
  // land on its OWN branch off the current HEAD (carries the working tree).
  let created = git(repoRoot, ['checkout', '-b', branch]);
  if (created.status !== 0) {
    // Branch may already exist from a prior attempt — switch to it.
    const switched = git(repoRoot, ['checkout', branch]);
    if (switched.status !== 0) {
      console.error(
        `story-branch: FAILED to create or switch to ${branch} ` +
        `(was on "${cur}"). git said: ${(created.stderr || switched.stderr || '').trim()}`,
      );
      return null;
    }
    console.log(`story-branch: switched to existing ${branch} (was on "${cur}").`);
  } else {
    console.log(`story-branch: created and switched to ${branch} (was on "${cur}"). Build edits land here.`);
  }

  writeMetaField(storyDir, { story_branch: branch });
  return branch;
}

/**
 * --assert: verify HEAD is this story's branch. Returns true/false; the CLI maps
 * false to a non-zero exit + a loud stderr message.
 */
export function assertStoryBranch({ repoRoot, storyId }) {
  const cur = currentBranch(repoRoot);
  return { ok: isStoryBranch(cur, storyId), branch: cur };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ensure') args.ensure = true;
    else if (a === '--assert') args.assert = true;
    else if (a === '--story') args.story = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--stories-dir') args.storiesDir = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.story) {
    console.error('story-branch: --story <id> is required.');
    process.exit(1);
  }
  const repoRoot = args.repo || REPO_ROOT;
  const storiesDir = args.storiesDir || PIPELINE_STORIES_DIR;

  if (args.ensure) {
    const settled = ensureStoryBranch({ repoRoot, storiesDir, storyId: args.story });
    process.exit(settled ? 0 : 1);
  }

  if (args.assert) {
    const { ok, branch } = assertStoryBranch({ repoRoot, storyId: args.story });
    if (ok) process.exit(0);
    console.error(
      `\n========================================================================\n` +
      `story-branch: REFUSING wrong-branch commit for ${args.story}.\n` +
      `  HEAD is "${branch}", which is NOT this story's branch (story/${args.story}-*).\n` +
      `  A concurrent session may have switched HEAD. Do NOT commit here — return\n` +
      `  to story/${args.story}-<slug> (run --ensure) before committing.\n` +
      `========================================================================\n`,
    );
    process.exit(1);
  }

  console.error('story-branch: pass --ensure or --assert.');
  process.exit(1);
}

// Run only as a CLI; stay importable for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
