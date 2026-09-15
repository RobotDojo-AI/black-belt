/**
 * lib/corpus-scan.js — the two scan families and surface-form variant generation
 * (st_dd0e19d8 Phase 1: AC12; the scan split is the design's load-bearing call).
 *
 * TWO SCAN FAMILIES, NOT ONE. This is the decision everything else rests on, and
 * it is a measurement, not a preference. `git grep -F -f <file>` costs time linear
 * in PATTERN COUNT, not in haystack size — measured on this tree (2,163 files):
 *
 *      58 patterns → 0.08s      9,276 → 7.25s      23,769 → 20.4s      61,000 → 36.9s
 *
 * and 23,769 patterns cost the same 1.1s over 5 staged files as over 40. So:
 *
 *   LITERAL family (scanLiterals) — one pattern file, one `git grep -F -i -w`.
 *   Cost linear in patterns. Home of the NAME-shaped classes: owner-config terms,
 *   person/company/place names, aliases, and the 25 employer domains (25 literals
 *   beat a shape grep over the 112k domain-shaped lines this tree contains).
 *
 *   SHAPE family (scanShape) — one structural regex grep, then intersect the
 *   near-zero hits against an in-memory Set. Cost 0.12s and INDEPENDENT OF CORPUS
 *   SIZE. Home of the PATTERN-shaped classes: 16-hex entity ids (155k) and contact
 *   email addresses (34.6k).
 *
 * The shape family is not a new invention — it is exactly what the entity-id pass
 * has done since st_e36f5f2b, generalised so the email arm can join it instead of
 * adding 34.6k literals. THE LITERAL PATTERN FILE MUST NEVER GROW TOWARD 61k, or
 * the every-commit report becomes unaffordable and the gate gets routed around.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 *
 * NO OWNER DATA LIVES IN THIS FILE. Patterns arrive as arguments.
 */

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The structural shape of an email address, written once so the SAME string
 * drives both `git grep -E` and the JS extraction pass. Two regexes that are
 * supposed to agree and are maintained separately eventually do not; one string
 * cannot drift from itself.
 *
 * NO `\b` IN ANY SHAPE — this is a measured platform constraint, not a style
 * choice. `git grep -E` honours `\b` when it walks the index but silently matches
 * NOTHING with it under `--no-index`, which is the mode every fixture-based
 * positive control runs in. A shape carrying `\b` therefore passes its real scan
 * and fails its own proof — a detector that cannot be proven is the exact failure
 * this gate exists to prevent. So the grep runs boundary-free as a coarse
 * line filter, and scanShape applies the word boundary in the JS extraction,
 * where it works in every mode.
 */
export const EMAIL_SHAPE = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';

/**
 * The structural shape of an entity content-id. 12..16 rather than 16: measured,
 * people and company context dirs suffix a 16-hex id but every place dir (and 45
 * company dirs) suffixes a 12-hex one, so a 16-only shape scans past the entire
 * places class. The membership intersection is what makes the wider shape safe —
 * an abbreviated commit hash that happens to be 12 hex chars is not in the id set
 * and is ignored. Measured cost of the widening on this tree: none.
 */
export const ENTITY_ID_SHAPE = '[0-9a-f]{12,16}';

/**
 * LITERAL family. Write the corpus terms to a temp pattern file, run one
 * `git grep -n -F -i -w -f <tmpfile>` over the scope, delete the temp file.
 *
 *  -w  whole-word: keeps a distinctive token from matching inside an innocent
 *      longer word. It also means a possessive (`name's`) and source-side
 *      trailing punctuation (`name.`) already match without any variant — which
 *      is why AC12 needs only two corpus-side rules, not four (see surfaceVariants).
 *  -F  literal, -i case-insensitive.
 *
 * `noIndex` lets the self-test scan an UNTRACKED fixture; `untracked` folds
 * non-ignored untracked files into the same single pass for publication runs. The
 * two are mutually exclusive by construction — no caller sets both.
 *
 * Returns raw `path:line:content` rows.
 */
