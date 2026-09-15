/**
 * lib/owner-corpus-sources.js — one named reader per owner-corpus source
 * (st_dd0e19d8 Phase 1: AC9, AC10, AC11).
 *
 * WHAT THIS IS: the extraction half of the completeness gate. Each reader pulls
 * one on-disk or in-DB source and returns a uniform record; `lib/owner-corpus.js`
 * merges, filters, and caches them. Splitting extraction from assembly is what
 * lets a partial build be *recorded* as partial (per-source `available`/`reason`)
 * instead of silently reporting as a full one — with seven sources instead of the
 * one this gate started with, a single flat "tierB_available" flag would let six
 * dead arms pass as clean.
 *
 * NO OWNER DATA LIVES IN THIS FILE. Every value is read at runtime from
 * gitignored on-disk data (config/*.user.json, config/private.json, the local
 * encrypted DB, user/contexts/). The only literals here are structural: field
 * PATHS, generic stopword dictionaries, and SQL column names.
 *
 * AND NOTHING IN THE GATE CAN CHECK THAT CLAIM HERE. This file is a `skip_paths`
 * entry in config/publication-posture.json — the gate must not flag its own
 * source, so it never scans it. That makes this the one file where the sentence
 * above could be false and every check would still report clean. It WAS false:
 * QA st_dd0e19d8 found the owner's employer and one of his affiliations written
 * into an illustrative comment below, in an underscore-joined form the corpus
 * scan cannot match even where it does look. The compensating control is
 * out-of-band and mandatory — scripts/qa/skip-paths-corpus-proof.js scans every
 * `gate_source` skip path against the corpus with separator variants and with
 * the local allowlist un-suppressed. When editing this file, write structure,
 * never an example drawn from the owner's own settings.
 *
 * COMPUTE TIER: Tier 0 throughout — deterministic, no LLM. Identity is never
 * trusted to an LLM (build-conventions Key Design Principle 3).
 *
 * READER CONTRACT (uniform, deliberately — see below):
 *
 *   reader(...) -> { values, available, reason, rows }
 *
 *   values     a CLASS BAG: { terms, literal_names, domains, emails, entity_ids }
 *              — arrays of raw (un-filtered, un-normalised) candidate strings.
 *   available  false when the source could not be read at all.
 *   reason     why it was unavailable; '' when available.
 *   rows       raw rows/values examined before filtering — the falsifiable
 *              number that distinguishes "read 9,531 rows, kept 1,620" from
 *              "read 0 rows, kept 0".
 *
 * WHY THE BAG IS UNIFORM even though most readers fill exactly one key: the
 * private-settings reader legitimately feeds three classes at once (names,
 * addresses, domains). Giving every reader the same shape means the assembler is
 * one merge loop over Object.entries(values) with no per-source branch. A
 * per-reader shape would buy one saved array allocation and cost a switch
 * statement that must be updated for every new source.
 *
 * CLASS MEANINGS (the posture table keys off these names):
 *   terms         Tier A — exact distinctive owner terms from the gitignored
 *                 config overrides. Blocking everywhere; unchanged by this story.
 *   private_terms the owner's private-settings identity literals (AC9) — his name,
 *                 family, stored contacts, work colleagues, taxonomy and archive
 *                 slugs. Kept SEPARATE from Tier A rather than merged into it,
 *                 because the two have different commit-time postures and a merged
 *                 array cannot express that.
 *   literal_names name-shaped entity values — companies, places, aliases, people,
 *                 and the owner's own recorded locations. The measured-noisy class.
 *   domains       owner/employer domains
 *   emails        real addresses — matched by SHAPE + set intersection, never as
 *                 34k literal patterns (see lib/corpus-scan.js scanShape)
 *   entity_ids    content-id hex suffixes — same shape+intersect family as emails
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ── shared normalisation + distinctiveness ───────────────────────────────────

/** Lower-cased, whitespace-collapsed comparison form. */
export function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when a token count qualifies a term as "multi-token distinctive". */
export function isMultiToken(term) {
  return /[ ]/.test(term.trim()) || term.split(/-/).filter(Boolean).length >= 2;
}

