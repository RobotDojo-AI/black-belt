#!/usr/bin/env node
/**
 * scripts/check-worktree-coverage.js — working-tree content no remote holds,
 * checked against the bucket.
 *
 * The copy set is computed from git at run time (modified tracked files plus
 * untracked-not-ignored files, minus anything an existing bucket root already
 * carries), and every member must have a real object in the bucket. This cannot
 * pass on a mocked backup: the objects either exist or they do not.
 *
 * Compute tier 0 — `git` and one recursive `gcloud storage ls`. No LLM call.
 *
 *   node scripts/check-worktree-coverage.js
 *   node scripts/check-worktree-coverage.js --plan-only   # skip the bucket read
 *   node scripts/check-worktree-coverage.js --json
 */
export const INTELLIGENCE_TIER = 'extraction';

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import config from '../lib/config.js';
import { loadProtectedRepos } from '../lib/protected-repos.js';
import { worktreeUploadPlan, WORKTREE_REMOTE_PREFIX } from '../lib/backup-worktree.js';

const MAIN_REPO = join(homedir(), 'robotdojo');

/** Every object under gs://bucket/worktree/, as a Set of full object URLs. */
export function listWorktreeObjects(bucket, { run = spawnSync } = {}) {
  const result = run('gcloud', ['storage', 'ls', '-r', `${bucket}/${WORKTREE_REMOTE_PREFIX}/**`], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  // An empty prefix is not an error condition for us — it means nothing has
  // been copied yet, which the caller reports per-file rather than as a crash.
  if (result.error || result.status !== 0) return new Set();
  return new Set((result.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean));
}

export function checkWorktreeCoverage({ bucket = config.gcsBucket, planOnly = false, mainRepoRoot = MAIN_REPO } = {}) {
  if (!bucket) return { ok: false, error: 'GCS_BUCKET not configured', plan: [], missing: [] };
  const repos = loadProtectedRepos();
  const plan = worktreeUploadPlan(repos, bucket, { mainRepoRoot });
  if (planOnly) return { ok: true, bucket, plan, missing: [], repos: repos.map((r) => r.label) };
  const objects = listWorktreeObjects(bucket);
  const missing = plan.filter((item) => !objects.has(item.remote));
  return { ok: missing.length === 0, bucket, plan, missing, repos: repos.map((r) => r.label) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const planOnly = process.argv.includes('--plan-only');
  const result = checkWorktreeCoverage({ planOnly });
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...result, plan: result.plan.map((p) => p.remote) })}\n`);
  }
  if (result.error) {
    process.stderr.write(`check-worktree-coverage: ${result.error}\n`);
    process.exit(1);
  }
  if (planOnly) {
    process.stdout.write(`check-worktree-coverage: ${result.plan.length} working-tree file(s) in the copy set (plan only, bucket not read)\n`);
    process.exit(0);
  }
  if (result.missing.length) {
    process.stderr.write(`BLOCKED: ${result.missing.length} working-tree file(s) exist on this machine only:\n`);
    for (const item of result.missing.slice(0, 60)) process.stderr.write(`- ${item.label}: ${item.rel}\n`);
    if (result.missing.length > 60) process.stderr.write(`  ... ${result.missing.length - 60} more\n`);
    process.exit(1);
  }
  process.stdout.write(`check-worktree-coverage: clean (${result.plan.length} working-tree file(s), all present in ${result.bucket}/${WORKTREE_REMOTE_PREFIX}/)\n`);
}