export function scanLiterals(git, patterns, pathspecs, { noIndex = false, untracked = false } = {}) {
  if (!patterns || patterns.length === 0) return [];
  let tmpDir;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'rd-corpus-'));
    const patternFile = join(tmpDir, 'patterns.txt');
    writeFileSync(patternFile, patterns.join('\n') + '\n');
    const args = ['grep', '-n', '-F', '-i', '-w', '--no-color'];
    if (noIndex) args.push('--no-index');
    if (untracked) args.push('--untracked');
    args.push('-f', patternFile, '--');
    for (const ps of pathspecs) args.push(ps);
    const r = git(args);
    // git grep: 0 = matches found, 1 = no matches (clean), >1 = real error.
    if (r.status === 1) return [];
    if (r.status !== 0) throw new Error(`git grep failed (status ${r.status}): ${r.stderr || ''}`);
    return r.stdout.split('\n').filter(Boolean);
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * SHAPE family. One `git grep -E <shape>` over the scope, then intersect the
 * extracted tokens against `memberSet`. A random 16-hex literal or a vendor
 * address that is NOT in the owner's corpus is ignored — which is what keeps this
 * arm at zero false positives while covering 34.6k addresses for the price of one
 * grep.
 *
 * `shape` is a single regex STRING used verbatim by git grep -E, and wrapped in
 * word boundaries for the JS extraction pass — see the EMAIL_SHAPE comment for
 * why the boundary cannot live in the shared string. The grep is the coarse
 * filter; the JS pass is where precision is enforced. Membership is tested on the
 * lower-cased token, so `memberSet` must hold lower-cased members.
 *
 * Returns findings: `{ class, term, file, line, matched_form }`.
 */
export function shapeFindings(
  git,
  { cls = 'shape', shape, memberSet },
  pathspecs,
  { untracked = false, noIndex = false } = {}
) {
  if (!memberSet || memberSet.size === 0) return [];
  const args = ['grep', '-n', '-E', '-I', '--no-color'];
  // Symmetric with scanLiterals: --no-index reaches an untracked fixture, which is
  // how the positive control proves this family can fail.
  if (noIndex) args.push('--no-index');
  if (untracked) args.push('--untracked');
  args.push('-e', shape, '--');
  for (const ps of pathspecs) args.push(ps);
  const r = git(args);
  if (r.status === 1) return [];
  if (r.status !== 0) throw new Error(`git grep (shape) failed: ${r.stderr || ''}`);
  // Boundaries applied here, not in the grep pattern: JS honours `\b` in every
  // mode, git grep does not (see EMAIL_SHAPE). Without them a 20-char hex run
  // would yield a 16-char prefix that could coincidentally sit in the id set.
  const extract = new RegExp(`\\b(?:${shape})\\b`, 'gi');
  const findings = [];
  for (const row of r.stdout.split('\n').filter(Boolean)) {
    const parsed = parseGrepRow(row);
    if (!parsed) continue;
    extract.lastIndex = 0;
    for (const m of parsed.content.matchAll(extract)) {
      const token = m[0].toLowerCase();
      if (memberSet.has(token)) {
        findings.push({
          class: cls,
          term: token,
          file: parsed.file,
          line: parsed.line,
          matched_form: m[0],
        });
        break;
      }
    }
  }
  return findings;
}

/** Back-compatible formatter over shapeFindings — `path:line: <description>`. */
export function scanShape(git, shape, memberSet, pathspecs, opts = {}) {
  const say = opts.describe || ((token) => `owner corpus value "${token}" in a tracked file`);
  return shapeFindings(git, { shape, memberSet }, pathspecs, opts).map(
    (f) => `${f.file}:${f.line}: ${say(f.term)}`
  );
}

/**
 * PATH family. A corpus term in a tracked FILE PATH leaks even when the file
 * contents are clean (an employer name baked into a script filename).
 *
 * Returns findings; `line` is 0 because the path itself, not a line in it, is the
 * hit.
 */
