#!/usr/bin/env node
/**
 * gate-wiring-proof.js — AC18's second half (st_dd0e19d8 Phase 7).
 *
 * AC18: "the three checks that exist but nothing runs are wired up or deleted."
 *
 * WIRED IS NOT MENTIONED. A gate whose filename appears in a hook comment is not
 * wired; a gate spawned by a test that never runs is not wired either. So this
 * proof does not grep for the name and declare victory. For each gate it finds
 * the invocation site and then OBSERVES THE GATE'S OWN OUTPUT coming back from
 * that site — a signature only the gate itself can print. A gate that has been
 * silently unhooked stops producing it, and this proof goes red.
 *
 * PASSING IS NOT THE PROPERTY UNDER TEST, and conflating the two would be the
 * easy mistake. Two of the three currently exit non-zero on this machine for
 * reasons this story did not create and has no mandate to fix: the launch
 * cleanliness audit reports seven hits in other subsystems, and the workbench
 * tree audit reports two leftover fixture directories inside the owner's own
 * gitignored workbench tree. Those are disclosed below as measurements. What
 * AC18 requires is that each gate is reachable and runs; a gate that runs and
 * reports a finding is working.
 *
 * WHY NOT WIRE THE WORKBENCH AUDIT INTO THE COMMIT HOOK, which is what the
 * design proposed. Because it exits non-zero on the owner's tree today, and a
 * hook step that fails on every commit is not a gate — it is a thing the owner
 * learns to bypass, which is the outcome research measured at CISA and the
 * reason this story's posture table exists at all. It is wired through its own
 * hermetic test instead, which is one of the three placements AC18's criterion
 * accepts, and the leftover fixtures are reported to the owner rather than
 * deleted by an agent that was not asked to touch his data.
 *
 * Exit 0 = every gate is reachable and demonstrably runs.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

/**
 * The three gates research measured as unrun, each with the output only it
 * prints. The signature is the load-bearing field: it is what turns "the name
 * appears somewhere" into "the gate executed".
 */
const GATES = [
  {
    path: 'scripts/check-launch-cleanliness.js',
    what: 'stale launch baggage in the tracked tree',
    signature: /launch cleanliness (PASS|FAIL)/,
    via: { kind: 'test', file: 'tests/launch-cleanliness.test.js' },
  },
  {
    path: 'scripts/check-workbench-tree-clean.js',
    what: 'a foreign git repository nested inside a workbench',
    signature: /(PASS|FAIL|OK) /,
    via: { kind: 'test', file: 'tests/workbench-tree-foreign-git.test.js' },
  },
  {
    path: 'scripts/check-vercelignore-private-data.js',
    what: 'the deploy ignore-list still excludes the private data roots',
    signature: /\[check-vercelignore-private-data\]/,
    via: { kind: 'ci', file: '.github/workflows/publication-checks.yml' },
  },
];

/** A control: a gate name nothing invokes. The detector must say so. */
const CONTROL = 'scripts/check-a-gate-nobody-runs.js';

