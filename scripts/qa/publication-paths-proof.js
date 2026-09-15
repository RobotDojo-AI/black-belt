#!/usr/bin/env node
/**
 * publication-paths-proof.js — AC4's bounding clause (st_dd0e19d8 Phase 5).
 *
 * AC4 says publishing happens through the checked step or it does not happen,
 * and then bounds that so it can be judged rather than asserted: "every
 * publication path the repository documents or scripts is enumerated, and each
 * one either routes through the checked step or is removed."
 *
 * A hand-written list satisfies that sentence on the day it is written and stops
 * being true the next time someone adds a script. So this proof does not read
 * the list and agree with it. It RE-DERIVES the candidate set from the tree —
 * every file carrying one of the signals declared in
 * config/publication-paths.json — and fails when the list and the tree disagree
 * in either direction:
 *
 *   - a candidate in the tree that the list does not name → an unenumerated path;
 *   - an entry naming a file that no longer exists → a stale enumeration, which
 *     is how a list stops describing the repository without anyone noticing;
 *   - a `removed` entry whose file is still there → a deletion that did not
 *     happen;
 *   - a path classified as participating in publication that is not the checked
 *     step and does not route through it.
 *
 * THE DERIVATION COVERS UNTRACKED FILES TOO. `git grep` reads the tracked tree,
 * so a brand-new, not-yet-added publication script would be invisible to it —
 * and a new script is exactly when this check matters. The candidate scan is the
 * union of tracked, staged and untracked-not-ignored files, the same union the
 * completeness gate uses for the same reason.
 *
 * Exit 0 = the enumeration matches the repository.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { globToRegExp } from '../../lib/publication-manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const PATHS_FILE = join(REPO_ROOT, 'config', 'publication-paths.json');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

function git(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Tracked + staged + untracked-not-ignored, deduped. */
function candidateFiles() {
  const out = new Set();
  for (const args of [
    ['ls-files', '-z'],
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]) {
    const r = git(args);
    if (r.status !== 0) continue;
    for (const p of r.stdout.split('\0')) if (p) out.add(p);
  }
  return [...out].sort();
}

function isTextFile(abs) {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > 5_000_000) return false;
    const buf = readFileSync(abs);
    const n = Math.min(buf.length, 8000);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
    return true;
  } catch {
    return false;
  }
}

function main() {
  const config = JSON.parse(readFileSync(PATHS_FILE, 'utf8'));
  process.stdout.write('publication-paths-proof: the enumeration against the repository\n');

  const excluded = (config.exclude_from_derivation || []).map((e) => ({ ...e, re: globToRegExp(e.glob) }));
  const signals = config.signals || [];
  check('the derivation declares at least one signal', signals.length > 0, signals.join(' | '));

  // Re-derive.
  const derived = [];
  for (const file of candidateFiles()) {
    if (excluded.some((e) => e.re.test(file))) continue;
    const abs = join(REPO_ROOT, file);
    if (!isTextFile(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    if (signals.some((s) => text.includes(s))) derived.push(file);
  }

  const enumerated = new Map((config.paths || []).map((p) => [p.path, p]));
  const removed = new Map((config.removed || []).map((p) => [p.path, p]));

  const unenumerated = derived.filter((f) => !enumerated.has(f) && !removed.has(f));
  check(
    'every publication-path candidate in the repository is enumerated',
    unenumerated.length === 0,
    unenumerated.length === 0 ? `${derived.length} candidate(s), all named` : unenumerated.join(', ')
  );

  const stale = [...enumerated.keys()].filter((p) => !existsSync(join(REPO_ROOT, p)));
  check(
    'no entry names a file that no longer exists',
    stale.length === 0,
    stale.length === 0 ? `${enumerated.size} entr(ies)` : stale.join(', ')
  );

  const resurrected = [...removed.keys()].filter((p) => existsSync(join(REPO_ROOT, p)));
  check(
    'every path listed as removed is really gone',
    resurrected.length === 0,
    resurrected.length === 0 ? [...removed.keys()].join(', ') || 'none listed' : resurrected.join(', ')
  );

  const missingReason = [...enumerated.values(), ...removed.values()].filter(
    (e) => typeof e.reason !== 'string' || !e.reason.trim()
  );
  check(
    'every entry states why it is classified as it is',
    missingReason.length === 0,
    missingReason.map((e) => e.path).join(', ')
  );

  // The checked step exists, is named, and is the one entry allowed to publish.
  const stepPath = config.checked_step;
  check(
    'the checked step exists and is enumerated as such',
    !!stepPath
      && existsSync(join(REPO_ROOT, stepPath))
      && enumerated.get(stepPath)
      && enumerated.get(stepPath).classification === 'checked-step',
    stepPath || 'none declared'
  );
  const stepEntries = [...enumerated.values()].filter((e) => e.classification === 'checked-step');
  check('there is exactly one checked step', stepEntries.length === 1, stepEntries.map((e) => e.path).join(', '));

  const known = new Set(['checked-step', 'routes-through', 'not-a-path']);
  const badClass = [...enumerated.values()].filter((e) => !known.has(e.classification));
  check(
    'every classification is one of the declared kinds',
    badClass.length === 0,
    badClass.map((e) => `${e.path}: ${e.classification}`).join(', ')
  );

  // The substantive assertion: nothing but the checked step and its own library
  // may actually push. A `not-a-path` entry that turns out to invoke a push
  // against this repository would be a classification that stopped being true.
  const pushers = [];
  for (const entry of enumerated.values()) {
    if (entry.classification === 'checked-step' || entry.classification === 'routes-through') continue;
    const abs = join(REPO_ROOT, entry.path);
    if (!existsSync(abs) || !isTextFile(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    // An executed push, not a mention of one: a shell/exec invocation whose
    // command string carries `git push`. Prose and assertions about a push do
    // not match, which is the distinction the classifications rest on.
    if (/(?:execSync|spawnSync|spawn|exec)\s*\([^)]*git push/.test(text) || /['"`]git push[^'"`]*['"`]\s*,\s*\{[^}]*cwd/.test(text)) {
      pushers.push(entry.path);
    }
  }
  // gsc-heal genuinely executes a push, at a repo root resolved elsewhere. The
  // classification claims it cannot address this repository; assert that claim
  // rather than exempting the file.
  const gsc = join(REPO_ROOT, 'lib', 'gsc-heal.js');
  let gscScoped = true;
  if (existsSync(gsc)) {
    const text = readFileSync(gsc, 'utf8');
    gscScoped = /_repoRootForFiles/.test(text) && /sitesRoot/.test(text);
    if (gscScoped) {
      const i = pushers.indexOf('lib/gsc-heal.js');
      if (i >= 0) pushers.splice(i, 1);
    }
  }
  check(
    'the site-healing push is still scoped to the configured sites root, not this repository',
    gscScoped,
    gscScoped ? 'resolved per finding by _repoRootForFiles(sitesRoot)' : 'the scoping helper is gone'
  );
  check(
    'no file classified as not-a-path actually executes a push',
    pushers.length === 0,
    pushers.join(', ')
  );

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`publication-paths-proof: ${results.length - failed.length}/${results.length} PASS\n`);
  return failed.length === 0 ? 0 : 1;
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`publication-paths-proof: ${err.stack || err.message}\n`);
  process.exit(2);
}
