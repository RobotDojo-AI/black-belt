#!/usr/bin/env node
/**
 * publication-refusals.js — every refusal in the publication step, demonstrated
 * against a deliberately broken input (st_dd0e19d8 Phase 5: AC4, AC6, AC7).
 *
 * WHY EVERY REFUSAL NEEDS A MATCHED PASS. A probe that only shows failures
 * cannot distinguish a step that refuses for the right reason from a step that
 * refuses always. So every group here runs a POSITIVE CONTROL first — the same
 * inputs, unbroken, reaching a later step — and then breaks exactly one thing
 * and asserts the refusal names that step. A refusal at the wrong step is
 * reported as a failure even though the run refused, because "it refused" is not
 * the property; "it refused for this reason, and would not have otherwise" is.
 *
 * WHAT IS REAL AND WHAT IS INJECTED, stated rather than blurred. The source
 * resolution, the corpus gates, the manifest resolution and the tree
 * construction run against the real repository, the real corpus cache and real
 * git. The DESTINATION checks are driven through an injected `gh` because the
 * real ones ask GitHub about a repository that must not exist yet — and creating
 * a fork or a repository with history purely to fail a probe would be
 * absurd. The injected responses are the exact JSON shapes `gh repo view --json
 * isFork,defaultBranchRef,url,parent` returns; the code under test is the real
 * assertion, unchanged.
 *
 * NOTHING IS EVER PUSHED. `publish()` is never called with `push: true` here,
 * and the deps handed to it carry a `gitIn` that refuses any `push` argv — so a
 * future edit that reached the push step during a probe would fail loudly rather
 * than publish something.
 *
 *   --all               source and destination refusals (AC4)
 *   --unnamed-source    the working-tree-state refusal, on its own (AC4)
 *   --corpus-floors     empty / undersized / stale corpus (AC6)
 *   --empty-fileset     a manifest that resolves to nothing (AC6)
 *   --selftest-fails    detection cannot be proven (AC7)
 *
 * Exit 0 = every refusal fires, and every positive control passes.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  publish,
  resolveSource,
  assertDestination,
  normaliseRepoUrl,
  resolvePublishedSet,
} from '../../lib/publication-step.js';
import { defaultDeps } from '../../lib/owner-corpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CONFIG_DIR = join(REPO_ROOT, 'config');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

/** A `gitIn` that runs everything except a push. The one thing a probe may not do. */
function gitIn(dir, args) {
  if (args.includes('push')) {
    throw new Error('publication-refusals: a probe reached the push step — refusing. Nothing is ever published from here.');
  }
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function archive(sha, paths, exportDir) {
  const quoted = paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
  return spawnSync('bash', ['-c', `set -o pipefail; git archive ${sha} -- ${quoted} | tar -x -C '${exportDir}'`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function filesAtCommit(commit) {
  const r = git(['ls-tree', '-r', '-z', '--name-only', commit]);
  if (r.status !== 0) return null;
  const paths = r.stdout.split('\0').filter(Boolean);
  return paths.length > 0 ? paths : null;
}

function baseDeps(overrides = {}) {
  return {
    ...defaultDeps(REPO_ROOT),
    git,
    gitIn,
    archive,
    filesAtCommit,
    originUrl: () => git(['remote', 'get-url', 'origin']).stdout.trim(),
    gh: () => ({ status: 1, stdout: '', stderr: 'gh not called in this probe' }),
    selfTest: () => ({ status: 0, output: 'injected: detection proven' }),
    auditor: () => ({ status: 0, output: 'injected: export audited' }),
    decay: () => ({ status: 0, output: 'injected: decay ran' }),
    ...overrides,
  };
}

/** A `gh` that answers `repo view --json …` with a fixed view. */
function ghReturning(view) {
  return () => ({ status: 0, stdout: JSON.stringify(view), stderr: '' });
}

/** Copy the real config directory, then break exactly one file in the copy. */
function scratchConfig(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'robotdojo-refusal-config.'));
  for (const f of ['publication-manifest.json', 'publication-posture.json', 'publication-permitted.json', 'defaults.json']) {
    try {
      copyFileSync(join(CONFIG_DIR, f), join(dir, f));
    } catch {
      /* optional file */
    }
  }
  mutate(dir);
  return dir;
}

/** Copy the real corpus cache, then break exactly one thing in the copy. */
function scratchCorpus(mutate) {
  const deps = defaultDeps(REPO_ROOT);
  const cache = JSON.parse(readFileSync(deps.cachePath, 'utf8'));
  mutate(cache);
  const dir = mkdtempSync(join(tmpdir(), 'robotdojo-refusal-cache.'));
  const path = join(dir, 'owner-corpus.cache.json');
  writeFileSync(path, JSON.stringify(cache));
  return { path, dir };
}

const scratchDirs = [];
function track(dir) {
  scratchDirs.push(dir);
  return dir;
}

const HEAD = () => git(['rev-parse', 'HEAD']).stdout.trim();

/** Did the run refuse at exactly this step? */
function refusedAt(result, step) {
  return !result.ok && result.step === step;
}

// ── AC4: the source ──────────────────────────────────────────────────────────

async function sourceRefusals() {
  process.stdout.write('\nAC4 — the source must be a named commit\n');
  const deps = baseDeps();

  check(
    'a real branch commit resolves',
    resolveSource(deps, HEAD()).ok,
    'positive control'
  );
  check(
    'no source at all is refused — there is no default',
    !resolveSource(deps, null).ok,
    'the previous step defaulted to a working-tree snapshot'
  );
  check(
    'a ref that names nothing is refused',
    !resolveSource(deps, 'refs/heads/this-branch-does-not-exist').ok
  );

  // The actual defect: `git stash create` writes a commit object holding
  // uncommitted tracked modifications, reachable from no branch.
  const stash = git(['stash', 'create']).stdout.trim();
  if (stash) {
    const r = resolveSource(deps, stash);
    check(
      'a working-tree snapshot (git stash create) is refused',
      !r.ok && /no branch contains/.test(r.errors.join(' ')),
      `${stash.slice(0, 12)} — the exact input the previous step used`
    );
  } else {
    // A clean tree produces no stash object; make an equivalent dangling commit.
    const tree = git(['rev-parse', 'HEAD^{tree}']).stdout.trim();
    const dangling = git(['commit-tree', tree, '-m', 'dangling']).stdout.trim();
    const r = resolveSource(deps, dangling);
    check(
      'a commit no branch contains is refused',
      !r.ok && /no branch contains/.test(r.errors.join(' ')),
      `${dangling.slice(0, 12)} — equivalent to a stash object`
    );
  }
}

// ── AC4: the destination ─────────────────────────────────────────────────────

function destinationRefusals() {
  process.stdout.write('\nAC4 — the destination must be fresh, unforked, and not this repository\n');
  const origin = git(['remote', 'get-url', 'origin']).stdout.trim();

  const empty = { isFork: false, defaultBranchRef: null, url: 'https://github.com/example-owner/public-copy', parent: null };
  check(
    'an empty, unforked, unrelated repository is accepted',
    assertDestination(baseDeps({ gh: ghReturning(empty) }), 'example-owner/public-copy').ok,
    'positive control'
  );

  const fork = { ...empty, isFork: true, parent: { nameWithOwner: 'someone/upstream' } };
  const forkResult = assertDestination(baseDeps({ gh: ghReturning(fork) }), 'example-owner/public-copy');
  check(
    'a fork is refused',
    !forkResult.ok && /fork/i.test(forkResult.errors.join(' ')),
    'a fork shares its object store with its parent'
  );

  const withHistory = { ...empty, defaultBranchRef: { name: 'main' } };
  const historyResult = assertDestination(baseDeps({ gh: ghReturning(withHistory) }), 'example-owner/public-copy');
  check(
    'a destination with prior history is refused',
    !historyResult.ok && /history/i.test(historyResult.errors.join(' ')),
    'the published copy must be the first and only commit'
  );

  const self = { ...empty, url: origin };
  const selfResult = assertDestination(baseDeps({ gh: ghReturning(self) }), 'RobotDojo-AI/dev');
  check(
    "this working repository's own origin is refused",
    !selfResult.ok && /own origin/i.test(selfResult.errors.join(' ')),
    origin ? 'compared against the live origin url' : 'no origin configured'
  );

  check(
    'clone-url comparison ignores scheme, credentials and the .git suffix',
    normaliseRepoUrl('git@github.com:Owner/Repo.git') === normaliseRepoUrl('https://x-token@github.com/owner/repo/'),
    'a destination cannot dodge the check by changing protocol'
  );

  const unreadable = baseDeps({ gh: () => ({ status: 1, stdout: '', stderr: 'could not resolve to a Repository' }) });
  check(
    'a destination gh cannot read is refused, not assumed safe',
    !assertDestination(unreadable, 'example-owner/nope').ok
  );
  check(
    'a destination that is not <owner>/<repo> is refused before any network call',
    !assertDestination(baseDeps(), 'not a repo name').ok
  );
}

// ── AC6: the corpus ──────────────────────────────────────────────────────────

async function corpusRefusals() {
  process.stdout.write('\nAC6 — publication refuses when the check cannot see the owner data\n');

  const cachePath = defaultDeps(REPO_ROOT).cachePath;
  const cacheBefore = readFileSync(cachePath);
  const ok = await publish(baseDeps(), { from: HEAD() });
  check(
    'the real corpus passes every gate and the run reaches the audit',
    ok.ok,
    'positive control — nothing pushed'
  );
  // AC21, honoured by the pipeline rather than merely present in the library:
  // the publication step LOADS the corpus and never builds it, so a publication
  // run — including one started from inside an export directory — cannot
  // overwrite the owner's cache with a degraded one.
  check(
    "a full certified run leaves the owner's corpus cache byte-identical",
    readFileSync(cachePath).equals(cacheBefore),
    `${cacheBefore.length} bytes, unchanged`
  );

  const absent = track(mkdtempSync(join(tmpdir(), 'robotdojo-refusal-nocache.')));
  const absentRun = await publish(baseDeps({ cachePath: join(absent, 'missing.json') }), { from: HEAD() });
  check(
    'an absent corpus is refused',
    refusedAt(absentRun, 'corpus-schema'),
    absentRun.step
  );

  const v1 = scratchCorpus((c) => {
    c.schema_version = 1;
  });
  track(v1.dir);
  const v1Run = await publish(baseDeps({ cachePath: v1.path }), { from: HEAD() });
  check(
    'a cache of the wrong schema is treated as ABSENT, not as empty',
    refusedAt(v1Run, 'corpus-schema'),
    '"nothing to find" and "refresh me" are different statements'
  );

  const truncated = scratchCorpus((c) => {
    c.emails = c.emails.slice(0, 1);
  });
  track(truncated.dir);
  const truncatedRun = await publish(baseDeps({ cachePath: truncated.path }), { from: HEAD() });
  check(
    'a corpus below its recorded floor is refused',
    refusedAt(truncatedRun, 'corpus-floors'),
    truncatedRun.errors[0] || ''
  );

  const emptyClass = scratchCorpus((c) => {
    c.domains = [];
  });
  track(emptyClass.dir);
  const emptyRun = await publish(baseDeps({ cachePath: emptyClass.path }), { from: HEAD() });
  check(
    'an emptied class is refused rather than reported as nothing to find',
    refusedAt(emptyRun, 'corpus-floors')
  );

  const stale = scratchCorpus((c) => {
    c.built_from = { ...c.built_from, db_watermark: '1970-01-01 00:00:00' };
  });
  track(stale.dir);
  const staleRun = await publish(baseDeps({ cachePath: stale.path }), { from: HEAD() });
  check(
    'a corpus older than the newest record it derives from is refused',
    refusedAt(staleRun, 'corpus-freshness'),
    staleRun.errors[0] || ''
  );
}

// ── AC6: the file set ────────────────────────────────────────────────────────

async function fileSetRefusals() {
  process.stdout.write('\nAC6 — publication refuses when the scanned file set is empty\n');

  const positive = resolvePublishedSet(baseDeps(), HEAD());
  check('the real manifest resolves to a non-empty published set', positive.ok && positive.paths.length > 0,
    positive.ok ? `${positive.paths.length} file(s)` : positive.errors[0]);

  const emptyInclude = track(scratchConfig((dir) => {
    const m = JSON.parse(readFileSync(join(dir, 'publication-manifest.json'), 'utf8'));
    m.include = [{ glob: 'no/such/path/**', reason: 'deliberately matches nothing' }];
    writeFileSync(join(dir, 'publication-manifest.json'), JSON.stringify(m, null, 2));
  }));
  const emptyRun = await publish(baseDeps({ configDir: emptyInclude }), { from: HEAD() });
  check(
    'a manifest that resolves to zero files is refused',
    !emptyRun.ok && /empty published set|resolved to zero/i.test(emptyRun.errors.join(' ')),
    emptyRun.errors[0] || ''
  );

  const driftedLock = track(scratchConfig((dir) => {
    const m = JSON.parse(readFileSync(join(dir, 'publication-manifest.json'), 'utf8'));
    m.lock = { ...m.lock, files: (m.lock.files || 0) + 1 };
    writeFileSync(join(dir, 'publication-manifest.json'), JSON.stringify(m, null, 2));
  }));
  const driftRun = await publish(baseDeps({ configDir: driftedLock }), { from: HEAD() });
  check(
    'a published set that no longer matches the lock is refused',
    refusedAt(driftRun, 'materialise-file-set'),
    'a file entering or leaving what ships is a decision, not a side effect'
  );

  const noLock = track(scratchConfig((dir) => {
    const m = JSON.parse(readFileSync(join(dir, 'publication-manifest.json'), 'utf8'));
    delete m.lock;
    writeFileSync(join(dir, 'publication-manifest.json'), JSON.stringify(m, null, 2));
  }));
  const noLockRun = await publish(baseDeps({ configDir: noLock }), { from: HEAD() });
  check(
    'a manifest with no lock at all is refused',
    refusedAt(noLockRun, 'materialise-file-set'),
    'without a lock a newly tracked file joins the published set silently'
  );
}

// ── AC7: the detection self-proof ────────────────────────────────────────────

async function selfTestRefusal() {
  process.stdout.write('\nAC7 — publication refuses when detection cannot be proven\n');

  // The real self-test, run for real. This is the positive control AND the
  // evidence that the wiring reaches live code rather than the injection below.
  const real = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-first-user-clean.js'), '--self-test'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  check(
    'the real detection self-proof passes against the real corpus',
    real.status === 0,
    'positive control — a planted term is caught in both contents and path'
  );

  const failing = baseDeps({ selfTest: () => ({ status: 1, output: 'seeded term NOT caught' }) });
  const run = await publish(failing, { from: HEAD() });
  check(
    'a failed self-proof refuses publication',
    refusedAt(run, 'detection-self-proof'),
    run.errors[0] || ''
  );

  // And it refuses BEFORE the tree is built — proving a broken detector never
  // gets the chance to bless an artifact.
  const reached = run.results.map((r) => r.step);
  check(
    'the refusal happens before any tree is built',
    !reached.includes('build-single-commit-tree'),
    `reached: ${reached.join(' → ')}`
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f) || args.includes('--everything');
  const any = args.length > 0;
  if (!any) {
    process.stderr.write(
      'publication-refusals: usage — --all | --unnamed-source | --corpus-floors | --empty-fileset | --selftest-fails | --everything\n'
    );
    return 2;
  }

  process.stdout.write('publication-refusals: every refusal, against a deliberately broken input\n');
  try {
    if (has('--all') || has('--unnamed-source')) await sourceRefusals();
    if (has('--all')) destinationRefusals();
    if (has('--corpus-floors')) await corpusRefusals();
    if (has('--empty-fileset')) await fileSetRefusals();
    if (has('--selftest-fails')) await selfTestRefusal();
  } finally {
    for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\npublication-refusals: ${results.length - failed.length}/${results.length} PASS\n`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
    process.stderr.write(`publication-refusals: ${err.stack || err.message}\n`);
    process.exit(2);
  });
