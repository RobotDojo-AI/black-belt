/**
 * source-finder/git-pickaxe.js — Tier 2 of the source-finder cascade.
 *
 * WHY: `git log -S '<literal>'` finds every commit that added or removed the
 * exact string. Useful when the file's path was introduced into source and
 * later moved — the pickaxe shows the introducing commit even if `--follow`
 * lost the trail.
 *
 * Returns earliest matching commit + the file paths it touched.
 */

import { execSync } from 'node:child_process';

export function gitPickaxe(literal, opts = {}) {
  const { repoRoot } = opts;
  if (!repoRoot || !literal) return null;

  let raw;
  try {
    raw = execSync(
      `git log --reverse --pretty=format:%H -S ${JSON.stringify(literal)} 2>/dev/null`,
      { cwd: repoRoot, encoding: 'utf8' }
    ).trim();
  } catch {
    return null;
  }
  if (!raw) return null;

  const sha = raw.split('\n')[0];
  if (!sha) return null;

  let files;
  try {
    files = execSync(
      `git show --pretty=format: --name-only ${sha} 2>/dev/null`,
      { cwd: repoRoot, encoding: 'utf8' }
    ).trim();
  } catch {
    return null;
  }
  const candidates = files.split('\n').filter(Boolean);
  if (candidates.length === 0) return null;

  return {
    tier: 'git-pickaxe',
    sha,
    candidates,
    confidence: candidates.length === 1 ? 'medium' : 'low',
    reason: `pickaxe earliest commit ${sha.slice(0, 8)} touched ${candidates.length} file(s)`,
  };
}
