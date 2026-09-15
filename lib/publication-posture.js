/**
 * lib/publication-posture.js — the posture table and the permitted list
 * (st_dd0e19d8 Phase 2: AC15, AC16).
 *
 * WHAT THIS IS: the half of the completeness gate that decides what a finding
 * MEANS. lib/corpus-scan.js decides what is there; this module decides whether
 * being there fails the run. Keeping those apart is what lets AC15 (block at
 * publication) and AC16 (report at every commit) be the SAME check configured
 * twice instead of two checks that drift apart the first time one is edited.
 *
 *   posture(deps, class, path) -> 'block' | 'report' | 'skip'
 *   failed = findings.filter(f => posture(...) === 'block' && !f.permitted)
 *
 * THE TABLE IS DATA (config/publication-posture.json), NOT CODE. If a blocking
 * class ever produces a false positive on ordinary product vocabulary, the
 * recovery is one word in a JSON file — not an edit to a gate that is, at that
 * moment, blocking every commit the owner tries to make. That escape hatch is
 * the reason this file loads a table instead of declaring one.
 *
 * NO OWNER DATA LIVES IN THIS FILE. Classes and repo paths only; every term
 * arrives at runtime from the permitted list or the corpus.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 *
 * ── THE PERMITTED LIST, AND WHY IT IS TWO FILES ─────────────────────────────
 *
 * A permitted entry is a deliberate weakening of the gate, so it is scoped to a
 * TERM *and* a FILE and *and* a CLASS, never a bare term: FSE 2025 measured 50.8%
 * of suppressions in real projects as dead, and 59 cases where one dead
 * suppression silently hid 184+ later real warnings. A bare-term entry is exactly
 * that failure. Every entry also carries a required, non-empty `reason` — the
 * schema check rejects an entry without one — and every publication run DECAYS
 * entries that no longer match anything.
 *
 * THE FILE SPLIT IS A LEAK FIX, NOT ORGANISATION. The tracked list ships in the
 * published repository. An entry is `{term, file, class, reason}` — so a tracked
 * entry publishes both the term AND the statement that the term belongs to an
 * owner-corpus class. For the classes that exist only because a value is
 * owner-specific (Tier A terms, private-settings terms, employer domains, entity
 * ids, path terms) that annotation is itself the leak this story exists to
 * prevent: writing `{"term":"example.com","class":"domains"}` into a tracked file
 * states in public that the owner works there. Those classes are therefore
 * REFUSED in the tracked file and belong in the gitignored
 * config/publication-permitted.user.json, which never ships.
 *
 * The second guard is the NO-NEW-EXPOSURE rule: a tracked entry's term must
 * already appear, in cleartext, in the tracked file the entry names. An entry can
 * then never introduce an exposure the tree does not already have — and when the
 * leak is finally removed, the entry decays away on the next publication run.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  literalFindings,
  shapeFindings,
  pathFindings,
  buildTermIndex,
  ENTITY_ID_SHAPE,
  EMAIL_SHAPE,
} from './corpus-scan.js';

export const POSTURE_VALUES = ['block', 'report', 'skip'];
export const PLACEMENTS = ['staged', 'publish'];

/**
 * What a self-excluded path IS, which decides how the out-of-band proof judges it
 * (scripts/qa/skip-paths-corpus-proof.js).
 *
 *   gate_source            code/config the gate must not flag itself on. Carries no
 *                          corpus term at all; the proof asserts zero findings.
 *   self_match_dictionary  a list the gate matches AGAINST, so it flags its own
 *                          entries by construction. The proof asserts every finding
 *                          is one of the file's own DATA entries — a term in a
 *                          comment or any non-entry position still fails.
 *
 * REQUIRED on every entry, and that is the load-bearing part. These files are the
 * only ones the gate never reads, so a leak in one is invisible to every check the
 * product runs — QA st_dd0e19d8 found the owner's employer in a gate_source
 * comment after the gate reported the tree clean. Requiring the kind means a new
 * exclusion cannot be added without also being classified, and therefore cannot
 * escape the out-of-band scan by being forgotten.
 */
