/**
 * lib/owner-corpus.js — build, cache, version, and provenance-guard the owner
 * corpus (st_dd0e19d8 Phase 1: AC9–AC12, AC21, AC22).
 *
 * WHAT THIS IS: the assembly half of the completeness gate. The readers in
 * lib/owner-corpus-sources.js extract; this module filters, expands surface
 * variants, records per-source availability, and writes the gitignored cache that
 * every pre-commit run reads. scripts/check-first-user-clean.js is the CLI facade
 * over it.
 *
 * NO OWNER DATA LIVES IN THIS FILE. Everything is read at runtime.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM. Identity is never trusted to an
 * LLM (build-conventions Key Design Principle 3).
 *
 * ── CACHE SCHEMA v2, AND WHY THE VERSION IS NOT OPTIONAL ────────────────────
 *
 * The v1 loader accepted any object carrying three arrays. A v1 cache satisfies
 * that check, so after this story shipped it would have silently driven a v2 gate
 * with three classes MISSING and every new arm reporting clean — the exact vacuous
 * pass this work exists to close. So: a cache whose schema_version is not 2 is
 * treated as ABSENT, never as EMPTY. Absent means "refresh me"; empty means
 * "nothing to find". Confusing the two is how a blind gate certifies a dirty tree.
 *
 * ── THREE WRITE-SAFETY INVARIANTS ───────────────────────────────────────────
 *
 * 1. PROVENANCE (AC21). The cache path is homedir-absolute; the repo root is
 *    script-relative. That asymmetry is deliberate and load-bearing — it is why
 *    auditing an exported tree works at all: the export's copy of the gate
 *    resolves its repo root to the export dir and reads the OWNER'S real corpus.
 *    But it also means a `--refresh` run from inside an export overwrites the
 *    owner's corpus with a degraded one built from the export's own contents.
 *    The fix is not to move either path. It is to guard WHO MAY WRITE: the cache
 *    records `built_from.repo_root`, and a build from a different root refuses to
 *    write. The READ path is untouched, so the export audit still works.
 *
 * 2. EXPORT-TREE SIGNATURE. Belt-and-suspenders, and cheap: a tree with exactly
 *    one commit and no `origin` remote is the structural signature of an export
 *    directory. Refuse to BUILD there at all, before the provenance check even
 *    matters.
 *
 * 3. NO WRITE ON AN UNAVAILABLE CORPUS. The v1 loader rebuilt whenever the cache
 *    was missing. On a machine without the DB that writes an EMPTY cache and every
 *    later run exits 0 for the rest of time. Pre-commit now never builds: an absent
 *    cache means "corpus unavailable", which exits 0 for a stranger's clone as
 *    designed — but writes nothing, so the state stays recoverable with a refresh.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import {
  norm,
  keepTerm,
  loadStopwordDicts,
  loadAllowlist,
  emptyValues,
  fromConfigOverrides,
  fromPrivateSettings,
  fromCompanies,
  fromPlaces,
  fromAliases,
  fromPeopleNames,
  fromContactEmails,
  fromEmployerDomains,
  fromEntityContexts,
} from './owner-corpus-sources.js';
import { expandVariants } from './corpus-scan.js';

export const CACHE_SCHEMA_VERSION = 2;

/**
 * The corpus classes, in cache order. Every class must exist in every v2 cache.
 *
 * `private_terms` is separate from `terms` rather than merged into it because the
 * two carry different postures and a merged array cannot express that: Tier A has
 * blocked every commit since st_e36f5f2b and finds nothing, while the AC9
 * private-settings literals match 35 places in tracked source today (the owner's
 * family names used as illustrative examples in comments and fixtures, and his
 * storage bucket name). Those are genuine leaks for the removal phase to clear —
 * but folding them into the blocking-at-commit array before they are cleared
 * would block every commit, which is how a gate gets routed around.
 */
export const CORPUS_CLASSES = [
  'terms',
  'private_terms',
  'literal_names',
  'domains',
  'emails',
  'entity_ids',
];

/**
 * Timestamp column per source table, measured against the live schema: `places`,
 * `person_aliases`, `person_identifiers` and `company_domains` have no
 * `updated_at`. Listing the column explicitly beats probing PRAGMA at runtime —
 * a schema change should break loudly here rather than silently degrade the
 * freshness anchor to null.
 */