export function pathFindings({ cls = 'paths', terms }, files, excluded = new Set()) {
  if (!terms || terms.length === 0) return [];
  const findings = [];
  for (const file of files) {
    if (excluded.has(file)) continue;
    const hay = file.toLowerCase();
    for (const term of terms) {
      // Path segments are hyphen/slash/dot separated; compare on a normalised form
      // so a hyphenated employer name in a path matches its spaced corpus form.
      const hyphenated = term.replace(/ /g, '-');
      const form = hay.includes(term) ? term : hay.includes(hyphenated) ? hyphenated : null;
      if (form) {
        findings.push({ class: cls, term, file, line: 0, matched_form: form });
        break;
      }
    }
  }
  return findings;
}

/** Back-compatible formatter over pathFindings. */
export function scanPaths(terms, files, excluded = new Set()) {
  return pathFindings({ terms }, files, excluded).map(
    (f) => `${f.file}: corpus term "${f.term}" appears in a tracked file PATH`
  );
}

// ── findings: naming WHICH corpus term matched ───────────────────────────────

/**
 * Split `path:line:content` once. git grep emits the path verbatim, and a path
 * can itself contain a colon, so the split is positional on the FIRST two colons
 * and nothing else — and the content keeps every colon it had.
 */
function parseGrepRow(row) {
  const firstColon = row.indexOf(':');
  if (firstColon < 0) return null;
  const secondColon = row.indexOf(':', firstColon + 1);
  if (secondColon < 0) return null;
  return {
    file: row.slice(0, firstColon),
    line: Number(row.slice(firstColon + 1, secondColon)) || 0,
    content: row.slice(secondColon + 1),
  };
}

/** Alphanumeric comparison key — the same collapse applied to both sides. */
function indexKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Build the lookup that turns a matched LINE back into the corpus TERM that
 * matched it.
 *
 * WHY THIS EXISTS: `git grep -F -f patterns` reports the line, never the pattern.
 * A finding that cannot name its term cannot be scoped on the permitted list
 * (which is per term AND file), cannot be counted as a (term, file) pair, and
 * cannot tell the owner what to fix. Asking grep once per pattern would be
 * 24,253 greps.
 *
 * The index is keyed on the alphanumeric collapse of each pattern, and lookup
 * generates the same collapse from the line's token n-grams. The two sides agree
 * because they are the same function: `-w` treats every non-word character as a
 * boundary, which is exactly what collapsing non-alphanumerics to spaces models.
 */
export function buildTermIndex(patterns) {
  const byKey = new Map();
  let maxTokens = 1;
  for (const p of patterns || []) {
    const key = indexKey(p);
    if (!key) continue;
    const n = key.split(' ').length;
    if (n > maxTokens) maxTokens = n;
    // First writer wins: variants collapse onto one key and the base form is
    // emitted first by expandVariants, so the term the owner recognises is kept.
    if (!byKey.has(key)) byKey.set(key, p);
  }
  return { byKey, maxTokens };
}

/**
 * Resolve the longest corpus term present in `text`. Returns
 * `{ term, matched_form }` or null.
 *
 * LONGEST WINS. A line can carry two corpus terms, one a prefix of the other
 * ("acme" inside "acme robotics"); naming the longer one is the more specific
 * true statement and it is the form the permitted list should be scoped to.
 */