// Truly generic single tokens that appear in the owner's taxonomy/routing config
// but carry zero identifying signal (they are the SAME words the tracked
// taxonomy.default.json ships). Dropped from the single-token corpus so the gate
// never flags the product's own generic vocabulary. This is NOT the owner
// allowlist (config/owner-corpus-allowlist.json + its gitignored .user.json
// override) — that file carries the owner-adjacent common-word collisions
// (former employers/schools that also appear as product concepts).
export const GENERIC_STOPWORDS = new Set([
  'career', 'health', 'home', 'finances', 'finance', 'hobbies', 'learning',
  'coaching', 'writing', 'technical', 'personal', 'family', 'work', 'education',
  'relationships', 'robot', 'dojo', 'google', 'general', 'tech', 'current',
  'role', 'side', 'projects', 'project', 'degree', 'courses', 'kids', 'home',
  'newsletter', 'newsletters', 'writing', 'people', 'companies', 'company',
  'default', 'primary', 'secondary', 'test', 'folder', 'icon', 'topics', 'topic',
  'other', 'task', 'notes', 'email', 'calendar', 'contacts', 'drive',
  // Company-alias KEYS that are also ubiquitous English words in source code
  // ("rate" → rate-limit, "post" → HTTP verb). Corpus-poisoning if kept.
  'rate', 'post',
]);

// Vendor / institution / legal-suffix / structural tokens that dominate the
// entity graph's PEOPLE, COMPANY and PLACE names but carry no owner-identity
// signal and appear ubiquitously in tracked product source (a card that names
// "Google Docs" or a "University" is not an owner leak). A multi-token name
// containing ANY of these is treated as a generic org, not a close-network
// entity, and dropped. This is the filter that keeps the DB-derived corpus from
// poisoning the blocking scan with false positives.
export const GENERIC_NAME_PARTS = new Set([
  'university', 'college', 'school', 'institute', 'academy', 'ring', 'docs',
  'doc', 'calendar', 'photos', 'photo', 'mail', 'gmail', 'drive', 'express',
  'american', 'national', 'international', 'global', 'group', 'labs', 'lab',
  'capital', 'ventures', 'venture', 'partners', 'partner', 'technologies',
  'technology', 'systems', 'system', 'solutions', 'solution', 'services',
  'service', 'company', 'holdings', 'associates', 'consulting', 'advisors',
  'management', 'financial', 'insurance', 'health', 'medical', 'center',
  'google', 'microsoft', 'apple', 'amazon', 'meta', 'oura', 'notion', 'slack',
  'github', 'linkedin', 'twitter', 'facebook', 'stripe', 'openai', 'anthropic',
  'bank', 'trust', 'fund', 'foundation', 'news', 'media', 'press', 'digital',
  'ventures', 'studio', 'studios', 'agency', 'team', 'network', 'platform',
  'the', 'and', 'for', 'inc', 'llc', 'ltd', 'corp', 'co', 'plc', 'gmbh',
]);

// Mailbox-role words. A "name" built from a role account (support@, no-reply@)
// is not a person and must never enter a blocking corpus.
export const ROLE_TOKENS = new Set([
  'team', 'support', 'notifications', 'noreply', 'admin', 'info', 'sales',
  'billing', 'hello', 'contact', 'newsletter', 'news', 'updates', 'account',
  'accounts', 'alerts', 'reply', 'do', 'not', 'via', 'from',
]);

/**
 * Decide whether a candidate term survives distinctiveness filtering. A term
 * that survives becomes a literal the gate hunts for across the tracked tree.
 *
 *   - drop empties and short tokens (len < 4)
 *   - drop anything on the auditable owner allowlist (known collisions)
 *   - multi-token proper nouns (a two-word employer name, a hyphenated topic
 *     slug) are distinctive → keep (they almost never appear innocently in source)
 *   - single tokens must clear the generic stoplist AND the surname/nickname
 *     dictionaries AND be length >= 4
 */