const WATERMARK_COLUMNS = [
  ['people', 'updated_at'],
  ['companies', 'updated_at'],
  ['places', 'created_at'],
  ['person_aliases', 'created_at'],
  ['person_identifiers', 'created_at'],
  ['company_domains', 'created_at'],
];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The fraction of the build-time count a class may fall to before publication
 * refuses. Tunable, so it lives in config/defaults.json rather than as a literal
 * here; env override for a one-off run.
 *
 * WHY THE FLOOR TRAVELS IN THE CACHE rather than living in the gate: a hardcoded
 * per-class minimum would be owner data in the gate file, which the gate's own
 * contract forbids. Writing the observed counts into the artifact means the
 * constraint moves with the data it constrains.
 */
export function floorFraction(configDir) {
  const env = Number(process.env.ROBOTDOJO_CORPUS_FLOOR_FRACTION);
  if (Number.isFinite(env) && env > 0 && env <= 1) return env;
  const defaults = readJson(join(configDir, 'defaults.json'));
  const v = defaults && defaults.ownerCorpus && Number(defaults.ownerCorpus.floorFraction);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.5;
}

/** Default dependency set: the owner's real repo, config, contexts, and cache. */
export function defaultDeps(repoRoot) {
  return {
    repoRoot,
    configDir: join(repoRoot, 'config'),
    contextsDir: join(repoRoot, 'user', 'contexts'),
    // Homedir-absolute BY DESIGN — see invariant 1 above. Do not make this
    // repo-relative; the export audit depends on the export reading this file.
    cachePath: process.env.ROBOTDOJO_OWNER_CORPUS_CACHE
      || join(homedir(), '.robotdojo', 'owner-corpus.cache.json'),
    dbPath: process.env.ROBOTDOJO_DB || join(homedir(), '.robotdojo', 'robotdojo.db'),
  };
}

// ── DB access ────────────────────────────────────────────────────────────────

/**
 * Open the live encrypted DB read-only. Fully guarded: any failure to load the
 * driver, read the key, or open the file degrades to a recorded unavailability
 * rather than throwing, so a missing DB never turns a commit into an error.
 *
 * Deliberately does NOT import lib/db.js: that module has boot side effects
 * (migrations, workbench registration, maintenance jobs) that have no business
 * running inside a pre-commit gate.
 */
export async function openOwnerDb(dbPath) {
  if (!existsSync(dbPath)) return { db: null, reason: 'no live DB on disk' };
  let Database;
  let readKey;
  let applyKeyPragma;
  try {
    ({ default: Database } = await import('better-sqlite3-multiple-ciphers'));
    ({ readKey, applyKeyPragma } = await import('./db-encryption.js'));
  } catch (err) {
    return { db: null, reason: `deps unavailable: ${err.message}` };
  }
  try {
    const key = readKey();
    const db = new Database(dbPath, { readonly: true });
    if (key) applyKeyPragma(db, key);
    db.prepare('SELECT 1').get(); // proves the cipher key before the big scans
    return { db, reason: '' };
  } catch (err) {
    return { db: null, reason: `DB read failed: ${err.message}` };
  }
}

/**
 * The freshness anchor (AC6): the newest record across every table the corpus
 * derives from. `built_at` is a wall clock nobody can falsify a claim against;
 * a watermark can be compared to the live database and produce a yes or no.
 */
export function liveWatermark(db) {
  if (!db) return null;
  let max = null;
  for (const [table, column] of WATERMARK_COLUMNS) {
    try {
      const row = db.prepare(`SELECT MAX(${column}) AS m FROM ${table}`).get();
      const v = row && row.m ? String(row.m) : null;
      if (v && (max === null || v > max)) max = v;
    } catch {
      // A table that does not exist on this schema contributes nothing rather
      // than aborting the build — graceful degradation, recorded via sources[].
    }
  }
  return max;
}

// ── export-tree detection (write-safety invariant 2) ─────────────────────────

/**
 * True when the tree looks like an exported publication copy: exactly one commit
 * and no `origin` remote. That is what `git archive → git init → single commit`
 * produces, and it is the shape a `--refresh` must never write from.
 */
export function looksLikeExportTree(git) {
  const remotes = git(['remote']);
  const hasOrigin = remotes.status === 0 && /^origin$/m.test(remotes.stdout || '');
  if (hasOrigin) return false;
  const count = git(['rev-list', '--count', 'HEAD']);
  if (count.status !== 0) return false;
  return String(count.stdout || '').trim() === '1';
}

