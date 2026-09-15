#!/usr/bin/env node
/**
 * residual-completeness-proof.js — AC19 (st_dd0e19d8 Phase 7).
 *
 * AC19 is the criterion the owner actually reads the output of: "everything that
 * remains uncertain is written in plain words rather than implied to be zero."
 * A document can satisfy that sentence by looking thorough, so this proof checks
 * the two things that cannot be faked by tone.
 *
 *   THE SIX CLASSES ARE ALL THERE. Not five with the awkward one merged into a
 *   neighbour. Each is matched by its own subject, not by a heading number.
 *
 *   THE NUMBERS ARE RE-DERIVED, NOT READ BACK. Class 5 is the only countable
 *   class, and its counts are the sizes of the dictionaries the gate excludes
 *   from its own scan. This proof reads those files from disk, counts them, and
 *   requires the document to carry the count it just computed. A residual that
 *   quotes a stale number is worse than one that quotes none: it reads as
 *   measured and is not. The sealed scope's own figure is the existence proof —
 *   it said seven excluded configuration files and there are nine.
 *
 * AND WHAT MUST *NOT* BE THERE. Classes 1-4 are uncountable by construction, so
 * each must carry a stated ceiling WITH its reason and must not carry a
 * fabricated total. Class 6 must say "unmeasured" and must name appetite as the
 * reason — writing "the overlap is probably small" there would be the exact
 * comfortable falsehood the criterion forbids.
 *
 * MODES: the flags name the properties rather than switching them on, so the
 * command in the plan reads as the assertion it makes. Every property is checked
 * on every run.
 *
 * Exit 0 = the residual says what it must and measures what it claims.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPostureTable, skipPaths } from '../../lib/publication-posture.js';
import { PIPELINE_STORIES_DIR } from '../../lib/robotdojo-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CONFIG_DIR = join(REPO_ROOT, 'config');
const RESIDUAL_FILE = '05-residual.md';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

/**
 * The six classes AC19 enumerates, each matched by the SUBJECT it must discuss
 * rather than by a heading number — a document that renumbers its sections still
 * passes, and one that quietly drops a class does not.
 */
const CLASSES = [
  {
    n: 1,
    subject: 'a real person absent from the owner\'s records',
    must: [/never (?:met|stored)|nowhere in your records|absent from (?:your|his) (?:data|records)/i],
    kind: 'ceiling',
  },
  {
    n: 2,
    subject: 'a name that reached the list and was not recognised',
    must: [/did not recognise|you did not recognise|not recognise/i],
    kind: 'ceiling',
  },
  {
    n: 3,
    subject: 'a place or company under the same ceiling',
    must: [/place or company/i],
    kind: 'ceiling',
  },
  {
    n: 4,
    subject: 'a credential in a shape the pattern list does not describe',
    must: [/credential/i, /shape nobody described|form nobody|nobody enumerated|nobody described/i],
    kind: 'ceiling',
  },
  {
    n: 5,
    subject: 'the self-excluded files that ship',
    must: [/cannot scan/i, /ship|published/i],
    kind: 'measured',
  },
  {
    n: 6,
    subject: 'a person in the records but only in a source no check reads',
    must: [/messages, emails, notes, transcripts|no check (?:looks|reads)/i],
    kind: 'unmeasured',
  },
];

/** A ceiling section must state a ceiling AND why no number exists. */
const CEILING = /\*\*the ceiling\.?\*\*|the ceiling[.,]/i;
const NO_COUNT = /cannot be counted|can it be counted\?\s*no|nothing to count|no number/i;

