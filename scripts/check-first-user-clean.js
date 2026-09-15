#!/usr/bin/env node
/**
 * check-first-user-clean.js — the completeness gate (st_e36f5f2b AC5,
 * extended by st_dd0e19d8 Phase 1).
 *
 * WHAT THIS IS: the single runnable definition of "clean" that ends five rounds
 * of PII whack-a-mole. Instead of scrubbing until no owner term is visible, this
 * gate DERIVES the owner's identity + entity corpus from the on-disk gitignored
 * data (never a hand list, never a literal in this file) and cross-references
 * every tracked file — CONTENTS and PATHS — against it. A leak the scrub rounds
 * could not anticipate cannot out-run the gate, because the leaking class is in
 * the corpus.
 *
 * THIS FILE IS A CLI FACADE. Parse, delegate, report. The corpus lives in
 * lib/owner-corpus.js + lib/owner-corpus-sources.js and the scanners live in
 * lib/corpus-scan.js — read those for the mechanism and the measurements behind
 * it (thin-facade convention: logic in lib/ as named (deps, …params) functions).
 *
 * WHY IT CANNOT VACUOUSLY PASS: a blind gate that derived an empty corpus would
 * exit 0 on a dirty tree and read as "clean". Three defenses:
 *   1. `--self-test` (positive control): seed a known corpus term into a
 *      throwaway fixture on a scanned path, run the scan, assert exit != 0 AND
 *      the fixture file:line is reported. A gate that cannot fail on a planted
 *      term proves nothing.
 *   2. Every run prints the corpus COUNTS it cross-checked, per class, plus any
 *      source that was unavailable and why. A partial build can no longer read as
 *      a full one.
 *   3. A cache of the wrong schema version is treated as ABSENT, never as EMPTY.
 *      "Absent" means refresh me; "empty" means nothing to find. Confusing the
 *      two is precisely how a blind gate certifies a dirty tree.
 *
 * NO OWNER DATA LIVES IN THIS FILE, or in the lib modules it delegates to. The
 * corpus is read at runtime from the same gitignored sources gate-pii.sh and
 * check-public-config-clean.js already use. On a fresh clone with no local data
 * the identity + entity cross-check is a no-op (corpus unavailable), but the
 * composed structural secrets scan still runs.
 *
 * COMPUTE TIER: Tier 0 throughout — deterministic, no LLM (identity is never
 * trusted to an LLM, per build-conventions). No INTELLIGENCE_TIER declaration:
 * this is a structural gate that opens no model client and names no model
 * constant, same as every sibling scripts/check-*.js (see
 * check-public-config-clean.js). The phrasing here is deliberate — spelling the
 * client factory's name in prose made check-structure.js's substring detector
 * read this comment as a model call and stop the line on a file that has never
 * made one.
 *
 * MODES:
 *   --staged   (default) pre-commit — scan only files staged in this commit.
 *              NEVER builds the corpus: a full refresh iterates 646k+ rows and
 *              takes minutes, and building here on a machine without the DB would
 *              write an EMPTY cache that makes every later run exit 0 forever.
 *              An absent cache is reported as unavailable and exits 0.
 *   --all      publication — scan every tracked file PLUS every about-to-ship
 *              file that is not yet committed: newly staged AND still-untracked
 *              (non-ignored). git ls-files alone omits an unstaged brand-new file,
 *              so a blind --all could vacuously pass while a new file carried owner
 *              data. The union closes that timing gap; gitignored owner data stays
 *              excluded, so the corpus source is never self-flagged.
 *   --refresh  rebuild the corpus cache from on-disk gitignored data, then --all.
 *              The write is guarded: a build from a repo root other than the one
 *              that created the cache, or from a tree with the structural
 *              signature of an export directory, refuses to overwrite.
 *   --refresh --adopt   re-establish cache provenance after a genuine repo move.
 *   --self-test positive control (see above).
 *
 * COMPOSITION: the publication modes (--all / --refresh) run gate-pii.sh (owner
 * names/emails/private patterns) and check-public-config-clean.js (owner domains/
 * gids/calendar-ids/credentials) so "clean" means free of owner identity AND
 * entity AND keys/secrets — matching the framing. --staged skips composition
 * because pre-commit already runs those two as their own adjacent hook steps.
 *
 *   --require-composed  (AC13) demand that both composed scans actually loaded
 *              their owner configuration, and refuse rather than report clean if
 *              either did not. Passed only by the publication step, which also
 *              bridges that configuration into the export by env. Without it,
 *              both scans behave exactly as they do today.
 *
 * ONE FINDINGS LIST, TWO PLACEMENTS (st_dd0e19d8 Phase 2, AC15/AC16). The scan
 * produces a single list where every finding carries its class; a POSTURE TABLE
 * consulted at report time decides whether that class blocks, reports, or is not
 * scanned at all in this placement. That is what makes the every-commit report
 * and the publication certification the SAME check configured twice, rather than
 * two checks that drift the first time one is edited. The table is data
 * (config/publication-posture.json), so a class that starts producing false
 * positives is demoted in one word — no edit to a gate that is at that moment
 * blocking every commit. Findings excused by config/publication-permitted.json
 * are counted and set aside, never silently dropped.
 *
 * Runnable from ~/robotdojo. Exit 0 = clean, exit != 0 = leak(s) as file:line.
 */
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildCorpus, loadCorpus, corpusCacheState, defaultDeps } from '../lib/owner-corpus.js';
import {
  scanLiterals,
  scanShape,
  scanPaths as scanPathsLib,
  ENTITY_ID_SHAPE,
  EMAIL_SHAPE,
} from '../lib/corpus-scan.js';
import {
  norm,
  isMultiToken,
  keepTerm,
  loadStopwordDicts as loadStopwordDictsLib,
  loadAllowlist as loadAllowlistLib,
  fromConfigOverrides,
  GENERIC_STOPWORDS,
} from '../lib/owner-corpus-sources.js';
import {
  loadPostureTable,
  loadPermitted,
  applyPermitted,
  collectFindings,
  posture,
  skipPaths,
  skipPathspecs,
} from '../lib/publication-posture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEPS = { ...defaultDeps(REPO_ROOT), git };