// ── build ────────────────────────────────────────────────────────────────────

/**
 * Build the corpus from every source and (unless `dryRun`) write the v2 cache.
 *
 * `opts.adopt` re-establishes provenance after a genuine repository move — the
 * one supported way past the AC21 write guard.
 * `opts.dryRun` builds and returns without writing (used by probes and by any
 * caller that must not touch the owner's cache).
 *
 * Returns the cache object. `cache.write` records what happened to the write:
 * `{ written: bool, reason: string }` — so a caller can report a refused write
 * instead of assuming success.
 */
export async function buildCorpus(deps, opts = {}) {
  const { repoRoot, configDir, contextsDir, cachePath, dbPath, git } = deps;
  const { adopt = false, dryRun = false } = opts;

  const { surnames, nicknames } = loadStopwordDicts(configDir);
  const allow = loadAllowlist(configDir);
  const filters = { surnames, nicknames, allow };

  const { db, reason: dbReason } = await openOwnerDb(dbPath);
  const sources = {};
  const merged = emptyValues();

  const run = (name, reader) => {
    let r;
    try {
      r = reader();
    } catch (err) {
      r = { values: emptyValues(), available: false, reason: `reader threw: ${err.message}`, rows: 0 };
    }
    sources[name] = { available: r.available, reason: r.reason, rows: r.rows };
    for (const cls of CORPUS_CLASSES) {
      // Element-wise, not push(...arr): the entity-id class carries 155k values
      // and spreading that many arguments overflows the call stack.
      if (r.values[cls]) for (const v of r.values[cls]) merged[cls].push(v);
    }
  };

  // Tier A + AC9 — on-disk config, no DB needed.
  run('config_overrides', () => fromConfigOverrides(configDir));
  run('private_settings', () => fromPrivateSettings(join(configDir, 'private.json')));
  run('entity_contexts', () => fromEntityContexts(contextsDir));

  // AC10 + AC11 — the live entity graph.
  const dbUnavailable = () => ({
    values: emptyValues(),
    available: false,
    reason: dbReason || 'no DB handle',
    rows: 0,
  });
  run('people', () => (db ? fromPeopleNames(db, filters) : dbUnavailable()));
  run('companies', () => (db ? fromCompanies(db, filters) : dbUnavailable()));
  run('places', () => (db ? fromPlaces(db, filters) : dbUnavailable()));
  run('aliases', () => (db ? fromAliases(db, filters) : dbUnavailable()));
  run('contact_emails', () => (db ? fromContactEmails(db) : dbUnavailable()));
  run('employer_domains', () => (db ? fromEmployerDomains(db) : dbUnavailable()));

  const watermark = liveWatermark(db);
  try {
    if (db) db.close();
  } catch {
    /* noop */
  }

  // ── filter + normalise per class ───────────────────────────────────────────
  // The three LITERAL classes go through the distinctiveness filter because they
  // become whole-word grep patterns and a generic one poisons every commit.
  // `domains`, `emails` and `entity_ids` do NOT: their shape is already
  // distinctive, and running a name filter over an address would drop it for
  // having too few word tokens.
  //
  // The classes are also disjoint, in precision order: a value that qualifies as
  // Tier A never also appears as a private literal or a graph name. Without that,
  // one term in two classes gets two postures and the stricter one is unreachable.
  const terms = new Set();
  for (const t of merged.terms) if (keepTerm(t, filters)) terms.add(norm(t));

  const privateTerms = new Set();
  for (const t of merged.private_terms) {
    const v = norm(t);
    if (v && keepTerm(v, filters) && !terms.has(v)) privateTerms.add(v);
  }

  const literalNames = new Set();
  for (const n of merged.literal_names) {
    const v = norm(n);
    if (v && keepTerm(v, filters) && !terms.has(v) && !privateTerms.has(v)) literalNames.add(v);
  }

  const domains = new Set();
  for (const d of merged.domains) {
    const v = norm(d);
    if (v && v.includes('.') && !allow.has(v)) domains.add(v);
  }

  const emails = new Set();
  for (const e of merged.emails) {
    const v = norm(e);
    if (v.includes('@') && v.includes('.')) emails.add(v);
  }

  const entityIds = new Set();
  for (const id of merged.entity_ids) entityIds.add(norm(id));

  // AC12 — surface-form variants, corpus-side, on the LITERAL classes only. The
  // shape classes need no variants: an address matches as itself or not at all.
  const termsExpanded = expandVariants([...terms]);
  const privateExpanded = expandVariants([...privateTerms]);
  const namesExpanded = expandVariants([...literalNames]);

  const sizes = {
    terms: termsExpanded.length,
    private_terms: privateExpanded.length,
    literal_names: namesExpanded.length,
    domains: domains.size,
    emails: emails.size,
    entity_ids: entityIds.size,
  };

  const counts = {
    ...sizes,
    // Pre-variant sizes, so a change in the variant multiplier is visible rather
    // than hidden inside a single grown number.
    terms_base: terms.size,
    private_terms_base: privateTerms.size,
    literal_names_base: literalNames.size,
  };

  const fraction = floorFraction(configDir);
  const floors = {};
  for (const [cls, n] of Object.entries(sizes)) {
    floors[cls] = n > 0 ? Math.max(1, Math.floor(n * fraction)) : 0;
  }

  const cache = {
    schema_version: CACHE_SCHEMA_VERSION,
    built_at: new Date().toISOString(),
    built_from: { repo_root: repoRoot, db_path: dbPath, db_watermark: watermark },
    counts,
    sources,
    floors,
    terms: termsExpanded,
    private_terms: privateExpanded,
    literal_names: namesExpanded,
    domains: [...domains].sort(),
    emails: [...emails].sort(),
    entity_ids: [...entityIds].sort(),
  };

  // The write receipt is attached AFTER serialisation on purpose: it describes
  // what happened to this run's write attempt, not a property of the artifact, so
  // it belongs on the returned object and not in the file. A caller reads it to
  // report a REFUSED write instead of assuming the cache on disk is now its own.
  cache.write = dryRun
    ? { written: false, reason: 'dry run — cache not written' }
    : writeCache(cache, { cachePath, repoRoot, git, adopt });
  return cache;
}

