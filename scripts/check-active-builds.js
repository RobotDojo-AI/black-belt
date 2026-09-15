#!/usr/bin/env node
// check-active-builds.js — pre-commit gate that warns when this commit is
// about to stage files claimed by another active build session.
//
// Behavior:
//   - Reads `git diff --cached --name-only` for staged files.
//   - Reads PIPELINE_ACTIVE_BUILDS_PATH (resolver default) for active claims.
//   - If any staged file matches another session's active claim, prints a
//     warning to stderr listing the conflicts and exits non-zero (BLOCKS the
//     commit). This is the structural defense against the multi-terminal
//     commit-scoop pattern (st_4e6e2ea9, st_cfb2859e, st_64d21872).
//
// Bypass: ROBOTDOJO_SKIP_ACTIVE_BUILDS_CHECK=1 (use only for force-merges
// when the other terminal is confirmed dead and the claim is stale).
//
// Source: st_64d21872 build extension. Owner intent: stop the failure mode
// where one terminal's bare `git commit` scoops another terminal's untracked
// or in-progress WIP without any warning.

import { execFileSync } from 'node:child_process';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findForeignStagedFiles } from '../lib/active-builds.js';

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '..');

// Resolve the active story id so the foreign-claim check can EXCLUDE the
// committing story's own claims (st_a5baa72c AC5). Without it, a story's own
// multi-session claims block its own commit (the committing hook pid never
// matches the claiming pid). Order of trust:
//   1. ROBOTDOJO_ACTIVE_STORY env (explicit, used by the build seam + tests).
//   2. active-story.js (the single in-progress story, if unambiguous).
// Returns null when neither resolves (then the gate falls back to session-only
// exclusion, the prior behavior — no regression for the cross-story case).
function resolveActiveStoryId() {
  if (process.env.ROBOTDOJO_ACTIVE_STORY) return process.env.ROBOTDOJO_ACTIVE_STORY.trim();
  try {
    const out = execFileSync('node', [pathResolve(REPO_ROOT, 'scripts/active-story.js')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const id = out.trim();
    return /^(st|df|wk)_/.test(id) ? id : null;
  } catch {
    // Zero or ambiguous active stories → no single story to exclude.
    return null;
  }
}

if (process.env.ROBOTDOJO_SKIP_ACTIVE_BUILDS_CHECK === '1') {
  process.stdout.write('[check-active-builds] skipped via ROBOTDOJO_SKIP_ACTIVE_BUILDS_CHECK=1\n');
  process.exit(0);
}

// Test seam mirroring root-lock-lib.js's stagedFiles(): ROBOTDOJO_STAGED_FILES
// (newline-separated) lets a hermetic test drive the gate with a known staged
// set instead of the live `git diff --cached`. Absent the env, real git is used.
let stagedRaw;
if (process.env.ROBOTDOJO_STAGED_FILES != null) {
  stagedRaw = process.env.ROBOTDOJO_STAGED_FILES;
} else {
  try {
    stagedRaw = execFileSync('git', ['-C', REPO_ROOT, 'diff', '--cached', '--name-only'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    process.stderr.write(`[check-active-builds] WARN: git invocation failed: ${err.message}\n`);
    process.exit(0); // do not block on git errors — let other gates surface them
  }
}

const stagedPaths = stagedRaw.split('\n').filter(Boolean);
if (stagedPaths.length === 0) {
  process.exit(0);
}

const ownSessionId = `${process.pid}@${process.env.HOSTNAME || 'localhost'}`;
const storyId = resolveActiveStoryId();
const conflicts = findForeignStagedFiles({ stagedPaths, ownSessionId, storyId });

if (conflicts.length === 0) {
  process.stdout.write(`[check-active-builds] ok — no cross-session conflicts\n`);
  process.exit(0);
}

process.stderr.write(`[check-active-builds] FAIL — ${conflicts.length} staged file(s) claimed by another active build:\n`);
for (const c of conflicts) {
  process.stderr.write(`  ${c.staged}  ← ${c.claimed_by}\n`);
}
process.stderr.write(`\nAnother Claude session has an active build claim on these files. Committing them here\n`);
process.stderr.write(`risks scooping that session's WIP (the st_4e6e2ea9 / st_cfb2859e / st_64d21872 pattern).\n`);
process.stderr.write(`\nResolution:\n`);
process.stderr.write(`  1. Confirm the other session is intentionally idle (check the active-builds.jsonl in the pipeline workbench).\n`);
process.stderr.write(`  2. If the claim is stale (>24h with no release), release it manually:\n`);
process.stderr.write(`     node -e "import('./lib/active-builds.js').then(m=>m.releaseBuild({story_id:'<id>',session_id:'<sid>'}))"\n`);
process.stderr.write(`  3. Or run with ROBOTDOJO_SKIP_ACTIVE_BUILDS_CHECK=1 to bypass (own the risk).\n`);
process.exit(1);
