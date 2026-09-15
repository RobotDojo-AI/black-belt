#!/usr/bin/env node
/**
 * corpus-provenance-guard.js — AC21 (st_dd0e19d8 Phase 1).
 *
 * THE BUG THIS GUARDS. The corpus cache lives at a fixed absolute path in the
 * owner's home directory — deliberately, because the publication audit runs
 * inside an exported copy and must still read his real data. The consequence is
 * that EVERY checkout on this machine writes the same file. Running a refresh
 * from an export directory, a worktree, or a scratch clone would overwrite his
 * real corpus with whatever that tree could see — and a degraded corpus does not
 * announce itself: it makes the gate report clean.
 *
 * So the write is guarded twice, and this proves both:
 *
 *   PROVENANCE — a build whose repository root differs from the root recorded in
 *   the existing cache refuses to overwrite it. `--adopt` is the escape hatch for
 *   a genuine repository move, and it is proven to work rather than assumed.
 *
 *   SHAPE — a tree with one commit and no origin remote is an exported
 *   publication copy. That refusal fires before provenance is even consulted,
 *   because an export has no prior cache to compare against.
 *
 * AND THE HALF A WRITE GUARD CANNOT COVER. Both refusals above live in the
 * writer, so they bind only code that carries them. A checkout still running a
 * copy of this gate from before the guard existed writes the shared cache in the
 * old format and nothing stops it — measured on this machine 2026-07-26. The
 * closing half is therefore in the READER: a cache that is present and cannot be
 * believed is refused rather than treated as absent, which is asserted here
 * behaviourally by running the real commit-time gate against one.
 *
 * WHY THE END-TO-END RUN IS NOT THE PROOF. A full `--refresh` iterates 646k rows
 * and takes minutes; running one from a foreign root to watch it refuse would
 * also mean running the build that the guard exists to stop. The guard is the
 * write function, so the write function is what is exercised — with a scratch
 * cache path, so the owner's real cache is never a participant. It is then
 * byte-compared before and after to prove that.
 *
 * Exit 0 = the guard refuses what it must and permits what it must.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeCache, loadCorpus, corpusCacheState, defaultDeps, CACHE_SCHEMA_VERSION } from '../../lib/owner-corpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

function digest(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** A minimal but structurally valid cache, recorded as built from `root`. */
function cacheBuiltFrom(root) {
  return {
    schema_version: CACHE_SCHEMA_VERSION,
    built_at: new Date().toISOString(),
    built_from: { repo_root: root, db_path: '/dev/null', db_watermark: null },
    counts: {},
    sources: {},
    floors: {},
    terms: ['a-synthetic-term'],
    private_terms: [],
    literal_names: [],
    domains: [],
    emails: [],
    entity_ids: [],
  };
}

