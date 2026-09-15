#!/usr/bin/env node
/**
 * sweep-decisions-proof.js — AC5's own gate (st_dd0e19d8 Phase 3).
 *
 * The sweep is the one part of this story that ends in a person's judgment
 * rather than in a check, so what CAN be checked has to be checked hard:
 *
 *   --assert-swept-set   the swept set is exactly the published set less the
 *                        FOUR carve-outs the sealed criterion names. The four
 *                        are restated here from the criterion text, deliberately
 *                        independent of lib/publication-sweep.js — two
 *                        statements of one fact, so editing one is visible
 *                        against the other. A single shared constant would make
 *                        this assertion self-confirming.
 *
 *   --non-empty          the candidate document exists and its row count matches
 *                        the recorded count. A sweep that surfaces nothing is
 *                        indistinguishable from a sweep that did not run.
 *
 *   --ceiling <n> --demonstrate-halt
 *                        the bound fires. Proven twice: at the exact boundary
 *                        against the pure predicate (401 halts, 400 does not),
 *                        and END TO END by running the real sweep against a
 *                        ceiling its real count exceeds, then asserting that NO
 *                        document was written.
 *
 *   --count-before-present
 *                        on that halted run the count was still recorded, and
 *                        the receipt says `presented: false`. That is the
 *                        ordering the criterion is about: the bound protects the
 *                        owner on the run that breaches it, not afterwards.
 *
 *   --no-writes          the sweep mutates nothing publishable. Asserted
 *                        behaviourally — `git status --porcelain` across a real
 *                        run, plus a CONTENT digest of the file a refused write
 *                        was aimed at, rather than by reading the source. The
 *                        content digest is there because porcelain alone missed
 *                        this exact bug once already.
 *
 *   --decisions          every candidate carries exactly one recorded owner
 *                        decision from the closed set, and every `replace` has a
 *                        matching edit in the build diff. This is the half that
 *                        cannot pass until the owner has actually decided; it
 *                        says so plainly instead of passing vacuously.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * Runnable from ~/robotdojo. Exit 0 = every requested property holds.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifest, resolveManifest } from '../../lib/publication-manifest.js';
import { sweptSet, ceilingVerdict, SWEEP_CARVE_OUTS } from '../../lib/publication-sweep.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CONFIG_DIR = join(REPO_ROOT, 'config');
const STORY_DOC = join(
  REPO_ROOT,
  'user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/st_dd0e19d8/05-sweep-decisions.md'
);

/**
 * The four carve-outs, transcribed from the sealed criterion rather than
 * imported. AC5: "less the three bulk reference dictionaries named in AC19 —
 * 25,005 surnames, 2,164 nicknames, 5,862 startup domains ... The fourth, the
 * allowlist file, is handled separately by AC22."
 */
const CRITERION_CARVE_OUTS = [
  'config/surnames-top-25K.json',
  'config/nicknames.json',
  'config/yc-domains.json',
  'config/owner-corpus-allowlist.json',
];

