/**
 * source-finder/grep-worktree.js — Tier 3 of the source-finder cascade.
 *
 * WHY: the literal string in source today is the ground truth for what the
 * worktree currently emits. Even if git history is lost, grep on lib/, scripts/,
 * routes/, api/, apps/ finds the writer line(s) where the path appears
 * literally.
 *
 * Per amendment 2026-04-30 (no ts-morph): if grep returns 0 matches, the
 * source-finder cascade ends and the orchestrator falls back to
 * move-to-canonical (path likely built via template literal — not auto-fixable).
 */

import { execSync } from 'node:child_process';
import { basename } from 'node:path';

const SEARCH_DIRS = ['lib', 'scripts', 'routes', 'api', 'apps', 'tests', 'index.js', 'middleware.js'];

export function grepWorktree(literal, opts = {}) {
  const { repoRoot } = opts;
  if (!repoRoot || !literal) return null;

  const matches = [];
  for (const d of SEARCH_DIRS) {
    let raw;
    try {
      raw = execSync(
        `grep -rn -F ${JSON.stringify(literal)} ${d} 2>/dev/null || true`,
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
      );
    } catch {
      continue;
    }
    if (!raw) continue;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const file = line.slice(0, colon);
      const rest = line.slice(colon + 1);
      const colon2 = rest.indexOf(':');
      const lineNo = colon2 >= 0 ? Number(rest.slice(0, colon2)) : null;
      const text = colon2 >= 0 ? rest.slice(colon2 + 1) : rest;
      matches.push({ file, line: lineNo, text });
    }
  }

  return {
    tier: 'grep-worktree',
    matches,
    candidates: matches.map(m => m.file),
    confidence: matches.length === 1 ? 'high' : matches.length > 1 ? 'medium' : 'none',
    reason: matches.length === 0
      ? `no literal grep match for "${literal}" — likely template-literal construction`
      : `${matches.length} grep match(es) for "${literal}"`,
  };
}

/**
 * grepWorktreeBasename — fallback when literal grep returns 0 matches. Search
 * for just the basename. Returns medium confidence if any single file matches.
 */
export function grepWorktreeBasename(absPathOrRel, opts = {}) {
  const { repoRoot } = opts;
  if (!repoRoot || !absPathOrRel) return null;
  const name = basename(absPathOrRel);
  if (!name) return null;

  return grepWorktree(name, { repoRoot });
}
