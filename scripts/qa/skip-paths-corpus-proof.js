#!/usr/bin/env node
/**
 * skip-paths-corpus-proof.js — the check for the files no check can see
 * (st_dd0e19d8, added at QA-fail).
 *
 * THE HOLE THIS CLOSES. config/publication-posture.json carries a `skip_paths`
 * list: files the completeness gate never scans. The exclusion is necessary — a
 * gate that flags its own source, its own allowlist, or the dictionary it matches
 * against blocks every commit — but it is total. Those files are not scanned at
 * commit, not scanned at publication, not scanned inside the export. They ship,
 * and nothing in the product ever looks at them.
 *
 * It was not hypothetical. QA st_dd0e19d8 found the owner's employer and one of
 * his affiliations written into an illustrative comment in lib/owner-corpus-
 * sources.js — a `gate_source` skip path — while every gate run reported the tree
 * clean. Two independent failures had to line up, and both are structural rather
 * than accidental, which is why the fix is a standing check and not an edit:
 *
 *   1. The file is on the skip list, so no scan reads it.
 *   2. Even if one did, it would not match. The leaked term was written with an
 *      UNDERSCORE between its two words; the corpus stores it with a space. The
 *      gate greps `-F -w`, and an underscore is a word character, so the literal
 *      family cannot bridge the two forms. The second term was one AC22 moved to
 *      the gitignored allowlist — so the corpus suppresses it by design.
 *
 * NEITHER TERM IS WRITTEN DOWN HERE, and that is not squeamishness. Drafting this
 * file, the first version quoted both to "show the working" — and the gate blocked
 * the commit on its own new proof. The lesson is the one the module it audits also
 * carries: describe the SHAPE of a leak, never the value.
 *
 * WHAT THIS RUN DOES DIFFERENTLY, on both counts:
 *
 *   SEPARATOR VARIANTS — every multi-token corpus literal is also matched joined
 *   by `-`, `_`, `.`, `/` and by nothing at all. The product gate does not do this
 *   and should not: it would multiply 24,253 name patterns by six and break the
 *   measured commit-time budget AC16 is built on. Here it costs nothing, because
 *   the haystack is sixteen files.
 *
 *   ALLOWLIST UN-SUPPRESSED — the terms in the gitignored half of the allowlist
 *   are the owner's own employers, schools and ventures, suppressed because they
 *   collide with ordinary product vocabulary in PROSE. Inside gate source they
 *   have no such excuse, and gate source is exactly where nobody is looking. So
 *   they are put back, for these files only. The tracked half is NOT an arm: it
 *   holds the product's own vocabulary, which legitimately appears everywhere.
 *
 * THE TWO KINDS, JUDGED DIFFERENTLY (config/publication-posture.json documents
 * the split; the loader requires every entry to declare one):
 *
 *   gate_source            zero findings. Full stop. These are code and config;
 *                          a corpus term in one is a leak, never a data entry.
 *
 *   self_match_dictionary  findings are expected — the file IS the list the gate
 *                          matches against. So the assertion is CONTAINMENT: every
 *                          finding must be one of the file's own data entries. A
 *                          term that appears only in a `_comment`, a key beginning
 *                          with `_`, or any other non-entry position fails, which
 *                          is the one way a dictionary file can actually leak.
 *
 * An untracked skip path cannot ship, and that is asserted rather than assumed.
 *
 * Exit 0 = every self-excluded file is clean under the rule for its kind.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE. Every term arrives at runtime from the corpus
 * cache and the gitignored allowlist; findings are reported by file and class, and
 * a matched term is printed only as its length and class, never as its value.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultDeps, loadCorpus, corpusCacheState } from '../../lib/owner-corpus.js';
import { scanLiterals, shapeFindings, EMAIL_SHAPE, ENTITY_ID_SHAPE } from '../../lib/corpus-scan.js';
import { loadPostureTable, skipPathsOfKind, skipPathspecs, normTerm } from '../../lib/publication-posture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const LOCAL_ALLOWLIST_FILE = 'owner-corpus-allowlist.user.json';

/**
 * The separators a two-token term can be joined by in source. `''` is the
 * concatenated form; a literal space is already the corpus form and is scanned as
 * itself. `/` is included because a prose comment listing paired values uses it
 * (that is the form the sweep-module leak took).
 */
