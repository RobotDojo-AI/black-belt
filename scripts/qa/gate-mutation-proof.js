#!/usr/bin/env node
/**
 * gate-mutation-proof.js — AC8, proven by mutation (st_dd0e19d8 Phase 6).
 *
 * WHAT AC8 ACTUALLY ASKS FOR. "A deliberately broken version of the check — one
 * fed a planted real name — fails the build, verified as a test that would go
 * red if the blocking behaviour were removed." Two halves, and only the second
 * one is hard:
 *
 *   POSITIVE — plant a real corpus value and assert the gate refuses. Easy, and
 *   on its own worthless: an assertion that the gate exits non-zero also passes
 *   when the gate exits non-zero for some unrelated reason, and it passes on a
 *   tree that was already dirty.
 *
 *   MUTATION — take the blocking behaviour OUT, in a scratch copy, and assert
 *   the positive half goes red. That is the only evidence that distinguishes a
 *   live gate from one whose test would pass either way. Research External §5
 *   names it as the only such evidence, and this story exists because a whole
 *   suite of assertions turned out to be no-ops.
 *
 * ONE SEED PER CORPUS CLASS, NOT ONE SEED OVERALL. Seven classes reach the
 * published tree through six different code paths (four literal greps, two shape
 * greps, one filename matcher). A single planted name exercises exactly one of
 * them and passes with the other six broken — which is the shape of the defect
 * Phase 1 found in the entity-id arm, where a `\b` git-grep incompatibility had
 * silently matched nothing at all for a whole story while its test stayed green.
 * So every class listed as blocking in the posture table gets its own seed, its
 * own fixture, and its own run, and a class with no seed available is a FAILURE
 * here rather than a silent omission.
 *
 * THE SCRATCH COPY, AND WHY IT IS NOT THE REAL TREE. The mutation edits the
 * gate's source. Doing that in the working tree — even with a restore in a
 * `finally` — leaves a window where an interrupted run abandons a repository
 * whose leak detector has been disabled. So this builds a throwaway git
 * repository in the temp directory holding a real copy of the gate and the
 * modules it imports, points it at the owner's REAL corpus cache (which is
 * homedir-absolute by design, so the copy reads the same data the real gate
 * does), and mutates only there. The working tree is never written to.
 *
 * THE COMPOSED SCANS ARE DELIBERATELY NEUTRALISED. `--all` also runs
 * gate-pii.sh and check-public-config-clean.js. Those have their own liveness
 * proof (export-scan-liveness.js) and letting them fire here would make the exit
 * code ambiguous — a planted domain would be caught twice and a mutation of the
 * corpus gate would still exit non-zero for the other scan's reason. Both are
 * pointed at empty configuration for every run in this file, so every exit code
 * below is attributable to the corpus gate alone. That is stated rather than
 * arranged quietly.
 *
 * NOTHING PLANTED IS EVER PRINTED, and neither is the gate's output. The seeds
 * are the owner's real names, addresses, domains and ids — that is what makes
 * the proof real — so findings are asserted in memory and reported by class and
 * shape. A probe that proves a leak detector works by printing the leak has
 * failed the story it belongs to.
 *
 * AND IT ASSERTS THAT THE TESTS RAN. The last section runs the AC7 suite and
 * fails unless node reports zero skips: `{ skip: '' }` is read by node:test as a
 * skip REASON, so the "not skipped" case skips the test while reporting a
 * duration as though it had run. That defect shipped inside this story's own
 * proof suite and was caught only by counting. A suite that skips is a suite
 * that passes.
 *
 * Exit 0 = every asserted property holds.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadCorpus, defaultDeps } from '../../lib/owner-corpus.js';
import { loadPostureTable, classPosture } from '../../lib/publication-posture.js';
import { EMAIL_SHAPE, ENTITY_ID_SHAPE } from '../../lib/corpus-scan.js';
import {
  REPO_ROOT,
  buildScratch,
  destroyScratch,
  runScratchGate,
  plantValue,
  plantPath,
  unplant,
  blockedOn,
  shapeOf,
} from './scratch-gate.js';

const CONFIG_DIR = join(REPO_ROOT, 'config');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

// ── seeds, one per class, drawn from the owner's real corpus ─────────────────

/**
 * A seed must be plantable VERBATIM and unambiguous. Multi-token values whose
 * parts are all real words are preferred for the name-shaped classes: a
 * single-token seed can collide with ordinary source text and would prove the
 * matcher fires, not that it fires on the owner's data.
 */
/**
 * Does a shape-family member survive its own extraction? The shape arms grep for
 * a structural pattern and then re-extract the token in JS with `\b` boundaries
 * before testing set membership, so a stored value carrying a character the
 * boundary excludes — an address whose local part begins `+`, or a quoted local
 * part — is extracted as a DIFFERENT string and can never match. That is a
 * measured false-negative class this story carries in its residual rather than
 * claiming to have closed. A seed that cannot round-trip would prove the
 * residual, not the arm, so seeds are chosen by running the extraction rather
 * than by guessing a shape.
 */
