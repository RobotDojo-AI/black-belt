/**
 * lib/publication-step.js — the checked publication step (st_dd0e19d8 Phase 5:
 * AC3, AC4, AC6, AC7, and the placement of AC13/AC14).
 *
 * WHAT THIS IS: a sequence of refusals ending in one irreversible action. Every
 * assertion that can fail cheaply runs before anything is built, and everything
 * that can fail at all runs before the push — because a push is the one step
 * with no undo. An object pushed into a fork network stays retrievable by hash
 * forever (research External §4); there is no equivalent of rotating a key for a
 * person's name.
 *
 * THE SEQUENCE, and why the order is the design rather than a convenience:
 *
 *    1  source is a NAMED COMMIT                      AC4
 *    2  destination is safe                           AC4
 *    3  corpus cache is schema v2                     AC6
 *    4  every class meets its recorded floor          AC6
 *    5  cache is not older than the database          AC6
 *    6  detection self-proof passes                   AC7
 *    7  materialise the file set from the manifest    AC3
 *    8  file set is non-empty and matches the list    AC3/AC6
 *    9  archive → fresh dir → git init → ONE commit   AC3
 *   10  bridge the composed-scan configuration in     AC13
 *   11  run the gate in publish posture               AC15
 *   12  composed scans, each asserting non-vacuity    AC13/AC14
 *   13  decay permitted entries that match nothing    AC15
 *   14  block on any remaining finding                AC15
 *   15  push                                          AC4
 *
 * Steps 1–6 cost seconds; steps 7–9 cost a tree. Proving the detector works
 * (6) BEFORE building the tree it would certify (7) is the whole argument for
 * that ordering: a broken detector should never get the chance to bless an
 * artifact.
 *
 * ── WHY A NAMED COMMIT, AND NOT `git stash create` ──────────────────────────
 *
 * The step this replaces snapshotted the working tree with `git stash create`
 * and published that. Verified by research against md5: uncommitted tracked
 * modifications shipped. A stash object is also unreachable from any ref, so
 * nobody could later say what was published. `--from <ref>` has NO DEFAULT —
 * the absence of a default IS the guarantee. A hand-run with no argument
 * refuses instead of quietly exporting whatever happens to be on disk.
 *
 * The commit must also be reachable from a branch. That single assertion is
 * what rejects a stash object, a detached experiment, and any other
 * "here, publish this blob" input: if no branch contains it, the repository
 * cannot answer what it was.
 *
 * ── WHY THE STEP PUSHES ─────────────────────────────────────────────────────
 *
 * AC4: publishing happens through the checked step or it does not happen. A step
 * that builds a verified tree and then tells a human to push it has moved the
 * dangerous action outside the checks. It shells out to `gh`, which reads the
 * already-authenticated token — no new credential, nothing in the process table,
 * nothing in a config file this repository owns.
 *
 * NO OWNER DATA LIVES IN THIS FILE. Paths, refs and repository names only.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 */

import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { loadManifest, resolveManifest, assertManifestLock } from './publication-manifest.js';
import { corpusCacheState, assertCorpusFloors, assertCorpusFresh, liveWatermark, openOwnerDb } from './owner-corpus.js';

/** Human-readable sequence, exported so the CLI and the proofs name the same steps. */
export const SEQUENCE = Object.freeze([
  'source-is-named-commit',
  'destination-is-safe',
  'corpus-schema',
  'corpus-floors',
  'corpus-freshness',
  'detection-self-proof',
  'materialise-file-set',
  'file-set-non-empty',
  'build-single-commit-tree',
  'bridge-composed-config',
  'audit-export',
  'decay-permitted',
  'push',
]);

/** A refusal: which step, and why, in words the owner can act on. */
function refuse(step, ...errors) {
  return { ok: false, step, errors: errors.flat().filter(Boolean) };
}
function pass(step, info = {}) {
  return { ok: true, step, errors: [], ...info };
}

// ── 1. the source ────────────────────────────────────────────────────────────

/**
 * Resolve `--from <ref>` to a commit that a branch can vouch for.
 *
 * Two assertions, and the second is the one that matters. Resolving proves the
 * ref names an object; being contained in a branch proves the repository can say
 * what that object is. `git stash create` passes the first and fails the second,
 * which is precisely the defect this closes.
 */
