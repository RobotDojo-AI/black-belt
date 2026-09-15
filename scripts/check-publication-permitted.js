#!/usr/bin/env node
/**
 * check-publication-permitted.js — the permitted list's own gate
 * (st_dd0e19d8 Phase 2: AC15).
 *
 * THIS FILE IS A CLI FACADE. Parse, delegate, report. The rules live in
 * lib/publication-posture.js and the scanners in lib/corpus-scan.js — read those
 * for the mechanism (thin-facade convention: logic in lib/ as named
 * `(deps, ...params)` functions).
 *
 * The permitted list is the one part of this gate that WEAKENS it, so it gets a
 * check of its own. Three modes, one per property the sealed criterion names:
 *
 *   --schema        every entry carries a name, a file, a class and a stated
 *                   reason — and the two placement rules hold: an owner-
 *                   identifying class may not be named in the tracked file, and a
 *                   tracked entry may only excuse a term the tree already carries
 *                   at that path.
 *
 *   --decay-proof   demonstrates BOTH halves of decay against synthetic entries in
 *                   a scratch config dir: an entry that matches nothing inside the
 *                   scanned path set is removed, and an entry whose file is
 *                   OUTSIDE that set survives untouched. The owner's real list is
 *                   never read or written by this mode.
 *
 *   --counts-recorded --invariants
 *                   ONE run computes both permitted-entry counts (full tracked
 *                   tree, published set) and both non-permitted remainders, writes
 *                   them to a receipt, and asserts the invariants: one run, the
 *                   full-tree count at least the published count, the non-permitted
 *                   remainder zero on both paths. No expected value is hard-coded —
 *                   the corpus moves, so the criterion pins the derivation and
 *                   requires the number to be RECORDED, not predicted.
 *
 * --decay applies decay to the real list and writes it back. That is the
 * publication path's step; nothing else in this script mutates anything.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 *
 * Runnable from ~/robotdojo. Exit 0 = the asserted property holds.
 */
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';

import { loadCorpus, defaultDeps } from '../lib/owner-corpus.js';
import {
  loadPostureTable,
  loadPermitted,
  validatePermitted,
  applyPermitted,
  collectFindings,
  decayPermitted,
  writePermitted,
  skipPaths,
  skipPathspecs,
  normTerm,
  PERMITTED_FILE,
} from '../lib/publication-posture.js';
import { loadManifest, resolveManifest } from '../lib/publication-manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CONFIG_DIR = join(REPO_ROOT, 'config');
// `~/.robotdojo/reports/` — an already-allowlisted home. A receipt written at the
// top of ~/.robotdojo/ is a structure violation that stops the line, which is a
// silly way for a permitted-list count to break someone's commit.
const RECEIPT_PATH =
  process.env.ROBOTDOJO_PERMITTED_RECEIPT
  || join(homedir(), '.robotdojo', 'reports', 'publication-permitted-counts.json');

