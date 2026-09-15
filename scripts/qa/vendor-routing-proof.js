#!/usr/bin/env node
/**
 * vendor-routing-proof.js — AC1's vendor half (st_dd0e19d8).
 *
 * THE PART OF AC1 THAT IS NOT A REMOVAL. Every other name AC1 names is replaced
 * with a placeholder. Two are not, and the reason is stated in the criterion: the
 * vendor list is a LIVE CLASSIFICATION RULE. `BRAND_SERVICE_NAMES.has(brand)`
 * decides whether a person is a service vendor, which caps how that person ranks
 * for the rest of the pipeline. Swapping the owner's company and a hotel for
 * placeholders would not redact anything — it would change how his own mail is
 * sorted. So those entries MOVE to a gitignored file that never ships, and the
 * union on his machine equals the old hardcoded set exactly.
 *
 * WHAT THIS PROOF HAS TO ESTABLISH, therefore, is not "the file exists" but two
 * things at once:
 *
 *   NOTHING LEAKED — no value in the gitignored half appears in the tracked half
 *   or anywhere else in the tracked tree, and the tracked half carries nothing
 *   the owner's own corpus recognises as his.
 *
 *   NOTHING CHANGED — every moved value is still matched by the live classifier,
 *   through the same call path production uses. A move that silently stopped
 *   classifying would satisfy the leak half and break the product, which is the
 *   failure AC2 exists to catch and this proof catches at its source.
 *
 * NO VALUE FROM EITHER LIST IS EVER PRINTED. Counts and shapes only.
 *
 * Exit 0 = the two entries moved, nothing leaked, classification is unchanged.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCorpus, defaultDeps } from '../../lib/owner-corpus.js';
import { norm } from '../../lib/owner-corpus-sources.js';
import {
  BRAND_SERVICE_NAMES,
  SYSTEM_LOCAL_TOKENS,
  SYSTEM_LOCAL_SUBSTRINGS,
  isSystemArtifact,
  isSystemEmailLocal,
} from '../../scripts/ingest/03b-service-vendor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const TRACKED = join(REPO_ROOT, 'config', 'service-vendor-keywords.json');
const OVERRIDE = join(REPO_ROOT, 'config', 'service-vendor-keywords.user.json');
const MODULE_REL = 'scripts/ingest/03b-service-vendor.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

function git(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  process.stdout.write('vendor-routing-proof: AC1 — the two entries that moved instead of being replaced\n\n');

  // ── the gitignored half ────────────────────────────────────────────────────
  process.stdout.write('The half that never ships\n');
  const override = readJson(OVERRIDE);
  check('the local vendor override exists and parses', !!override, OVERRIDE.replace(REPO_ROOT + '/', ''));
  const moved = override
    ? [...(override.brands || []), ...(override.localTokens || []), ...(override.localSubstrings || [])].map((v) => norm(v))
    : [];
  check(
    'it carries the owner-derived entries',
    moved.length > 0,
    `${moved.length} value(s) across brands, local tokens and local substrings`
  );
  check(
    'it is gitignored',
    git(['check-ignore', '-q', 'config/service-vendor-keywords.user.json']).status === 0,
    'an override that is not ignored ships on the next commit'
  );
  check(
    'and it is untracked — it has never been committed',
    git(['ls-files', '--error-unmatch', 'config/service-vendor-keywords.user.json']).status !== 0,
    'a committed override is not an override'
  );

  // ── nothing leaked ─────────────────────────────────────────────────────────
  process.stdout.write('\nNothing leaked into the tracked half\n');
  const tracked = readJson(TRACKED) || {};
  const trackedValues = new Set(
    [...(tracked.general || []), ...(tracked.audited || [])].map((v) => norm(v))
  );
  const overlap = moved.filter((v) => trackedValues.has(v));
  check(
    'no moved value is also in the tracked keyword file',
    overlap.length === 0,
    overlap.length === 0 ? `${trackedValues.size} tracked keyword(s), none of them his` : `${overlap.length} still in both`
  );

  // The stronger statement: the tracked MODULE's own hardcoded sets — the ones
  // the classifier reads directly — carry none of the moved values either. The
  // tracked keyword file and the module's literal sets are two different lists,
  // and checking only the file would miss the one AC1 actually names.
  const moduleSource = readFileSync(join(REPO_ROOT, MODULE_REL), 'utf8');
  const inModule = moved.filter((v) => new RegExp(`['"\`]${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`, 'i').test(moduleSource));
  check(
    'and none of them is a literal in the classifier source',
    inModule.length === 0,
    inModule.length === 0 ? `${MODULE_REL} carries only generic trade words` : `${inModule.length} literal(s) remain`
  );

  // Scoped to the values that are OWNER-IDENTIFYING, which is not all of them
  // and the distinction is the point. Two of the moved values are his company
  // and a hotel — those must appear nowhere. The others are ordinary trade
  // words that were moved because of where they came FROM (his inbox), not
  // because the words themselves disclose anything; demanding that "notes" or
  // "concierge" appear in no tracked file would fail on unrelated code and
  // teach the next reader to ignore this check.
  const corpusForLeak = loadCorpus(defaultDeps(REPO_ROOT));
  const ownerSet = corpusForLeak
    ? new Set([
      ...(corpusForLeak.terms || []),
      ...(corpusForLeak.private_terms || []),
      ...(corpusForLeak.literal_names || []),
      ...(corpusForLeak.domains || []),
    ])
    : new Set();
  const identifying = moved.filter((v) => ownerSet.has(v));
  const generic = moved.filter((v) => !ownerSet.has(v));
  const leaked = [];
  for (const v of identifying) {
    const r = git(['grep', '-l', '-i', '-F', '-e', v, '--', '.']);
    if (r.status === 0) leaked.push(...r.stdout.split('\n').filter(Boolean));
  }
  check(
    'no owner-identifying moved value appears anywhere in the tracked tree',
    identifying.length > 0 && leaked.length === 0,
    identifying.length === 0
      ? 'no moved value is in the owner corpus — the move would not have been necessary'
      : `${identifying.length} owner-identifying value(s) searched across every tracked file`
  );
  process.stdout.write(
    `  MEASURED  ${generic.length} moved value(s) are ordinary trade words rather than owner-identifying;\n`
      + '            they were moved for their provenance, and they legitimately occur in unrelated files\n'
  );

  // ── nothing changed ────────────────────────────────────────────────────────
  process.stdout.write('\nClassification is unchanged — every moved value is still live\n');
  const brands = (override && override.brands ? override.brands : []).map((v) => norm(v));
  const tokens = (override && override.localTokens ? override.localTokens : []).map((v) => norm(v));
  const substrings = (override && override.localSubstrings ? override.localSubstrings : []).map((v) => norm(v));

  check(
    `  ${brands.length} brand(s) reach the live brand set`,
    brands.length > 0 && brands.every((b) => BRAND_SERVICE_NAMES.has(b)),
    'the union the module builds at import time'
  );
  check(
    `  ${tokens.length} local token(s) reach the live token set`,
    tokens.every((t) => SYSTEM_LOCAL_TOKENS.has(t)),
    tokens.length === 0 ? 'none in this half' : 'merged, not replaced'
  );
  check(
    `  ${substrings.length} local substring(s) reach the live substring list`,
    substrings.every((s) => SYSTEM_LOCAL_SUBSTRINGS.includes(s)),
    substrings.length === 0 ? 'none in this half' : 'merged, not replaced'
  );

  // The call path production uses, not the data structure behind it. A merged
  // set that the classifier does not consult would pass every check above.
  const brandVerdicts = brands.map((b) => isSystemArtifact({ display_name: b }, []));
  check(
    'every moved brand is classified as a service vendor through the real entry point',
    brands.length > 0 && brandVerdicts.every(Boolean),
    `${brandVerdicts.filter(Boolean).length}/${brands.length} via isSystemArtifact`
  );
  const tokenVerdicts = tokens.map((t) => isSystemEmailLocal(t));
  check(
    'and every moved local token is classified through the real entry point',
    tokens.every((t, i) => tokenVerdicts[i]),
    tokens.length === 0 ? 'none in this half' : `${tokenVerdicts.filter(Boolean).length}/${tokens.length} via isSystemEmailLocal`
  );

  // A control: a value that is in neither half must NOT classify, or the
  // classifier is saying yes to everything and the checks above are vacuous.
  check(
    'a value in neither half is NOT classified — the classifier can say no',
    isSystemArtifact({ display_name: 'Zylphara Quendrith' }, []) === false,
    'a matcher that always matches proves nothing'
  );

  // ── and the corpus agrees the tracked half is clean ───────────────────────
  const corpus = loadCorpus(defaultDeps(REPO_ROOT));
  if (corpus) {
    const owner = new Set([...(corpus.terms || []), ...(corpus.private_terms || [])]);
    const flagged = [...trackedValues].filter((v) => owner.has(v));
    check(
      "the owner's own corpus recognises nothing in the tracked half as his",
      flagged.length === 0,
      flagged.length === 0 ? `${owner.size} owner terms cross-checked` : `${flagged.length} match`
    );
  } else {
    check('the owner corpus is available to cross-check the tracked half', false, 'no v2 cache on this machine');
  }

  const failures = results.filter((r) => !r.ok);
  process.stdout.write(`\nvendor-routing-proof: ${results.length - failures.length}/${results.length} PASS\n`);
  return failures.length === 0 ? 0 : 1;
}

process.exit(main());