export function resolveTerm(index, text) {
  if (!index || index.byKey.size === 0) return null;
  const tokens = [];
  const re = /[a-z0-9]+/gi;
  for (const m of String(text).matchAll(re)) {
    tokens.push({ v: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  if (tokens.length === 0) return null;
  const maxN = Math.min(index.maxTokens, tokens.length);
  for (let n = maxN; n >= 1; n -= 1) {
    for (let i = 0; i + n <= tokens.length; i += 1) {
      const key = tokens.slice(i, i + n).map((t) => t.v).join(' ');
      const term = index.byKey.get(key);
      if (term !== undefined) {
        return { term, matched_form: String(text).slice(tokens[i].start, tokens[i + n - 1].end) };
      }
    }
  }
  return null;
}

/**
 * LITERAL family, as findings. One grep per CLASS rather than one grep for all
 * literal classes together: the class then comes from which pass produced the
 * row, with no attribution ambiguity, and a class the posture table skips costs
 * nothing because its pattern file is never compiled. At commit time the
 * non-skipped literal classes total under 200 patterns, so the extra passes cost
 * ~0.01s each — measured, 2026-07-25.
 *
 * A row whose term cannot be resolved keeps its class and reports `term: null`
 * with the trimmed line as its matched form. That finding can never be permitted
 * (the permitted list is scoped per term), which is the fail-closed direction.
 */
export function literalFindings(git, { cls, patterns, index }, pathspecs, opts = {}) {
  const rows = scanLiterals(git, patterns, pathspecs, opts);
  if (rows.length === 0) return [];
  const idx = index || buildTermIndex(patterns);
  const findings = [];
  for (const row of rows) {
    const parsed = parseGrepRow(row);
    if (!parsed) continue;
    const hit = resolveTerm(idx, parsed.content);
    findings.push({
      class: cls,
      term: hit ? hit.term : null,
      file: parsed.file,
      line: parsed.line,
      matched_form: hit ? hit.matched_form : parsed.content.trim().slice(0, 120),
    });
  }
  return findings;
}

/**
 * AC12 — surface-form variants, generated CORPUS-SIDE.
 *
 * TWO RULES ONLY, and the narrowing is measured rather than assumed. AC12's text
 * names punctuation, plurals and possessives; a live `git grep -F -i -w` run shows
 * two of those already match with no work at all, because `-w` treats every
 * non-word character as a boundary:
 *
 *   corpus `a b`  vs source `a b's`   → ALREADY MATCHES (possessive)
 *   corpus `a b`  vs source `a b.`    → ALREADY MATCHES (source-side punctuation)
 *   corpus `a b.` vs source `a b`     → does NOT match  → rule 1
 *   corpus `a bs` vs source `a b`     → does NOT match  → rule 2
 *
 * So exactly two rules remain, both corpus-side:
 *
 *   1. PUNCTUATION-STRIP — emit the term with non-alphanumerics collapsed to
 *      spaces. This is the rule that catches a company stored with a trailing
 *      period and written in code without one: the leak nothing surfaces today.
 *   2. FINAL-TOKEN SINGULAR/PLURAL — and only when that token is purely
 *      alphanumeric. The guard is not decoration: without it the rule generates
 *      junk like `... co.s`, which is a pattern that can never match anything and
 *      still costs compile time on every scan.
 *
 * Haystack-side normalisation is deliberately NOT attempted: it would end the
 * single `git grep -F` pass, which is the property the whole cost model rests on.
 * These two rules achieve both known catches at a ~2x pattern multiplier.
 */
export function surfaceVariants(term) {
  const base = String(term || '').trim();
  if (!base) return [];
  const out = new Set([base]);

  const stripped = base.replace(/[^a-z0-9 ]+/gi, ' ').replace(/\s+/g, ' ').trim();
  if (stripped) out.add(stripped);

  for (const form of [...out]) {
    const tokens = form.split(' ');
    const last = tokens[tokens.length - 1];
    if (!/^[a-z0-9]+$/i.test(last)) continue;
    // Length guard: pluralising a 1–2 char token, or singularising one, produces a
    // fragment too short to be distinctive.
    const swapped = last.length > 3 && /s$/i.test(last) ? last.slice(0, -1) : `${last}s`;
    if (swapped.length < 3) continue;
    tokens[tokens.length - 1] = swapped;
    out.add(tokens.join(' '));
  }

  return [...out].filter(Boolean);
}

/** Expand a whole class through surfaceVariants, de-duplicated and sorted. */
export function expandVariants(terms) {
  const out = new Set();
  for (const t of terms) for (const v of surfaceVariants(t)) out.add(v);
  return [...out].sort();
}
