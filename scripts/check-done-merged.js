#!/usr/bin/env node
/**
 * check-done-merged.js — reconciliation backstop for the done↔merged invariant
 * (df_0bd64903, AC5/AC6).
 *
 * Turns "done" back into a read of ground truth: for every story marked
 * `kanban=done`, confirm its code is actually on origin/main via the shared
 * `lib/merge-verify.isLandedOnMain` predicate. Any done story NOT on main is a
 * false-close — listed loudly. Exit 1 if any flagged, 0 if all green. `--story
 * <id>` (repeatable) scopes the check to specific records (AC6 proves the three
 * hand-reconciled defects green without tripping on the wider backlog).
 *
 * This is the continuous observer the dual-write literature prescribes: the
 * close-time gate is the primary defense, this check catches any residual skew.
 *
 * No LLM, no DB — reads meta.json + git only.
 */

// Tier: deterministic reconciliation read. No model call, no structured-store write.
export const INTELLIGENCE_TIER = 'extraction';

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';
import { isLandedOnMain } from '../lib/merge-verify.js';

function parseArgs(argv) {
  const args = { stories: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--story') args.stories.push(argv[++i]);
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--stories-dir') args.storiesDir = argv[++i];
    else if (a === '--no-fetch') args.noFetch = true;
    else if (a === '--json') args.json = true;
  }
  return args;
}

function loadMeta(storiesDir, id) {
  const p = join(storiesDir, id, 'meta.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function listStoryIds(storiesDir) {
  try {
    return readdirSync(storiesDir).filter((d) => /^(st|df|wk)_/.test(d));
  } catch {
    return [];
  }
}

export function reconcile({ repoRoot, storiesDir, storyFilter = [], fetch = true }) {
  const ids = storyFilter.length > 0 ? storyFilter : listStoryIds(storiesDir);
  // Refresh origin/main ONCE for the whole scan, not once per story — a full
  // backlog scan is hundreds of records and a per-story fetch is hundreds of
  // network round-trips. isLandedOnMain is then called with fetch:false so each
  // record is a fast local ref read against the freshly-updated tip.
  if (fetch) {
    spawnSync('git', ['-C', repoRoot, 'fetch', 'origin', 'main'], { encoding: 'utf8' });
  }
  const results = [];
  for (const id of ids) {
    const meta = loadMeta(storiesDir, id);
    if (!meta) continue;
    // Only `kanban=done` stories carry the done↔merged obligation. A scoped
    // --story that is not done is reported so the operator sees why (never a
    // silent skip that could hide a missing record).
    if (meta.kanban !== 'done') {
      if (storyFilter.length > 0) {
        results.push({ id, kanban: meta.kanban, landed: null, method: 'skip', reason: 'not-done' });
      }
      continue;
    }
    // Work records are exploratory workbench closes: no story branch, no code
    // to land on origin/main, so a done work record owes no done↔merged check.
    // This mirrors the close-gate's identical `type === 'work'` exemption
    // (story-gate.js) so the gate and this backstop never diverge on which
    // records owe the invariant (df_0bd64903 D4). Keyed on `type === 'work'`
    // only — story/defect done records are still checked. Reported (when
    // scoped) as a skip, never flagged, exactly like the not-done skip above.
    if (meta.type === 'work') {
      if (storyFilter.length > 0) {
        results.push({ id, kanban: meta.kanban, landed: null, method: 'skip', reason: 'work-exempt' });
      }
      continue;
    }
    const { landed, method } = isLandedOnMain({
      repoRoot,
      sha: meta.head_sha,
      storyId: id,
      fetch: false,
    });
    results.push({ id, kanban: meta.kanban, landed, method });
  }
  return results;
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = args.repo || REPO_ROOT;
  const storiesDir = args.storiesDir || PIPELINE_STORIES_DIR;

  const results = reconcile({
    repoRoot,
    storiesDir,
    storyFilter: args.stories,
    fetch: !args.noFetch,
  });

  const flagged = results.filter((r) => r.landed === false);

  if (args.json) {
    console.log(JSON.stringify({ flagged, results }, null, 2));
  } else {
    for (const r of results) {
      if (r.landed === true) console.log(`  ok    ${r.id}  (landed via ${r.method})`);
      else if (r.landed === false) console.log(`  FLAG  ${r.id}  done but NOT on origin/main (checked via ${r.method})`);
      else console.log(`  --    ${r.id}  kanban=${r.kanban} (${r.reason || 'skipped'})`);
    }
    if (flagged.length === 0) {
      console.log(`check-done-merged: all ${results.filter((r) => r.landed === true).length} done stor(ies) verified on origin/main.`);
    } else {
      console.error(
        `check-done-merged: ${flagged.length} FALSE-CLOSE(S) — marked done, code not on origin/main:\n` +
        flagged.map((r) => `  ${r.id}`).join('\n'),
      );
    }
  }

  process.exit(flagged.length === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