export function resolveSource(deps, ref) {
  const step = 'source-is-named-commit';
  if (!ref || !String(ref).trim()) {
    return refuse(
      step,
      'no --from <ref> given. This step has no default source on purpose: the version it replaced '
        + 'defaulted to a working-tree snapshot and silently published uncommitted changes.'
    );
  }
  const r = deps.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = r.status === 0 ? String(r.stdout || '').trim() : '';
  if (!sha) return refuse(step, `"${ref}" does not resolve to a commit in this repository.`);

  const contains = deps.git(['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads']);
  const branches = String(contains.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (branches.length === 0) {
    return refuse(
      step,
      `"${ref}" (${sha.slice(0, 12)}) resolves to a commit that no branch contains. A dangling commit — a `
        + 'stash object, a detached experiment — cannot be named later, so it cannot be published. Commit '
        + 'to a branch and pass that.'
    );
  }
  return pass(step, { sha, ref, branches });
}

// ── 2. the destination ───────────────────────────────────────────────────────

/** Compare clone URLs ignoring scheme, credentials, a trailing `.git`, and case. */
export function normaliseRepoUrl(url) {
  return String(url || '')
    .trim()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^[a-z+]+:\/\/([^@/]+@)?/i, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Three refusals before any push, all answerable through `gh` with the token
 * already on this machine.
 *
 * `deps.gh(args)` returns a spawn result; `deps.originUrl()` returns this
 * working repository's origin. Both injected so a probe can demonstrate each
 * refusal against a deliberately broken destination without touching GitHub.
 *
 * A FORK IS THE SUBTLE ONE. GitHub's cross-fork object reachability means a
 * fork's object store is shared with its parent, so pushing the clean tree into
 * a fork re-attaches it to the private repository's network — the exact thing
 * building a fresh unrelated repository exists to prevent.
 */
export function assertDestination(deps, dest) {
  const step = 'destination-is-safe';
  if (!dest || !/^[\w.-]+\/[\w.-]+$/.test(String(dest))) {
    return refuse(step, `destination "${dest || ''}" is not of the form <owner>/<repo>.`);
  }
  const r = deps.gh(['repo', 'view', dest, '--json', 'isFork,defaultBranchRef,url,parent']);
  if (r.status !== 0) {
    return refuse(
      step,
      `cannot read destination "${dest}" through gh: ${String(r.stderr || r.stdout || '').trim() || 'no output'}`,
      'Create the empty public repository first, or check `gh auth status`.'
    );
  }
  let view;
  try {
    view = JSON.parse(r.stdout);
  } catch {
    return refuse(step, `gh returned unparseable JSON for "${dest}".`);
  }

  const errors = [];
  if (view.isFork) {
    errors.push(
      `"${dest}" is a fork of ${view.parent && view.parent.nameWithOwner ? view.parent.nameWithOwner : 'another repository'}. `
        + "A fork shares its object store with its parent, so publishing there re-attaches the clean tree to the "
        + 'private history it was built to escape.'
    );
  }
  if (view.defaultBranchRef && String(view.defaultBranchRef.name || '').trim()) {
    errors.push(
      `"${dest}" already has history (default branch ${view.defaultBranchRef.name}). The published copy must be `
        + 'the first and only commit in a fresh repository.'
    );
  }
  const origin = deps.originUrl();
  if (origin && normaliseRepoUrl(view.url) === normaliseRepoUrl(origin)) {
    errors.push(`"${dest}" is this working repository's own origin (${origin}). Refusing to publish into it.`);
  }
  if (errors.length > 0) return refuse(step, errors);
  return pass(step, { dest, cloneUrl: view.url });
}

// ── 3–5. the corpus ──────────────────────────────────────────────────────────

/**
 * The three corpus refusals, in one place because they share a failure meaning:
 * the check cannot actually see the owner's data, so certifying would be a
 * statement about nothing.
 *
 * `assertCorpusFresh` is given the LIVE watermark; a run with no database to
 * compare against makes no staleness claim rather than a false one.
 */
export async function assertCorpusReady(deps) {
  // Says WHICH of the two it is. "No cache" and "a cache I cannot believe" are
  // different situations with different causes — the second one means another
  // checkout on this machine rewrote the shared file — and a refusal that does
  // not distinguish them sends the owner looking in the wrong place.
  const { state, reason, corpus } = corpusCacheState(deps);
  if (!corpus) {
    return refuse(
      'corpus-schema',
      state === 'untrusted'
        ? `${reason} Publication certifies nothing until the cache is rebuilt from this checkout.`
        : 'no usable corpus cache on disk. A v1 cache is treated as ABSENT, never as '
          + 'empty — "nothing to find" and "refresh me" are different statements. Run '
          + '`node scripts/check-first-user-clean.js --refresh`.'
    );
  }
  const floors = assertCorpusFloors(corpus);
  if (floors.length > 0) return refuse('corpus-floors', floors);

  const { db } = await openOwnerDb(deps.dbPath);
  const watermark = liveWatermark(db);
  try {
    if (db) db.close();
  } catch {
    /* noop */
  }
  const fresh = assertCorpusFresh(corpus, watermark);
  if (fresh.length > 0) return refuse('corpus-freshness', fresh);
  return pass('corpus-freshness', { corpus, watermark });
}

// ── 6. the detection self-proof ──────────────────────────────────────────────

/**
 * AC7's core requirement, placed where it can fail loudly: refuse to certify
 * anything if the gate cannot prove it detects a planted term.
 *
 * `deps.selfTest()` returns `{ status, output }`. The CLI binds it to a real
 * `check-first-user-clean.js --self-test` run; a probe can bind a failing one to
 * demonstrate the refusal without breaking the real gate.
 */
export function assertSelfTest(deps) {
  const step = 'detection-self-proof';
  const r = deps.selfTest();
  if (r.status === 0) return pass(step, { output: r.output });
  return refuse(
    step,
    'the gate could not prove it detects a planted term, so it cannot certify a tree as clean.',
    ...(r.output ? [r.output] : [])
  );
}

// ── 7–8. the file set ────────────────────────────────────────────────────────

/**
 * Resolve the manifest AGAINST THE NAMED COMMIT, not the working tree.
 *
 * This is the difference between "what would ship if I published now" and "what
 * ships from the thing I am publishing". Resolving against the working tree
 * would let an uncommitted deletion or addition change the published set behind
 * the lock — reintroducing, one layer up, the exact working-tree leak step 1
 * closes.
 */
export function resolvePublishedSet(deps, sha) {
  const step = 'materialise-file-set';
  // loadManifest and resolveManifest THROW on an unusable manifest and on a
  // resolution that matches nothing. Those are refusals, not crashes: a stack
  // trace out of a publication step tells the owner the step is broken when what
  // actually happened is that the step correctly declined. Converted here, at
  // the boundary, so the lib functions keep their fail-loud contract for every
  // other caller. Measured: --empty-fileset produced a stack trace instead of a
  // named refusal on its first run.
  let manifest;
  let resolved;
  try {
    manifest = loadManifest(deps.configDir);
  } catch (err) {
    return refuse(step, err.message);
  }
  const atCommit = deps.filesAtCommit(sha);
  if (!atCommit || atCommit.length === 0) {
    return refuse(step, `cannot list the tracked files at ${sha.slice(0, 12)}.`);
  }
  try {
    resolved = resolveManifest({ trackedFiles: () => atCommit }, manifest);
  } catch (err) {
    return refuse('file-set-non-empty', err.message);
  }
  const lock = assertManifestLock(deps, manifest, resolved);
  if (!lock.ok) {
    return refuse(
      step,
      ...lock.errors,
      ...lock.added.map((p) => `  + ${p}`),
      ...lock.removed.map((p) => `  - ${p}`),
      'A file entering or leaving the published set is a decision, not a side effect. Accept it with '
        + '`node scripts/publication-manifest.js --write-lock` or exclude it in config/publication-manifest.json.'
    );
  }
  if (resolved.paths.length === 0) {
    return refuse('file-set-non-empty', 'the manifest resolved to zero files — there is nothing to publish.');
  }
  return pass(step, { paths: resolved.paths, tracked: resolved.tracked, excluded: resolved.excluded, digest: lock.digest });
}

// ── 9. the tree ──────────────────────────────────────────────────────────────

/** Every file under `dir`, repo-relative, excluding `.git/`. */
export function filesOnDisk(dir) {
  const out = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative(dir, child));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Build the published tree by CONSTRUCTION: `git archive <sha> -- <paths>` emits
 * only the paths named, so a tracked file the manifest excludes is never written
 * to disk at all. That is a stronger guarantee than archiving everything and
 * deleting the excess, which is a filter with a window.
 *
 * Paths are archived in chunks because they are passed as arguments and a
 * 1,500-path command line is a portability question nobody should have to think
 * about at publication time.
 *
 * Then step 8: the extracted set must EQUAL the resolved list. Not "contain" —
 * equal. A tar that dropped a file and a tar that added one are both
 * publications of something other than what was approved.
 */
export function buildExportTree(deps, { sha, paths, exportDir, chunkSize = 500 }) {
  const step = 'build-single-commit-tree';
  mkdirSync(exportDir, { recursive: true });
  for (let i = 0; i < paths.length; i += chunkSize) {
    const chunk = paths.slice(i, i + chunkSize);
    const r = deps.archive(sha, chunk, exportDir);
    if (r.status !== 0) {
      return refuse(step, `git archive failed for paths ${i}–${i + chunk.length}: ${String(r.stderr || '').trim()}`);
    }
  }

  const onDisk = filesOnDisk(exportDir);
  if (onDisk.length === 0) return refuse('file-set-non-empty', 'the export directory is empty after archiving.');
  const expected = new Set(paths);
  const actual = new Set(onDisk);
  const missing = paths.filter((p) => !actual.has(p));
  const extra = onDisk.filter((p) => !expected.has(p));
  if (missing.length > 0 || extra.length > 0) {
    return refuse(
      step,
      `the materialised tree does not match the manifest: ${missing.length} missing, ${extra.length} unexpected.`,
      ...missing.slice(0, 20).map((p) => `  missing ${p}`),
      ...extra.slice(0, 20).map((p) => `  unexpected ${p}`)
    );
  }

  const init = deps.gitIn(exportDir, ['init', '-q', '-b', 'main']);
  if (init.status !== 0) return refuse(step, `git init failed: ${String(init.stderr || '').trim()}`);
  deps.gitIn(exportDir, ['add', '-A']);
  const commit = deps.gitIn(exportDir, [
    '-c', 'user.name=Robot Dojo',
    '-c', 'user.email=noreply@robotdojo.ai',
    'commit', '-q', '-m', 'Robot Dojo — clean public tree (single commit, no development history)',
  ]);
  if (commit.status !== 0) return refuse(step, `git commit failed: ${String(commit.stderr || '').trim()}`);

  const count = deps.gitIn(exportDir, ['rev-list', '--count', 'HEAD']);
  const commits = String(count.stdout || '').trim();
  if (commits !== '1') return refuse(step, `expected exactly 1 commit in the export, found ${commits}.`);
  return pass(step, { files: onDisk.length, exportDir });
}

// ── 10. the bridge ───────────────────────────────────────────────────────────

/**
 * AC13. Both composed scans read their owner configuration from places `git
 * archive` cannot emit — `.git/info/` and the gitignored `config/*.user.json`
 * overrides — so inside the export both loaded nothing and reported clean.
 *
 * The bridge points them back at the REAL repository. It is deliberately env,
 * not a copy: copying the pattern file into the export would put the owner's
 * patterns inside the artifact being published, which is the leak this whole
 * story exists to prevent. The export reads the owner's configuration; it never
 * contains it.
 */
export function composedBridgeEnv(deps) {
  return {
    ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS_FILE: join(deps.repoRoot, '.git', 'info', 'private-identity-patterns'),
    ROBOTDOJO_OWNER_CONFIG_DIR: join(deps.repoRoot, 'config'),
  };
}

// ── 11–12. the audit ─────────────────────────────────────────────────────────

/**
 * Run the export's OWN copy of the gate over the export tree, with the bridge in
 * the environment and `--require-composed` set so a scan that loaded nothing
 * refuses instead of reporting clean.
 *
 * Running the export's copy rather than the real repo's is deliberate: it is the
 * code that ships, so a gate broken in the published copy is caught here rather
 * than by the first stranger who runs it.
 */
export function auditExportTree(deps, exportDir) {
  const step = 'audit-export';
  const r = deps.auditor(exportDir, composedBridgeEnv(deps));
  if (r.status === 0) return pass(step, { output: r.output });
  return refuse(step, 'the completeness gate flagged the exported tree.', ...(r.output ? [r.output] : []));
}

// ── 13. decay ────────────────────────────────────────────────────────────────

/**
 * AC15. A permitted entry that no longer matches anything is removed on every
 * publication run, so the list cannot fill with dead rules that hide later real
 * findings. Runs in the REAL repository, because that is where the list lives.
 */
export function decayPermittedEntries(deps) {
  const step = 'decay-permitted';
  const r = deps.decay();
  if (r.status === 0) return pass(step, { output: r.output });
  return refuse(step, 'permitted-list decay failed.', ...(r.output ? [r.output] : []));
}

// ── 15. the push ─────────────────────────────────────────────────────────────

/**
 * The only irreversible action in the sequence, and the only place a push
 * happens. Reached only when every step above returned ok.
 */
export function pushExportTree(deps, exportDir, cloneUrl) {
  const step = 'push';
  const add = deps.gitIn(exportDir, ['remote', 'add', 'origin', cloneUrl]);
  if (add.status !== 0) return refuse(step, `could not set the remote: ${String(add.stderr || '').trim()}`);
  const push = deps.gitIn(exportDir, ['push', '-u', 'origin', 'main']);
  if (push.status !== 0) return refuse(step, `push failed: ${String(push.stderr || '').trim()}`);
  return pass(step, { cloneUrl, output: String(push.stdout || push.stderr || '').trim() });
}

// ── the whole sequence ───────────────────────────────────────────────────────

/**
 * Run the step. Returns `{ ok, step, errors, results, exportDir }`.
 *
 * `opts.push` is the only way an object leaves this machine, and it requires
 * `opts.dest`. Without it the run builds, audits, and reports — the mode every
 * proof and every rehearsal uses.
 *
 * `opts.keep` leaves the export directory for inspection. Default is to remove
 * it: build-conventions requires a stage to clean up after itself, and an
 * accumulating pile of export trees in $TMPDIR is exactly the residue that rule
 * names.
 */
export async function publish(deps, opts = {}) {
  const results = [];
  const record = (r) => {
    results.push(r);
    return r;
  };
  const fail = (r) => ({ ok: false, step: r.step, errors: r.errors, results, exportDir: null });

  const source = record(resolveSource(deps, opts.from));
  if (!source.ok) return fail(source);

  // The destination is checked BEFORE the tree is built, not after: a typo
  // should cost a second, and a fork destination must never get as far as having
  // a candidate tree sitting next to it.
  let destination = null;
  if (opts.dest) {
    destination = record(assertDestination(deps, opts.dest));
    if (!destination.ok) return fail(destination);
  } else if (opts.push) {
    return fail(refuse('destination-is-safe', '--push requires --to <owner>/<repo>.'));
  }

  const corpus = record(await assertCorpusReady(deps));
  if (!corpus.ok) return fail(corpus);

  const selfTest = record(assertSelfTest(deps));
  if (!selfTest.ok) return fail(selfTest);

  const set = record(resolvePublishedSet(deps, source.sha));
  if (!set.ok) return fail(set);

  const exportDir = opts.exportDir || mkdtempSync(join(tmpdir(), 'robotdojo-clean-export.'));
  let removed = false;
  const cleanup = () => {
    if (removed || opts.keep) return;
    removed = true;
    try {
      rmSync(exportDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  };

  try {
    const tree = record(buildExportTree(deps, { sha: source.sha, paths: set.paths, exportDir }));
    if (!tree.ok) return fail(tree);

    const audit = record(auditExportTree(deps, exportDir));
    if (!audit.ok) return fail(audit);

    const decayed = record(decayPermittedEntries(deps));
    if (!decayed.ok) return fail(decayed);

    if (!opts.push) {
      return { ok: true, step: 'audited', errors: [], results, exportDir: opts.keep ? exportDir : null };
    }
    const pushed = record(pushExportTree(deps, exportDir, destination.cloneUrl));
    if (!pushed.ok) return fail(pushed);
    return { ok: true, step: 'pushed', errors: [], results, exportDir: opts.keep ? exportDir : null };
  } finally {
    cleanup();
  }
}