function git(args) {
  return spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function trackedFiles() {
  const r = git(['ls-files', '-z']);
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr || ''}`);
  return r.stdout.split('\0').filter(Boolean);
}

/**
 * The no-new-exposure probe: does the TRACKED copy of `file` contain `term`?
 * Read from the index (`git show :file` falls back to HEAD) rather than the
 * working tree, so an uncommitted edit cannot talk an entry past the rule.
 */
function trackedFileHasTerm(file, term) {
  let body = '';
  for (const ref of [`:${file}`, `HEAD:${file}`]) {
    const r = git(['show', ref]);
    if (r.status === 0) {
      body = r.stdout;
      break;
    }
  }
  if (!body) return false;
  return body.toLowerCase().includes(normTerm(term));
}

// ── the scan, run once and shared by every mode that needs findings ──────────

/**
 * Scan a path set at the `publish` placement and return every finding. Used by
 * --counts-recorded (twice, in one process, so both counts provably come from one
 * run) and by --decay.
 *
 * The scan itself is lib/publication-posture.js's `collectFindings` — the SAME
 * function the commit-time gate calls. A permitted-entry count derived from a
 * second implementation would drift from what the gate actually blocks on, which
 * is the one way this count could be confidently wrong.
 */
function scanPathSet(corpus, table, pathspecs, files) {
  const deps = { git, table, placement: 'publish', skip: skipPaths(table) };
  return collectFindings(deps, corpus, { pathspecs, pathFiles: files }).findings;
}

// ── --schema ─────────────────────────────────────────────────────────────────

function modeSchema() {
  const entries = loadPermitted(CONFIG_DIR);
  const errors = validatePermitted(entries, { fileHasTerm: trackedFileHasTerm });
  const tracked = entries.filter((e) => e.source === PERMITTED_FILE).length;
  const local = entries.length - tracked;
  process.stdout.write(
    `check-publication-permitted --schema: ${entries.length} entr(ies) — ${tracked} tracked, ${local} local\n`
  );
  if (errors.length > 0) {
    process.stderr.write('check-publication-permitted --schema: the permitted list is not sound:\n');
    for (const e of errors) process.stderr.write(`  ${e}\n`);
    return 1;
  }
  process.stdout.write(
    '  every entry carries a name, a file, a class and a stated reason; no owner-identifying\n'
      + '  class is named in the tracked file; every tracked term already exists at its path.\n'
  );
  return 0;
}

// ── --decay-proof ────────────────────────────────────────────────────────────

/**
 * Both halves of decay, demonstrated rather than asserted. The proof runs against
 * SYNTHETIC entries with no owner data, so it is reproducible on any machine and
 * it never touches the owner's real list.
 *
 * The second half is the one that matters and the one a naive implementation gets
 * wrong: an entry covering a file this run did not scan must SURVIVE. Decay it and
 * the next wider run flags that finding again as brand new, which is how a
 * permitted list starts fighting the person maintaining it.
 */
function modeDecayProof() {
  const dir = mkdtempSync(join(tmpdir(), 'rd-decay-proof-'));
  try {
    const live = {
      term: 'live-term@example.invalid',
      file: 'scanned/live.txt',
      class: 'emails',
      reason: 'synthetic — still matched by a finding inside the scanned set',
      added: '2026-07-25',
    };
    const dead = {
      term: 'dead-term@example.invalid',
      file: 'scanned/dead.txt',
      class: 'emails',
      reason: 'synthetic — inside the scanned set, matched by nothing',
      added: '2026-07-25',
    };
    const outside = {
      term: 'outside-term@example.invalid',
      file: 'tests/outside.test.js',
      class: 'emails',
      reason: 'synthetic — legitimately covers a file a published-set run never scans',
      added: '2026-07-25',
    };
    writeFileSync(
      join(dir, PERMITTED_FILE),
      `${JSON.stringify({ _comment: 'synthetic proof fixture', permitted: [live, dead, outside] }, null, 2)}\n`
    );

    const permitted = loadPermitted(dir);
    // The run scanned two paths. The third entry's file is deliberately not among
    // them — that is the whole point of the second half of the proof.
    const scannedPaths = new Set(['scanned/live.txt', 'scanned/dead.txt']);
    const findings = [{ class: 'emails', term: live.term, file: live.file, line: 1, matched_form: live.term }];

    const { kept, removed, unscanned } = decayPermitted(permitted, findings, scannedPaths);
    const written = writePermitted(dir, kept);
    const after = JSON.parse(readFileSync(join(dir, PERMITTED_FILE), 'utf8')).permitted;
    const has = (t) => after.some((e) => e.term === t);

    const checks = [
      ['an entry matched by a finding survives', has(live.term)],
      ['an entry inside the scanned set that matches nothing is REMOVED', !has(dead.term)],
      ['exactly one entry was removed', removed.length === 1 && removed[0].term === dead.term],
      ['an entry whose file was never scanned SURVIVES', has(outside.term)],
      ['that survivor is reported as unscanned, not as matched', unscanned.length === 1 && unscanned[0].term === outside.term],
      ['the decayed list was written back to disk', written.includes(PERMITTED_FILE)],
    ];
    let ok = true;
    process.stdout.write('check-publication-permitted --decay-proof:\n');
    for (const [label, pass] of checks) {
      if (!pass) ok = false;
      process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'}  ${label}\n`);
    }
    if (!ok) {
      process.stderr.write('check-publication-permitted --decay-proof: decay does not behave as specified.\n');
    }
    return ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── --counts-recorded --invariants ───────────────────────────────────────────

