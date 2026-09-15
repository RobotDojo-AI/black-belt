#!/usr/bin/env node
/**
 * publish-clean-tree.js — THE checked publication step (st_dd0e19d8 AC4).
 *
 * THIS FILE IS A CLI FACADE. Parse, bind the real world to the injected
 * dependencies, report. The sequence and every refusal live in
 * lib/publication-step.js — read that for the order and the reasoning
 * (build-conventions thin-facade rule: logic in lib/ as named `(deps, …params)`
 * functions).
 *
 * It replaces scripts/export-clean-tree.sh, which had three defects the sealed
 * scope names: it built from `git stash create` (working-tree state, not a named
 * commit), it ran its audit through two composed scans that were structural
 * no-ops inside the export, and it left the push to a human — moving the one
 * irreversible action outside the checks. That script is deleted rather than
 * kept as a shim: two ways to publish is one way too many, and
 * config/publication-paths.json now enumerates every remaining path so the claim
 * can be checked rather than believed.
 *
 *   --from <ref>       REQUIRED. The named commit to publish. No default —
 *                      absence of a default is what stops a hand-run from
 *                      exporting the working tree.
 *   --to <owner>/<repo>  destination. Checked (empty, not a fork, not this
 *                      repository) even without --push.
 *   --push             perform the push. The only irreversible action here, and
 *                      the only way an object leaves this machine.
 *   --keep             leave the export directory for inspection.
 *   --json             machine-readable result.
 *
 * Without --push this is a full rehearsal: every check runs, nothing leaves.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 *
 * Runnable from ~/robotdojo. Exit 0 = certified (and pushed, with --push).
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publish } from '../lib/publication-step.js';
import { defaultDeps } from '../lib/owner-corpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function gitIn(dir, args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function gh(args) {
  return spawnSync('gh', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** The tracked paths at a commit, or null when that commit is unreadable. */
function filesAtCommit(commit) {
  const r = git(['ls-tree', '-r', '-z', '--name-only', commit]);
  if (r.status !== 0) return null;
  const paths = r.stdout.split('\0').filter(Boolean);
  return paths.length > 0 ? paths : null;
}

/**
 * `git archive <sha> -- <paths> | tar -x -C <dir>`, run as a shell pipeline so
 * the tar stream is never buffered in this process. Only the named paths are
 * emitted, which is what makes the published set a construction rather than a
 * filter.
 */
function archive(sha, paths, exportDir) {
  const quoted = paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
  return spawnSync(
    'bash',
    ['-c', `set -o pipefail; git archive ${sha} -- ${quoted} | tar -x -C '${exportDir}'`],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
}

function originUrl() {
  const r = git(['remote', 'get-url', 'origin']);
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

/** The real detection self-proof, run in THIS repository where the corpus lives. */
function selfTest() {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-first-user-clean.js'), '--self-test'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/**
 * The export's OWN copy of the gate, over the export tree, with the composed
 * scans bridged to this repository's owner configuration and required to prove
 * they loaded it.
 */
function auditor(exportDir, bridge) {
  const r = spawnSync(
    process.execPath,
    [join(exportDir, 'scripts', 'check-first-user-clean.js'), '--all', '--require-composed'],
    { cwd: exportDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...bridge } }
  );
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function decay() {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-publication-permitted.js'), '--decay'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

export function cliDeps() {
  return {
    ...defaultDeps(REPO_ROOT),
    git,
    gitIn,
    gh,
    archive,
    filesAtCommit,
    originUrl,
    selfTest,
    auditor,
    decay,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const valueOf = (f) => {
    const i = args.indexOf(f);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };

  const opts = {
    from: valueOf('--from'),
    dest: valueOf('--to'),
    push: has('--push'),
    keep: has('--keep'),
  };

  const result = await publish(cliDeps(), opts);

  if (has('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  for (const r of result.results) {
    process.stdout.write(`  ${r.ok ? 'ok  ' : 'REFUSED'} ${r.step}\n`);
  }
  if (!result.ok) {
    process.stderr.write(`publish-clean-tree: REFUSED at "${result.step}" —\n`);
    for (const e of result.errors) process.stderr.write(`  ${e}\n`);
    return 1;
  }
  process.stdout.write(
    result.step === 'pushed'
      ? 'publish-clean-tree: published.\n'
      : 'publish-clean-tree: certified. Nothing was pushed (pass --push --to <owner>/<repo> to publish).\n'
  );
  if (result.exportDir) process.stdout.write(`publish-clean-tree: export kept at ${result.exportDir}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`publish-clean-tree: ${err.stack || err.message}\n`);
      process.exit(2);
    });
}

export { REPO_ROOT };
