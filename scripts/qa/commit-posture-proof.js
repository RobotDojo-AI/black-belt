#!/usr/bin/env node
/**
 * commit-posture-proof.js — AC16: on every commit the same check reports what it
 * finds without blocking, the commit still succeeds, and the owner sees the
 * report (st_dd0e19d8 Phase 2).
 *
 * WHY THIS IS A SEPARATE PROBE rather than an assertion inside the gate: the
 * property is about the gate's BEHAVIOUR IN THE HOOK — exit code, output, and
 * wall time under a realistic staged set — and none of those can be proven by
 * reading the gate's source. So this stages real files and runs the real command.
 *
 * IT NEVER TOUCHES THE OWNER'S INDEX. Staging happens in a COPY of .git/index
 * addressed through GIT_INDEX_FILE, which every child `git` inherits. An
 * interrupted run leaves the real index byte-identical, which matters because
 * this probe is meant to be runnable mid-commit-cycle without thinking about it.
 *
 * Four properties, each falsifiable:
 *   1. a staged set carrying REPORT-class findings exits 0 — the commit succeeds
 *   2. those findings are actually PRINTED — reporting that reports nothing is
 *      indistinguishable from not scanning. The report-class finding is PLANTED,
 *      not borrowed from the tree: a proof that only passes while real leaks
 *      remain goes red when the leak removal succeeds.
 *   3. a permitted finding is counted as permitted, not re-reported as noise
 *   4. the same check still FAILS on a planted BLOCK-class term — without this
 *      the first three are satisfied by a gate that does nothing at all
 * Plus the budget: the whole staged run stays inside 1.5s.
 *
 * ── THE PROMOTION PROOF (owner decision 12: "Turn them on") ─────────────────
 *
 * Promoting `emails` and `entity_ids` to block at commit has one failure mode
 * that matters and it is not a leak — it is that EVERY COMMIT FAILS. The
 * pre-commit de-tax regenerates and stages five generated surfaces that embed
 * the product's public support address, so the hook re-introduces an `emails`
 * finding on every commit, including a commit that touched none of those files.
 * Permitted entries cover them; if any is missing the owner cannot commit at all.
 *
 * So the promotion is proven at the placement it changes, on the exact files the
 * hook regenerates, with both directions asserted: those files staged must exit
 * 0, AND a planted non-permitted address of the owner's in a staged file must
 * fail. Only the pair distinguishes "seeded correctly" from "not scanning".
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM. NO OWNER DATA IN THIS FILE.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { loadCorpus, defaultDeps } from '../../lib/owner-corpus.js';
import { EMAIL_SHAPE } from '../../lib/corpus-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const BUDGET_SECONDS = 1.5;

/**
 * A realistic staged set: a permitted public address, product source, and two
 * de-tax-regenerated surfaces the hook itself stages during a commit. It carries
 * the PERMITTED finding the third assertion needs and it makes the budget
 * measurement honest. It is deliberately NOT the source of the report-class
 * finding — that one is planted below. If any path is renamed the probe fails
 * loudly rather than silently proving nothing about an empty set.
 */
const STAGE_SET = [
  'apps/static/public-truth.json',
  'lib/config.js',
  'lib/gsc-heal.js',
  'lib/referral/yc-filter.js',
  'tests/relation-mine.test.js',
  'architecture/sitemap.md',
  // The five surfaces scripts/detax.sh regenerates and stages DURING a commit.
  // Every one of them embeds the product's public support address, so with
  // `emails` promoted to block these are the files that would fail every commit
  // if a permitted entry were missing. They are in the staged set precisely so
  // that failure cannot hide.
  'lib/public-chat/public-truth.js',
  'lib/public-chat/faq-bundle.js',
  'apps/static/llms-full.txt',
  'apps/static/faq/faq-context.json',
];

/**
 * The classes the owner promoted to blocking at commit, and the de-tax files
 * whose regeneration makes that promotion conditional on seeding. Named here so
 * the assertion below fails loudly if the posture is silently relaxed again —
 * a proof that reads the posture it is proving would pass either way.
 */
const PROMOTED_CLASSES = ['emails', 'entity_ids'];
const DETAX_REGENERATED = [
  'lib/public-chat/public-truth.js',
  'lib/public-chat/faq-bundle.js',
  'apps/static/public-truth.json',
  'apps/static/llms-full.txt',
  'apps/static/faq/faq-context.json',
];