function summarise(findings, permitted) {
  const applied = applyPermitted(findings, permitted);
  const permittedRows = applied.findings.filter((f) => f.permitted);
  const remainder = applied.findings.filter((f) => !f.permitted);
  const pairs = new Set(permittedRows.map((f) => `${f.class} ${f.file} ${normTerm(f.term)}`));
  const remainderPairs = new Set(remainder.map((f) => `${f.class} ${f.file} ${f.term ? normTerm(f.term) : '?'}`));
  const byClass = {};
  for (const f of remainder) byClass[f.class] = (byClass[f.class] || 0) + 1;
  return {
    permitted_pairs: pairs.size,
    permitted_rows: permittedRows.length,
    non_permitted_pairs: remainderPairs.size,
    non_permitted_rows: remainder.length,
    non_permitted_by_class: byClass,
    remainder,
  };
}

/**
 * Where the build artifact lives. The sealed criterion is run without arguments,
 * so "recorded in the build artifact" has to resolve to a real path by itself or
 * the phrase is decoration. The build/QA skills export ROBOTDOJO_ACTIVE_STORY;
 * --artifact overrides for any other caller.
 */
function resolveArtifactPath(explicit) {
  const stories = join(REPO_ROOT, 'user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories');
  if (explicit) return explicit;
  const story = process.env.ROBOTDOJO_ACTIVE_STORY;
  if (story) return join(stories, story, '03-build.md');
  // MEASURED, and the reason this fallback exists: the criteria runner does not
  // export ROBOTDOJO_ACTIVE_STORY, so the sealed criterion — which is run with no
  // arguments and no env — could never pass, not because the property was false
  // but because the artifact could not be found. A criterion that cannot pass is
  // not a strict criterion, it is a broken one.
  //
  // The fallback is the STORY BRANCH, not the story records. Inferring from the
  // records was tried first and is useless: 184 of them carry a non-closed stage
  // and a build artifact, because `stage` is not reset when a story finishes. The
  // branch is unambiguous — the build convention is that a story's work happens on
  // `story/<id>-<slug>`, one branch, one story. Off such a branch this returns
  // null and the caller still fails loudly.
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const m = /^story\/((?:st|df)_[0-9a-z]+)/.exec((branch.stdout || '').trim());
  if (!m) return null;
  const path = join(stories, m[1], '03-build.md');
  return existsSync(path) ? path : null;
}

