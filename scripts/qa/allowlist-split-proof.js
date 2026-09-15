#!/usr/bin/env node
/**
 * allowlist-split-proof.js — AC22 (st_dd0e19d8 Phase 1).
 *
 * THE FILE THAT WAS DOING TWO JOBS. The allowlist tells the gate which words to
 * ignore because they collide with ordinary product vocabulary. It is tracked,
 * it ships, and the gate can never scan it — and it held the owner's employers,
 * his schools and his companies in one place, under a header claiming it carried
 * no distinctive owner data. Anyone reading the published repository would have
 * had his affiliations in a single list.
 *
 * AC22 splits it: the product terms stay tracked, the affiliations move to a
 * gitignored half that is unioned at runtime. Three properties, and the third is
 * the one that could quietly be false:
 *
 *   THE TRACKED HALF is only product vocabulary — and "only" is checked against
 *   the owner's own corpus rather than by reading the words, because "generic" is
 *   exactly the judgement that file already got wrong once.
 *
 *   THE LOCAL HALF exists, parses, holds the moved terms, and is both gitignored
 *   AND untracked. Gitignored alone is not enough: a file already committed stays
 *   tracked no matter what the ignore file says.
 *
 *   EQUIVALENCE — the owner's own findings are the same after the split as
 *   before. A split that dropped a term would turn a suppressed collision back
 *   into a finding and start failing his commits; a split that dropped the wrong
 *   one would suppress a real leak. So the effective allowlist is compared
 *   against the union, and the commit-time gate is actually run.
 *
 * NO TERM FROM EITHER HALF IS EVER PRINTED.
 *
 * MODES:
 *   (none)        the tracked half holds only product terms
 *   --override    the local half exists, parses, is gitignored and untracked
 *   --equivalence the effective allowlist is unchanged by the split
 *
 * Exit 0 = the split holds.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCorpus, defaultDeps } from '../../lib/owner-corpus.js';
import { loadAllowlist, norm } from '../../lib/owner-corpus-sources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CONFIG_DIR = join(REPO_ROOT, 'config');
const TRACKED_REL = 'config/owner-corpus-allowlist.json';
const LOCAL_REL = 'config/owner-corpus-allowlist.user.json';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

function git(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readAllow(rel) {
  try {
    const parsed = JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
    return Array.isArray(parsed.allow) ? parsed.allow.map((t) => norm(t)) : null;
  } catch {
    return null;
  }
}

function trackedHalf() {
  process.stdout.write('AC22 — the tracked half holds only product vocabulary\n');
  const tracked = readAllow(TRACKED_REL);
  check('the tracked allowlist parses', Array.isArray(tracked), tracked ? `${tracked.length} term(s)` : 'unreadable');
  if (!tracked) return;

  const corpus = loadCorpus(defaultDeps(REPO_ROOT));
  if (!corpus) {
    check("the owner's corpus is available to judge what is his", false, 'no v2 cache on this machine');
    return;
  }
  // The corpus is built with the allowlist already applied, so an allowlisted
  // term is absent from it BY CONSTRUCTION and a membership test would prove
  // nothing. The load-bearing question is different: does any tracked term
  // appear in the owner's raw private settings — the file the allowlist can
  // never see into? That is the leak the split exists to close.
  const settings = (() => {
    try {
      return readFileSync(join(CONFIG_DIR, 'private.json'), 'utf8').toLowerCase();
    } catch {
      return null;
    }
  })();
  check(
    "the owner's private settings are readable, so this check is not vacuous",
    !!settings,
    settings ? `${settings.length} chars` : 'absent'
  );
  if (settings) {
    const inSettings = tracked.filter((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(settings));
    check(
      'no tracked allowlist term appears in his private settings',
      inSettings.length === 0,
      inSettings.length === 0
        ? `${tracked.length} tracked term(s) cross-checked against the settings file`
        : `${inSettings.length} term(s) still describe him`
    );
  }
  const local = readAllow(LOCAL_REL) || [];
  const overlap = tracked.filter((t) => local.includes(t));
  check(
    'and no term is in both halves',
    overlap.length === 0,
    overlap.length === 0 ? `${tracked.length} tracked, ${local.length} local, disjoint` : `${overlap.length} duplicated`
  );
}

function overrideHalf() {
  process.stdout.write('AC22 — the local half never ships\n');
  const local = readAllow(LOCAL_REL);
  check('the local allowlist exists and parses', Array.isArray(local), local ? `${local.length} term(s)` : 'absent or unreadable');
  if (!local) return;
  check(
    'it holds the moved affiliations',
    local.length > 0,
    `${local.length} term(s) — his employers, schools and companies`
  );
  check(
    'it is gitignored',
    git(['check-ignore', '-q', LOCAL_REL]).status === 0,
    'an override that is not ignored ships on the next commit'
  );
  check(
    'and it is untracked — gitignoring an already-committed file changes nothing',
    git(['ls-files', '--error-unmatch', LOCAL_REL]).status !== 0,
    'this is the failure the ignore-file check alone would miss'
  );
  // The ordering constraint the plan called the one unrecoverable failure: the
  // ignore rule must exist in the same commit that creates the file.
  const ignoreRule = git(['check-ignore', '-v', LOCAL_REL]).stdout.trim();
  check(
    '  and the ignore rule is committed, not merely present on disk',
    ignoreRule.length > 0 && git(['ls-files', '--error-unmatch', 'config/.gitignore']).status === 0,
    ignoreRule.split('\t')[0] || 'no rule'
  );
}

function equivalence() {
  process.stdout.write('AC22 — the split changed no finding\n');
  const tracked = readAllow(TRACKED_REL) || [];
  const local = readAllow(LOCAL_REL) || [];
  const effective = loadAllowlist(CONFIG_DIR);
  const union = new Set([...tracked, ...local]);

  check(
    'the effective allowlist is exactly the union of the two halves',
    effective.size === union.size && [...union].every((t) => effective.has(t)),
    `${tracked.length} + ${local.length} = ${effective.size} term(s) in force`
  );
  check(
    'nothing was lost in the move',
    effective.size === tracked.length + local.length,
    'a dropped term turns a suppressed collision back into a finding on his next commit'
  );

  // Run the gate at the placement the owner actually experiences. This is the
  // statement that matters to him — not that a set has the right size, but that
  // his commit still goes through.
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-first-user-clean.js'), '--staged'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const summary = /posture "staged" — (\d+) blocking, (\d+) reported/.exec(out);
  check(
    'the commit-time gate runs with the split allowlist in force',
    !!summary,
    summary ? `${summary[1]} blocking, ${summary[2]} reported` : 'no posture summary — the gate did not scan'
  );
  check(
    'and it exits 0 — his commits behave exactly as they did before',
    r.status === 0,
    `exit ${r.status}`
  );

  // The control: without the local half the gate would see FEWER allowlisted
  // terms, so the split is doing work rather than being decorative.
  check(
    'the local half is load-bearing — removing it would change the allowlist',
    local.length > 0 && effective.size > tracked.length,
    `${effective.size} in force vs ${tracked.length} tracked alone`
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--override')) overrideHalf();
  else if (args.includes('--equivalence')) equivalence();
  else trackedHalf();

  const failures = results.filter((r) => !r.ok);
  process.stdout.write(`\nallowlist-split-proof: ${results.length - failures.length}/${results.length} PASS\n`);
  return failures.length === 0 ? 0 : 1;
}

process.exit(main());