/**
 * AC21 — the provenance guard. Refuses to overwrite a cache that a DIFFERENT repo
 * root built. Returns `{written, reason}`; never throws, so a refused write is a
 * reported outcome rather than a stack trace in a pre-commit hook.
 */
export function writeCache(cache, { cachePath, repoRoot, git, adopt = false }) {
  if (git && looksLikeExportTree(git)) {
    return {
      written: false,
      reason:
        'refused: this tree has a single commit and no origin remote — the signature of an '
        + 'exported publication copy. A corpus built here would be degraded; the owner\'s cache is untouched.',
    };
  }
  const existing = readJson(cachePath);
  const priorRoot = existing && existing.built_from && existing.built_from.repo_root;
  if (priorRoot && priorRoot !== repoRoot && !adopt) {
    return {
      written: false,
      reason:
        `refused: cache at ${cachePath} was built from ${priorRoot}, this build ran from ${repoRoot}. `
        + 'Re-run with --adopt from the intended repository if it genuinely moved.',
    };
  }
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache));
    return { written: true, reason: adopt && priorRoot ? `adopted provenance from ${priorRoot}` : '' };
  } catch (err) {
    return { written: false, reason: `could not write cache ${cachePath}: ${err.message}` };
  }
}

// ── load ─────────────────────────────────────────────────────────────────────

/**
 * ── ABSENT IS NOT THE SAME AS UNTRUSTED, AND COLLAPSING THEM HID A REAL BUG ──
 *
 * `loadCorpus` returns null for two situations that mean opposite things:
 *
 *   ABSENT — there is no cache file. This is a STRANGER's machine. Their clone
 *   has none of the owner's data, the gate finds nothing because there is
 *   nothing of his to find, and their commit must go through. Exiting 0 here is
 *   the correct answer, not a vacuous one (AC6, scripts/qa/fresh-clone-harmless.js).
 *
 *   UNTRUSTED — there IS a cache file and it cannot be believed: unreadable
 *   JSON, an older schema, or a class array missing. This is the OWNER's machine
 *   with a degraded artifact, and exiting 0 on it certifies a tree nothing
 *   scanned.
 *
 * MEASURED, 2026-07-26, which is why this exists. The cache path is one fixed
 * absolute path shared by every checkout on the machine. A second, older
 * checkout still carrying a pre-v2 copy of this gate ran and rewrote the file in
 * the old format. The current gate correctly refused to believe it — and then
 * printed "corpus UNAVAILABLE" and exited 0, exactly as it does for a stranger.
 * Commits were scanned against nothing and said so in a line that reads like
 * routine noise. The provenance guard above cannot prevent this: it binds the
 * writer, and code that predates the guard was never bound by it. So the reader
 * must refuse instead.
 *
 * Returns `{ state, reason, corpus }` with state one of `ok` | `absent` |
 * `untrusted`. Callers on a blocking or publication path must treat `untrusted`
 * as a failure; `absent` keeps its long-standing harmless behaviour.
 */
