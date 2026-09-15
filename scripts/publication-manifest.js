#!/usr/bin/env node
/**
 * publication-manifest.js — the CLI over the published-file list (AC3,
 * st_dd0e19d8 Phase 3).
 *
 * THIS FILE IS A CLI FACADE. Parse, delegate, report. The rules live in
 * lib/publication-manifest.js — read that for the glob semantics and for why the
 * lock records a commit (build-conventions thin-facade rule: logic in lib/ as
 * named `(deps, ...params)` functions).
 *
 *   --list         one published path per line, sorted. This is the file set the
 *                  publication step materialises, and the input the AC5 sweep
 *                  reads.
 *   --check-lock   refuse when today's resolved set differs from the recorded
 *                  lock, naming the files that entered or left.
 *   --write-lock   record today's set as the lock. The owner's deliberate act:
 *                  it is what "he decided to ship this file" means.
 *   --explain <p>  why one path is in or out — which rule matched, and its
 *                  stated reason.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 *
 * Runnable from ~/robotdojo. Exit 0 = the asserted property holds.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadManifest,
  resolveManifest,
  assertManifestLock,
  manifestDigest,
  compileRules,
  MANIFEST_FILE,
} from '../lib/publication-manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CONFIG_DIR = join(REPO_ROOT, 'config');

function git(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** The tracked set. `-z` because a path may contain anything but NUL. */
function trackedFiles() {
  const r = git(['ls-files', '-z']);
  if (r.status !== 0) throw new Error(`git ls-files failed: ${(r.stderr || '').trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}

/** The tracked set at a commit, or null when that commit is not readable here. */
function filesAtCommit(commit) {
  const r = git(['ls-tree', '-r', '-z', '--name-only', commit]);
  if (r.status !== 0) return null;
  const paths = r.stdout.split('\0').filter(Boolean);
  return paths.length > 0 ? paths : null;
}

const deps = { trackedFiles, filesAtCommit };

function headCommit() {
  const r = git(['rev-parse', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : null;
}

// ── modes ────────────────────────────────────────────────────────────────────

function modeList() {
  const manifest = loadManifest(CONFIG_DIR);
  const { paths } = resolveManifest(deps, manifest);
  process.stdout.write(`${paths.join('\n')}\n`);
  return 0;
}

function modeCheckLock() {
  const manifest = loadManifest(CONFIG_DIR);
  const resolved = resolveManifest(deps, manifest);
  const result = assertManifestLock(deps, manifest, resolved);
  if (result.ok) {
    process.stdout.write(
      `publication-manifest --check-lock: ${resolved.paths.length} published file(s) of `
        + `${resolved.tracked} tracked (${resolved.excluded} excluded); matches the lock.\n`
    );
    return 0;
  }
  process.stderr.write('publication-manifest --check-lock: REFUSED —\n');
  for (const e of result.errors) process.stderr.write(`  ${e}\n`);
  for (const p of result.added.slice(0, 40)) process.stderr.write(`  + ${p}\n`);
  if (result.added.length > 40) process.stderr.write(`  + … ${result.added.length - 40} more\n`);
  for (const p of result.removed.slice(0, 40)) process.stderr.write(`  - ${p}\n`);
  if (result.removed.length > 40) process.stderr.write(`  - … ${result.removed.length - 40} more\n`);
  process.stderr.write(
    '  Either exclude these paths in config/publication-manifest.json or accept them with '
      + '`node scripts/publication-manifest.js --write-lock`.\n'
  );
  return 1;
}

/**
 * Record today's set as the lock.
 *
 * REFUSES when the tracked set differs from the set at HEAD — i.e. a file has
 * been staged for addition or removal but not committed. A lock written from a
 * dirty index records a commit that does not reproduce its own digest, and every
 * later mismatch report would then be attributed to the wrong change. Commit
 * first, then lock.
 */
function modeWriteLock() {
  const manifest = loadManifest(CONFIG_DIR);
  const resolved = resolveManifest(deps, manifest);
  const head = headCommit();
  const atHead = head ? filesAtCommit(head) : null;
  if (!head || !atHead) {
    process.stderr.write('publication-manifest --write-lock: cannot read HEAD — refusing to write an unattributable lock.\n');
    return 1;
  }
  const indexSet = new Set(trackedFiles());
  const headSet = new Set(atHead);
  const drifted = [
    ...[...indexSet].filter((p) => !headSet.has(p)).map((p) => `+ ${p}`),
    ...[...headSet].filter((p) => !indexSet.has(p)).map((p) => `- ${p}`),
  ];
  if (drifted.length > 0) {
    process.stderr.write(
      'publication-manifest --write-lock: REFUSED — the tracked file set differs from HEAD, so the lock\n'
        + 'would record a commit that does not reproduce its own digest. Commit these first:\n'
    );
    for (const d of drifted.slice(0, 40)) process.stderr.write(`  ${d}\n`);
    if (drifted.length > 40) process.stderr.write(`  … ${drifted.length - 40} more\n`);
    return 1;
  }

  const path = join(CONFIG_DIR, MANIFEST_FILE);
  const current = JSON.parse(readFileSync(path, 'utf8'));
  const next = {
    ...current,
    lock: {
      files: resolved.paths.length,
      digest: manifestDigest(resolved.paths),
      commit: head,
      generated_at: new Date().toISOString(),
    },
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(
    `publication-manifest --write-lock: locked ${resolved.paths.length} published file(s) of `
      + `${resolved.tracked} tracked at ${head}.\n`
  );
  return 0;
}

function modeExplain(target) {
  const manifest = loadManifest(CONFIG_DIR);
  const include = compileRules(manifest.include);
  const exclude = compileRules(manifest.exclude);
  const inc = include.filter((r) => r.re.test(target));
  const exc = exclude.filter((r) => r.re.test(target));
  const shipped = inc.length > 0 && exc.length === 0;
  process.stdout.write(`publication-manifest --explain ${target}: ${shipped ? 'PUBLISHED' : 'not published'}\n`);
  for (const r of inc) process.stdout.write(`  include "${r.glob}" — ${r.reason}\n`);
  for (const r of exc) process.stdout.write(`  exclude "${r.glob}" — ${r.reason}\n`);
  if (inc.length === 0) process.stdout.write('  no include rule matches this path\n');
  return 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const valueOf = (f) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] || null : null;
  };

  if (has('--list')) return modeList();
  if (has('--check-lock')) return modeCheckLock();
  if (has('--write-lock')) return modeWriteLock();
  if (has('--explain')) {
    const target = valueOf('--explain');
    if (!target) {
      process.stderr.write('publication-manifest --explain: needs a path\n');
      return 2;
    }
    return modeExplain(target);
  }

  process.stderr.write(
    'publication-manifest: usage — --list | --check-lock | --write-lock | --explain <path>\n'
  );
  return 2;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`publication-manifest: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}

export { trackedFiles, filesAtCommit, REPO_ROOT, CONFIG_DIR };
