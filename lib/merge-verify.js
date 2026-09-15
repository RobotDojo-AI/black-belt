/**
 * merge-verify.js — the shared "did this story's code actually land on
 * origin/main" predicate (df_0bd64903).
 *
 * The false-close bug was a dual-write: `kanban=done` was written independently
 * of the push it was supposed to assert, so a failed/raced merge left a story
 * marked done with code never on origin/main. The fix makes "done" a READ of
 * ground truth rather than an independent write. `isLandedOnMain` is that read,
 * imported by BOTH the done-gate (scripts/story-gate.js at --approve close) and
 * the reconciliation check (scripts/check-done-merged.js) so their definition of
 * "landed" cannot diverge.
 *
 * Two methods, chosen by what the record carries:
 *   - sha  : a `head_sha` (the story-branch tip) is recorded → the exact check
 *            `git merge-base --is-ancestor <sha> origin/main`. After a --no-ff
 *            close merge the feature tip stays reachable from main, so an
 *            is-ancestor test on the FEATURE sha holds (the merge commit itself
 *            does not exist until close succeeds — D5).
 *   - grep : legacy records predating `head_sha` (the three hand-reconciled
 *            defects) have no sha → fall back to a commit-message search for the
 *            story id on origin/main. Keyed on the BARE id, not `(<id>)`: the
 *            hand-reconcile merges use mixed forms (`<id>:` and
 *            `merge(<idA>,<idB>):`), so a per-id-parenthesized grep misses the
 *            comma-joined case. Bounded, named in the plan's failure manifest.
 *
 * Deterministic git only — no LLM, no DB.
 */

// Tier: deterministic git-state read. No model call, no structured-store write.
export const INTELLIGENCE_TIER = 'extraction';

import { spawnSync } from 'node:child_process';

function git(repoRoot, args) {
  return spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot   git repo to check against.
 * @param {string} [opts.sha]      story-branch head SHA; when present, the exact
 *                                 is-ancestor check is used.
 * @param {string} [opts.storyId]  used for the grep fallback when `sha` absent.
 * @param {boolean} [opts.fetch]   best-effort `git fetch origin main` first, so
 *                                 an on-demand check sees the freshest tip. The
 *                                 gate passes false (close just pushed, which
 *                                 already advanced the local origin/main ref).
 * @param {string} [opts.mainRef]  the ref that defines "landed"; default
 *                                 'origin/main'.
 * @returns {{landed: boolean, method: 'sha'|'grep'|'none'}}
 */
export function isLandedOnMain({ repoRoot, sha, storyId, fetch = false, mainRef = 'origin/main' } = {}) {
  if (!repoRoot) return { landed: false, method: 'none' };

  if (fetch) {
    // Best-effort only: an offline/remoteless repo must not throw — a missing
    // remote simply means we verify against whatever local origin/main we have.
    git(repoRoot, ['fetch', 'origin', 'main']);
  }

  if (sha) {
    // exit 0 = ancestor (landed), 1 = not ancestor, 128 = bad ref/etc → not landed.
    const r = git(repoRoot, ['merge-base', '--is-ancestor', sha, mainRef]);
    return { landed: r.status === 0, method: 'sha' };
  }

  if (storyId) {
    const r = git(repoRoot, ['log', mainRef, '--grep', storyId, '--fixed-strings', '--oneline']);
    const landed = r.status === 0 && r.stdout.trim().length > 0;
    return { landed, method: 'grep' };
  }

  return { landed: false, method: 'none' };
}
