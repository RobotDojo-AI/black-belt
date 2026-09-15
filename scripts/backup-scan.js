#!/usr/bin/env node
/**
 * scripts/backup-scan.js — the guardian's two heavy scans, off the server
 * thread.
 *
 * WHY a separate process: the coverage audit walks 224K ignored files and takes
 * ~5.7 s, and the push scan ends in `git push`, which is network I/O of
 * unbounded duration. The guardian lives inside the always-on server, and this
 * codebase has already paid for running heavy synchronous work there — the
 * supervisor's own history records measured 12–70 s main-thread stalls that
 * froze every chat turn until the work moved off-process. Chat speed is a P0.
 * So the guardian SPAWNS this, detached, and reads the report it leaves behind
 * on a later tick. Nothing here ever runs on the request path.
 *
 * Compute tier 0 — `git` subprocesses and file reads. No LLM call.
 *
 *   node scripts/backup-scan.js --push       # push branches no remote holds
 *   node scripts/backup-scan.js --coverage   # audit uncovered files
 *   node scripts/backup-scan.js --push --coverage --dry-run
 */
export const INTELLIGENCE_TIER = 'extraction';

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, evidencePaths, readScanReport } from '../lib/backup-evidence.js';
import { auditCoverage } from '../lib/backup-coverage.js';
import { decidePush, loadProtectedRepos, pushBranch, readRepoState } from '../lib/protected-repos.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function scanReportPath(configDir) {
  return evidencePaths(configDir).scan;
}

/**
 * Push every branch whose commits no remote holds. A diverged branch is
 * reported and NEVER force-pushed; a repository with no remote is reported
 * directly rather than delegated to the uncovered-file signal, because a
 * no-remote repo's files can be fully bucket-covered while its history is held
 * by nothing.
 */
export function runPushScan({ repos = loadProtectedRepos(), dryRun = false } = {}) {
  const pushed = [];
  const problems = [];
  for (const repo of repos) {
    let state;
    try {
      state = readRepoState(repo.path);
    } catch (error) {
      problems.push({ kind: 'unreadable', detail: `${repo.path}: ${error?.message || error}` });
      continue;
    }
    const plan = decidePush(state);
    problems.push(...plan.report);
    for (const branchName of plan.push) {
      const branch = state.branches.find((b) => b.name === branchName);
      if (dryRun) { pushed.push(`${repo.label}:${branchName} (dry-run)`); continue; }
      const result = pushBranch(repo.path, branchName, { hasUpstream: branch?.hasUpstream });
      if (result.ok) pushed.push(`${repo.label}:${branchName}`);
      else problems.push({ kind: 'push_failed', detail: `${repo.path}: ${branchName} — ${result.error}` });
    }
  }
  return { at: new Date().toISOString(), pushed, problems };
}

export function runCoverageScan({ repoRoot = join(homedir(), 'robotdojo') } = {}) {
  const audit = auditCoverage(repoRoot);
  return {
    at: new Date().toISOString(),
    repo_root: repoRoot,
    uncovered_count: audit.uncovered.length,
    uncovered: audit.uncovered.slice(0, 60).map((p) => ({ path: p, reason: audit.reasons.get(p) || null })),
  };
}

function main(argv = process.argv) {
  const wantPush = argv.includes('--push');
  const wantCoverage = argv.includes('--coverage');
  const dryRun = argv.includes('--dry-run');
  const report = readScanReport() || {};

  if (wantPush) {
    try { report.push = runPushScan({ dryRun }); }
    catch (error) { report.push = { at: new Date().toISOString(), pushed: [], problems: [{ kind: 'scan_failed', detail: String(error?.message || error) }] }; }
  }
  if (wantCoverage) {
    try { report.coverage = runCoverageScan(); }
    catch (error) { report.coverage = { at: new Date().toISOString(), uncovered_count: null, error: String(error?.message || error) }; }
  }
  report.updated_at = new Date().toISOString();
  atomicWriteJson(scanReportPath(), report);
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stdout.write(`backup-scan: ${wantPush ? `push(${report.push?.pushed?.length ?? 0} pushed, ${report.push?.problems?.length ?? 0} problems) ` : ''}${wantCoverage ? `coverage(${report.coverage?.uncovered_count} uncovered)` : ''}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { REPO_ROOT as _repoRootForTest };