export function corpusCacheState(deps) {
  const path = deps.cachePath;
  if (!existsSync(path)) {
    return { state: 'absent', reason: `no corpus cache at ${path}`, corpus: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      state: 'untrusted',
      reason: `the corpus cache at ${path} exists but is not readable JSON (${err.message}). `
        + 'A file that is there and cannot be believed is not the same as no file at all.',
      corpus: null,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'untrusted', reason: `the corpus cache at ${path} is not an object`, corpus: null };
  }
  if (parsed.schema_version !== CACHE_SCHEMA_VERSION) {
    return {
      state: 'untrusted',
      reason: `the corpus cache at ${path} declares schema version `
        + `${parsed.schema_version === undefined ? 'none' : JSON.stringify(parsed.schema_version)}, `
        + `not ${CACHE_SCHEMA_VERSION}. Every checkout on this machine writes this one file, so an older `
        + 'copy of this gate running from another checkout will overwrite it in a format this one cannot '
        + 'use. Rebuild it from this checkout: node scripts/check-first-user-clean.js --refresh',
      corpus: null,
    };
  }
  const missing = CORPUS_CLASSES.filter((cls) => !Array.isArray(parsed[cls]));
  if (missing.length > 0) {
    return {
      state: 'untrusted',
      reason: `the corpus cache at ${path} is missing ${missing.length} required class array(s): `
        + `${missing.join(', ')}. Rebuild it: node scripts/check-first-user-clean.js --refresh`,
      corpus: null,
    };
  }
  return { state: 'ok', reason: '', corpus: parsed };
}

/**
 * Load the cache. Returns null when the cache is ABSENT — which includes a cache
 * of the wrong schema version or the wrong shape. Never builds: a caller that
 * wants a build asks for one explicitly (write-safety invariant 3).
 *
 * Callers that need to tell "no file" from "a file I cannot believe" call
 * `corpusCacheState` instead; this signature is unchanged so every existing
 * reader keeps its behaviour.
 */
export function loadCorpus(deps) {
  const { state, corpus } = corpusCacheState(deps);
  return state === 'ok' ? corpus : null;
}

// ── assertions used by the publication path ──────────────────────────────────

/**
 * AC6 — every class must still meet the floor recorded when the cache was built.
 * Returns an array of human-readable failures; empty means the corpus is sound.
 * A class whose recorded floor is 0 was empty at build time and is reported as
 * unavailable rather than as passing.
 */
export function assertCorpusFloors(corpus) {
  const failures = [];
  if (!corpus) return ['corpus unavailable — no v2 cache on disk'];
  const floors = corpus.floors || {};
  for (const cls of CORPUS_CLASSES) {
    const size = Array.isArray(corpus[cls]) ? corpus[cls].length : 0;
    const floor = Number(floors[cls] || 0);
    if (floor === 0) {
      failures.push(`class "${cls}" has no recorded floor — it was empty when the corpus was built`);
      continue;
    }
    if (size < floor) failures.push(`class "${cls}" holds ${size} entries, below its recorded floor of ${floor}`);
  }
  return failures;
}

/**
 * AC6 — the cache must not predate the newest record it derives from. Compared as
 * ISO-ish strings, which sort correctly for both formats the schema stores.
 * Returns an array of failures; empty means fresh.
 */
export function assertCorpusFresh(corpus, watermark) {
  if (!corpus) return ['corpus unavailable — no v2 cache on disk'];
  const built = corpus.built_from && corpus.built_from.db_watermark;
  if (!watermark) return []; // no live DB to compare against — not a staleness claim
  if (!built) return ['corpus records no database watermark — rebuild it before publishing'];
  if (String(built) < String(watermark)) {
    return [`corpus was built at watermark ${built}; the database has moved to ${watermark}`];
  }
  return [];
}
