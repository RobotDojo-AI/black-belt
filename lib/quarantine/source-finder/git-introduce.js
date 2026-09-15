/**
 * source-finder/git-introduce.js — Tier 1 of the source-finder cascade.
 *
 * WHY: the commit that ADDED the file usually touched the writer too. `git log
 * --diff-filter=A --reverse --follow -1 -- <path>` returns the introducing
 * commit; its diff often exposes which source file emitted the path.
 *
 * Returns the introducing commit's other-file paths, or null if the file was
 * never tracked (e.g. it's a brand-new untracked artifact).
 */

import { execSync } from 'node:child_process';

export function gitIntroduce(absPathOrRel, opts = {}) {
  const { repoRoot } = opts;
  if (!repoRoot) return null;

  let sha;
  try {
    sha = execSync(
      `git log --diff-filter=A --reverse --follow -1 --format=%H -- ${JSON.stringify(absPathOrRel)} 2>/dev/null`,
      { cwd: repoRoot, encoding: 'utf8' }
    ).trim();
  } catch {
    return null;
  }
  if (!sha) return null;

  let touched;
  try {
    touched = execSync(
      `git show --pretty=format: --name-only ${sha} 2>/dev/null`,
      { cwd: repoRoot, encoding: 'utf8' }
    ).trim();
  } catch {
    return null;
  }
  const files = touched.split('\n').filter(Boolean).filter(f => f !== absPathOrRel);
  if (files.length === 0) return null;

  return {
    tier: 'git-introduce',
    sha,
    candidates: files,
    confidence: files.length === 1 ? 'medium' : 'low',
    reason: `commit ${sha.slice(0, 8)} introduced the file alongside ${files.length} other path(s)`,
  };
}