/** Resolve the residual: an explicit --file, else the single active story. */
function residualPath() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--file');
  if (i !== -1 && args[i + 1]) return resolve(args[i + 1]);
  let dirs = [];
  try {
    dirs = readdirSync(PIPELINE_STORIES_DIR).filter((d) => /^(st|df)_/.test(d));
  } catch {
    return null;
  }
  const active = dirs
    .map((d) => {
      try {
        return { d, meta: JSON.parse(readFileSync(join(PIPELINE_STORIES_DIR, d, 'meta.json'), 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter((x) => x && x.meta.stage && !['done', 'close-complete', 'cancelled', 'archived', 'absorbed'].includes(x.meta.stage))
    .filter((x) => existsSync(join(PIPELINE_STORIES_DIR, x.d, RESIDUAL_FILE)));
  if (active.length !== 1) return null;
  return join(PIPELINE_STORIES_DIR, active[0].d, RESIDUAL_FILE);
}

/** Split the document into sections at `## ` headings. */
function sections(text) {
  const out = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (/^## /.test(line)) {
      if (current) out.push(current);
      current = { heading: line.replace(/^##\s*/, ''), body: '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) out.push(current);
  return out;
}

/**
 * The countable half, re-derived. Every path the posture table excludes from the
 * scan, that is tracked and therefore ships, with its entry count where it is a
 * list. The gate's own source files have no entry count — they carry rules, not
 * data — and are counted separately.
 */
function selfExcluded() {
  const table = loadPostureTable(CONFIG_DIR);
  const configs = [];
  const code = [];
  // TRACKED, not merely present on disk. The class AC19 discloses is "files the
  // check cannot scan AND that ship" — a gitignored local override is excluded
  // from the scan for the same reason and ships with nothing, so counting it
  // would inflate the number the owner is asked to accept. Measured: the local
  // permitted list appears on disk the moment the first entry is written, and
  // counting by existence alone moved the figure from 9 to 10 with nothing
  // having been published.
  const tracked = new Set(
    spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      .stdout.split('\0')
      .filter(Boolean)
  );
  for (const path of skipPaths(table)) {
    const abs = join(REPO_ROOT, path);
    if (!existsSync(abs) || !tracked.has(path)) continue;
    if (!path.startsWith('config/')) {
      code.push(path);
      continue;
    }
    let entries = null;
    try {
      const parsed = JSON.parse(readFileSync(abs, 'utf8'));
      if (Array.isArray(parsed)) entries = parsed.length;
      else {
        const lists = Object.entries(parsed).filter(([k]) => !k.startsWith('_'));
        // A dictionary keyed by term (surnames, nicknames) counts its keys; one
        // holding a single named list counts that list.
        const onlyList = lists.length === 1 && Array.isArray(lists[0][1]) ? lists[0][1].length : null;
        const onlyMap = lists.length === 1 && lists[0][1] && typeof lists[0][1] === 'object' && !Array.isArray(lists[0][1])
          ? Object.keys(lists[0][1]).length
          : null;
        // Several named lists in one file (a general set plus an audited set)
        // count as their sum — that is the number a reader of the file counts.
        const summed = lists.length > 1 && lists.every(([, v]) => Array.isArray(v))
          ? lists.reduce((n, [, v]) => n + v.length, 0)
          : null;
        entries = onlyList ?? onlyMap ?? summed ?? (lists.every(([, v]) => !Array.isArray(v) && typeof v !== 'object')
          ? lists.length
          : Object.keys(parsed).filter((k) => !k.startsWith('_')).length);
      }
    } catch {
      entries = null;
    }
    configs.push({ path, entries });
  }
  return { configs, code };
}

/**
 * Is `n` present in the text? Digits, thousands-separated digits, or — for the
 * small counts a plain-English paragraph spells out — the word. The document is
 * written for the owner to read, and forcing "9" where "nine" belongs would make
 * the proof shape the prose rather than check it.
 */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
function statesNumber(text, n) {
  const bare = String(n);
  const grouped = bare.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const forms = [bare, grouped];
  if (n <= 20) forms.push(WORDS[n]);
  return new RegExp(`\\b(?:${forms.join('|')})\\b`, 'i').test(text);
}

function main() {
  const path = residualPath();
  if (!path || !existsSync(path)) {
    process.stderr.write(
      `residual-completeness-proof: no ${RESIDUAL_FILE} found. Pass --file <path>, or run with exactly `
        + 'one active story that has one.\n'
    );
    return 1;
  }
  const text = readFileSync(path, 'utf8');
  const secs = sections(text);
  process.stdout.write(`residual-completeness-proof: ${path}\n  ${secs.length} sections, ${text.length} chars\n\n`);

  process.stdout.write('AC19 — all six classes, named\n');
  const matched = new Map();
  for (const cls of CLASSES) {
    const hit = secs.find((s) => cls.must.every((re) => re.test(`${s.heading}\n${s.body}`)));
    check(`class ${cls.n} — ${cls.subject}`, !!hit, hit ? `“${hit.heading}”` : 'not found');
    if (hit) matched.set(cls.n, hit);
  }

  process.stdout.write('\nAC19 — classes 1-4 state a ceiling and why no count exists\n');
  for (const cls of CLASSES.filter((c) => c.kind === 'ceiling')) {
    const hit = matched.get(cls.n);
    if (!hit) continue;
    check(
      `class ${cls.n} states its ceiling with a reason, not a number`,
      CEILING.test(hit.body) && NO_COUNT.test(hit.body),
      'an invented total would read as measured and would not be'
    );
  }

  process.stdout.write('\nAC19 — class 5 carries the sizes this run just measured\n');
  const { configs, code } = selfExcluded();
  const five = matched.get(5);
  if (five) {
    check(
      'the count of self-excluded configuration files is the re-derived one',
      statesNumber(five.body, configs.length),
      `${configs.length} configuration files ship self-excluded`
    );
    check(
      'the gate\'s own source files are counted too, not silently omitted',
      statesNumber(five.body, code.length),
      `${code.length} code files ship self-excluded`
    );
    for (const c of configs) {
      if (c.entries === null || c.entries < 5) continue; // no meaningful size to state
      check(
        `  ${c.path} — ${c.entries} entries, stated`,
        statesNumber(five.body, c.entries),
        'a size quoted from memory is a size that goes stale'
      );
    }
  }

  process.stdout.write('\nAC19 — class 6 says unmeasured, and says why\n');
  const six = matched.get(6);
  if (six) {
    check('it says "unmeasured"', /unmeasured/i.test(six.body));
    check(
      'and names appetite — not coverage — as the reason',
      /appetite/i.test(six.body) && /not (?:coverage|small)/i.test(six.body),
      '"probably small" would be the comfortable falsehood the criterion forbids'
    );
  }

  const failures = results.filter((r) => !r.ok);
  process.stdout.write(`\nresidual-completeness-proof: ${results.length - failures.length}/${results.length} PASS\n`);
  return failures.length === 0 ? 0 : 1;
}

process.exit(main());