export const SKIP_PATH_KINDS = ['gate_source', 'self_match_dictionary'];

export const POSTURE_FILE = 'publication-posture.json';
export const PERMITTED_FILE = 'publication-permitted.json';
export const PERMITTED_LOCAL_FILE = 'publication-permitted.user.json';

/**
 * Classes whose very membership is owner-identifying, so naming one in a TRACKED
 * file publishes the association. These may only be permitted in the gitignored
 * local half. `emails` and `literal_names` are deliberately absent: both are
 * mixed — the product's own public support address is an `emails` member, and a
 * public brand is a `literal_names` member — so the class cannot decide, and the
 * no-new-exposure rule plus the written reason carry it instead.
 */
export const LOCAL_ONLY_CLASSES = new Set(['terms', 'private_terms', 'domains', 'entity_ids', 'paths']);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Comparison form: lower-cased, whitespace-collapsed. Matches lib/owner-corpus-sources norm(). */
export function normTerm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

// ── posture table ────────────────────────────────────────────────────────────

/**
 * Validate a posture table. Returns an array of human-readable errors; empty
 * means sound. Keys beginning with `_` are documentation and are ignored.
 *
 * A malformed table must never silently degrade to "everything reports" — that
 * is a gate that has stopped gating. Callers treat a non-empty result as fatal.
 */
export function validatePostureTable(table) {
  const errors = [];
  if (!table || typeof table !== 'object') return ['posture table is absent or not an object'];
  if (!table.classes || typeof table.classes !== 'object') {
    errors.push('posture table has no "classes" object');
  } else {
    for (const [cls, row] of Object.entries(table.classes)) {
      if (cls.startsWith('_')) continue;
      if (!row || typeof row !== 'object') {
        errors.push(`class "${cls}" is not an object`);
        continue;
      }
      for (const placement of PLACEMENTS) {
        const v = row[placement];
        if (!POSTURE_VALUES.includes(v)) {
          errors.push(
            `class "${cls}" placement "${placement}" is ${JSON.stringify(v)}; expected one of ${POSTURE_VALUES.join('/')}`
          );
        }
      }
    }
  }
  if (!Array.isArray(table.skip_paths)) {
    errors.push('posture table has no "skip_paths" array');
  } else {
    for (const entry of table.skip_paths) {
      if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) {
        errors.push(`skip_paths entry ${JSON.stringify(entry)} has no path`);
      } else if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
        // AC19 requires the exclusions be STATED, not merely applied.
        errors.push(`skip_paths entry "${entry.path}" has no reason`);
      } else if (!SKIP_PATH_KINDS.includes(entry.kind)) {
        // Fail CLOSED on an unclassified exclusion. An entry with no kind is a
        // file the gate stops scanning and the out-of-band proof does not know
        // how to judge — the exact gap that let a leak ship (see SKIP_PATH_KINDS).
        errors.push(
          `skip_paths entry "${entry.path}" has kind ${JSON.stringify(entry.kind)}; expected one of ${SKIP_PATH_KINDS.join('/')}`
        );
      }
    }
  }
  return errors;
}

/** Load and validate the posture table. Throws on a malformed table — see above. */
export function loadPostureTable(configDir) {
  const path = join(configDir, POSTURE_FILE);
  const table = readJson(path);
  const errors = validatePostureTable(table);
  if (errors.length > 0) {
    throw new Error(`posture table ${path} is unusable:\n  ${errors.join('\n  ')}`);
  }
  return table;
}

/** The set of repo-relative paths the gate never scans. */
export function skipPaths(table) {
  return new Set((table.skip_paths || []).map((e) => e.path));
}

/**
 * The self-excluded paths of one kind, in table order. The out-of-band proof
 * judges the two kinds by different rules (see SKIP_PATH_KINDS), and it reads the
 * split from the table rather than re-deriving it from filenames — a path-shape
 * heuristic would silently reclassify the next entry someone adds.
 */
