#!/usr/bin/env node
/**
 * scripts/check-unpushed-commits.js — commit history held on exactly one disk.
 *
 * `.git` is excluded from the cloud copy by design, so a commit that has not
 * reached a remote is protected by GitHub, the bucket, and the outer repository
 * in exactly none of the three. `code/black-belt` is the case that matters
 * most: `code/` is gitignored by the outer repo, so an unpushed commit there is
 * genuinely single-copy.
 *
 * This is a CONTRACT check against the live tree — it computes its expected set
 * from git at run time and holds no list that can drift out of agreement with
 * reality. It cannot pass while the outcome is broken: `rev-list --count <ref>
 * --not --remotes` is non-zero exactly when a commit exists nowhere else.
 *
 * Compute tier 0 — `git` subprocesses only. No LLM call.
 *
 *   node scripts/check-unpushed-commits.js          # exit 1 on any single-copy history
 *   node scripts/check-unpushed-commits.js --json
 */
export const INTELLIGENCE_TIER = 'extraction';

import { decidePush, loadProtectedRepos, readRepoState } from '../lib/protected-repos.js';

export function scanUnpushed({ repos = loadProtectedRepos() } = {}) {
  const findings = [];
  const scanned = [];
  for (const repo of repos) {
    let state;
    try {
      state = readRepoState(repo.path);
    } catch (error) {
      findings.push({ kind: 'unreadable', repo: repo.path, detail: `${repo.path}: ${error?.message || error}` });
      continue;
    }
    scanned.push(repo.path);
    const plan = decidePush(state);
    for (const branch of plan.push) {
      const info = state.branches.find((b) => b.name === branch);
      findings.push({
        kind: 'unpushed',
        repo: repo.path,
        detail: `${repo.path}: ${branch} carries ${info?.unpushed ?? '?'} commit(s) no remote holds${info?.hasUpstream ? '' : ' (no upstream configured)'}`,
      });
    }
    for (const report of plan.report) findings.push({ ...report, repo: repo.path });
  }
  return { scanned, findings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = scanUnpushed();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  if (result.scanned.length === 0) {
    process.stderr.write('check-unpushed-commits: no protected repositories found — config/protected-repos.json is empty or unreadable\n');
    process.exit(1);
  }
  if (result.findings.length) {
    process.stderr.write(`BLOCKED: commit history held on one disk (${result.findings.length}):\n`);
    for (const finding of result.findings) process.stderr.write(`- [${finding.kind}] ${finding.detail}\n`);
    process.stderr.write('\n.git is excluded from the cloud copy, so losing this machine loses this history.\n');
    process.exit(1);
  }
  process.stdout.write(`check-unpushed-commits: clean (${result.scanned.length} repositories, every commit on a remote)\n`);
}