/** The decisions the document's own header offers. Anything else is not a decision. */
const DECISION_WORDS = ['clear', 'replace', 'move'];

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function trackedFiles() {
  const r = git(['ls-files', '-z']);
  if (r.status !== 0) throw new Error(`git ls-files failed: ${(r.stderr || '').trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}

function runSweep(args, env = {}) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'publication-sweep.js'), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

/**
 * Parse the decision document.
 *
 * Rows are `| n | \`term\` | provenance | sites | decision |`. Since the owner
 * re-scoped the presentation into groups, a row's decision may be inherited from
 * its group's `**Group decision:** \`word\`` line — so the parser tracks the
 * current heading and computes an EFFECTIVE decision per row. Reading only the
 * row cell would report a fully-decided grouped document as entirely undecided;
 * reading only the group line would miss the per-row override the document
 * offers. Both, with the row winning, is the document's own stated rule.
 */
function readDocument(path) {
  if (!existsSync(path)) return { ok: false, reason: `the candidate document is absent at ${path}` };
  const body = readFileSync(path, 'utf8');
  const rows = [];
  const groups = [];
  let group = null;
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+?)(?:\s+\((\d+)\))?\s*$/.exec(line);
    if (heading && heading[1] !== 'Provenance' && heading[1] !== 'Decisions') {
      group = { label: heading[1], declared: heading[2] ? Number(heading[2]) : null, decision: '', rows: 0 };
      groups.push(group);
      continue;
    }
    const gd = /^\*\*Group decision:\*\*\s*`?([a-z_]*)`?\s*$/.exec(line);
    if (gd && group) {
      group.decision = /^_+$/.test(gd[1]) ? '' : gd[1];
      continue;
    }
    const m = /^\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/.exec(line);
    if (m) {
      const own = m[5].trim().replace(/`/g, '');
      if (group) group.rows += 1;
      rows.push({
        n: Number(m[1]),
        term: m[2],
        provenance: m[3].trim(),
        sites: m[4].trim(),
        decision: own,
        group: group ? group.label : null,
        // A row's own cell overrides its group; otherwise the group governs.
        effective: own || (group ? group.decision : ''),
      });
    }
  }
  const declared = /\*\*(\d+) candidates\.\*\*/.exec(body);
  return { ok: true, body, rows, groups, declared: declared ? Number(declared[1]) : null };
}

// ── checks ───────────────────────────────────────────────────────────────────

/**
 * The set the owner's decisions were actually taken over, read out of the
 * document he decided on.
 *
 * WHY THIS IS PARSED RATHER THAN RECOMPUTED, and it is the whole point of the
 * drift check below. The first version of `checkSweptSet` derived BOTH sides of
 * its comparison from one live resolution of the manifest — `swept.length ===
 * published.length - 4`. That is arithmetic about a single number; it holds no
 * matter what the number is, so it passed at 1,511 published files and would
 * have passed just as happily at 1,531, at 2,000, or at any other figure. It
 * could not detect the case it existed to detect: the published set moving after
 * the owner had cleared it. Measured 2026-07-26 — twenty files joined the
 * published set between the sweep run and the end of the build, and this check
 * reported PASS throughout.
 *
 * The recorded number is therefore a SECOND, INDEPENDENT statement of the same
 * fact, written into the document at the moment of the decision. One side comes
 * off disk, the other out of the record. They can disagree, which is what makes
 * the comparison worth running.
 */
function recordedCoverage(path) {
  if (!existsSync(path)) return null;
  const m = /\*\*Decisions cover:\*\*\s*([\d,]+)\s+swept files of\s+([\d,]+)\s+published/
    .exec(readFileSync(path, 'utf8'));
  if (!m) return null;
  const n = (s) => Number.parseInt(s.replace(/,/g, ''), 10);
  return { swept: n(m[1]), published: n(m[2]) };
}

/**
 * Does a recorded coverage line still describe the live published set? Pure, so
 * the assertions above can be mutation-tested with a fabricated record.
 */
function covers(recorded, livePublishedCount) {
  return {
    published: recorded.published === livePublishedCount,
    swept: recorded.swept === livePublishedCount - CRITERION_CARVE_OUTS.length,
  };
}

function checkSweptSet(report) {
  const manifest = loadManifest(CONFIG_DIR);
  const published = resolveManifest({ trackedFiles }, manifest).paths;
  const swept = sweptSet(published);

  report('the module and the criterion name the same four carve-outs',
    JSON.stringify(SWEEP_CARVE_OUTS.map((c) => c.path).sort()) === JSON.stringify([...CRITERION_CARVE_OUTS].sort()),
    `module: ${SWEEP_CARVE_OUTS.map((c) => c.path).join(', ')}`);

  const missing = CRITERION_CARVE_OUTS.filter((p) => !published.includes(p));
  report('all four carve-outs are files the manifest actually ships',
    missing.length === 0,
    missing.length ? `not in the published set: ${missing.join(', ')}` : '');

  const leaked = CRITERION_CARVE_OUTS.filter((p) => swept.includes(p));
  report('no carve-out is in the swept set', leaked.length === 0, leaked.join(', '));

  // ── the drift check: one side off disk, one side out of the record ─────────
  const recorded = recordedCoverage(STORY_DOC);
  report('the decision document records which file set the owner cleared',
    recorded !== null,
    'expected a "**Decisions cover:** N swept files of M published" line in 05-sweep-decisions.md');

  if (recorded) {
    report('the published set today is the one the owner\'s decisions were taken over',
      covers(recorded, published.length).published,
      `the document records ${recorded.published} published file(s); the manifest resolves `
        + `${published.length} today. ${Math.abs(published.length - recorded.published)} file(s) `
        + 'joined or left the published set after the sweep, so the clearance no longer covers what '
        + 'ships. Re-run scripts/publication-sweep.js and reconcile before publishing.');

    report('the swept set the owner cleared is today\'s published set less exactly those four',
      covers(recorded, published.length).swept,
      `the document records ${recorded.swept} swept; today's published set less the four `
        + `carve-outs is ${published.length - CRITERION_CARVE_OUTS.length}`);

    // MUTATION, not inspection. The two assertions above are worth exactly as
    // much as the predicate's ability to say no, so it is driven here with
    // fabricated records that are wrong by one file in each direction and
    // required to reject both. Without this, a predicate that returned true
    // unconditionally would print two PASS lines and look identical.
    const drifted = { swept: recorded.swept, published: recorded.published + 1 };
    const shrunk = { swept: recorded.swept - 1, published: recorded.published };
    report('  …and a record one file out from what ships is REJECTED, both ways',
      !covers(drifted, published.length).published && !covers(shrunk, published.length).swept,
      'the comparison accepts a wrong number, so it is not load-bearing');
  }

  report('the live swept set is the live published set less exactly those four',
    swept.length === published.length - CRITERION_CARVE_OUTS.length,
    `published ${published.length}, swept ${swept.length}`);

  // The three small reference files AC5 keeps IN. Naming them is the other half:
  // "swept" would otherwise be satisfiable by carving out everything awkward.
  const mustBeSwept = [
    'config/big-tech-domains.json',
    'config/vc-firms-domains.json',
    'config/service-vendor-keywords.json',
  ];
  const dropped = mustBeSwept.filter((p) => !swept.includes(p));
  report('the 129 employer domains, 52 investor domains and 28 vendor keywords are swept, not carved out',
    dropped.length === 0, dropped.join(', '));
}

function checkNonEmpty(report) {
  const doc = readDocument(STORY_DOC);
  report('the candidate document exists', doc.ok, doc.ok ? '' : doc.reason);
  if (!doc.ok) return;
  report('it lists at least one candidate', doc.rows.length > 0, `${doc.rows.length} row(s)`);
  report('the row count matches the count the document declares',
    doc.declared === doc.rows.length, `declared ${doc.declared}, rows ${doc.rows.length}`);
  report('every row names a candidate and where it appears',
    doc.rows.every((r) => r.term && r.sites), '');

  // Grouping may not lose or duplicate a candidate. Each group states its own
  // size in its heading; those must sum to the total and match what was printed.
  const sized = doc.groups.filter((g) => g.declared !== null);
  const mismatched = sized.filter((g) => g.declared !== g.rows);
  report('every group prints exactly as many rows as its heading claims',
    mismatched.length === 0,
    mismatched.map((g) => `${g.label}: says ${g.declared}, printed ${g.rows}`).join('; '));
  report('the groups together account for every candidate, none twice',
    sized.reduce((n, g) => n + g.declared, 0) === doc.rows.length,
    `groups sum ${sized.reduce((n, g) => n + g.declared, 0)}, rows ${doc.rows.length}`);
  report('the row numbers run 1..N with no gap — every candidate is enumerated',
    doc.rows.every((r, i) => r.n === i + 1), `first bad index at ${doc.rows.findIndex((r, i) => r.n !== i + 1)}`);
}

function checkCeiling(report, ceiling) {
  // (i) the boundary, against the pure predicate.
  report(`${ceiling + 1} candidates halt against a ceiling of ${ceiling}`,
    ceilingVerdict(ceiling + 1, ceiling).halt === true, '');
  report(`exactly ${ceiling} does NOT halt — the bound is inclusive`,
    ceilingVerdict(ceiling, ceiling).within === true, '');

  // (ii) end to end: the real sweep, a ceiling its real count exceeds, and the
  // assertion that matters — no document on disk.
  const dir = mkdtempSync(join(tmpdir(), 'rd-sweep-halt-'));
  try {
    const receipt = join(dir, 'count.json');
    const out = join(dir, 'would-be-list.md');
    const r = runSweep(['--write', out, '--ceiling', '1'], { ROBOTDOJO_SWEEP_RECEIPT: receipt });
    report('a real run over its ceiling exits with the halt code', r.status === 3, `exit ${r.status}: ${r.stderr.trim().split('\n')[0] || ''}`);
    report('it presents NOTHING — no document was written', !existsSync(out), out);
    report('it says why, in the owner\'s terms', /HALTED/.test(r.stderr) && /Nothing has been presented/.test(r.stderr), '');

    // (iii) THE GROUPED MODE IS BOUNDED TOO. Moving the ceiling from rows to
    // decisions is only defensible if it still fires; a "bound" that cannot
    // halt is a bound that was removed. Same real sweep, grouped, ceiling 1.
    const gOut = join(dir, 'would-be-grouped.md');
    const g = runSweep(['--write', gOut, '--grouped', '--ceiling', '1'], {
      ROBOTDOJO_SWEEP_RECEIPT: join(dir, 'grouped-count.json'),
    });
    report('the grouped mode halts on its own ceiling as well', g.status === 3, `exit ${g.status}`);
    report('and it too presents nothing', !existsSync(gOut), gOut);
    return { receipt, existed: existsSync(receipt) };
  } finally {
    // Build conventions: no probe fixture outlives the check that created it.
    // The receipt is read by --count-before-present first, so the caller runs
    // both checks inside this same scope when both are requested.
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkCountBeforePresent(report, ceiling) {
  const dir = mkdtempSync(join(tmpdir(), 'rd-sweep-order-'));
  try {
    const receipt = join(dir, 'count.json');
    const out = join(dir, 'would-be-list.md');
    const r = runSweep(['--write', out, '--ceiling', '1'], { ROBOTDOJO_SWEEP_RECEIPT: receipt });
    report('the halted run still recorded its count', existsSync(receipt), receipt);
    if (!existsSync(receipt)) return;
    const rec = JSON.parse(readFileSync(receipt, 'utf8'));
    report('the recorded count is a real number, not a placeholder',
      Number.isInteger(rec.candidates) && rec.candidates > 0, `${rec.candidates}`);
    report('the receipt records that nothing was presented',
      rec.presented === false, JSON.stringify({ presented: rec.presented }));
    report('the receipt carries the timestamp of the count itself',
      typeof rec.counted_at === 'string' && !Number.isNaN(Date.parse(rec.counted_at)), `${rec.counted_at}`);
    report('the receipt states the ceiling it was judged against',
      rec.ceiling === 1 && rec.within_ceiling === false, JSON.stringify({ ceiling: rec.ceiling }));
    report('and the run that produced it presented nothing', !existsSync(out), '');
    report('the halt was reported to the caller, not swallowed', r.status === 3, `exit ${r.status}`);

    // The real run, at the real ceiling, records its count before the document.
    const realReceipt = join(dir, 'real-count.json');
    const realOut = join(dir, 'real-list.md');
    const real = runSweep(['--write', realOut, '--ceiling', String(ceiling)], {
      ROBOTDOJO_SWEEP_RECEIPT: realReceipt,
    });
    report('the real run completes inside the ceiling', real.status === 0, `exit ${real.status}: ${real.stderr.trim()}`);
    if (real.status === 0 && existsSync(realReceipt)) {
      const rr = JSON.parse(readFileSync(realReceipt, 'utf8'));
      report('its count was taken before the document was presented',
        Date.parse(rr.counted_at) <= Date.parse(rr.presented_at || rr.counted_at),
        `counted ${rr.counted_at}, presented ${rr.presented_at}`);
      report('its recorded count equals the number of rows it presented',
        rr.candidates === readDocument(realOut).rows.length,
        `${rr.candidates} recorded vs ${readDocument(realOut).rows.length} rows`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkNoWrites(report) {
  const before = git(['status', '--porcelain']).stdout;
  const dir = mkdtempSync(join(tmpdir(), 'rd-sweep-writes-'));
  try {
    const r = runSweep(['--write', join(dir, 'list.md')], { ROBOTDOJO_SWEEP_RECEIPT: join(dir, 'count.json') });
    report('the sweep ran', r.status === 0, `exit ${r.status}: ${r.stderr.trim()}`);
    const after = git(['status', '--porcelain']).stdout;
    report('it changed nothing in the working tree', before === after,
      after.split('\n').filter((l) => !before.includes(l)).join(' | '));

    // It refuses to be pointed at a publishable path — and the probe target is
    // config/publication-manifest.json ON PURPOSE. That file was UNTRACKED while
    // this story was building it, and the first version of the guard tested
    // "is it tracked", so it let the write through and 215 real names landed in
    // a config file bound for the public repository. A porcelain comparison did
    // not notice, because an untracked file reads the same before and after. So
    // the assertion is on the file's CONTENT.
    const probe = join(REPO_ROOT, 'config', 'publication-manifest.json');
    const digestOf = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'absent');
    const probeBefore = digestOf(probe);
    const refused = runSweep(['--write', 'config/publication-manifest.json'], {
      ROBOTDOJO_SWEEP_RECEIPT: join(dir, 'count2.json'),
    });
    report('it refuses to write the candidate list into a publishable path',
      refused.status === 2 && /REFUSED/.test(refused.stderr), `exit ${refused.status}`);
    report('and the file it was aimed at is byte-identical afterwards',
      digestOf(probe) === probeBefore, `${probeBefore} -> ${digestOf(probe)}`);
    report('the refusal left the rest of the tree untouched',
      before === git(['status', '--porcelain']).stdout, '');

    // Positive control: the guard must still ALLOW the gitignored story
    // directory, or "refuses everything" would pass every assertion above.
    const allowed = join(dirname(STORY_DOC), '.sweep-guard-probe.md');
    const ok = runSweep(['--write', allowed], { ROBOTDOJO_SWEEP_RECEIPT: join(dir, 'count3.json') });
    report('it still writes to the gitignored story directory', ok.status === 0 && existsSync(allowed),
      `exit ${ok.status}: ${ok.stderr.trim().split('\n')[0] || ''}`);
    rmSync(allowed, { force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Owner decision 10 — "List every entry." Every entry of the three small
 * reference files must appear in the document as its own row.
 *
 * The entries are re-read HERE, from the files, rather than taken from the
 * sweep's own enumeration. A check fed by the thing it is checking passes
 * whenever that thing is self-consistent, including when it is consistently
 * wrong — un-skipping the files surfaced six of 209 and looked fine.
 */
function checkEnumerated(report) {
  const doc = readDocument(STORY_DOC);
  if (!doc.ok) {
    report('the candidate document exists', false, doc.reason);
    return;
  }
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const present = new Set(doc.rows.map((r) => norm(r.term)));
  const read = (f) => JSON.parse(readFileSync(join(REPO_ROOT, f), 'utf8'));

  const files = [
    { path: 'config/big-tech-domains.json', terms: (read('config/big-tech-domains.json').companies || []).map((c) => c.name) },
    { path: 'config/vc-firms-domains.json', terms: (read('config/vc-firms-domains.json').firms || []).map((f) => f.name) },
    {
      path: 'config/service-vendor-keywords.json',
      terms: (() => {
        const s = read('config/service-vendor-keywords.json');
        return [...(s.general || []), ...(s.audited || [])];
      })(),
    },
  ];
  for (const f of files) {
    const missing = f.terms.filter((t) => !present.has(norm(t)));
    report(`every one of the ${f.terms.length} entries of ${f.path} is listed`,
      missing.length === 0,
      `${missing.length} missing: ${missing.slice(0, 8).join(', ')}`);
  }
  const total = files.reduce((n, f) => n + f.terms.length, 0);
  report(`all ${total} reference entries are enumerated, not just the ones something matched`,
    files.every((f) => f.terms.every((t) => present.has(norm(t)))), '');
}

function checkDecisions(report) {
  const doc = readDocument(STORY_DOC);
  if (!doc.ok) {
    report('the candidate document exists', false, doc.reason);
    return;
  }
  const undecided = doc.rows.filter((r) => !r.effective);
  report('every candidate carries a recorded owner decision',
    undecided.length === 0,
    undecided.length
      ? `${undecided.length} of ${doc.rows.length} rows have no decision, their own or their group's — the `
        + 'owner has not decided yet. This check is meant to fail until he has. Undecided groups: '
        + `${[...new Set(undecided.map((r) => r.group))].join('; ')}`
      : '');
  const invalid = doc.rows.filter((r) => r.effective && !DECISION_WORDS.includes(r.effective.toLowerCase()));
  report('every decision is one of the words the document offers',
    invalid.length === 0,
    invalid.map((r) => `${r.term}: "${r.effective}"`).slice(0, 10).join(', '));

  const replaced = doc.rows.filter((r) => r.effective.toLowerCase() === 'replace');
  if (replaced.length === 0) {
    report('every "replace" decision has a matching edit in the build diff', undecided.length === 0,
      undecided.length ? 'no decisions recorded yet' : 'no replace decisions to check');
    return;
  }
  // A replaced term must no longer appear in the tracked tree. `git grep -F -i`
  // over the index: the working tree is not what ships.
  const stillThere = replaced.filter((r) => git(['grep', '-q', '-F', '-i', '-e', r.term]).status === 0);
  report('every "replace" decision has a matching edit in the build diff',
    stillThere.length === 0,
    stillThere.map((r) => r.term).slice(0, 10).join(', '));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const valueOf = (f) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] || null : null;
  };
  const ceiling = Number.parseInt(valueOf('--ceiling') || '400', 10);

  let failures = 0;
  const report = (label, pass, detail) => {
    if (!pass) failures += 1;
    process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'}  ${label}\n`);
    if (!pass && detail) process.stdout.write(`          ${detail}\n`);
  };

  const requested = ['--assert-swept-set', '--non-empty', '--enumerated', '--demonstrate-halt', '--count-before-present', '--no-writes', '--decisions'].filter(has);
  if (requested.length === 0) {
    process.stderr.write(
      'sweep-decisions-proof: usage —\n'
        + '  --assert-swept-set\n'
        + '  --non-empty\n'
        + '  --enumerated\n'
        + '  --ceiling <n> --demonstrate-halt\n'
        + '  --count-before-present\n'
        + '  --no-writes\n'
        + '  --decisions\n'
    );
    return 2;
  }

  process.stdout.write('sweep-decisions-proof (AC5):\n');
  if (has('--assert-swept-set')) checkSweptSet(report);
  if (has('--non-empty')) checkNonEmpty(report);
  if (has('--enumerated')) checkEnumerated(report);
  if (has('--demonstrate-halt')) checkCeiling(report, ceiling);
  if (has('--count-before-present')) checkCountBeforePresent(report, ceiling);
  if (has('--no-writes')) checkNoWrites(report);
  if (has('--decisions')) checkDecisions(report);

  if (failures > 0) {
    process.stderr.write(`sweep-decisions-proof: ${failures} check(s) failed.\n`);
    return 1;
  }
  process.stdout.write('sweep-decisions-proof: every requested property holds.\n');
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`sweep-decisions-proof: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}

export { readDocument, CRITERION_CARVE_OUTS, STORY_DOC };