export function skipPathsOfKind(table, kind) {
  return (table.skip_paths || []).filter((e) => e.kind === kind).map((e) => e.path);
}

/**
 * The same set expressed as git pathspec exclusions, so the grep never reads
 * them in the first place. DERIVED from skip_paths rather than maintained
 * separately: one list, one meaning, and the run summary can state it.
 */
export function skipPathspecs(table) {
  return (table.skip_paths || []).map((e) => `:!${e.path}`);
}

/**
 * The posture of a whole class in a placement, independent of any path. This is
 * the question the scanner asks BEFORE scanning: a `skip` class is not scanned at
 * all, which is where the commit-time budget is actually saved.
 */
export function classPosture({ table, placement }, cls) {
  const row = table.classes && table.classes[cls];
  if (!row) return 'block'; // fail closed: an unknown class is not a licence to pass
  return row[placement] || 'block';
}

/**
 * The posture of one finding: `skip` when the path is self-excluded, otherwise
 * the class posture. The design's two-argument `posture(class, path)` is this
 * function with its deps bound (build-conventions: logic in lib/ as named
 * `(deps, ...params)` functions).
 */
export function posture(deps, cls, path) {
  if (path && deps.skip && deps.skip.has(path)) return 'skip';
  return classPosture(deps, cls);
}

// ── running the scan under a posture ─────────────────────────────────────────

/**
 * The literal-family classes, in report order. `entity_ids` and `emails` use the
 * shape family and `paths` matches filenames, so each is dispatched explicitly
 * below rather than through a family lookup table — three branches read more
 * plainly than an indirection that has exactly three entries.
 */
export const LITERAL_CLASSES = ['terms', 'private_terms', 'domains', 'literal_names'];

/**
 * Run every non-skipped class over `pathspecs` and return ONE findings list where
 * each finding carries its class (design §2.1). The old shape — a `violations`
 * array and an `advisories` array that nothing could reconcile — is what made
 * AC15 and AC16 two checks that could drift; this is one check, and the posture
 * table decides at report time what each finding means.
 *
 * THIS LIVES IN lib/ AND HAS EXACTLY ONE IMPLEMENTATION on purpose: the
 * commit-time gate and the permitted-list counter both call it. A second copy in
 * the second facade would agree on the day it was written and disagree the first
 * time a class was added to one of them — and the disagreement would show up as a
 * permitted-entry count that does not match what the gate actually blocks on.
 *
 * `pathFiles` is separate from `pathspecs` because the path family matches
 * filenames, not file contents, so it takes a file list rather than a grep scope.
 *
 * A class the table marks `skip` is NOT SCANNED — that is where the commit-time
 * budget is kept, not merely where its output is suppressed.
 */
export function collectFindings(deps, corpus, { pathspecs, pathFiles, untracked = false } = {}) {
  const { git } = deps;
  const findings = [];
  const skipped = [];
  const scanned = [];
  const isOn = (cls) => {
    const p = classPosture(deps, cls);
    (p === 'skip' ? skipped : scanned).push(cls);
    return p !== 'skip';
  };

  if (pathspecs) {
    for (const cls of LITERAL_CLASSES) {
      if (!isOn(cls)) continue;
      const patterns = corpus[cls] || [];
      if (patterns.length === 0) continue;
      findings.push(
        ...literalFindings(git, { cls, patterns, index: buildTermIndex(patterns) }, pathspecs, { untracked })
      );
    }
    // SHAPE classes: one structural grep each, then a Set intersection. Cost is
    // independent of corpus size, so both stay affordable in every placement.
    if (isOn('entity_ids')) {
      findings.push(
        ...shapeFindings(
          git,
          { cls: 'entity_ids', shape: ENTITY_ID_SHAPE, memberSet: new Set(corpus.entity_ids || []) },
          pathspecs,
          { untracked }
        )
      );
    }
    if (isOn('emails')) {
      findings.push(
        ...shapeFindings(
          git,
          { cls: 'emails', shape: EMAIL_SHAPE, memberSet: new Set(corpus.emails || []) },
          pathspecs,
          { untracked }
        )
      );
    }
  }

  // PATH family: an employer name baked into a filename leaks even when the file
  // contents are clean. Matched against the high-precision literals only.
  if (isOn('paths') && pathFiles) {
    const terms = [...(corpus.terms || []), ...(corpus.private_terms || [])];
    findings.push(...pathFindings({ cls: 'paths', terms }, pathFiles, deps.skip || new Set()));
  }

  // Belt-and-suspenders: a finding on a self-excluded path is dropped here too,
  // not only by the pathspec. The path scan and the --no-index self-test both
  // reach files the pathspec exclusion never sees.
  return {
    findings: findings.filter((f) => posture(deps, f.class, f.file) !== 'skip'),
    scannedClasses: scanned,
    skippedClasses: skipped,
  };
}