function roundTrips(shape, value) {
  const re = new RegExp(`\\b(?:${shape})\\b`, 'gi');
  for (const m of `planted fixture line: ${value}\n`.matchAll(re)) {
    if (m[0].toLowerCase() === String(value).toLowerCase()) return true;
  }
  return false;
}

function pickSeed(corpus, cls) {
  const list = corpus[cls] || [];
  if (list.length === 0) return null;
  if (cls === 'entity_ids') return list.find((v) => roundTrips(ENTITY_ID_SHAPE, v)) || null;
  if (cls === 'emails') return list.find((v) => roundTrips(EMAIL_SHAPE, v)) || null;
  if (cls === 'domains') return list.find((v) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)) || null;
  return (
    list.find((v) => v.includes(' ') && v.split(/\s+/).every((p) => p.length >= 4) && /^[a-z0-9 ]+$/i.test(v))
    || list.find((v) => v.includes(' '))
    || list.find((v) => v.length >= 6)
    || null
  );
}

/**
 * The path class matches FILENAMES against the two high-precision literal
 * classes (see collectFindings), so its seed comes from those and is planted as
 * a filename rather than as file contents.
 */
function pickPathSeed(corpus) {
  return pickSeed(corpus, 'terms') || pickSeed(corpus, 'private_terms');
}

// ── the mutations ────────────────────────────────────────────────────────────

/**
 * Two mutations, at the two places the blocking decision is actually made.
 * Proving only one leaves the other untested, and they fail differently: the
 * posture mutation makes the gate stop CALLING a finding blocking, while the
 * facade mutation leaves the finding blocking and stops ACTING on it — the
 * second is the more dangerous shape, because the run still prints the leak and
 * exits 0, which reads like a pass with a warning.
 */
const MUTATIONS = [
  {
    id: 'posture',
    file: 'lib/publication-posture.js',
    what: 'no class can be blocking any more',
    apply: (src) => {
      const from = "  return row[placement] || 'block';";
      if (!src.includes(from)) return null;
      return src.replace(from, "  return row[placement] === 'skip' ? 'skip' : 'report';");
    },
  },
  {
    id: 'facade',
    file: 'scripts/check-first-user-clean.js',
    what: 'blocking findings are printed and no longer fail the run',
    apply: (src) => {
      const from = '  let failed = blocking.length > 0;';
      if (!src.includes(from)) return null;
      return src.replace(from, '  let failed = false;');
    },
  },
];

// ── the probe ────────────────────────────────────────────────────────────────

