#!/usr/bin/env node
/**
 * scripts/sitemap-gate-needed.js — st_4312c9c0 AC 19
 *
 * Decides whether the staged commit can possibly change the repository's file
 * inventory (architecture/sitemap.md, architecture/ontology.md). Both freshness
 * checks re-derive the ENTIRE file inventory via `git ls-files` + a tree walk on
 * every commit (generate-sitemap.js:48-50,109) — measured at 7.1s of the 20.6s
 * pre-commit baseline — even for a commit that only edits text inside files that
 * already exist. That work is only ever necessary when the staged set adds,
 * deletes, or renames a path.
 *
 * `git diff --cached --name-status` reports one status letter per staged path:
 * A (add), D (delete), R### (rename, with a similarity score suffix — still
 * starts with R), C### (copy), M (modify), T (type change, e.g. symlink<->file).
 * Only a pure-M staged set is guaranteed not to touch the inventory; anything
 * else (including T — a type change can flip a tracked path's kind) must run
 * the full check.
 *
 * THE CORRECTNESS REQUIREMENT IS OR, NOT AND. Exit 1 (skip the full check)
 * only when EVERY staged entry is exactly M. A single non-M entry among many
 * M entries must still trigger the full check — that is the exact case an
 * AND-logic bug (requiring A *and* D *and* R together) would miss: a lone
 * file add would pass every original criterion while landing a stale sitemap.
 *
 * Exit codes:
 *   0 — the staged set may have changed the inventory; run the full check.
 *       Also the conservative default for an empty staged set (nothing to
 *       lose by running the check; never skip on ambiguity).
 *   1 — every staged entry is M; the full check is provably unnecessary.
 *
 * INTELLIGENCE_TIER: n/a — this script makes no LLM call and does not touch
 * lib/db.js; it is a pure git-diff classifier.
 */

import { spawnSync } from 'node:child_process';

/**
 * @param {string} nameStatusOutput raw stdout of `git diff --cached --name-status -z`
 * @returns {boolean} true when every staged entry's status is exactly 'M'
 */
export function everyStagedEntryIsModifyOnly(nameStatusOutput) {
  const raw = String(nameStatusOutput || '');
  // -z output is NUL-delimited: STATUS\0PATH\0[PATH2\0 for rename/copy]\0...
  const fields = raw.split('\0').filter((f) => f.length > 0);
  if (fields.length === 0) return false; // empty staged set — caller decides (conservative: run the check)

  const statuses = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i];
    statuses.push(status);
    // R### and C### consume two path fields (old + new); everything else consumes one.
    const consumesTwoPaths = /^[RC]/.test(status);
    i += consumesTwoPaths ? 3 : 2;
  }
  return statuses.length > 0 && statuses.every((s) => s === 'M');
}

function main() {
  const result = spawnSync('git', ['diff', '--cached', '--name-status', '-z'], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || result.error) {
    // Cannot determine the staged set — conservative: run the full check.
    process.exit(0);
  }
  const stdout = result.stdout || '';
  if (stdout.trim().length === 0) {
    // Empty staged set — nothing to gate on yet (e.g. `git commit --amend` with
    // no new staged changes, or the hook running ahead of `git add`). Conservative:
    // run the full check rather than assume the inventory is unchanged.
    process.exit(0);
  }
  process.exit(everyStagedEntryIsModifyOnly(stdout) ? 1 : 0);
}

main();