function run(cmd, args, env = {}) {
  return spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

function main() {
  const corpus = loadCorpus(defaultDeps(REPO_ROOT));
  if (!corpus || !corpus.terms || corpus.terms.length === 0) {
    process.stderr.write(
      'commit-posture-proof: corpus UNAVAILABLE or EMPTY — this probe cannot distinguish a\n'
        + 'reporting gate from a blind one without it. Run check-first-user-clean.js --refresh.\n'
    );
    return 1;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'rd-commit-posture-'));
  const indexFile = join(scratch, 'index');
  const fixtureDir = join(REPO_ROOT, 'scripts', '.commit-posture-proof');
  const fixtureRel = 'scripts/.commit-posture-proof/planted.txt';
  const reportRel = 'scripts/.commit-posture-proof/report-planted.txt';
  const emailRel = 'scripts/.commit-posture-proof/email-planted.txt';
  const checks = [];
  const narrowed = [];
  try {
    const realIndex = join(REPO_ROOT, '.git', 'index');
    if (!existsSync(realIndex)) {
      process.stderr.write('commit-posture-proof: no .git/index — run from the repository root.\n');
      return 1;
    }
    copyFileSync(realIndex, indexFile);
    const env = { GIT_INDEX_FILE: indexFile };

    const missing = STAGE_SET.filter((f) => run('git', ['ls-files', '--error-unmatch', f], env).status !== 0);
    if (missing.length > 0) {
      process.stderr.write(
        `commit-posture-proof: these files are no longer tracked, so the probe would prove nothing: ${missing.join(', ')}\n`
      );
      return 1;
    }
    // STAGING AN UNMODIFIED FILE IS A NO-OP — `git add` on a file identical to
    // HEAD leaves `diff --cached` empty, and the gate would scan nothing while
    // every assertion below still "passed". So each path is registered in the
    // scratch index pointing at a DIFFERENT existing blob, which makes it read as
    // modified. No object is written and the working tree is untouched, which
    // matters: the gate greps the WORKING TREE for content and uses the staged
    // list only as its scope, so the real file contents are still what gets
    // scanned.
    const decoy = run('git', ['rev-parse', 'HEAD:package.json'], env).stdout.trim();
    if (!/^[0-9a-f]{40,}$/.test(decoy)) {
      process.stderr.write('commit-posture-proof: could not resolve a blob to mark the staged set with.\n');
      return 1;
    }
    for (const f of STAGE_SET) {
      const upd = run('git', ['update-index', '--cacheinfo', `100644,${decoy},${f}`], env);
      if (upd.status !== 0) {
        process.stderr.write(`commit-posture-proof: staging ${f} into the scratch index failed: ${upd.stderr}\n`);
        return 1;
      }
    }

    // A REPORT-class finding is PLANTED rather than borrowed from the tree.
    //
    // The first version of this probe leaned on real findings that happened to
    // sit in the staged files, and phase 3 removed them — so a probe asserting
    // "reporting works" went red precisely because the leak removal succeeded. A
    // proof that can only pass while the tree is still leaking is a proof that
    // fights the story. Planting makes the assertion about the MECHANISM, which
    // is what AC16 is actually about, and it keeps working on a clean tree.
    const reportSeed =
      (corpus.private_terms || []).find((t) => t.length >= 5 && !t.includes(' '))
      || (corpus.private_terms || [])[0];
    if (!reportSeed) {
      process.stderr.write(
        'commit-posture-proof: the corpus carries no private-settings term to plant, so "reporting\n'
          + 'works" cannot be demonstrated. Run check-first-user-clean.js --refresh.\n'
      );
      return 1;
    }
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(REPO_ROOT, reportRel), `planted report-class control: ${reportSeed}\n`);
    const addReport = run('git', ['add', '-f', '--', reportRel], env);
    if (addReport.status !== 0) {
      process.stderr.write(`commit-posture-proof: staging the report fixture failed: ${addReport.stderr}\n`);
      return 1;
    }

    // ── 1..3: the reporting run ──────────────────────────────────────────────
    const t0 = Date.now();
    const r = run('node', ['scripts/check-first-user-clean.js', '--staged'], env);
    const elapsed = (Date.now() - t0) / 1000;
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const reported = Number((out.match(/(\d+) reported/) || [])[1] ?? -1);
    const permitted = Number((out.match(/(\d+) permitted/) || [])[1] ?? -1);
    const blocking = Number((out.match(/(\d+) blocking/) || [])[1] ?? -1);

    checks.push([`the commit is not blocked (exit 0, got ${r.status})`, r.status === 0]);
    checks.push([`the run summary is printed with a blocking count (${blocking})`, blocking === 0]);
    checks.push([`report-class findings are printed, not swallowed (${reported} reported)`, reported > 0]);
    checks.push([`the planted report-class finding is the one reported`, out.includes(reportRel)]);
    checks.push([
      `each reported finding is listed with its file, line and class`,
      /REPORTED, not blocking/.test(out) && /^\s+~ \S+:\d+: \w+ /m.test(out),
    ]);
    checks.push([`a permitted finding is counted as permitted, not re-reported (${permitted})`, permitted > 0]);
    checks.push([
      `the staged run stays inside the ${BUDGET_SECONDS}s budget (${elapsed.toFixed(2)}s)`,
      elapsed <= BUDGET_SECONDS,
    ]);

    // ── 4: the same check still blocks on a BLOCK-class term ─────────────────
    // Without this the four checks above are satisfied by a gate that scans
    // nothing. Tier A ("terms") blocks at commit, so a planted Tier A term in a
    // staged file must fail the run.
    const seed =
      corpus.terms.find((t) => t.includes(' ') && t.split(/\s+/).every((p) => p.length >= 4))
      || corpus.terms[0];
    writeFileSync(join(REPO_ROOT, fixtureRel), `planted positive control: ${seed}\n`);
    const addFixture = run('git', ['add', '-f', '--', fixtureRel], env);
    if (addFixture.status !== 0) {
      process.stderr.write(`commit-posture-proof: staging the planted fixture failed: ${addFixture.stderr}\n`);
      return 1;
    }
    const r2 = run('node', ['scripts/check-first-user-clean.js', '--staged'], env);
    const out2 = `${r2.stdout || ''}${r2.stderr || ''}`;
    checks.push([`a planted blocking-class term FAILS the same check (exit ${r2.status})`, r2.status !== 0]);
    checks.push([`the failure names the planted file`, out2.includes(fixtureRel)]);

    // ── 5: the promotion (owner decision 12) ────────────────────────────────
    // Read the posture from the table rather than assuming it: the assertions
    // that follow prove nothing about a class that is merely reporting.
    const table = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'publication-posture.json'), 'utf8'));
    for (const cls of PROMOTED_CLASSES) {
      checks.push([
        `"${cls}" blocks at commit placement (table says "${(table.classes[cls] || {}).staged}")`,
        (table.classes[cls] || {}).staged === 'block',
      ]);
    }
    // ── 6: class coverage, stated STRICTLY so it can actually fail ──────────
    // AC16 reads "on every commit the same check reports what it finds". The
    // falsifier this proof used to carry — "the classes are never scanned at
    // commit" — cannot fail while ANY class reports, so three reporting classes
    // made it vacuous no matter what the fourth did. The falsifiable form is
    // per-class: every class the check covers is scanned at commit, or the run
    // says which one is not and why. A class set to `skip` is not scanned at all
    // (see collectFindings) — that is a real narrowing of AC16, not a detail.
    for (const cls of Object.keys(table.classes)) {
      if (cls.startsWith('_')) continue;
      const p = (table.classes[cls] || {}).staged;
      narrowed.push([cls, p, (table.classes[cls] || {})._why || '']);
      checks.push([`class "${cls}" is scanned at commit (table says "${p}")`, p !== 'skip']);
    }

    const staged = new Set(run('git', ['diff', '--cached', '--name-only'], env).stdout.split('\n').filter(Boolean));
    const absent = DETAX_REGENERATED.filter((f) => !staged.has(f));
    checks.push([
      `all ${DETAX_REGENERATED.length} de-tax-regenerated surfaces are in the staged set the run scanned`,
      absent.length === 0,
    ]);
    // Assertion 1 already ran with those files staged and exited 0 — that IS the
    // "every commit still works" proof, so it is restated here rather than
    // re-run: a second identical run would only re-measure the same thing.
    checks.push([
      'with those files staged and both classes blocking, the commit still succeeds',
      r.status === 0 && absent.length === 0,
    ]);

    // The other direction. Without it, "exit 0" is equally consistent with a
    // class that is not scanned at all. A REAL owner address that is NOT on the
    // permitted list, planted in a staged file, must fail the same run.
    const permittedTerms = new Set(
      (JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'publication-permitted.json'), 'utf8')).permitted || [])
        .map((e) => String(e.term || '').toLowerCase())
    );
    // THE SEED MUST BE ONE THE ARM CAN ACTUALLY EXTRACT, and "matches
    // EMAIL_SHAPE" is not the same test. Measured on this corpus, twice:
    //   - the list's first entries are quoted-local-part forms (`"a.b."@host`)
    //     that the shape cannot match at all;
    //   - the first entry that DOES match the shape is an SMS-gateway address
    //     beginning `+1...`, and the arm extracts with `\b(?:SHAPE)\b`, whose
    //     leading \b cannot fire before a `+`. It extracts the address WITHOUT
    //     the plus, which is not in the member set, so nothing is found.
    // Planting either one produced a control the arm could never catch, and the
    // check read that as the promotion failing. So the filter is the arm's own
    // extraction, round-tripped: plant only a seed the arm returns verbatim.
    // (Both classes above are real false negatives of the address arm. They are
    // out of this story's scope — AC11 bounds the class to shape-matched
    // addresses — and are reported as a residual, not silently absorbed here.)
    const extract = new RegExp(`\\b(?:${EMAIL_SHAPE})\\b`, 'gi');
    const roundTrips = (e) => {
      extract.lastIndex = 0;
      const m = extract.exec(`control: ${e} end`);
      return Boolean(m) && m[0].toLowerCase() === String(e).toLowerCase();
    };
    const emailSeed = (corpus.emails || []).find(
      (e) => roundTrips(e) && !permittedTerms.has(String(e).toLowerCase())
    );
    if (emailSeed) {
      // UNSTAGE THE TIER A CONTROL FIRST. Left in place it fails the next run on
      // its own, and "exit non-zero" would then be evidence of nothing — the
      // first version of this check passed for exactly that wrong reason.
      run('git', ['update-index', '--force-remove', '--', fixtureRel], env);
      rmSync(join(REPO_ROOT, fixtureRel), { force: true });
      writeFileSync(join(REPO_ROOT, emailRel), `planted non-permitted address control: ${emailSeed}\n`);
      run('git', ['add', '-f', '--', emailRel], env);
      const r3 = run('node', ['scripts/check-first-user-clean.js', '--staged'], env);
      const out3 = `${r3.stdout || ''}${r3.stderr || ''}`;
      checks.push([`a planted non-permitted address BLOCKS the commit (exit ${r3.status})`, r3.status !== 0]);
      checks.push(['and the failure names it as an address finding', /emails "/.test(out3) && out3.includes(emailRel)]);
    } else {
      checks.push(['a planted non-permitted address BLOCKS the commit — NO SEED AVAILABLE', false]);
    }

    let ok = true;
    process.stdout.write('commit-posture-proof (AC16):\n');
    for (const [label, pass] of checks) {
      if (!pass) ok = false;
      process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'}  ${label}\n`);
    }
    // The narrowing, printed in the owner's terms rather than left for a reader
    // to infer from a FAIL line. This is a decision he has to make; it is not a
    // defect the build can engineer away, because the cost that forced it is
    // measured (see the class note in the posture table).
    const skipped = narrowed.filter(([, p]) => p === 'skip');
    if (skipped.length > 0) {
      process.stdout.write('\nNARROWED — a decision for the owner, not a defect this build can close:\n');
      for (const [cls, , why] of skipped) {
        process.stdout.write(`  "${cls}" is NOT scanned on commit. It is scanned at publication.\n`);
        if (why) process.stdout.write(`    why: ${why.slice(0, 400)}\n`);
      }
      process.stdout.write(
        '  AC16 as sealed says the check reports on every commit. It does, for every class\n'
          + '  but this one. Closing it needs a different scan family, not a posture change.\n'
      );
    }
    if (!ok) {
      process.stderr.write('\ncommit-posture-proof: the reporting run output was:\n');
      process.stderr.write(out.replace(/^/gm, '  ') + '\n');
    }
    return ok ? 0 : 1;
  } finally {
    // Build-conventions: every probe deletes its own fixtures. The scratch index
    // and the planted file both go, whatever happened above.
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

process.exit(main());