// WHAT THE GATE NEVER SCANS, and where that list lives. The gate necessarily
// reasons about the patterns it hunts, so it must not flag its own source, its
// own allowlist, its own permitted list, or the bulk dictionaries it matches
// against. That list used to be a literal here; it now lives in the posture
// table (config/publication-posture.json) with a stated reason per path, so the
// exclusions AC19 has to disclose are DATA the run can print rather than a
// constant only a reader of this file would ever see.
const POSTURE_TABLE = loadPostureTable(DEPS.configDir);
const SKIP_PATHS = skipPaths(POSTURE_TABLE);
const SCAN_EXCLUDE_PATHSPECS = skipPathspecs(POSTURE_TABLE);

// ── shell helpers ────────────────────────────────────────────────────────────
function git(args, opts = {}) {
  return spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

/** Every tracked working-tree file (NUL-delimited so paths with spaces are safe). */
function trackedFiles() {
  const r = git(['ls-files', '-z']);
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr || ''}`);
  return r.stdout.split('\0').filter(Boolean);
}

/** Files staged in this commit (ACMR = added/copied/modified/renamed). */
function stagedFiles() {
  const r = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  if (r.status !== 0) throw new Error(`git diff --cached failed: ${r.stderr || ''}`);
  return r.stdout.split('\0').filter(Boolean);
}

/**
 * Untracked, non-ignored files — brand-new files that exist in the working tree
 * but have not been `git add`-ed yet. --exclude-standard honors .gitignore, so
 * the gitignored owner corpus is never returned here (it must not be — that data
 * is SUPPOSED to live on disk). These are the about-to-ship files git ls-files
 * cannot see; --all folds them in so a fresh file's owner leak can't out-run the
 * publication scan.
 */
function untrackedFiles() {
  const r = git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (r.status !== 0) throw new Error(`git ls-files --others failed: ${r.stderr || ''}`);
  return r.stdout.split('\0').filter(Boolean);
}

// ── scan wrappers (stable signatures — imported by tests/first-user-clean.test.js)
function scanContents(terms, pathspecs, opts = {}) {
  return scanLiterals(git, terms, pathspecs, opts);
}

function scanEntityIds(idSet, pathspecs, opts = {}) {
  return scanShape(git, ENTITY_ID_SHAPE, idSet, pathspecs, {
    ...opts,
    describe: (token) => `real entity content-id "${token}" in a tracked file`,
  });
}

function scanEmails(emailSet, pathspecs, opts = {}) {
  return scanShape(git, EMAIL_SHAPE, emailSet, pathspecs, {
    ...opts,
    describe: (token) => `real contact address "${token}" in a tracked file`,
  });
}

function scanPaths(terms, files) {
  return scanPathsLib(terms, files, SKIP_PATHS);
}

// Legacy names kept for the existing test surface and any external caller.
function loadStopwordDicts() {
  return loadStopwordDictsLib(DEPS.configDir);
}
function loadAllowlist() {
  return loadAllowlistLib(DEPS.configDir);
}
function candidateTermsFromConfig() {
  return new Set(fromConfigOverrides(DEPS.configDir).values.terms);
}

// ── composed secrets/identity scans ──────────────────────────────────────────

/**
 * Run a composed sub-gate and surface its stdout/stderr on failure. gate-pii.sh
 * matches owner names/emails/private patterns; check-public-config-clean.js
 * matches owner domains/gids/calendar-ids. Composing them means "clean" is
 * identity AND entity AND keys/secrets.
 */
function runComposed(label, cmd, args) {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    label,
    ok: r.status === 0,
    output: `${r.stdout || ''}${r.stderr || ''}`.trim(),
  };
}

/**
 * `require` is AC13's non-vacuity switch, and it is OFF by default for a
 * reason. Both composed scans read their configuration from outside git —
 * gate-pii.sh from `.git/info/`, check-public-config-clean.js from the
 * gitignored `config/*.user.json` overrides — so inside an export tree both
 * loaded nothing and reported clean. The publication step bridges that
 * configuration in by env and sets `require`, which turns "loaded nothing" from
 * a silent pass into a refusal. A fresh clone passes neither the bridge nor the
 * flag and keeps its designed no-op.
 */
function composedScans(mode, { require: requireNonVacuous = false } = {}) {
  const results = [];
  // gate-pii.sh honors --all; otherwise it scans staged files (its default).
  const piiArgs = ['scripts/gate-pii.sh'];
  if (mode === 'all') piiArgs.push('--all');
  if (requireNonVacuous) piiArgs.push('--require-patterns');
  results.push(runComposed('gate-pii', 'bash', piiArgs));
  // check-public-config-clean.js always scans the whole tracked tree.
  const configArgs = ['scripts/check-public-config-clean.js'];
  if (requireNonVacuous) configArgs.push('--require-domains', '--require-credentials');
  results.push(runComposed('check-public-config-clean', 'node', configArgs));
  return results;
}

// ── modes ────────────────────────────────────────────────────────────────────

function scanScopePathspecs(mode) {
  // --staged limits the corpus scans to the staged files; --all/--refresh scan
  // the whole tree. Exclusions (gate sources, allowlist, dictionaries) always apply.
  if (mode === 'staged') {
    const staged = stagedFiles().filter((f) => !SKIP_PATHS.has(f));
    if (staged.length === 0) return null; // nothing staged → corpus scans are a no-op
    return [...staged, ...SCAN_EXCLUDE_PATHSPECS];
  }
  return [...SCAN_EXCLUDE_PATHSPECS];
}

/**
 * Resolve the corpus for a mode.
 *
 * --refresh BUILDS. Every other mode LOADS and never builds — see write-safety
 * invariant 3 in lib/owner-corpus.js: building from pre-commit on a machine
 * without the DB writes an empty cache, and every run after that exits 0 forever.
 */
async function resolveCorpus(mode, { adopt = false } = {}) {
  if (mode === 'refresh') return buildCorpus(DEPS, { adopt });
  return loadCorpus(DEPS);
}

async function runGate(mode, { corpusOverride, adopt = false, requireComposed = false } = {}) {
  const corpus = corpusOverride || (await resolveCorpus(mode, { adopt }));
  const scanMode = mode === 'refresh' ? 'all' : mode;
  const placement = scanMode === 'staged' ? 'staged' : 'publish';

  // A cache that is PRESENT and cannot be believed fails the run. Absent keeps
  // its harmless behaviour — see corpusCacheState() for why the two must not be
  // the same outcome. Skipped when the caller injected a corpus (the mutation
  // proofs do) and on --refresh, which is the mode that repairs this state.
  const cacheState =
    corpusOverride || mode === 'refresh' ? { state: 'ok', reason: '' } : corpusCacheState(DEPS);

  let findings = [];
  let scannedClasses = [];
  let skippedClasses = [];
  let permittedCount = 0;

  if (corpus) {
    const pathspecs = scanScopePathspecs(scanMode);
    // Publication modes (--all/--refresh) must also see about-to-ship files that
    // are not yet committed — still-untracked ones git ls-files omits — or the gate
    // vacuously passes on a dirty new file. One flag threads that into the
    // content/id git-grep pass; the path scan gets the explicit union below.
    const untracked = scanMode === 'all';
    // Path scan scope: --staged uses the staged set; --all/--refresh use the UNION
    // of tracked + newly staged + still-untracked files so an employer name baked
    // into a brand-new, not-yet-added FILENAME can't slip through. The Set dedupes.
    const pathFiles =
      scanMode === 'staged'
        ? stagedFiles()
        : [...new Set([...trackedFiles(), ...stagedFiles(), ...untrackedFiles()])];

    const collected = collectFindings(
      { git, table: POSTURE_TABLE, placement, skip: SKIP_PATHS },
      corpus,
      { pathspecs, pathFiles, untracked }
    );
    scannedClasses = collected.scannedClasses;
    skippedClasses = collected.skippedClasses;
    const applied = applyPermitted(collected.findings, loadPermitted(DEPS.configDir));
    findings = applied.findings;
    permittedCount = findings.filter((f) => f.permitted).length;
  }

  // Compose the secrets/identity scans only for the publication modes
  // (--all / --refresh). In --staged (pre-commit), gate-pii.sh and
  // check-public-config-clean.js already run as their own adjacent hook steps, so
  // re-running them here would just double the cost.
  //
  // These are corpus-INDEPENDENT: they run even when the corpus is unavailable,
  // which is what keeps a fresh clone's publication audit from being a total no-op.
  const composed = scanMode === 'all' ? composedScans(scanMode, { require: requireComposed }) : [];

  return { corpus, cacheState, placement, findings, permittedCount, scannedClasses, skippedClasses, composed };
}

// ── reporting ────────────────────────────────────────────────────────────────

function printCounts(corpus) {
  if (!corpus) {
    process.stdout.write(
      'check-first-user-clean: corpus UNAVAILABLE (no v2 cache on disk) — identity/entity\n'
        + '  cross-check skipped. Run `node scripts/check-first-user-clean.js --refresh` on the\n'
        + '  owner\'s box to build it. Nothing was written.\n'
    );
    return;
  }
  const c = corpus.counts || {};
  process.stdout.write(
    `check-first-user-clean: corpus cross-checked — ${c.terms || 0} owner terms, `
      + `${c.private_terms || 0} private-settings terms, ${c.entity_ids || 0} entity ids, `
      + `${c.emails || 0} contact addresses, ${c.domains || 0} owner domains, `
      + `${c.literal_names || 0} entity-graph names\n`
  );
  const unavailable = Object.entries(corpus.sources || {}).filter(([, s]) => !s.available);
  if (unavailable.length > 0) {
    process.stdout.write(
      `check-first-user-clean: ${unavailable.length} corpus source(s) UNAVAILABLE at build time —\n`
    );
    for (const [name, s] of unavailable) {
      process.stdout.write(`  ! ${name}: ${s.reason || 'no reason recorded'}\n`);
    }
  }
  if (corpus.write && corpus.write.written === false && corpus.write.reason) {
    process.stdout.write(`check-first-user-clean: cache NOT written — ${corpus.write.reason}\n`);
  }
}

/** One line per finding: where it is, what class it is, what matched. */
function describe(f) {
  const what = f.term
    ? `${f.class} "${f.term}"`
    : `${f.class} (term unresolved — line reads: ${JSON.stringify(f.matched_form)})`;
  return f.line > 0 ? `${f.file}:${f.line}: ${what}` : `${f.file}: ${what} in the file PATH`;
}

/**
 * Group findings by class, preserving the posture-table order so the report reads
 * the same way every run.
 */
function byClass(findings) {
  const groups = new Map();
  for (const cls of Object.keys(POSTURE_TABLE.classes)) if (!cls.startsWith('_')) groups.set(cls, []);
  for (const f of findings) {
    if (!groups.has(f.class)) groups.set(f.class, []);
    groups.get(f.class).push(f);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 0);
}

/**
 * ONE findings list, TWO placements. `failed` is exactly the design's rule —
 * a finding fails the run only when its class BLOCKS in this placement and no
 * permitted entry excuses it. Everything else is printed and the run continues.
 */
function report(result) {
  // BEFORE anything else, and it exits rather than falling through. A run that
  // cannot believe its corpus has scanned nothing, so every count printed below
  // it would be a statement about nothing — and printing "0 blocking, clean"
  // under an untrusted cache is the exact failure this whole story is about.
  const cacheState = result.cacheState || { state: 'ok' };
  if (cacheState.state === 'untrusted') {
    process.stderr.write(
      'check-first-user-clean: REFUSING — the owner corpus cache is present but cannot be trusted.\n'
        + `  ${cacheState.reason}\n`
        + '  This is NOT the same as having no corpus. With no corpus the gate has nothing of yours to\n'
        + '  find and passing is correct; here it has a file it cannot read, so passing would certify a\n'
        + '  tree it never scanned. Nothing was written and nothing was scanned.\n'
    );
    return 1;
  }

  printCounts(result.corpus);
  const deps = { table: POSTURE_TABLE, placement: result.placement, skip: SKIP_PATHS };
  const findings = result.findings || [];
  const live = findings.filter((f) => !f.permitted);
  const blocking = live.filter((f) => posture(deps, f.class, f.file) === 'block');
  const reporting = live.filter((f) => posture(deps, f.class, f.file) === 'report');
  let failed = blocking.length > 0;

  if (result.corpus) {
    process.stdout.write(
      `check-first-user-clean: posture "${result.placement}" — `
        + `${blocking.length} blocking, ${reporting.length} reported, ${result.permittedCount} permitted; `
        + `classes scanned: ${result.scannedClasses.join(', ') || 'none'}`
        + (result.skippedClasses.length > 0 ? `; skipped: ${result.skippedClasses.join(', ')}` : '')
        + `; ${SKIP_PATHS.size} self-excluded paths\n`
    );
  }

  if (blocking.length > 0) {
    process.stderr.write(
      `check-first-user-clean: ${blocking.length} owner identity/entity leak(s) that BLOCK this run:\n`
    );
    for (const [cls, list] of byClass(blocking)) {
      process.stderr.write(`  [${cls}] ${list.length}\n`);
      for (const f of list) process.stderr.write(`    ${describe(f)}\n`);
    }
  }

  // REPORTED (non-blocking, AC16): the commit still succeeds and the owner sees
  // this. It is not a softer verdict — the same finding blocks at publication.
  if (reporting.length > 0) {
    process.stdout.write(
      `check-first-user-clean: ${reporting.length} finding(s) REPORTED, not blocking `
        + '(these block at publication — clear them before the public flip):\n'
    );
    for (const [cls, list] of byClass(reporting)) {
      process.stdout.write(`  [${cls}] ${list.length}\n`);
      for (const f of list) process.stdout.write(`    ~ ${describe(f)}\n`);
    }
  }

  for (const c of result.composed) {
    if (!c.ok) {
      failed = true;
      process.stderr.write(`check-first-user-clean: composed scan "${c.label}" failed:\n`);
      if (c.output) process.stderr.write(c.output.replace(/^/gm, '  ') + '\n');
    }
  }

  if (failed) {
    process.stderr.write(
      '\nMove owner identity/entity/employer data into the gitignored config/*.user.json\n'
        + 'overrides (or fix synthetic fixtures) and re-run. If a finding is genuinely not a\n'
        + 'leak, add it to config/publication-permitted.json with a stated reason. This gate is\n'
        + 'the publication certification — the tree cannot be published until it exits 0 on the\n'
        + "owner's box.\n"
    );
  } else {
    process.stdout.write('check-first-user-clean: clean (identity + entity + keys/secrets)\n');
  }
  return failed ? 1 : 0;
}

/**
 * Positive control (AC7/AC8 groundwork). A blind gate is worthless; prove
 * detection. Seed a corpus term into a throwaway fixture under a scanned path,
 * run the CONTENT + PATH scans against a scope that includes it, and assert both
 * that the scan fails AND that the fixture file:line is reported. Clean up the
 * fixture no matter what.
 */
async function selfTest() {
  const state = corpusCacheState(DEPS);
  const corpus = state.corpus;
  if (!corpus || !corpus.terms || corpus.terms.length === 0) {
    process.stderr.write(
      state.state === 'untrusted'
        ? `check-first-user-clean --self-test: the corpus cache is present but UNTRUSTED — ${state.reason}\n`
        : 'check-first-user-clean --self-test: corpus is UNAVAILABLE or EMPTY — cannot prove detection.\n'
          + 'Run `node scripts/check-first-user-clean.js --refresh` on the owner\'s box (corpus present).\n'
    );
    return 1;
  }
  // Pick a genuinely distinctive seed — a multi-token term whose parts are all
  // real words (>= 4 chars) — so the positive control tests a strong term, not a
  // slug fragment. Fall back progressively.
  const seedTerm =
    corpus.terms.find((t) => t.includes(' ') && t.split(/\s+/).every((p) => p.length >= 4))
    || corpus.terms.find((t) => isMultiToken(t))
    || corpus.terms[0];
  const fixtureDirAbs = join(REPO_ROOT, 'scripts', '.first-user-clean-selftest');
  const fixtureRel = 'scripts/.first-user-clean-selftest/planted-fixture.txt';
  const fixtureAbs = join(REPO_ROOT, fixtureRel);
  let passed = false;
  try {
    mkdirSync(fixtureDirAbs, { recursive: true });
    writeFileSync(fixtureAbs, `planted positive-control line: ${seedTerm}\n`);
    // Scan the fixture directly (it is untracked, so a normal tracked-file scan
    // would miss it — pass it explicitly as the scope). This proves the CONTENT
    // matcher fails on a planted corpus term.
    const hits = scanContents(corpus.terms, [fixtureRel], { noIndex: true });
    const caught = hits.some((h) => h.includes(fixtureRel));
    // And prove the PATH matcher fails on a planted corpus term in a filename.
    const pathTerm = seedTerm.replace(/ /g, '-');
    const plantedPathRel = `scripts/.first-user-clean-selftest/${pathTerm}.txt`;
    writeFileSync(join(REPO_ROOT, plantedPathRel), 'x\n');
    const pathHits = scanPaths(corpus.terms, [plantedPathRel]);
    const pathCaught = pathHits.some((h) => h.startsWith(`${plantedPathRel}:`));

    if (caught && pathCaught) {
      passed = true;
      process.stdout.write(
        `check-first-user-clean --self-test: PASS — seeded term "${seedTerm}" caught in\n`
          + `  contents (${fixtureRel}) and path (${plantedPathRel}). Detection proven.\n`
      );
    } else {
      process.stderr.write(
        `check-first-user-clean --self-test: FAIL — seeded term "${seedTerm}" NOT caught`
          + ` (content:${caught} path:${pathCaught}). A blind gate proves nothing.\n`
      );
    }
  } finally {
    rmSync(fixtureDirAbs, { recursive: true, force: true });
  }
  return passed ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const adopt = args.includes('--adopt');
  const requireComposed = args.includes('--require-composed');
  const MODIFIERS = new Set(['--adopt', '--require-composed']);
  const mode = args.find((a) => !MODIFIERS.has(a)) || '--staged';
  if (mode === '--self-test') {
    process.exit(await selfTest());
  }
  if (mode === '--refresh') {
    const result = await runGate('refresh', { adopt, requireComposed });
    process.exit(report(result));
  }
  if (mode === '--all') {
    const result = await runGate('all', { requireComposed });
    process.exit(report(result));
  }
  if (mode === '--staged') {
    const result = await runGate('staged');
    process.exit(report(result));
  }
  process.stderr.write(
    `check-first-user-clean: unknown mode "${mode}" `
      + '(use --staged | --all [--require-composed] | --refresh [--adopt] | --self-test)\n'
  );
  process.exit(2);
}

// Testable surface — imported by tests/first-user-clean.test.js. The pure helpers
// below take injected filter sets so the test stays hermetic (no DB, no real
// cache, no minutes-long corpus build). This list is deliberately the SAME
// surface the gate has always exported: the corpus and scan APIs added by
// st_dd0e19d8 are imported from lib/ directly, so the facade does not accumulate
// re-exports that nothing consumes.
export {
  norm,
  isMultiToken,
  keepTerm,
  candidateTermsFromConfig,
  loadStopwordDicts,
  loadAllowlist,
  scanContents,
  scanPaths,
  scanEntityIds,
  scanEmails,
  composedScans,
  buildCorpus,
  selfTest,
  runGate,
  GENERIC_STOPWORDS,
  POSTURE_TABLE,
  SKIP_PATHS,
  REPO_ROOT,
};

// Run the CLI only when invoked directly (`node scripts/check-first-user-clean.js`),
// never on import — so the test module can import the helpers without triggering
// the full scan.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`check-first-user-clean: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}