export function keepTerm(term, { surnames, nicknames, allow }) {
  const t = norm(term);
  if (!t || t.length < 4) return false;
  if (allow.has(t)) return false;
  if (isMultiToken(t)) return true; // distinctive multi-token proper noun
  if (GENERIC_STOPWORDS.has(t)) return false;
  if (surnames.has(t)) return false;
  if (nicknames.has(t)) return false;
  return true;
}

/**
 * The entity-graph name filter — the `consider()` rule the people arm has used
 * since st_e36f5f2b, extracted so the companies, places and aliases arms share
 * exactly one definition of "distinctive entity name" rather than three that
 * drift.
 *
 * Returns the normalised name, or null when the candidate is rejected.
 *
 * `rejectAddressShapes` adds the two rejects the companies/places tables force
 * and the people table does not need (measured, st_dd0e19d8 design §1.1):
 *   - a value matching `https?:` or containing `/` or `@` — the places table
 *     stores webinar/Zoom URLs as venue names;
 *   - a value whose first character is a digit — 1,381 of 7,811 place rows are
 *     street addresses, and a postal address in the pattern file is noise that
 *     matches version strings and line numbers.
 * Without both, the places arm injects URLs and street addresses into a scan
 * that is supposed to hold names.
 */
export function considerEntityName(raw, filters, { rejectAddressShapes = false } = {}) {
  const n = norm(raw);
  if (!n || /[@]/.test(n)) return null;
  if (rejectAddressShapes) {
    if (/https?:/.test(n) || n.includes('/')) return null;
    if (/^[0-9]/.test(n)) return null;
  }
  const tokens = n.split(/\s+/).filter(Boolean);
  // A distinctive entity name is 2..4 whitespace tokens, each a real name part.
  if (tokens.length < 2 || tokens.length > 4) return null;
  if (tokens.some((t) => t.length < 2)) return null;
  if (tokens.some((t) => ROLE_TOKENS.has(t) || GENERIC_NAME_PARTS.has(t))) return null;
  // Require at least one genuinely distinctive token — not a common surname, not
  // a common given-name/nickname, not generic, length >= 4. This drops
  // "John Smith"-class common names that would flood the blocking scan.
  const distinctive = tokens.some(
    (t) =>
      t.length >= 4 &&
      !filters.surnames.has(t) &&
      !filters.nicknames.has(t) &&
      !GENERIC_STOPWORDS.has(t)
  );
  if (!distinctive) return null;
  if (filters.allow.has(n)) return null;
  return n;
}

// ── uniform reader plumbing ──────────────────────────────────────────────────

/** The empty class bag. Every reader starts here and fills the keys it owns. */
export function emptyValues() {
  return { terms: [], private_terms: [], literal_names: [], domains: [], emails: [], entity_ids: [] };
}

