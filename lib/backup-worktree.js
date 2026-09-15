/**
 * lib/backup-worktree.js — working-tree content that no remote holds.
 *
 * THE PARTITION DIMENSION CHANGED, deliberately. st_e0776b46 partitioned by
 * PATH: every path belongs to exactly one system. df_3df1f108 AC7 moves the
 * partition to CONTENT-STATE: content a remote holds is GitHub's; content no
 * remote holds is the bucket's. Note the phrasing — NOT "committed is
 * GitHub's", which is false for content committed locally and not yet pushed.
 * This comment exists so a future reader does not "correct" it back.
 *
 * Every content state a file in a repository can occupy, each with exactly one
 * owner:
 *
 *   clean and pushed                       → GitHub. Not copied.
 *   modified and pushed                    → bucket holds the working bytes,
 *                                            GitHub holds the committed bytes.
 *                                            Different content, so genuinely
 *                                            exclusive rather than duplicated.
 *   committed-not-pushed AND clean         → AC4's. Bounded by the 30-minute
 *                                            auto-push interval, NOT copied.
 *   committed-not-pushed AND modified      → bucket, as a modified file.
 *   untracked and not ignored              → bucket.
 *   ignored                                → bucket (the existing roots).
 *
 * WHY committed-not-pushed-and-clean is excluded: the bucket runs with
 * `--no-delete-unmatched-destination-objects`, so nothing reclaims a copy once
 * made. Every tracked file passes through committed-not-pushed on its way to
 * GitHub, so copying that state would accumulate a permanent copy of
 * essentially all tracked content — wholesale duplication reached through time
 * instead of through one sync. Modified files are already in the copy set under
 * the plain rule, so including them adds nothing to the eventual copy set;
 * excluding them would suspend AC7's protection on exactly the uncommitted edit
 * AC7 exists to protect.
 *
 * Whole files, never diffs. `gcloud storage rsync` copies files, and a restore
 * that needed GitHub-plus-delta reassembly would break the framing's promise.
 *
 * Compute tier 0 — `git` subprocesses only. No LLM call.
 */

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { PRIVATE_DATA_FILES, PRIVATE_DATA_ROOTS } from './private-data-roots.js';
import { isPrivateConfigFile } from './backup-coverage.js';

export const WORKTREE_REMOTE_PREFIX = 'worktree';

function git(repoRoot, args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.toString('utf8') || `git ${args.join(' ')} failed`);
  }
  return result.stdout.toString('utf8');
}

/**
 * Parse `git status --porcelain=v1 -z -uall` into working-tree states.
 * Rename/copy entries carry a second NUL-separated path (the source) which must
 * be consumed or every subsequent entry shifts by one.
 */
export function parsePorcelain(raw) {
  const fields = raw.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const x = field[0];
    const y = field[1];
    const path = field.slice(3);
    if (x === 'R' || x === 'C') i++; // consume the rename/copy source path
    entries.push({ x, y, path });
  }
  return entries;
}

/**
 * True when a repo-relative path is already carried by an existing bucket root
 * or file entry. Copying it again would be the duplication AC7(a) forbids.
 */
export function alreadyUnderBucketRoot(relPath) {
  if (PRIVATE_DATA_FILES.some((file) => file.local === relPath)) return true;
  if (isPrivateConfigFile(relPath)) return true;
  return PRIVATE_DATA_ROOTS.some((root) => relPath === root.local || relPath.startsWith(`${root.local}/`));
}

/**
 * The AC7 copy set for one repository.
 *
 * @param {string} repoRoot absolute repository root
 * @param {object} [opts]
 * @param {string|null} [opts.mainRepoRoot] absolute path of the repository the
 *   PRIVATE_DATA_ROOTS are relative to. Supplying it lets a NESTED repository's
 *   paths be tested against those roots, which is how code/black-belt is
 *   recognised as already carried by the `code/` root.
 * @returns {{modified: string[], untracked: string[], copy: string[], skippedUnderRoot: string[], deleted: string[]}}
 */
export function worktreeCopySet(repoRoot, { mainRepoRoot = null, runGit = git } = {}) {
  const abs = resolve(repoRoot);
  const raw = runGit(abs, ['status', '--porcelain=v1', '-z', '-uall']);
  const entries = parsePorcelain(raw);

  // A path is skipped when an EXISTING bucket root already carries it. The
  // roots are expressed relative to the main repository, so a nested repo's
  // paths are re-based before the test — which is why code/black-belt needs no
  // separate mechanism: the `code/` root already carries its working tree.
  const rebase = (rel) => {
    if (!mainRepoRoot) return rel;
    const main = resolve(mainRepoRoot);
    if (abs === main) return rel;
    if (!abs.startsWith(`${main}/`)) return null;
    return `${abs.slice(main.length + 1)}/${rel}`;
  };

  const modified = [];
  const untracked = [];
  const deleted = [];
  for (const { x, y, path } of entries) {
    if (x === '?' && y === '?') { untracked.push(path); continue; }
    if (x === '!' || y === '!') continue;           // ignored — the roots own it
    if (x === 'D' || y === 'D') { deleted.push(path); continue; } // nothing to copy
    modified.push(path);                            // added / modified / renamed target
  }

  const candidates = [...new Set([...modified, ...untracked])].sort();
  const skippedUnderRoot = candidates.filter((rel) => {
    const rebased = rebase(rel);
    return rebased !== null && alreadyUnderBucketRoot(rebased);
  });
  const skipSet = new Set(skippedUnderRoot);
  const copy = candidates.filter((p) => !skipSet.has(p));

  return { modified: modified.sort(), untracked: untracked.sort(), deleted: deleted.sort(), copy, skippedUnderRoot };
}

/** Bucket object path for one copied working-tree file. */
export function worktreeRemote(bucket, label, relPath) {
  return `${bucket}/${WORKTREE_REMOTE_PREFIX}/${label}/${relPath}`;
}

/**
 * The full upload plan across every protected repository.
 *
 * @param {{label: string, path: string}[]} repos
 * @param {string} bucket e.g. gs://example-backup-bucket
 * @returns {{repo: string, label: string, local: string, remote: string, rel: string}[]}
 */
export function worktreeUploadPlan(repos, bucket, { runGit = git, mainRepoRoot = null } = {}) {
  const plan = [];
  for (const repo of repos) {
    let set;
    try {
      set = worktreeCopySet(repo.path, { mainRepoRoot, runGit });
    } catch {
      continue; // a repository that cannot be read is reported by the checker, not here
    }
    for (const rel of set.copy) {
      plan.push({
        repo: repo.path,
        label: repo.label,
        rel,
        local: join(repo.path, rel),
        remote: worktreeRemote(bucket, repo.label, rel),
      });
    }
  }
  return plan;
}
