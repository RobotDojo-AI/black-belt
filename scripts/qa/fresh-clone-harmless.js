#!/usr/bin/env node
/**
 * fresh-clone-harmless.js — the designed property AC6 protects while tightening
 * everything around it (st_dd0e19d8 Phase 5).
 *
 * THE TENSION THIS RESOLVES. AC6 makes publication refuse when the check cannot
 * see the owner's data. Taken carelessly, that turns every gate into a hard
 * failure on a machine that has no owner data — which is every machine except
 * one. Robot Dojo is open source: a stranger clones it, edits a file, and
 * commits. Their commit must go through. Their tests must pass. The gate finds
 * nothing because there is nothing of the owner's to find, and that is the
 * correct answer, not a vacuous one.
 *
 * So the property has two halves and they must both hold at once:
 *
 *   COMMIT-TIME on a stranger's clone → exits 0, quietly, having written
 *   nothing. An absent corpus is reported as unavailable, never rebuilt (a
 *   rebuild on a machine without the database writes an EMPTY cache, and every
 *   run after that exits 0 forever — the vacuous pass this story exists to
 *   close).
 *
 *   PUBLICATION on that same state → REFUSES. Nobody but the owner can publish,
 *   and the reason is stated rather than implied.
 *
 * HOW A FRESH CLONE IS SIMULATED, honestly. Not by deleting anything: by
 * pointing the corpus cache at an empty scratch directory and the owner
 * configuration at another, so every source of owner data is genuinely absent
 * while the code under test is the real code. The real cache is never touched.
 *
 * Exit 0 = both halves hold.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publish } from '../../lib/publication-step.js';
import { defaultDeps } from '../../lib/owner-corpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

async function main() {
  const scratchCache = mkdtempSync(join(tmpdir(), 'robotdojo-freshclone-cache.'));
  const scratchOwnerConfig = mkdtempSync(join(tmpdir(), 'robotdojo-freshclone-config.'));
  const missingCache = join(scratchCache, 'owner-corpus.cache.json');
  const before = readFileSync(defaultDeps(REPO_ROOT).cachePath).length;

  // A stranger's environment: no corpus cache, no private pattern file, no
  // gitignored owner overrides.
  const strangerEnv = {
    ...process.env,
    ROBOTDOJO_OWNER_CORPUS_CACHE: missingCache,
    ROBOTDOJO_OWNER_CONFIG_DIR: scratchOwnerConfig,
    ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS_FILE: join(scratchOwnerConfig, 'no-patterns'),
    ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS: '',
  };

  try {
    process.stdout.write('fresh-clone-harmless: a clone with no owner data\n');

    const staged = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-first-user-clean.js'), '--staged'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: strangerEnv,
      maxBuffer: 32 * 1024 * 1024,
    });
    const stagedOut = `${staged.stdout || ''}${staged.stderr || ''}`;
    check(
      'the commit-time gate exits 0 on a clone with no owner data',
      staged.status === 0,
      `exit ${staged.status}`
    );
    check(
      'it reports the corpus as UNAVAILABLE rather than as empty',
      /corpus UNAVAILABLE/.test(stagedOut),
      '"nothing to find" would be the vacuous pass'
    );
    check(
      'it writes no cache — a rebuild here would poison every later run',
      !existsSync(missingCache),
      'an empty cache written once makes every run exit 0 forever'
    );

    const configClean = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'check-public-config-clean.js')],
      { cwd: REPO_ROOT, encoding: 'utf8', env: strangerEnv, maxBuffer: 32 * 1024 * 1024 }
    );
    check(
      'the config guard exits 0 with zero owner domains to cross-check',
      configClean.status === 0,
      `exit ${configClean.status}`
    );

    const pii = spawnSync('bash', [join(REPO_ROOT, 'scripts', 'gate-pii.sh')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: strangerEnv,
      maxBuffer: 32 * 1024 * 1024,
    });
    check('the identity guard exits 0 with zero patterns loaded', pii.status === 0, `exit ${pii.status}`);

    // And the other half: publication on that same state refuses.
    const head = git(['rev-parse', 'HEAD']).stdout.trim();
    const strangerDeps = {
      ...defaultDeps(REPO_ROOT),
      cachePath: missingCache,
      git,
      gitIn: (dir, args) => {
        if (args.includes('push')) throw new Error('fresh-clone-harmless reached a push — refusing');
        return spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      },
      archive: () => ({ status: 1, stderr: 'not reached' }),
      filesAtCommit: () => null,
      originUrl: () => '',
      gh: () => ({ status: 1, stdout: '', stderr: 'not reached' }),
      selfTest: () => ({ status: 1, output: 'not reached' }),
      auditor: () => ({ status: 1, output: 'not reached' }),
      decay: () => ({ status: 1, output: 'not reached' }),
    };
    const run = await publish(strangerDeps, { from: head });
    check(
      'publication from that same state REFUSES',
      !run.ok && run.step === 'corpus-schema',
      run.ok ? 'it certified' : run.errors[0] || run.step
    );

    const after = readFileSync(defaultDeps(REPO_ROOT).cachePath).length;
    check("the owner's real corpus cache is untouched by any of the above", after === before, `${before} bytes before and after`);

    const failed = results.filter((r) => !r.ok);
    process.stdout.write(`fresh-clone-harmless: ${results.length - failed.length}/${results.length} PASS\n`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    rmSync(scratchCache, { recursive: true, force: true });
    rmSync(scratchOwnerConfig, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fresh-clone-harmless: ${err.stack || err.message}\n`);
    process.exit(2);
  });
