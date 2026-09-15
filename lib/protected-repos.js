/**
 * lib/protected-repos.js — the git repositories whose commit history must never
 * live on exactly one disk.
 *
 * WHY a config file rather than two constants: the owner's scope boundary is
 * "just robotdojo, let's get it working 100% then i can expand if desired".
 * That is only cheap to honour if the repository set is CONFIGURATION. Two
 * hardcoded paths would make his stated intent quietly expensive.
 *
 * WHY discovery on top of the list: a repository created tomorrow must be
 * picked up by the mechanism, not by remembering to edit a file. `discover`
 * walks the backed-up roots for `.git` and merges what it finds, so the list is
 * a floor rather than a ceiling.
 *
 * Compute tier 0 — filesystem walk and `git` subprocesses. No LLM call.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = join(REPO_ROOT, 'config', 'protected-repos.json');

function expandHome(path, home = homedir()) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/** Depth-bounded walk for `.git` entries. Returns absolute repository roots. */
function discoverRepos(root, { maxDepth = 4, skipDirs = [] } = {}) {
  const skip = new Set(skipDirs.map((d) => d.split('/').pop()));
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === '.git')) found.push(dir);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (skip.has(entry.name) || entry.name === '.git') continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  if (existsSync(root)) walk(root, 0);
  return found;
}

/**
 * The protected repository set: configured entries first, then discovered ones.
 * Entries that do not exist on disk are dropped — a laptop without black-belt
 * checked out must not fail the push scan.
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] override the config file (tests)
 * @param {string} [opts.home] override $HOME (tests)
 * @returns {{label: string, path: string, reason?: string, source: 'config'|'discovered'}[]}
 */
export function loadProtectedRepos({ configPath = DEFAULT_CONFIG, home = homedir() } = {}) {
  let cfg = { repos: [], discover: null };
  try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); } catch { /* fall through to discovery */ }

  const out = [];
  const seen = new Set();
  const push = (label, path, source, reason) => {
    const abs = resolve(expandHome(path, home));
    if (seen.has(abs)) return;
    if (!existsSync(join(abs, '.git'))) return;
    seen.add(abs);
    out.push({ label, path: abs, source, ...(reason ? { reason } : {}) });
  };

  for (const entry of cfg.repos || []) {
    if (!entry?.path) continue;
    push(entry.label || entry.path, entry.path, 'config', entry.reason);
  }

  for (const root of cfg.discover?.roots || []) {
    const absRoot = resolve(expandHome(root, home));
    for (const found of discoverRepos(absRoot, cfg.discover)) {
      push(found.slice(absRoot.length).replace(/^\//, '') || 'robotdojo', found, 'discovered');
    }
  }
  return out;
}

// ── git state per repository ─────────────────────────────────────────────────

function git(repoPath, args) {
  const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/**
 * The push-relevant state of one repository. Pure read — never mutates git.
 *
 * `unpushed` is computed with `rev-list --count <ref> --not --remotes`, which
 * asks the only question that matters: does this commit exist under ANY remote
 * ref? A branch with no upstream configured but whose tip is on origin is NOT
 * single-copy; a branch with an upstream that is 3 commits behind IS.
 *
 * @param {string} repoPath absolute repository root
 * @returns {object} state consumed by decidePush()
 */
export function readRepoState(repoPath) {
  const remotes = git(repoPath, ['remote']).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const headRef = git(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const detached = !headRef.ok;
  const branch = detached ? null : headRef.stdout;
  const branchList = git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
    .stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  const branches = branchList.map((name) => {
    const count = git(repoPath, ['rev-list', '--count', name, '--not', '--remotes']);
    const unpushed = count.ok ? Number(count.stdout) || 0 : 0;
    const upstream = git(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${name}@{u}`]);
    const hasUpstream = upstream.ok && Boolean(upstream.stdout);
    let behind = 0;
    if (hasUpstream) {
      const counts = git(repoPath, ['rev-list', '--left-right', '--count', `${name}...${name}@{u}`]);
      behind = counts.ok ? Number(counts.stdout.split(/\s+/)[1]) || 0 : 0;
    }
    return {
      name,
      unpushed,
      hasUpstream,
      upstream: hasUpstream ? upstream.stdout : null,
      // Diverged: the remote carries commits this branch does not AND this
      // branch carries commits the remote does not. Fast-forward is impossible.
      diverged: hasUpstream && behind > 0 && unpushed > 0,
    };
  });

  // A detached HEAD whose commit reaches no remote is single-copy history that
  // no branch push can rescue. Reported, never pushed.
  let detachedUnpushed = 0;
  if (detached) {
    const count = git(repoPath, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
    detachedUnpushed = count.ok ? Number(count.stdout) || 0 : 0;
  }

  return {
    path: repoPath,
    remotes,
    hasRemote: remotes.length > 0,
    branch,
    detached,
    detachedUnpushed,
    branches,
  };
}

/**
 * What to do with one repository, as data. Pure — no git calls, so the whole
 * decision table is unit-testable without a fixture repository.
 *
 * @param {object} state from readRepoState()
 * @returns {{push: string[], report: {kind: string, detail: string}[]}}
 */
export function decidePush(state) {
  const push = [];
  const report = [];

  if (!state.hasRemote) {
    // AC4(b): surfaced DIRECTLY, not delegated to the uncovered-file signal.
    // A no-remote repo's FILES can be fully bucket-covered while its HISTORY is
    // held by nothing, because .git is excluded from the bucket — so a
    // file-level detector can never fire on it. A delegation that cannot fire
    // reads as handled and is worse than a named gap.
    const commits = state.branches.reduce((n, b) => n + b.unpushed, 0) + state.detachedUnpushed;
    report.push({ kind: 'no_remote', detail: `${state.path}: no remote configured; ${commits} commit(s) exist on one disk` });
    return { push, report };
  }

  for (const branch of state.branches) {
    if (branch.unpushed === 0) continue;
    if (branch.diverged) {
      // Never force-push. The remote history is not ours to overwrite.
      report.push({ kind: 'diverged', detail: `${state.path}: ${branch.name} has diverged from ${branch.upstream} — resolve manually; never force-pushed` });
      continue;
    }
    push.push(branch.name);
  }

  if (state.detached && state.detachedUnpushed > 0) {
    report.push({ kind: 'detached', detail: `${state.path}: detached HEAD carries ${state.detachedUnpushed} commit(s) on no branch — never pushed` });
  }

  return { push, report };
}

/**
 * Push one branch. A branch with no upstream gets `-u origin <branch>` — a
 * story branch with commits is exactly the class the owner said to auto-push.
 * Returns a result rather than throwing; the caller records and retries.
 */
export function pushBranch(repoPath, branch, { hasUpstream, remote = 'origin', run = git } = {}) {
  const args = hasUpstream ? ['push', remote, branch] : ['push', '-u', remote, branch];
  const result = run(repoPath, args);
  return { repo: repoPath, branch, ok: result.ok, error: result.ok ? null : (result.stderr || 'push failed') };
}

export { git as _gitForTest, discoverRepos as _discoverReposForTest };