// ── permitted list ───────────────────────────────────────────────────────────

/**
 * Load the permitted list: the UNION of the tracked file and the gitignored local
 * override, each optional and each parsed independently. Every entry is tagged
 * with the file it came from so decay can write it back to the right half.
 */
export function loadPermitted(configDir) {
  const entries = [];
  for (const file of [PERMITTED_FILE, PERMITTED_LOCAL_FILE]) {
    const path = join(configDir, file);
    if (!existsSync(path)) continue;
    const parsed = readJson(path);
    if (!parsed || !Array.isArray(parsed.permitted)) continue;
    for (const e of parsed.permitted) entries.push({ ...e, source: file });
  }
  return entries;
}

/**
 * Schema + placement validation for the permitted list.
 *
 * `deps.fileHasTerm(file, term)` is injected so the no-new-exposure rule can be
 * proven against the real tracked tree without this module knowing about git.
 * Omit it and that rule is skipped (used by the unit tests, which have no tree).
 *
 * Returns an array of human-readable errors; empty means the list is sound.
 */
export function validatePermitted(entries, deps = {}) {
  const errors = [];
  const seen = new Set();
  entries.forEach((e, i) => {
    const at = `entry ${i + 1}${e && e.source ? ` (${e.source})` : ''}`;
    if (!e || typeof e !== 'object') {
      errors.push(`${at}: not an object`);
      return;
    }
    for (const field of ['term', 'file', 'class', 'reason']) {
      if (typeof e[field] !== 'string' || !e[field].trim()) {
        errors.push(`${at}: "${field}" is missing or empty — every permitted entry needs a name, a file, a class and a stated reason`);
      }
    }
    if (errors.some((m) => m.startsWith(`${at}:`))) return;
    if (typeof e.added !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(e.added)) {
      errors.push(`${at}: "added" must be an ISO date — an entry with no age cannot be audited for staleness`);
    }
    const key = `${e.source} ${e.class} ${e.file} ${normTerm(e.term)}`;
    if (seen.has(key)) errors.push(`${at}: duplicate of an earlier entry for the same term/file/class`);
    seen.add(key);

    // The leak fix: an owner-identifying CLASS may not be named in the tracked file.
    if (e.source === PERMITTED_FILE && LOCAL_ONLY_CLASSES.has(e.class)) {
      errors.push(
        `${at}: class "${e.class}" is owner-identifying — naming a term as a member of it in a TRACKED file `
          + `publishes the association. Move this entry to ${PERMITTED_LOCAL_FILE}.`
      );
    }
    // The no-new-exposure rule: a tracked entry may only excuse a term the tracked
    // tree already carries at that path.
    if (e.source === PERMITTED_FILE && typeof deps.fileHasTerm === 'function') {
      if (!deps.fileHasTerm(e.file, e.term)) {
        errors.push(
          `${at}: "${e.file}" does not contain this term in the tracked tree. A tracked permitted entry may `
            + `only excuse an exposure that already exists; a dead entry must be decayed, not written.`
        );
      }
    }
  });
  return errors;
}