async function main() {
  const deps = defaultDeps(REPO_ROOT);
  const corpus = loadCorpus(deps);
  if (!corpus) {
    process.stderr.write(
      'gate-mutation-proof: no v2 owner corpus on this machine — AC8 cannot be proven without one.\n'
        + "Run `node scripts/check-first-user-clean.js --refresh` on the owner's box first.\n"
    );
    return 1;
  }

  const table = loadPostureTable(CONFIG_DIR);
  // Every class the table says BLOCKS at publication. Derived, never listed: a
  // class added to the table later is proven by this file on the day it is added.
  const blockingClasses = Object.keys(table.classes)
    .filter((c) => !c.startsWith('_'))
    .filter((c) => classPosture({ table, placement: 'publish' }, c) === 'block');

  process.stdout.write(
    `gate-mutation-proof: ${blockingClasses.length} classes block at publication — ${blockingClasses.join(', ')}\n\n`
  );

  const scratch = buildScratch();
  try {
    // ── baseline ─────────────────────────────────────────────────────────────
    process.stdout.write('Baseline — the scratch copy of the gate, with nothing planted\n');
    const baseline = runScratchGate(scratch);
    // The baseline is RECORDED, not required to be zero. The scratch tree holds
    // a real copy of the gate's own dependencies, and one of them (the
    // integration registry) legitimately names a corpus value — so demanding a
    // zero baseline would either be false or force the proof to suppress a
    // genuine finding. What must hold is that no baseline finding names a
    // fixture, so every fixture attribution below is caused by the plant.
    check(
      'the unplanted baseline is recorded and names no fixture',
      baseline.blocking !== null && !/^\s+docs\//m.test(baseline.output),
      `${baseline.blocking} pre-existing blocking finding(s) in the gate's own dependencies`
    );
    check(
      'the scratch gate reads the real corpus, not an empty one',
      /corpus cross-checked/.test(baseline.output) && !/corpus UNAVAILABLE/.test(baseline.output),
      'a blind copy would prove nothing'
    );

    // ── one seed per class ───────────────────────────────────────────────────
    process.stdout.write('\nAC8 positive — one real value planted per corpus class\n');
    const seeds = [];
    for (const cls of blockingClasses) {
      const isPath = cls === 'paths';
      const seed = isPath ? pickPathSeed(corpus) : pickSeed(corpus, cls);
      if (!seed) {
        check(`[${cls}] a real value is available to plant`, false, 'no usable member in this class');
        continue;
      }
      seeds.push({ cls, seed, isPath });
      const rel = isPath ? plantPath(scratch, seed) : plantValue(scratch, `gate-mutation-${cls}`, seed);
      const run = runScratchGate(scratch);
      check(
        `[${cls}] a planted real value is REFUSED, attributed to this class`,
        run.status !== 0 && run.blocking > baseline.blocking && blockedOn(run, { rel, cls, isPath }),
        `exit ${run.status}, ${run.blocking} blocking (baseline ${baseline.blocking}), seed ${shapeOf(seed)}`
      );
      unplant(scratch);
    }
    check(
      'every blocking class got its own seed — none was silently skipped',
      seeds.length === blockingClasses.length,
      `${seeds.length}/${blockingClasses.length} classes seeded`
    );

    // MEASURED, and reported whether or not anything is wrong: how much of each
    // shape class cannot survive its own extraction. This is the residual's
    // address-arm number, counted rather than estimated, and it is printed on
    // every run so it cannot quietly grow.
    for (const [cls, shape] of [['emails', EMAIL_SHAPE], ['entity_ids', ENTITY_ID_SHAPE]]) {
      const list = corpus[cls] || [];
      const unmatchable = list.filter((v) => !roundTrips(shape, v)).length;
      process.stdout.write(
        `  MEASURED  [${cls}] ${unmatchable} of ${list.length} stored values cannot be matched by this arm's shape\n`
      );
    }

    // ── all seeds at once, as the mutation baseline ──────────────────────────
    process.stdout.write('\nAC8 mutation — the same planted tree with the blocking behaviour removed\n');
    for (const s of seeds) (s.isPath ? plantPath(scratch, s.seed) : plantValue(scratch, `gate-mutation-${s.cls}`, s.seed));
    const allPlanted = runScratchGate(scratch);
    const caughtAll = seeds.every((s) =>
      blockedOn(allPlanted, {
        rel: s.isPath ? `docs/${s.seed.replace(/\s+/g, '-')}-fixture.md` : `docs/gate-mutation-${s.cls}-fixture.md`,
        cls: s.cls,
        isPath: s.isPath,
      })
    );
    check(
      'with every class planted at once the gate refuses, naming all of them',
      allPlanted.status !== 0 && caughtAll,
      `exit ${allPlanted.status}, ${allPlanted.blocking} blocking`
    );

    for (const m of MUTATIONS) {
      const abs = join(scratch.dir, m.file);
      const original = readFileSync(abs, 'utf8');
      const mutated = m.apply(original);
      if (mutated === null) {
        check(`[${m.id}] the blocking behaviour is where this proof says it is`, false, `anchor not found in ${m.file}`);
        continue;
      }
      try {
        writeFileSync(abs, mutated);
        const run = runScratchGate(scratch);
        check(
          `[${m.id}] with ${m.what}, the SAME planted tree passes — so the assertion above is load-bearing`,
          run.status === 0,
          `exit ${run.status}`
        );
        if (m.id === 'posture') {
          check(
            '[posture] and nothing is reported as blocking any more',
            run.blocking === 0 && run.reported > 0,
            `${run.blocking} blocking, ${run.reported} reported`
          );
        }
        if (m.id === 'facade') {
          check(
            '[facade] the leaks are still PRINTED while the run exits 0 — the vacuous-pass shape',
            run.blocking > 0,
            `${run.blocking} blocking findings printed, exit 0`
          );
        }
      } finally {
        writeFileSync(abs, original);
      }
    }

    const restored = runScratchGate(scratch);
    check(
      'restoring the mutation restores the refusal — the red state reproduces',
      restored.status !== 0 && restored.blocking === allPlanted.blocking,
      `exit ${restored.status}, ${restored.blocking} blocking`
    );
    unplant(scratch);

    // ── the tests actually ran ───────────────────────────────────────────────
    process.stdout.write('\nAC7/AC8 — the proof suite RAN rather than skipped\n');
    const suite = spawnSync(
      process.execPath,
      ['--test', join(REPO_ROOT, 'tests', 'first-user-clean-selftest.test.js')],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
    const suiteOut = `${suite.stdout || ''}${suite.stderr || ''}`;
    const passed = Number((/^.\s*pass (\d+)$/m.exec(suiteOut) || [])[1] ?? -1);
    const skipped = Number((/^.\s*skipped (\d+)$/m.exec(suiteOut) || [])[1] ?? -1);
    check('the AC7 self-proof suite exits 0', suite.status === 0, `exit ${suite.status}`);
    check(
      'and it SKIPPED nothing — a skipped assertion is a passing assertion',
      skipped === 0 && passed > 0,
      `${passed} passed, ${skipped} skipped`
    );

    const failures = results.filter((r) => !r.ok);
    process.stdout.write(
      `\ngate-mutation-proof: ${results.length - failures.length}/${results.length} PASS\n`
    );
    return failures.length === 0 ? 0 : 1;
  } finally {
    destroyScratch(scratch);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`gate-mutation-proof: ${err.stack || err.message}\n`);
    process.exit(2);
  });