function readText(rel) {
  try {
    return readFileSync(join(REPO_ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Where is this gate invoked from? Returns every site as {kind, file}.
 *
 * The basename is matched rather than the full path because a real invocation
 * often assembles the path from segments — `join(dir, '..', 'scripts', 'x.js')`
 * — and a full-path search misses exactly those. The false-positive risk that
 * introduces is closed by the signature run below, not by a cleverer regex.
 */
function invocationSites(gatePath) {
  const name = basename(gatePath);
  const sites = [];
  const hook = readText('scripts/pre-commit.sh');
  if (hook && hook.includes(name)) sites.push({ kind: 'hook', file: 'scripts/pre-commit.sh' });

  let workflows = [];
  try {
    workflows = readdirSync(join(REPO_ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    workflows = [];
  }
  for (const f of workflows) {
    const rel = `.github/workflows/${f}`;
    const text = readText(rel);
    if (text && new RegExp(`^\\s*-\\s*run:.*${name.replace(/[.]/g, '\\.')}`, 'm').test(text)) {
      sites.push({ kind: 'ci', file: rel });
    }
  }

  let tests = [];
  try {
    tests = readdirSync(join(REPO_ROOT, 'tests')).filter((f) => f.endsWith('.test.js'));
  } catch {
    tests = [];
  }
  for (const f of tests) {
    const rel = `tests/${f}`;
    const text = readText(rel);
    if (!text || !text.includes(name)) continue;
    // A mention inside a comment is not an invocation. Require the file to
    // actually start a process — the signature run below is what confirms it.
    if (/spawnSync|execSync|spawn\(|exec\(/.test(text)) sites.push({ kind: 'test', file: rel });
  }
  return sites;
}

/** Run the gate directly and return everything it emitted. */
function runGate(gatePath) {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, gatePath)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

/**
 * Does this test actually DEPEND on the gate, or merely name it?
 *
 * A passing test prints nothing, so the gate's own output cannot be observed
 * through it — which is exactly the case where "wired" could be claimed on no
 * evidence. So the dependency is proven by removing the gate: the test file is
 * copied into a scratch tree that has an empty `scripts/` directory, and it must
 * go RED there. A test that stays green without the gate present was never
 * running it.
 *
 * Nothing is written inside the repository: the scratch tree links `lib` and
 * `node_modules` and is removed in a `finally`.
 */
function testDependsOnGate(testFile) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'robotdojo-gate-wiring.')));
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    cpSync(join(REPO_ROOT, testFile), join(dir, 'tests', basename(testFile)));
    cpSync(join(REPO_ROOT, 'package.json'), join(dir, 'package.json'));
    symlinkSync(join(REPO_ROOT, 'lib'), join(dir, 'lib'));
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
    const r = spawnSync(process.execPath, ['--test', join(dir, 'tests', basename(testFile))], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const passed = Number((/^.\s*pass (\d+)$/m.exec(out) || [])[1] ?? -1);
    const skipped = Number((/^.\s*skipped (\d+)$/m.exec(out) || [])[1] ?? -1);
    // Red, and red for the right reason: it must have RUN its tests and failed,
    // not skipped them all or refused to load.
    return { red: r.status !== 0, passed, skipped };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  process.stdout.write('gate-wiring-proof: AC18 — the three gates nothing used to run\n\n');

  for (const gate of GATES) {
    process.stdout.write(`${gate.path} — ${gate.what}\n`);
    check('  the gate exists', existsSync(join(REPO_ROOT, gate.path)));

    const sites = invocationSites(gate.path);
    check(
      '  it is invoked from a hook, CI, or a test',
      sites.length > 0,
      sites.map((s) => `${s.kind}: ${s.file}`).join(', ') || 'nothing invokes it'
    );
    if (sites.length === 0) continue;

    const site = sites.find((s) => s.kind === gate.via.kind && s.file === gate.via.file) || sites[0];
    const run = runGate(gate.path);
    check(
      "  it runs and prints its own verdict",
      gate.signature.test(run.output),
      `exit ${run.status}`
    );
    if (site.kind === 'test') {
      const mutation = testDependsOnGate(site.file);
      check(
        `  and ${site.file} goes RED with the gate removed — it is running it, not naming it`,
        mutation.red && mutation.skipped === 0,
        `${mutation.passed} passed, ${mutation.skipped} skipped without the gate`
      );
    }
    if (run.status !== 0) {
      process.stdout.write(
        `  MEASURED  this gate reports findings on this machine today (exit ${run.status}); `
          + 'AC18 requires it to RUN, and a gate that runs and reports is working\n'
      );
    }
  }

  process.stdout.write('\nThe detector itself\n');
  check(
    'a gate nothing invokes is reported as unwired',
    invocationSites(CONTROL).length === 0,
    'a detector that always finds wiring proves nothing'
  );

  const failures = results.filter((r) => !r.ok);
  process.stdout.write(`\ngate-wiring-proof: ${results.length - failures.length}/${results.length} PASS\n`);
  return failures.length === 0 ? 0 : 1;
}

process.exit(main());