/** A git stub reporting the structural signature of an exported copy. */
function exportShapedGit() {
  return (args) => {
    const cmd = args.join(' ');
    if (cmd.startsWith('rev-list')) return { status: 0, stdout: '1\n', stderr: '' };
    if (cmd.startsWith('remote')) return { status: 0, stdout: '', stderr: '' };
    if (cmd.startsWith('config --get remote.origin.url')) return { status: 1, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

/** The real repository's git, for the control. */
function realGit(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Run the real commit-time gate against a given cache path. Behavioural, not a
 * reading of the source: the property under test is what the owner's `git
 * commit` actually does, and the previous version of this bug was invisible
 * precisely because the code looked right.
 */
function runStagedGate(cachePath) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-first-user-clean.js'), '--staged'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ROBOTDOJO_OWNER_CORPUS_CACHE: cachePath },
  });
}

function main() {
  process.stdout.write('corpus-provenance-guard: AC21 — a refresh from a foreign root cannot poison the cache\n\n');

  const deps = defaultDeps(REPO_ROOT);
  const realCache = deps.cachePath;
  const before = digest(realCache);
  const beforeSize = existsSync(realCache) ? statSync(realCache).size : 0;
  check(
    "the owner's real cache is present, so a poisoning would have something to destroy",
    !!before,
    `${beforeSize} bytes`
  );

  const dir = mkdtempSync(join(tmpdir(), 'robotdojo-provenance.'));
  const scratchCache = join(dir, 'owner-corpus.cache.json');
  try {
    // ── provenance ───────────────────────────────────────────────────────────
    process.stdout.write('\nA build from a different repository root\n');
    writeFileSync(scratchCache, JSON.stringify(cacheBuiltFrom(REPO_ROOT)));
    const seeded = digest(scratchCache);

    const foreign = writeCache(cacheBuiltFrom('/tmp/some-other-checkout'), {
      cachePath: scratchCache,
      repoRoot: '/tmp/some-other-checkout',
      git: realGit,
    });
    check(
      'is REFUSED',
      foreign.written === false && /refused/.test(foreign.reason || ''),
      foreign.reason ? foreign.reason.slice(0, 96) : 'no reason given'
    );
    check(
      '  and the existing cache is byte-identical afterwards',
      digest(scratchCache) === seeded,
      'a refusal that still wrote would be worse than no guard'
    );
    check(
      '  and the refusal names both roots, so it can be acted on',
      /built from .*other-checkout|this build ran from/.test(foreign.reason || ''),
      'an unactionable refusal gets bypassed'
    );

    // ── adopt ────────────────────────────────────────────────────────────────
    process.stdout.write('\nThe escape hatch for a genuine repository move\n');
    const adopted = writeCache(cacheBuiltFrom('/tmp/some-other-checkout'), {
      cachePath: scratchCache,
      repoRoot: '/tmp/some-other-checkout',
      git: realGit,
      adopt: true,
    });
    check(
      '--adopt re-establishes provenance and writes',
      adopted.written === true,
      adopted.reason || 'written'
    );
    check(
      '  and the cache now records the new root',
      (JSON.parse(readFileSync(scratchCache, 'utf8')).built_from || {}).repo_root === '/tmp/some-other-checkout',
      'an adopt that did not record the move would refuse again next run'
    );

    // ── the export shape ─────────────────────────────────────────────────────
    process.stdout.write('\nA tree with the structural signature of an exported copy\n');
    rmSync(scratchCache, { force: true });
    const exported = writeCache(cacheBuiltFrom('/tmp/export-tree'), {
      cachePath: scratchCache,
      repoRoot: '/tmp/export-tree',
      git: exportShapedGit(),
    });
    check(
      'is REFUSED even with no prior cache to compare against',
      exported.written === false && /single commit|export/.test(exported.reason || ''),
      exported.reason ? exported.reason.slice(0, 96) : 'no reason given'
    );
    check(
      '  and nothing was written',
      !existsSync(scratchCache),
      'the export is exactly the tree whose corpus would be degraded'
    );

    // ── the hole the write guard cannot close ────────────────────────────────
    //
    // The guard above binds the WRITER. Code that predates the guard was never
    // bound by it: the old checkout at ~/robotdojo-worktrees/df_3df1f108 still
    // carries a pre-v2 copy of this gate, and running it rewrites the shared
    // cache in the old format. Measured 2026-07-26 — that is exactly what
    // happened, and the current gate then read "no v2 cache", printed the same
    // line it prints for a stranger's clone, and exited 0. Commits were scanned
    // against nothing.
    //
    // So the READER refuses. These three assertions are the closing half of the
    // provenance story and the reason a second checkout can no longer make this
    // machine's gate silently blind.
    process.stdout.write('\nA cache an older checkout left behind, which the write guard cannot prevent\n');
    const oldFormat = join(dir, 'v1-format.cache.json');
    writeFileSync(oldFormat, JSON.stringify({ terms: ['x'], domains: [], emails: [] }));
    const stale = corpusCacheState({ cachePath: oldFormat });
    check(
      'is read as UNTRUSTED, not as absent',
      stale.state === 'untrusted',
      `state "${stale.state}" — "no file" and "a file I cannot believe" are opposite situations`
    );
    check(
      '  and the gate REFUSES on the blocking path rather than reporting clean',
      runStagedGate(oldFormat).status !== 0,
      'exiting 0 here certifies a tree nothing scanned'
    );
    check(
      '  and it says which of the two it is, so the owner knows where to look',
      /schema version/.test(stale.reason) && /another checkout/.test(stale.reason),
      stale.reason.slice(0, 96)
    );

    // The negative control for that refusal, and it is the property AC6 protects:
    // a stranger with NO cache must still commit. Refusing on absent would break
    // every clone but this one, so the distinction is asserted in both directions.
    const nowhere = join(dir, 'does-not-exist', 'cache.json');
    check(
      'a genuinely absent cache is still read as absent, and still commits',
      corpusCacheState({ cachePath: nowhere }).state === 'absent' && runStagedGate(nowhere).status === 0,
      'a stranger\'s clone has nothing of the owner\'s to find; passing is the correct answer'
    );

    // ── the control ──────────────────────────────────────────────────────────
    process.stdout.write('\nThe control — the guard must still permit the legitimate write\n');
    const same = writeCache(cacheBuiltFrom(REPO_ROOT), {
      cachePath: scratchCache,
      repoRoot: REPO_ROOT,
      git: realGit,
    });
    check(
      'a build from the recorded root writes normally',
      same.written === true,
      'a guard that refuses everything is a broken refresh, not a safe one'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  process.stdout.write('\nAnd the owner\'s real cache was never a participant\n');
  check(
    'it is byte-identical to how this run found it',
    digest(realCache) === before,
    'proven by hash, not by intention'
  );
  check(
    'and it still loads as a usable corpus',
    !!loadCorpus(deps),
    'the guard must not leave the thing it protects unreadable'
  );

  const failures = results.filter((r) => !r.ok);
  process.stdout.write(`\ncorpus-provenance-guard: ${results.length - failures.length}/${results.length} PASS\n`);
  return failures.length === 0 ? 0 : 1;
}

process.exit(main());
