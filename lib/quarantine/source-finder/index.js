/**
 * source-finder/index.js — 3-tier cascade per amendment 2026-04-30.
 *
 * WHY this order: cheapest first.
 *   Tier 1 (git-introduce) — instant; uses git history.
 *   Tier 2 (git-pickaxe)  — instant; uses git history with content match.
 *   Tier 3 (grep-worktree) — fast; current tree only.
 *
 * Per amendment, NO ts-morph AST tier. When grep returns 0 literal matches,
 * the source-finder declares "writer not auto-fixable" and the orchestrator
 * falls back to move-to-canonical.
 *
 * Returns:
 *   { writerFile, line, oldLiteral, newLiteral, confidence, tier, alternatives? }
 *   or null when no writer is locatable.
 */

import { gitIntroduce } from './git-introduce.js';
import { gitPickaxe } from './git-pickaxe.js';
import { grepWorktree, grepWorktreeBasename } from './grep-worktree.js';

/**
 * findWriter — given (oldLiteral, newLiteral), locate the source file that
 * emits the old literal so it can be rewritten to the new literal.
 *
 * `oldLiteral` is the path string the WRITER currently emits (e.g. for
 * vault-manifest.json: the literal `'.robotdojo/vault-manifest.json'` if the
 * writer uses that, or the basename `'vault-manifest.json'` if joined with
 * a constant).
 */
export function findWriter({ oldLiteral, newLiteral, repoRoot, filePath }) {
  if (!oldLiteral) {
    return { ok: false, reason: 'no oldLiteral provided' };
  }

  // Tier 3 first because it's the most authoritative for "what the worktree
  // emits today." Cheap, instant, and tells us the actionable line+file. If
  // grep finds exactly one match, we're done. Multi-match → escalate (or
  // surface alternatives). Zero match → fall back to git history hints.
  const t3 = grepWorktree(oldLiteral, { repoRoot });
  if (t3 && t3.matches.length === 1) {
    const m = t3.matches[0];
    return {
      ok: true,
      writerFile: m.file,
      line: m.line,
      text: m.text,
      oldLiteral,
      newLiteral,
      confidence: 'high',
      tier: 3,
      alternatives: [],
    };
  }
  if (t3 && t3.matches.length > 1) {
    return {
      ok: true,
      writerFile: t3.matches[0].file,
      line: t3.matches[0].line,
      text: t3.matches[0].text,
      oldLiteral,
      newLiteral,
      confidence: 'medium',
      tier: 3,
      alternatives: t3.matches.slice(1),
    };
  }

  // No literal match. Try git tiers as informational fallback.
  const t1 = filePath ? gitIntroduce(filePath, { repoRoot }) : null;
  const t2 = gitPickaxe(oldLiteral, { repoRoot });

  // Fallback: grep for basename — useful when path is built via template/join.
  // Returns medium confidence if 1 match, low if many. This is THE signal
  // backing AC #4 case (b).
  const t3b = filePath ? grepWorktreeBasename(filePath, { repoRoot }) : null;
  if (t3b && t3b.matches.length >= 1) {
    const m = t3b.matches[0];
    return {
      ok: true,
      writerFile: m.file,
      line: m.line,
      text: m.text,
      oldLiteral,
      newLiteral,
      confidence: t3b.matches.length === 1 ? 'medium' : 'low',
      tier: '3-basename',
      alternatives: t3b.matches.slice(1),
      note: 'literal not found; matched on basename only — template-literal candidate',
    };
  }

  return {
    ok: false,
    reason: 'no writer locatable — likely template-literal or missing source',
    git_introduce: t1,
    git_pickaxe: t2,
    grep_worktree: t3,
  };
}