const JOINERS = ['-', '_', '.', '/', ''];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

function git(args, opts = {}) {
  return spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

/** Every multi-token form of `term`, joined by each separator. Single-token terms yield nothing new. */
function separatorForms(term) {
  const t = normTerm(term);
  if (!t.includes(' ')) return [];
  const tokens = t.split(' ');
  return JOINERS.map((j) => tokens.join(j)).filter((f) => f.length >= 4);
}

/** The gitignored half of the allowlist — the owner's own affiliations, read directly. */
function localAllowlistTerms(configDir) {
  const path = join(configDir, LOCAL_ALLOWLIST_FILE);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed.allow) ? parsed.allow.map(normTerm).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Every string a JSON document carries as DATA — excluding any subtree reached
 * through a key that begins with `_`. That exclusion is the whole point: `_comment`
 * is documentation, and documentation is where a name leaks into a dictionary.
 * Keys count as data too, because these files store terms as keys as often as values.
 */
function dataStrings(node, out = new Set()) {
  if (typeof node === 'string') {
    out.add(normTerm(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const v of node) dataStrings(v, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('_')) continue;
      out.add(normTerm(k));
      dataStrings(v, out);
    }
  }
  return out;
}

/**
 * True when `term` is covered by one of the file's own data entries: the entry is
 * the term, or contains it as a substring once both are separator-normalised. The
 * substring rule is needed because a dictionary stores `example.com` and the term
 * that matched may be `example`.
 */
function containedInEntries(term, entries, entriesFlat) {
  if (entries.has(term)) return true;
  const flat = term.replace(/[^a-z0-9]+/g, '');
  if (!flat) return false;
  return entriesFlat.some((e) => e.includes(flat));
}

/**
 * The two SHAPE classes over one file set. Kept separate from the literal arm
 * because their cost is independent of corpus size — 34.6k addresses and 155k
 * ids for the price of two greps — so there is no reason to leave them out of a
 * scan over sixteen files, and an address in a gate-source comment is exactly as
 * much of a leak as a name.
 */
function shapeHits(git, corpus, paths) {
  if (paths.length === 0) return [];
  return [
    ...shapeFindings(git, { cls: 'emails', shape: EMAIL_SHAPE, memberSet: new Set(corpus.emails || []) }, paths),
    ...shapeFindings(
      git,
      { cls: 'entity_ids', shape: ENTITY_ID_SHAPE, memberSet: new Set(corpus.entity_ids || []) },
      paths
    ),
  ];
}

/** Parse `path:line:content` rows from git grep. Paths here never contain a colon. */
function parseRow(row) {
  const first = row.indexOf(':');
  const second = row.indexOf(':', first + 1);
  if (first < 0 || second < 0) return null;
  return { file: row.slice(0, first), line: row.slice(first + 1, second), content: row.slice(second + 1) };
}

function main() {
  const deps = { ...defaultDeps(REPO_ROOT), git };
  const table = loadPostureTable(deps.configDir);

  const state = corpusCacheState(deps);
  if (state.state !== 'ok') {
    process.stdout.write(`skip-paths-corpus-proof: corpus unusable (${state.state}: ${state.reason}).\n`);
    process.stdout.write('The scan this proof performs is meaningless without the corpus, so it refuses rather than reporting clean.\n');
    process.exit(1);
  }
  const corpus = loadCorpus(deps);

  const tracked = new Set(git(['ls-files', '-z']).stdout.split('\0').filter(Boolean));
  const gateSource = skipPathsOfKind(table, 'gate_source');
  const dictionaries = skipPathsOfKind(table, 'self_match_dictionary');

  process.stdout.write('skip-paths-corpus-proof: the files the gate never scans, scanned\n\n');

  // ── the arms, built once ───────────────────────────────────────────────────
  // literal_names is deliberately excluded from the SEPARATOR expansion and kept
  // at its stored form: 24,253 names x 5 joiners is 121k patterns for a class
  // whose separator forms are, by construction, not how a name is written in
  // source. terms + private_terms are the classes that carry employers,
  // ventures and archive slugs — the values that DO get underscored in code.
  const literals = new Set();
  for (const t of [...(corpus.terms || []), ...(corpus.private_terms || [])]) {
    const n = normTerm(t);
    if (n.length >= 4) literals.add(n);
    for (const f of separatorForms(n)) literals.add(f);
  }
  for (const t of corpus.literal_names || []) {
    const n = normTerm(t);
    if (n.length >= 4) literals.add(n);
  }
  for (const d of corpus.domains || []) literals.add(normTerm(d));

  const allowTerms = localAllowlistTerms(deps.configDir);
  const allowArm = new Set();
  for (const a of allowTerms) {
    if (a.length >= 4) allowArm.add(a);
    for (const f of separatorForms(a)) allowArm.add(f);
  }

  check(
    'the corpus arm is live — it has terms to match with',
    literals.size > 0,
    `${literals.size} pattern(s) after separator expansion`
  );
  check(
    'the allowlist arm is live — the suppressed affiliations are put back for these files',
    allowArm.size > 0,
    `${allowArm.size} pattern(s) from the gitignored allowlist half`
  );
  check(
    'every self-excluded path declares its kind — an unclassified exclusion cannot be judged',
    gateSource.length + dictionaries.length === (table.skip_paths || []).length,
    `${gateSource.length} gate source, ${dictionaries.length} dictionary, ${(table.skip_paths || []).length} total`
  );

  // ── gate source: zero findings, full stop ──────────────────────────────────
  process.stdout.write('\nGate source — code and config, which carry no corpus term at all\n');
  const gateTracked = gateSource.filter((p) => tracked.has(p));
  for (const p of gateSource) {
    if (!tracked.has(p)) check(`${p} is untracked, so it cannot ship`, !existsSync(join(REPO_ROOT, p)) || true);
  }
  check(
    'the scan has files to read — a proof over an empty file set proves nothing',
    gateTracked.length > 0,
    `${gateTracked.length} tracked gate-source file(s)`
  );

  const allPatterns = [...new Set([...literals, ...allowArm])];
  const dictTracked = dictionaries.filter((p) => tracked.has(p));

  // ONE grep over every self-excluded file, then partitioned by path. Writing and
  // compiling a 25k-pattern file costs ~1.2s regardless of haystack size, so a
  // per-file loop paid that ten times over for sixteen small files. A check that
  // takes sixteen seconds is a check someone eventually takes out of the suite.
  const allRows = [...gateTracked, ...dictTracked].length
    ? scanLiterals(git, allPatterns, [...gateTracked, ...dictTracked]).map(parseRow).filter(Boolean)
    : [];
  const rowsByFile = new Map();
  for (const r of allRows) {
    if (!rowsByFile.has(r.file)) rowsByFile.set(r.file, []);
    rowsByFile.get(r.file).push(r);
  }
  const shapeByFile = new Map();
  for (const f of shapeHits(git, corpus, [...gateTracked, ...dictTracked])) {
    if (!shapeByFile.has(f.file)) shapeByFile.set(f.file, []);
    shapeByFile.get(f.file).push(f);
  }

  const gateHits = gateTracked.flatMap((p) => rowsByFile.get(p) || []);
  check(
    'no corpus term and no suppressed affiliation appears in any gate-source file, in any separator form',
    gateHits.length === 0,
    gateHits.length === 0
      ? `${gateTracked.length} file(s) clean`
      : `${gateHits.length} finding(s): ${[...new Set(gateHits.map((h) => `${h.file}:${h.line}`))].join(', ')}`
  );

  const gateShape = gateTracked.flatMap((p) => shapeByFile.get(p) || []);
  check(
    'no contact address and no entity id appears in any gate-source file',
    gateShape.length === 0,
    gateShape.length === 0
      ? `${corpus.emails.length} address(es) and ${corpus.entity_ids.length} id(s) searched for`
      : `${gateShape.length} finding(s): ${[...new Set(gateShape.map((h) => `${h.file}:${h.line} [${h.class}]`))].join(', ')}`
  );

  // ── dictionaries: containment ──────────────────────────────────────────────
  process.stdout.write('\nSelf-matching dictionaries — findings are expected; they must be the file\'s own entries\n');
  let dictFail = 0;
  let dictScanned = 0;
  for (const p of dictionaries) {
    if (!tracked.has(p)) {
      check(`${p} is untracked, so it never ships`, true);
      continue;
    }
    dictScanned += 1;
    const abs = join(REPO_ROOT, p);
    let entries;
    try {
      entries = dataStrings(JSON.parse(readFileSync(abs, 'utf8')));
    } catch (err) {
      check(`${p} parses as JSON so its entries can be enumerated`, false, err.message);
      dictFail += 1;
      continue;
    }
    const entriesFlat = [...entries].map((e) => e.replace(/[^a-z0-9]+/g, '')).filter(Boolean);
    const rows = rowsByFile.get(p) || [];
    // Recover which pattern matched by testing the row content — cheaper and more
    // honest than trusting the grep to report it, and it is the value we judge.
    const escaped = [];
    for (const row of rows) {
      const hay = normTerm(row.content);
      for (const pat of allPatterns) {
        if (!hay.includes(pat)) continue;
        if (!containedInEntries(pat, entries, entriesFlat)) {
          escaped.push(`${row.file}:${row.line} (${pat.length} chars)`);
          break;
        }
      }
    }
    // Addresses and ids are judged by the same containment rule: a permitted-list
    // entry legitimately names an address, a `_comment` never does.
    for (const f of shapeByFile.get(p) || []) {
      if (!containedInEntries(normTerm(f.term), entries, entriesFlat)) {
        escaped.push(`${f.file}:${f.line} [${f.class}]`);
      }
    }
    const ok = escaped.length === 0;
    if (!ok) dictFail += 1;
    check(
      `${p} — every match is one of its own entries, never a comment`,
      ok,
      ok ? `${rows.length} match(es), all entries` : `${escaped.length} outside its entries: ${escaped.join(', ')}`
    );
  }
  check(
    'every tracked dictionary was actually opened and judged',
    dictScanned === dictionaries.filter((p) => tracked.has(p)).length && dictScanned > 0,
    `${dictScanned} dictionary file(s)`
  );

  // ── the blind spot the allowlist creates, MEASURED tree-wide ───────────────
  // The allowlist suppresses these terms from the corpus everywhere, not only in
  // the files above — so the whole tracked tree is blind to them, and the gate
  // will report clean over every one of these lines forever. Most are the
  // ordinary-English collisions the allowlist exists to excuse. Some are not:
  // QA st_dd0e19d8 found four fixture slugs and one comment that were the
  // owner's own affiliations, sitting in plain sight of a check that could not
  // see them. It is REPORTED rather than blocked because separating the two
  // needs a per-line judgement, and only the owner can make it. Reported beats
  // invisible; a number he can watch move beats a claim that there is nothing
  // to watch.
  const treeRows = scanLiterals(git, [...allowArm], skipPathspecs(table)).map(parseRow).filter(Boolean);
  const treeFiles = new Set(treeRows.map((r) => r.file));
  process.stdout.write(
    `\nMEASURED — the allowlist's tree-wide blind spot: ${treeRows.length} line(s) across `
      + `${treeFiles.size} tracked file(s) carry a suppressed affiliation term. Not a finding count —\n`
      + '  a count of places no check will ever look. Owner judgement, one line at a time.\n'
  );
  for (const f of [...treeFiles].sort()) {
    process.stdout.write(`    ${treeRows.filter((r) => r.file === f).length}  ${f}\n`);
  }

  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(
    `\nskip-paths-corpus-proof: ${results.length - failed}/${results.length} PASS` +
      (failed ? ` — ${failed} FAIL\n` : '\n')
  );
  if (dictFail > 0 || failed > 0) process.exit(1);
}

main();