function modeCounts({ invariants, artifactPath }) {
  const deps = defaultDeps(REPO_ROOT);
  const corpus = loadCorpus(deps);
  if (!corpus) {
    process.stderr.write(
      'check-publication-permitted --counts-recorded: corpus UNAVAILABLE (no v2 cache). A count\n'
        + 'derived from an absent corpus is a vacuous zero. Run check-first-user-clean.js --refresh.\n'
    );
    return 1;
  }
  const table = loadPostureTable(CONFIG_DIR);
  const permitted = loadPermitted(CONFIG_DIR);
  const excl = skipPathspecs(table);

  // ONE run, one process, one corpus, one permitted list — the two counts below
  // cannot come from different states of the tree.
  const runId = `${new Date().toISOString()}-${process.pid}`;
  const tracked = trackedFiles();
  // The published set comes from AC3's manifest, not from a rule restated here.
  // A count derived from a second definition of "what ships" would drift from
  // what the publication step actually copies — and the drift would look like a
  // permitted-list problem rather than what it is.
  const published = resolveManifest({ trackedFiles }, loadManifest(CONFIG_DIR)).paths;

  const fullFindings = scanPathSet(corpus, table, excl, tracked);
  const publishedFindings = scanPathSet(corpus, table, [...published, ...excl], published);

  const full = summarise(fullFindings, permitted);
  const pub = summarise(publishedFindings, permitted);

  const receipt = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    repo_root: REPO_ROOT,
    corpus_built_at: corpus.built_at,
    scanned_files: { full_tree: tracked.length, published_set: published.length },
    full_tree: { ...full, remainder: undefined },
    published_set: { ...pub, remainder: undefined },
  };
  mkdirSync(dirname(RECEIPT_PATH), { recursive: true });
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);

  process.stdout.write(
    `check-publication-permitted --counts-recorded: run ${runId}\n`
      + `  full tracked tree  — ${tracked.length} files, ${full.permitted_pairs} permitted (term,file) pair(s), `
      + `${full.non_permitted_pairs} non-permitted pair(s)\n`
      + `  published set      — ${published.length} files, ${pub.permitted_pairs} permitted (term,file) pair(s), `
      + `${pub.non_permitted_pairs} non-permitted pair(s)\n`
      + `  receipt written to ${RECEIPT_PATH}\n`
  );

  if (!invariants) return 0;

  const failures = [];
  if (!(full.permitted_pairs >= pub.permitted_pairs)) {
    failures.push(
      `the full-tree permitted count (${full.permitted_pairs}) is below the published-set count `
        + `(${pub.permitted_pairs}) — the published set is a subset, so this cannot happen`
    );
  }
  for (const [label, s] of [['full tracked tree', full], ['published set', pub]]) {
    if (s.non_permitted_pairs !== 0) {
      failures.push(
        `${label}: ${s.non_permitted_pairs} non-permitted (term,file) pair(s) remain across `
          + `${s.non_permitted_rows} row(s); rows by class — `
          + Object.entries(s.non_permitted_by_class).map(([c, n]) => `${c}:${n}`).join(', ')
      );
    }
  }
  const artifact = resolveArtifactPath(artifactPath);
  if (!artifact) {
    failures.push(
      'cannot locate the build artifact — set ROBOTDOJO_ACTIVE_STORY or pass --artifact <path>. '
        + '"Recorded in the build artifact" cannot be asserted against a file nobody named.'
    );
  } else {
    let body = '';
    try {
      body = readFileSync(artifact, 'utf8');
    } catch {
      failures.push(`build artifact ${artifact} is unreadable — the counts cannot be recorded in it`);
    }
    for (const [label, n] of [
      ['full-tree permitted count', full.permitted_pairs],
      ['published-set permitted count', pub.permitted_pairs],
    ]) {
      if (body && !new RegExp(`\\b${n}\\b`).test(body)) {
        failures.push(`the ${label} (${n}) does not appear in ${artifact}`);
      }
    }
  }

  if (failures.length > 0) {
    process.stderr.write('check-publication-permitted --invariants: NOT satisfied:\n');
    for (const f of failures) process.stderr.write(`  ${f}\n`);
    const worst = [...full.remainder].slice(0, 25);
    if (worst.length > 0) {
      process.stderr.write('  first non-permitted findings on the full tree:\n');
      for (const f of worst) {
        process.stderr.write(`    ${f.file}:${f.line} [${f.class}] ${f.term || '(unresolved)'}\n`);
      }
    }
    return 1;
  }
  process.stdout.write(
    '  invariants hold: both counts from one run, full tree >= published, non-permitted remainder zero on both paths.\n'
  );
  return 0;
}

// ── --decay (the publication path's own step) ────────────────────────────────

function modeDecay() {
  const deps = defaultDeps(REPO_ROOT);
  const corpus = loadCorpus(deps);
  if (!corpus) {
    process.stderr.write('check-publication-permitted --decay: corpus UNAVAILABLE — refusing to decay against nothing.\n');
    return 1;
  }
  const table = loadPostureTable(CONFIG_DIR);
  const permitted = loadPermitted(CONFIG_DIR);
  const tracked = trackedFiles();
  const findings = scanPathSet(corpus, table, skipPathspecs(table), tracked);
  const { kept, removed, unscanned } = decayPermitted(permitted, findings, new Set(tracked));
  const written = writePermitted(CONFIG_DIR, kept);
  process.stdout.write(
    `check-publication-permitted --decay: ${permitted.length} entr(ies) in, ${kept.length} kept, `
      + `${removed.length} removed, ${unscanned.length} outside the scanned set (left alone).\n`
  );
  for (const e of removed) process.stdout.write(`  removed: [${e.class}] ${e.file} (${e.source})\n`);
  if (written.length > 0) process.stdout.write(`  rewrote: ${written.join(', ')}\n`);
  return 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const valueOf = (f) => {
    const i = args.indexOf(f);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };

  if (has('--schema')) return modeSchema();
  if (has('--decay-proof')) return modeDecayProof();
  if (has('--counts-recorded')) {
    return modeCounts({ invariants: has('--invariants'), artifactPath: valueOf('--artifact') });
  }
  if (has('--decay')) return modeDecay();

  process.stderr.write(
    'check-publication-permitted: usage —\n'
      + '  --schema\n'
      + '  --decay-proof\n'
      + '  --counts-recorded [--invariants] [--artifact <path>]\n'
      + '  --decay\n'
  );
  return 2;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`check-publication-permitted: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}

export { scanPathSet, summarise, trackedFileHasTerm, REPO_ROOT, CONFIG_DIR };