function result(values, { available = true, reason = '', rows = 0 } = {}) {
  return { values, available, reason, rows };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// ── AC9 — config/private.json, by explicit path allow-list ───────────────────

/**
 * The routing table for config/private.json (AC9, design §1.2).
 *
 * THIS IS AN ALLOW-LIST OF PATHS, NEVER A RECURSIVE WALK, and that is the whole
 * point. A recursive walk would sweep `health.medications` and `health.keywords_*`
 * — generic medical vocabulary — into a blocking corpus, where an unrelated
 * commit mentioning a common drug name would block the build. Google's
 * zero-effective-false-positive bar rules that out. The structural health field
 * (`health.domains`) is in; the health VOCABULARY fields are deliberately absent
 * from this table and stay absent. Same property protects a future top-level key:
 * anything not listed here defaults to NOT in the corpus.
 *
 * Path syntax: dots for object keys; `[]` for "each element of this array";
 * `[].field` for "this field of each object in this array"; a trailing `*` for
 * "each child object under this key". `#keys` yields the KEYS of an object rather
 * than its values (used where the values are prose, not identifiers).
 *
 * ROUTE BY MEASURED SHAPE, NOT BY THE FIELD'S NAME. Three routings here were
 * corrected after running the arm against the real file and the real tree:
 *   - `contacts.bachelor_party` stores ADDRESSES, not names → emails;
 *   - `family.email_patterns` stores local-part FRAGMENTS, not addresses → they
 *     could never match inside a whole-address intersection, so they go literal;
 *   - `locations` are place names and behave like place names: routing the ten of
 *     them as high-precision identity literals produced 86 hits on ordinary
 *     geography in product source (a US state that names a fiscal-data workbench,
 *     city names in an address normaliser). They belong with the other places.
 */
export const PRIVATE_SETTINGS_ROUTES = [
  // The owner himself.
  { path: 'owner.name', class: 'private_terms' },
  { path: 'owner.short', class: 'private_terms' },
  { path: 'owner.emails[]', class: 'emails' },

  // Family: names, short forms, handles, surnames — and the addresses separately.
  { path: 'family.wife.name', class: 'private_terms' },
  { path: 'family.wife.short', class: 'private_terms' },
  { path: 'family.son.name', class: 'private_terms' },
  { path: 'family.mother_in_law.name', class: 'private_terms' },
  { path: 'family.dog.name', class: 'private_terms' },
  { path: 'family.siblings[].name', class: 'private_terms' },
  { path: 'family.siblings[].short', class: 'private_terms' },
  { path: 'family.siblings[].handle', class: 'private_terms' },
  { path: 'family.siblings[].email', class: 'emails' },
  { path: 'family.last_name', class: 'private_terms' },
  { path: 'family.spouse_last_name', class: 'private_terms' },
  { path: 'family.email_patterns[]', class: 'private_terms' },
  // Street names the owner has lived on. A digit-initial house number is dropped
  // by keepTerm's length and distinctiveness rules.
  { path: 'family.properties[]', class: 'private_terms' },

  // Work: domains, addresses, colleagues.
  { path: 'work.*.domain', class: 'domains' },
  { path: 'work.*.email', class: 'emails' },
  { path: 'work.*.colleagues[].name', class: 'private_terms' },
  { path: 'work.*.colleagues[].short', class: 'private_terms' },
  { path: 'work.*.colleagues[].email', class: 'emails' },
  { path: 'work.*.colleagues[].pattern', class: 'private_terms' },

  // Stored contacts — BOTH lists, routed by what each actually holds.
  { path: 'contacts.static_people[]', class: 'private_terms' },
  { path: 'contacts.bachelor_party[]', class: 'emails' },

  // Health: the STRUCTURAL field only. `medications`, `conditions` and every
  // `keywords_*` field are excluded by their absence from this table — see the
  // block comment above.
  { path: 'health.domains[]', class: 'domains' },

  // Infrastructure: the private bucket name.
  { path: 'infrastructure.gcs_bucket', class: 'private_terms' },

  // Taxonomy slugs: KEYS only. The description bodies are prose and must not
  // enter a literal corpus.
  { path: 'taxonomy_descriptions#keys', class: 'private_terms' },

  // The ten places — the framing's "places I've been". Name-shaped, so they join
  // the other place names rather than the identity literals.
  { path: 'locations[]', class: 'literal_names' },

  // Archive import labels: the slugs the owner named his own historical accounts
  // by, plus those accounts' addresses. The display `name` values are excluded —
  // they wrap institution names already covered by the allowlist.
  { path: 'import_labels.archive#keys', class: 'private_terms' },
  { path: 'import_labels.archive.*.email', class: 'emails' },
];

/**
 * Resolve one route path against a parsed object. Returns an array of scalar
 * values (never objects). Missing intermediate keys yield an empty array — a
 * settings file that omits a section is not an error.
 */
function resolveRoute(root, path) {
  const keysMode = path.endsWith('#keys');
  const segments = (keysMode ? path.slice(0, -'#keys'.length) : path).split('.');
  let cursor = [root];
  for (const rawSeg of segments) {
    const next = [];
    const isEach = rawSeg.endsWith('[]');
    const seg = isEach ? rawSeg.slice(0, -2) : rawSeg;
    for (const node of cursor) {
      if (node == null || typeof node !== 'object') continue;
      if (seg === '*') {
        // Every child object under this key — the `*` in a route like
        // `import_labels.archive.*.email`, where the intermediate keys are the
        // owner's own labels and so can never be written down here.
        for (const v of Object.values(node)) next.push(v);
        continue;
      }
      const value = seg === '' ? node : node[seg];
      if (value == null) continue;
      if (isEach) {
        if (Array.isArray(value)) for (const v of value) next.push(v);
      } else {
        next.push(value);
      }
    }
    cursor = next;
  }
  const out = [];
  for (const node of cursor) {
    if (keysMode) {
      if (node && typeof node === 'object' && !Array.isArray(node)) out.push(...Object.keys(node));
      continue;
    }
    if (node == null) continue;
    if (typeof node === 'object') continue; // never flatten an unrouted object
    out.push(String(node));
  }
  return out;
}

/**
 * AC9 — the owner's private settings file. Today nothing opens it; it holds his
 * name, his addresses, his family, both stored contact lists, his work domains
 * and the ten places he has been.
 *
 * `gs://bucket` is reduced to `bucket`: the scheme prefix would make the literal
 * unmatchable by a whole-word grep, and the bucket name is the identifying part.
 */
export function fromPrivateSettings(privatePath) {
  const values = emptyValues();
  const parsed = readJson(privatePath);
  if (!parsed) {
    return result(values, { available: false, reason: `unreadable or absent: ${privatePath}`, rows: 0 });
  }
  let rows = 0;
  for (const route of PRIVATE_SETTINGS_ROUTES) {
    const literal = route.class === 'private_terms' || route.class === 'literal_names';
    for (const raw of resolveRoute(parsed, route.path)) {
      rows += 1;
      // Strip a URI scheme on the literal classes: `gs://bucket` can never match
      // under a whole-word grep, and the bucket name is the identifying part.
      const v = literal ? String(raw).replace(/^[a-z0-9]+:\/\//i, '') : String(raw);
      if (v.trim()) values[route.class].push(v);
    }
  }
  return result(values, { rows });
}

// ── AC10 — companies + places ────────────────────────────────────────────────

/**
 * AC10 — company names from the entity graph. Measured 9,531 rows → ~1,620 after
 * the distinctiveness filter. Companies were deliberately NOT scanned before this
 * story; the filter plus the address-shape rejects are what make the arm
 * affordable enough to add.
 */
export function fromCompanies(db, filters) {
  return readEntityNames(db, filters, {
    sql: 'SELECT name AS v FROM companies WHERE name IS NOT NULL',
    label: 'companies',
  });
}

/**
 * AC10 — place names from the entity graph. Measured 7,811 rows → ~667. The
 * address-shape rejects matter most here: 1,381 rows are street addresses and the
 * table stores webinar URLs as venue names.
 */
export function fromPlaces(db, filters) {
  return readEntityNames(db, filters, {
    sql: 'SELECT name AS v FROM places WHERE name IS NOT NULL',
    label: 'places',
  });
}

/**
 * AC11 — the alternate forms the owner's own records already store for people.
 * Bounded to what is recorded; no open-ended notion of a spelling variant.
 */
export function fromAliases(db, filters) {
  return readEntityNames(db, filters, {
    sql: 'SELECT alias AS v FROM person_aliases WHERE alias IS NOT NULL',
    label: 'aliases',
  });
}

/**
 * Tier B (the named residual): distinctive real PEOPLE names from the encrypted
 * live DB. Filtered hard — multi-token, no role accounts, no generic org tokens,
 * at least one genuinely distinctive token. The address-shape rejects do not
 * apply: a person row never carries a URL and a digit-initial person name is
 * vanishingly rare, so adding the guard would only cost a branch.
 */
export function fromPeopleNames(db, filters) {
  return readEntityNames(db, filters, {
    sql: 'SELECT display_name AS v FROM people WHERE display_name IS NOT NULL',
    label: 'people',
    rejectAddressShapes: false,
  });
}

function readEntityNames(db, filters, { sql, label, rejectAddressShapes = true }) {
  const values = emptyValues();
  if (!db) return result(values, { available: false, reason: 'no DB handle', rows: 0 });
  let rows = 0;
  try {
    for (const row of db.prepare(sql).iterate()) {
      rows += 1;
      const kept = considerEntityName(row.v, filters, { rejectAddressShapes });
      if (kept) values.literal_names.push(kept);
    }
  } catch (err) {
    return result(values, { available: false, reason: `${label} read failed: ${err.message}`, rows });
  }
  return result(values, { rows });
}

// ── AC11 — contact emails, employer domains ──────────────────────────────────

/**
 * AC11 — every real address in the owner's graph (~34.6k). These NEVER become
 * literal grep patterns: 61k literals cost 36.9s per scan, while one structural
 * email-shape grep plus a Set intersection costs 0.12s and does not grow with the
 * corpus. See lib/corpus-scan.js scanShape.
 *
 * This is the highest-recall arm available — addresses are pattern-shaped in a
 * way names are not.
 */
export function fromContactEmails(db) {
  const values = emptyValues();
  if (!db) return result(values, { available: false, reason: 'no DB handle', rows: 0 });
  let rows = 0;
  try {
    for (const row of db
      .prepare("SELECT value AS v FROM person_identifiers WHERE type = 'email' AND value IS NOT NULL")
      .iterate()) {
      rows += 1;
      const v = norm(row.v);
      if (v.includes('@')) values.emails.push(v);
    }
  } catch (err) {
    return result(values, { available: false, reason: `contact emails read failed: ${err.message}`, rows });
  }
  return result(values, { rows });
}

/**
 * AC11 — company domains, SCOPED TO EMPLOYERS.
 *
 * WHY THE SCOPE IS LOAD-BEARING (measured, design §1.4): all 9,533 domains
 * against the tracked tree produce 366 (term, file) pairs — dominated by the
 * product's own domain in 149 files including README.md — plus every public brand
 * the graph has ever recorded. A blocking gate on that set blocks the repository's
 * own README. `companies.tier` cannot separate them (uniform value across all
 * 9,531 rows — a dead column). `companies.n2 = 'Employer'` can: 25 domains,
 * 1 (term, file) pair, and it is the literal database expression of the framing's
 * "companies I'm part of". `Core` is relationship strength, not affiliation.
 *
 * EXTENSION POINT: if a later story needs affiliation beyond employment — board
 * seats, investments, advisory roles — widen the n2 predicate here and nowhere
 * else. No other extension point is designed in.
 */
export function fromEmployerDomains(db) {
  const values = emptyValues();
  if (!db) return result(values, { available: false, reason: 'no DB handle', rows: 0 });
  let rows = 0;
  try {
    for (const row of db
      .prepare(
        `SELECT cd.domain AS v
           FROM company_domains cd
           JOIN companies c ON c.id = cd.company_id
          WHERE c.n2 = 'Employer' AND cd.domain IS NOT NULL`
      )
      .iterate()) {
      rows += 1;
      const v = norm(row.v);
      if (v) values.domains.push(v);
    }
  } catch (err) {
    return result(values, { available: false, reason: `employer domains read failed: ${err.message}`, rows });
  }
  return result(values, { rows });
}

// ── entity content-ids (people, companies, and — new for AC10 — places) ──────

/**
 * Entity content-ids that suffix the context dir names. Returned for the
 * structural id-shape intersection, never as literal patterns: 155k ids never
 * become 155k greps. Reading dir names (not the DB) keeps this cheap and
 * dependency-free.
 *
 * `places` is new in st_dd0e19d8 (AC10) — and it is the reason the suffix pattern
 * widened. MEASURED: people and companies suffix a 16-hex id (117,706 and 33,914
 * dirs), but every one of the 3,415 place dirs suffixes a 12-hex id, as do 45
 * company dirs. A 16-only pattern reads all 3,460 of them as "no id present" and
 * silently contributes nothing — the arm would have looked wired and caught
 * nothing. The intersection against the real id set is what keeps the wider shape
 * safe: an unrelated 12-hex token in source is ignored.
 */
export const ENTITY_ID_SUFFIX = /--([0-9a-f]{12,16})$/;

export function fromEntityContexts(contextsDir) {
  const values = emptyValues();
  let rows = 0;
  let read = 0;
  for (const sub of ['people', 'companies', 'places']) {
    let names = [];
    try {
      names = readdirSync(join(contextsDir, sub));
      read += 1;
    } catch {
      continue; // fresh clone — no entity graph on disk
    }
    for (const name of names) {
      rows += 1;
      const m = name.match(ENTITY_ID_SUFFIX);
      if (m) values.entity_ids.push(m[1]);
    }
  }
  if (read === 0) {
    return result(values, { available: false, reason: `no entity context dirs under ${contextsDir}`, rows });
  }
  return result(values, { rows });
}

// ── Tier A — the gitignored config/*.user.json overrides ─────────────────────

/**
 * Tier A: exact, distinctive owner terms from the gitignored config overrides —
 * employer/routing/taxonomy/company/family/venture. Near-zero false positives, so
 * a hit fails the gate. Domains/gids/calendar-ids are the composed
 * check-public-config-clean.js's job and are intentionally not duplicated here.
 */
export function fromConfigOverrides(configDir) {
  const values = emptyValues();
  const seen = new Set();
  let rows = 0;
  const add = (v) => {
    rows += 1;
    const n = norm(v);
    if (n && !seen.has(n)) {
      seen.add(n);
      values.terms.push(n);
    }
  };

  // asana-routing.user.json — destination slugs (non-default), labels, aliases.
  const asana = readJson(join(configDir, 'asana-routing.user.json'));
  if (asana) {
    for (const key of Object.keys(asana.destinations || {})) {
      if (key !== 'default') add(key);
    }
    for (const dest of Object.values(asana.destinations || {})) {
      if (dest && dest.label) add(dest.label);
    }
    for (const [k, v] of Object.entries(asana.topicAliases || {})) {
      add(k);
      add(v);
    }
  }

  // source-topic-routing.user.json — the routed topic slug VALUES (the owner's
  // employer/school/venture slugs). The domain KEYS are check-public-config-
  // clean.js's job (owner domains) and are not duplicated here.
  const src = readJson(join(configDir, 'source-topic-routing.user.json'));
  if (src) for (const v of Object.values(src.domains || {})) add(v);

  // company-aliases.user.json — brand VALUES (proper names) + alias KEYS.
  const aliases = readJson(join(configDir, 'company-aliases.user.json'));
  if (aliases) {
    for (const [k, v] of Object.entries(aliases.aliases || {})) {
      add(k);
      add(v);
    }
  }

  // taxonomy.user.json — labels + topic keys ABSENT from the tracked generic
  // default (the owner-specific slice). Generic labels shared with the default
  // (Career, Health, …) are excluded so the gate never flags the product's own
  // vocabulary.
  const taxUser = readJson(join(configDir, 'taxonomy.user.json'));
  const taxDefault = readJson(join(configDir, 'taxonomy.default.json')) || {};
  const defaultLabels = new Set();
  const defaultKeys = new Set();
  for (const section of Object.values(taxDefault)) {
    if (section && typeof section === 'object' && section.topics) {
      for (const [tkey, t] of Object.entries(section.topics)) {
        defaultKeys.add(norm(tkey));
        if (t && t.label) defaultLabels.add(norm(t.label));
      }
    }
  }
  if (taxUser) {
    for (const section of Object.values(taxUser)) {
      if (!section || typeof section !== 'object' || !section.topics) continue;
      for (const [tkey, t] of Object.entries(section.topics)) {
        if (!defaultKeys.has(norm(tkey))) add(tkey);
        if (t && t.label && !defaultLabels.has(norm(t.label))) add(t.label);
      }
    }
  }

  // viewer-topic-lens.user.json — the alphanumeric word-runs inside each match
  // regex (the owner's school/employer lens keys) + prewarm entity slugs.
  const lens = readJson(join(configDir, 'viewer-topic-lens.user.json'));
  if (lens) {
    for (const l of lens.lenses || []) {
      if (!l || !l.match) continue;
      // Replace regex word-boundary escapes (\b) with a space BEFORE splitting so
      // a pattern like `\bxyz\b` yields "xyz", not the artifact "bxyz".
      const cleaned = String(l.match).replace(/\\[a-z]/gi, ' ');
      for (const word of cleaned.split(/[^a-z0-9]+/i)) {
        if (word && word.length >= 4) add(word);
      }
    }
    for (const route of lens.prewarmRoutes || []) {
      // entities/people|companies/<name-slug>--<id> → the human/brand name. Only
      // people/companies (a place slug is a long address fragment that yields junk
      // multi-token noise). Keep tokens of length >= 3 so a stray single char from
      // a messy slug never enters the corpus.
      const m = String(route).match(/^entities\/(?:people|companies)\/([a-z][a-z-]+[a-z])--[0-9a-f]{12,}/i);
      if (m) {
        const parts = m[1].split('-').filter((p) => p.length >= 3);
        if (parts.length >= 2) add(parts.join(' '));
      }
    }
  }

  // family.json — member full names (multi-token distinctive) + surname patterns.
  const family = readJson(join(configDir, 'family.json'));
  if (family) {
    for (const m of family.members || []) if (m && m.name) add(m.name);
    for (const sp of family.surname_patterns || []) if (sp && sp.surname) add(sp.surname);
  }

  // identity.json — the declared name (belt-and-suspenders over gate-pii.sh).
  const identity = readJson(join(configDir, 'identity.json'));
  if (identity && identity.name) add(identity.name);

  return result(values, { rows });
}

// ── stopword dictionaries + allowlist ────────────────────────────────────────

/**
 * Load the surname + nickname stopword dictionaries (Tier 0, already in the
 * repo). Used to drop single tokens that collide with a common surname or a
 * common given-name/nickname. Degrades to empty sets if a dictionary is missing
 * (fresh clone) — the gate still runs.
 */
export function loadStopwordDicts(configDir) {
  const surnames = new Set();
  const nicknames = new Set();
  const sn = readJson(join(configDir, 'surnames-top-25K.json'));
  if (sn) for (const k of Object.keys(sn)) surnames.add(norm(k));
  const nn = readJson(join(configDir, 'nicknames.json'));
  if (nn) {
    for (const k of Object.keys(nn)) {
      nicknames.add(norm(k));
      for (const v of nn[k] || []) nicknames.add(norm(v));
    }
  }
  return { surnames, nicknames };
}

/**
 * AC22 — the allowlist is the UNION of the tracked file and the gitignored local
 * override, each parsed independently and each optional.
 *
 * UNION, NOT OVERRIDE, and that is the requirement: the tracked file keeps the
 * six terms that are genuinely the product's vocabulary, and the owner's local
 * file carries the thirteen that are his affiliations. An override would delete
 * the product terms on the owner's machine.
 *
 * FRESH-CLONE CORRECTNESS: the allowlist is only ever consulted to SUPPRESS terms
 * derived from the gitignored overrides and the local DB. On a clone with neither,
 * nothing is derived, so there is nothing to suppress and the missing local file
 * changes nothing. The gate's behaviour on a stranger's clone is bit-identical
 * before and after the split.
 */
export function loadAllowlist(configDir) {
  const set = new Set();
  for (const file of ['owner-corpus-allowlist.json', 'owner-corpus-allowlist.user.json']) {
    const a = readJson(join(configDir, file));
    if (a && Array.isArray(a.allow)) for (const t of a.allow) set.add(norm(t));
  }
  return set;
}