/**
 * Annotate each finding with the permitted entry that excuses it, if any.
 *
 * Matching is exact on (class, file, normalised term). A finding whose term could
 * not be resolved is NEVER permitted — fail closed: an unattributable finding is
 * precisely the one a stale entry should not be allowed to swallow.
 *
 * Returns `{ findings, matchedKeys }` — `matchedKeys` is what decay consumes.
 */
export function applyPermitted(findings, permitted) {
  const index = new Map();
  for (const e of permitted) {
    if (!e || !e.term || !e.file || !e.class) continue;
    index.set(`${e.class} ${e.file} ${normTerm(e.term)}`, e);
  }
  const matchedKeys = new Set();
  const out = findings.map((f) => {
    if (!f.term) return { ...f, permitted: null };
    const key = `${f.class} ${f.file} ${normTerm(f.term)}`;
    const entry = index.get(key);
    if (!entry) return { ...f, permitted: null };
    matchedKeys.add(key);
    return { ...f, permitted: entry };
  });
  return { findings: out, matchedKeys };
}

/**
 * AC15's decay: a permitted entry that no longer matches anything is removed on a
 * publication run, so the list cannot silently fill with dead rules that hide
 * later real findings.
 *
 * THE SHARP EDGE, and why `scannedPaths` is a required argument. A publication
 * run scans the published set; a full-tree run scans more. An entry legitimately
 * covering a finding in a test file matches nothing during a published-set run —
 * decay it and the very next full-tree run flags that finding again as new. So an
 * entry whose file is OUTSIDE the paths this run actually scanned is neither
 * matched nor decayed. It is not evidence of anything, so it is left alone.
 *
 * Returns `{ kept, removed, unscanned }` — three arrays of entries.
 */
export function decayPermitted(permitted, findings, scannedPaths) {
  const { matchedKeys } = applyPermitted(findings, permitted);
  const kept = [];
  const removed = [];
  const unscanned = [];
  for (const e of permitted) {
    if (!scannedPaths.has(e.file)) {
      unscanned.push(e);
      kept.push(e);
      continue;
    }
    const key = `${e.class} ${e.file} ${normTerm(e.term)}`;
    if (matchedKeys.has(key)) kept.push(e);
    else removed.push(e);
  }
  return { kept, removed, unscanned };
}

/**
 * Write the kept entries back, each to the half it came from, preserving that
 * file's `_comment`. Only files that actually changed are rewritten, so a clean
 * run leaves no diff. Returns the list of files written.
 */
export function writePermitted(configDir, kept) {
  const bySource = new Map();
  for (const e of kept) {
    const source = e.source || PERMITTED_FILE;
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.set(source, [...bySource.get(source), e]);
  }
  const written = [];
  for (const file of [PERMITTED_FILE, PERMITTED_LOCAL_FILE]) {
    const path = join(configDir, file);
    if (!existsSync(path)) continue;
    const parsed = readJson(path);
    if (!parsed || !Array.isArray(parsed.permitted)) continue;
    const next = {
      ...parsed,
      permitted: (bySource.get(file) || []).map(({ source, ...rest }) => rest),
    };
    const body = `${JSON.stringify(next, null, 2)}\n`;
    if (body !== readFileSync(path, 'utf8')) {
      writeFileSync(path, body);
      written.push(file);
    }
  }
  return written;
}

// ── the published set ────────────────────────────────────────────────────────
//
// It used to be defined here, as `isTestPath()` / `publishedPaths()` — an
// INTERIM rule stated while AC3's manifest did not yet exist. It exists now:
// lib/publication-manifest.js is the single authority, config/publication-
// manifest.json is the list, and the lock is what stops a new tracked file
// joining the published set silently. Two definitions of "what ships" would
// agree on the day the second was written and disagree the first time one was
// edited — and the disagreement would surface as a permitted-entry count that
// does not match what actually gets published. So there is one.
