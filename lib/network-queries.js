/**
 * Data queries for routes/network.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */
import { nicknameVariants } from './nickname-resolver.js';

/**
 * Returns visible people ordered alphabetically within each (n1, n2) bucket.
 *
 * st_93fddaf0 Phase 9 amendment (2026-05-14): within-bucket order is
 * alphabetical by display_name (case-insensitive). The original Phase 9
 * "absolute 1..N rank" path was retired per owner directive: ranking
 * within a tier is noise once the tier is correct. Tier (n1/n2 placement)
 * is the load-bearing signal; column sorting is a client-side affordance.
 *
 * ORDER BY n1, n2, LOWER(display_name) matches the composite index from
 * migration 077 (archived, n1, n2, display_name COLLATE NOCASE), keeping
 * the bucket-filtered query an O(index-scan) operation. The legacy
 * `(n1, n2, score DESC)` index from migration 074 remains in place for
 * any path that still references score-based ordering.
 *
 * No `rank` field is returned — UI computes display index from array
 * position after applying client-side sort.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} limit
 * @param {number} offset
 * @returns {Array}
 */
export function getPeopleTeaser(db, limit, offset) {
  return db.prepare(`
    SELECT p.id, p.uuid, p.display_name, p.tier, p.score, p.n1, p.n2,
      (SELECT c.name FROM companies c WHERE c.id = p.company_id LIMIT 1) AS company_name
    FROM people p
    WHERE p.archived = 0
    ORDER BY p.n1, p.n2, LOWER(p.display_name)
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

/**
 * Returns count of non-archived people.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getScoredPeopleCount(db) {
  return db.prepare('SELECT COUNT(*) as n FROM people WHERE archived = 0').get()?.n || 0;
}

/**
 * Returns class/subcategory counts for the network sidebar.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array}
 */
export function getPeopleClasses(db) {
  return db.prepare(`
    SELECT class, subcategory, COUNT(*) as count
    FROM people WHERE archived = 0 AND class IS NOT NULL
    GROUP BY class, subcategory
    ORDER BY count DESC
  `).all();
}

/**
 * Returns count of unclassified non-archived people.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getUnclassifiedPeopleCount(db) {
  return db.prepare(
    `SELECT COUNT(*) as n FROM people WHERE archived = 0 AND class IS NULL`
  ).get()?.n || 0;
}

/**
 * Returns a single person's basic profile by id (WB fallback for getPersonProfile).
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} id
 */
export function getPersonById(db, id) {
  return db.prepare(`
    SELECT p.id, p.uuid, p.display_name, p.tier, p.score,
      (SELECT c.name FROM companies c WHERE c.id = p.company_id LIMIT 1) AS company_name
    FROM people p WHERE p.id = ? AND p.archived = 0
  `).get(id);
}

/**
 * Returns a person's uuid by id.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} id
 */
export function getPersonUuidById(db, id) {
  return db.prepare('SELECT uuid FROM people WHERE id = ?').get(id);
}

/**
 * Looks up a person by uuid column, then falls back to id column.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} idOrUuid
 */
export function getPersonByUuidOrId(db, idOrUuid) {
  const q = `
    SELECT p.id, p.uuid, p.display_name, p.tier, p.score,
      (SELECT c.name FROM companies c WHERE c.id = p.company_id LIMIT 1) AS company_name
    FROM people p WHERE p.archived = 0 AND p.`;
  let p = db.prepare(q + 'uuid = ?').get(idOrUuid);
  if (!p) p = db.prepare(q + 'id = ?').get(idOrUuid);
  return p;
}

/**
 * Returns people matching a display_name LIKE pattern (WB search fallback).
 * @param {import('better-sqlite3').Database} db
 * @param {string} pattern - LIKE pattern including %
 * @param {number} limit
 */
export function searchPeopleByName(db, pattern, limit) {
  // Visibility contract: any non-archived person can match. Score affects
  // internal ordering only; low-score people remain searchable/mentionable.
  return db.prepare(
    "SELECT id, display_name, score FROM people WHERE archived = 0 AND display_name LIKE ? ORDER BY COALESCE(score, 0) DESC, display_name COLLATE NOCASE ASC LIMIT ?"
  ).all(pattern, limit);
}

// st_f67bc2eb D10 — stated-first precedence. person_relations holds STATED
// relationships (authored statements, owner answers, contact cards); the
// legacy entity_relationships rows are machine-derived (5.65M colleague rows,
// frozen by OOS-1). Wherever both are readable, stated wins and legacy rows
// fill only pairs with no stated edge in the same domain — the product can
// never show two colleague truths.
const LEGACY_TYPE_DOMAIN = Object.freeze({
  spouse: 'kinship', family: 'kinship', pet: 'kinship',
  'romantic-partner': 'kinship', 'former-romantic-partner': 'kinship',
  'former-spouse': 'kinship', 'former-family': 'kinship',
  friend: 'social', 'former-friend': 'social',
  acquaintance: 'social', 'former-acquaintance': 'social',
});

/** Domain a legacy entity_relationships row competes in (default professional). */
export function legacyEdgeDomain(relationshipType) {
  return LEGACY_TYPE_DOMAIN[String(relationshipType || '').trim()] || 'professional';
}

/**
 * Returns the strongest relationship edge for an entity — STATED edges first
 * (kinship > social > professional; owner > contact > stated within a
 * domain), the legacy machine-derived table only when no stated edge exists.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} personId
 */
export function getPersonRelationshipEdge(db, personId) {
  try {
    const stated = db.prepare(`
      SELECT rel_type AS relationship_type FROM person_relations
      WHERE status = 'active' AND (person_a = ? OR person_b = ?)
      ORDER BY CASE domain WHEN 'kinship' THEN 1 WHEN 'social' THEN 2 ELSE 3 END,
               CASE authority WHEN 'owner' THEN 1 WHEN 'contact' THEN 2 ELSE 3 END,
               confidence DESC, id ASC
      LIMIT 1
    `).get(String(personId), String(personId));
    if (stated) return stated;
  } catch { /* table absent in minimal fixtures — legacy fallback below */ }
  return db.prepare(
    `SELECT relationship_type FROM entity_relationships
     WHERE entity_id_a = ? OR entity_id_b = ?
     ORDER BY CASE source WHEN 'relation_tag' THEN 1 WHEN 'company_affiliation' THEN 2 ELSE 3 END,
              weight DESC LIMIT 1`
  ).get(personId, personId);
}

/**
 * Stated (person_relations) edges for an entity, shaped like the legacy edge
 * rows so route serializers need no fork: relationship_type, weight (mapped
 * from confidence), display names, plus stated-only columns (authority,
 * domain, derived source marker).
 */
export function getStatedEdges(db, entityId) {
  try {
    return db.prepare(`
      SELECT pr.id, pr.person_a AS entity_id_a, pr.person_b AS entity_id_b,
             'person' AS entity_type_a, 'person' AS entity_type_b,
             pr.rel_type AS relationship_type, pr.domain, pr.authority,
             pr.confidence AS weight, pr.stated_at AS last_seen,
             pr.valid_from AS first_seen, pr.valid_until,
             'person_relations' AS source,
             p1.display_name AS display_name_a, p2.display_name AS display_name_b
      FROM person_relations pr
      LEFT JOIN people p1 ON pr.person_a = p1.id
      LEFT JOIN people p2 ON pr.person_b = p2.id
      WHERE pr.status = 'active' AND (pr.person_a = ? OR pr.person_b = ?)
      ORDER BY CASE pr.domain WHEN 'kinship' THEN 1 WHEN 'social' THEN 2 ELSE 3 END, pr.id ASC
    `).all(String(entityId), String(entityId));
  } catch {
    return [];
  }
}

/**
 * Stated-first filter: drop legacy rows whose (unordered pair, domain) is
 * already covered by a stated edge. One precedence rule for every listing.
 */
export function filterLegacyEdgesAgainstStated(legacyRows, statedRows) {
  if (!statedRows.length) return legacyRows;
  const covered = new Set(statedRows.map((s) => {
    const [a, b] = [String(s.entity_id_a), String(s.entity_id_b)].sort();
    return `${a}|${b}|${s.domain}`;
  }));
  return legacyRows.filter((r) => {
    const [a, b] = [String(r.entity_id_a), String(r.entity_id_b)].sort();
    return !covered.has(`${a}|${b}|${legacyEdgeDomain(r.relationship_type)}`);
  });
}

/**
 * Returns all relationship edges for an entity with decayed strength.
 *
 * WHY dual JOIN on both people AND companies for each side: an edge can
 * connect any pair of entity types (person↔person, person↔company,
 * company↔company). Joining only people caused NULL display names whenever
 * either endpoint was a company. COALESCE resolves whichever side is present.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} entityId
 */
export function getRelationshipEdges(db, entityId) {
  // st_f67bc2eb D10 — stated edges lead; legacy rows fill uncovered pairs.
  const stated = getStatedEdges(db, entityId).map((s) => ({ ...s, strength: Number(s.weight) || 1 }));
  const legacy = db.prepare(`
    SELECT er.*,
      er.weight * exp(-0.0019 * (julianday('now') - julianday(COALESCE(er.last_seen, datetime('now'))))) as strength,
      COALESCE(p1.display_name, c1.name) as display_name_a,
      COALESCE(p2.display_name, c2.name) as display_name_b
    FROM entity_relationships er
    LEFT JOIN people   p1 ON er.entity_id_a = p1.id
    LEFT JOIN companies c1 ON er.entity_id_a = c1.id
    LEFT JOIN people   p2 ON er.entity_id_b = p2.id
    LEFT JOIN companies c2 ON er.entity_id_b = c2.id
    WHERE er.entity_id_a = ? OR er.entity_id_b = ?
    ORDER BY strength DESC
  `).all(entityId, entityId);
  return [...stated, ...filterLegacyEdgesAgainstStated(legacy, stated)];
}

/**
 * Returns all entity_relationships edges connected to a given entity,
 * with resolved display names for both endpoints.
 *
 * Covers all entity-type combinations (person↔person, person↔company,
 * company↔company, etc.) via COALESCE across people + companies on each side.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} entityId   - the entity whose connections to fetch
 * @param {string}        entityType - 'person' | 'company' | 'place'
 * @returns {Array}
 */
export function getEntityConnections(db, entityId, entityType) {
  // st_f67bc2eb D10 — stated (person_relations) edges lead; legacy
  // machine-derived rows fill only pairs with no stated edge in the same
  // domain. Never two colleague truths.
  const stated = entityType === 'person' ? getStatedEdges(db, entityId) : [];
  const legacy = db.prepare(`
    SELECT
      er.id,
      er.entity_id_a,
      er.entity_type_a,
      er.entity_id_b,
      er.entity_type_b,
      er.relationship_type,
      er.weight,
      er.source,
      er.first_seen,
      er.last_seen,
      COALESCE(p1.display_name, c1.name) as display_name_a,
      COALESCE(p2.display_name, c2.name) as display_name_b
    FROM entity_relationships er
    LEFT JOIN people    p1 ON er.entity_id_a = p1.id
    LEFT JOIN companies c1 ON er.entity_id_a = c1.id
    LEFT JOIN people    p2 ON er.entity_id_b = p2.id
    LEFT JOIN companies c2 ON er.entity_id_b = c2.id
    WHERE er.entity_id_a = ? OR er.entity_id_b = ?
    ORDER BY er.weight DESC, er.last_seen DESC
  `).all(entityId, entityId);
  return [...stated, ...filterLegacyEdgesAgainstStated(legacy, stated)];
}

/**
 * Returns the count of non-archived people.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getPeopleCount(db) {
  return db.prepare('SELECT COUNT(*) as n FROM people WHERE archived = 0').get()?.n || 0;
}

/**
 * Returns place subtypes with counts (ontology-aligned sidebar view).
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} subtypes
 */
export function getPlaceSubtypeCounts(db, subtypes) {
  return db.prepare(`
    SELECT place_subtype, COUNT(*) as count
    FROM places
    WHERE hidden_in_sidebar = 0
      AND (sub_type IS NULL OR sub_type != 'travel')
      AND place_subtype IN (${subtypes.map(() => '?').join(',')})
    GROUP BY place_subtype
    ORDER BY count DESC
  `).all(...subtypes);
}

/**
 * Returns count of places matching where clause + params.
 * @param {import('better-sqlite3').Database} db
 * @param {string} where
 * @param {any[]} params
 * @returns {number}
 */
export function getPlacesAllCount(db, where, params) {
  return db.prepare(`SELECT COUNT(*) as n FROM places WHERE ${where}`).get(...params)?.n || 0;
}

/**
 * Returns places with recency-weighted ordering.
 * @param {import('better-sqlite3').Database} db
 * @param {string} where
 * @param {any[]} params
 * @param {number} limit
 * @param {number} offset
 */
export function getPlacesAll(db, where, params, limit, offset) {
  return db.prepare(`
    SELECT id, name, place_subtype, sub_type, frequency, total_visits, first_seen, last_seen
    FROM places WHERE ${where}
    ORDER BY (COALESCE(total_visits, 0) * CASE
      WHEN julianday('now') - julianday(COALESCE(last_seen,'2000-01-01')) < 30  THEN 1.0
      WHEN julianday('now') - julianday(COALESCE(last_seen,'2000-01-01')) < 90  THEN 0.75
      WHEN julianday('now') - julianday(COALESCE(last_seen,'2000-01-01')) < 180 THEN 0.5
      WHEN julianday('now') - julianday(COALESCE(last_seen,'2000-01-01')) < 365 THEN 0.3
      ELSE 0.15
    END) DESC, last_seen DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

/**
 * Returns top-5 preferred places per venue type.
 * @param {import('better-sqlite3').Database} db
 * @param {string} placeType - e.g. 'restaurant'
 */
export function getPlacePreferences(db, placeType) {
  return db.prepare(
    `SELECT id, name, frequency, sub_type, first_seen, last_seen FROM places
     WHERE place_type = 'venue' AND place_subtype = ? AND useful = 1
     ORDER BY frequency DESC LIMIT 5`
  ).all(placeType);
}

/**
 * Returns city places ordered by lived-in status + visit count.
 * @param {import('better-sqlite3').Database} db
 */
export function getCities(db) {
  return db.prepare(
    `SELECT id, name, frequency, years_lived, total_visits, first_seen, last_seen
     FROM places WHERE place_type = 'city'
     ORDER BY CASE WHEN years_lived > 0 THEN 0 ELSE 1 END, total_visits DESC`
  ).all();
}

/**
 * Returns venue subtypes with counts.
 * @param {import('better-sqlite3').Database} db
 */
export function getVenueSubtypes(db) {
  return db.prepare(`SELECT place_subtype, COUNT(*) as count FROM places WHERE place_type = 'venue' AND place_subtype IS NOT NULL AND place_subtype != 'other' GROUP BY place_subtype ORDER BY count DESC`).all();
}

/**
 * Looks up a person by uuid (no archived filter) for /people/:id extended lookup.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} idOrUuid
 */
export function getPersonByUuidOrIdExtended(db, idOrUuid) {
  const q = `
    SELECT p.id, p.uuid, p.display_name, p.tier, p.score,
      (SELECT c.name FROM companies c WHERE c.id = p.company_id LIMIT 1) AS company_name
    FROM people p WHERE p.`;
  let p = db.prepare(q + 'uuid = ?').get(idOrUuid);
  if (!p) p = db.prepare(q + 'id = ?').get(idOrUuid);
  return p;
}

/**
 * Returns companies matching where clause with domain enrichment.
 * @param {import('better-sqlite3').Database} db
 * @param {string} where
 * @param {any[]} params
 * @param {number} limit
 * @param {number} offset
 * @returns {{ total: number, rows: Array }}
 */
export function getCompanies(db, where, params, limit, offset) {
  const total = db.prepare(`SELECT COUNT(*) as count FROM companies WHERE ${where}`).get(...params)?.count || 0;
  const rows = db.prepare(`SELECT * FROM companies WHERE ${where} ORDER BY people_count DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { total, rows };
}

/**
 * Returns domains for a company.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} companyId
 */
export function getCompanyDomains(db, companyId) {
  return db.prepare('SELECT domain FROM company_domains WHERE company_id = ?').all(companyId).map(d => d.domain);
}

/**
 * Prepares a reusable domain statement for batch domain lookups.
 * @param {import('better-sqlite3').Database} db
 */
export function prepareCompanyDomainStmt(db) {
  return db.prepare('SELECT domain FROM company_domains WHERE company_id = ?');
}

/**
 * Returns a company with its people and domains.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} id
 */
export function getCompanyWithPeople(db, id) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!company) return null;
  const people = db.prepare('SELECT id, display_name, tier, score FROM people WHERE company_id = ? AND archived = 0 ORDER BY score DESC').all(company.id);
  const domains = db.prepare('SELECT domain FROM company_domains WHERE company_id = ?').all(company.id).map(d => d.domain);
  return { ...company, people, domains };
}

/**
 * Returns a basic person profile by id (for context narrative).
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} id
 */
export function getPersonForContext(db, id) {
  return db.prepare(`
    SELECT p.id, p.display_name, p.tier, p.score,
      (SELECT c.name FROM companies c WHERE c.id = p.company_id LIMIT 1) AS company_name
    FROM people p WHERE p.id = ?
  `).get(id);
}

/**
 * Updates a field on a person row.
 * @param {import('better-sqlite3').Database} db
 * @param {string} field - validated field name
 * @param {any} val
 * @param {string|number} id
 */
export function updatePersonField(db, field, val, id) {
  return db.prepare(`UPDATE people SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(val, id);
}

/**
 * Inserts a person identifier (idempotent).
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} personId
 * @param {string} type
 * @param {string} value
 */
export function insertPersonIdentifier(db, personId, type, value) {
  return db.prepare('INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source) VALUES (?, ?, ?, ?)').run(personId, type, value, 'manual');
}

/**
 * Deletes a person identifier by id + personId.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} id
 * @param {string|number} personId
 */
export function deletePersonIdentifier(db, id, personId) {
  return db.prepare('DELETE FROM person_identifiers WHERE id = ? AND person_id = ?').run(id, personId);
}

/**
 * Returns rebuild summary counts.
 * @param {import('better-sqlite3').Database} db
 */
export function getRebuildCounts(db) {
  return {
    people:       db.prepare('SELECT COUNT(*) as n FROM people WHERE archived = 0').get()?.n || 0,
    companies:    db.prepare('SELECT COUNT(*) as n FROM companies').get()?.n || 0,
    places:       db.prepare('SELECT COUNT(*) as n FROM places').get()?.n || 0,
    family_groups: db.prepare('SELECT COUNT(*) as n FROM person_groups').get()?.n || 0,
  };
}

// st_fd14cdd4 — MEANINGFUL-PERSON predicate for the CHAT recognition/search path.
//
// WHY: chat inline-recognition (lib/chat-context.js) resolves typed name spans
// through a `display_name LIKE` matcher. The word-start `% q%` branch is
// un-indexable, so over the full people table SQLite scans every non-archived
// row (~385k live, the overwhelming majority email-backfill noise). That scan is
// the dominant warm-turn cost (~0.45–1.3 s/span, ~5 s under writer load). The fix
// caps the chat candidate set to MEANINGFUL people — real relationships, not
// every email address — without touching storage. Every person row still exists
// and is reachable by id/uuid; only the fuzzy name-match pool is bounded.
//
// THE DEFINITION (owner directive 2026-06-13): "include everyone EXCEPT noise."
// The classifier writes a relationship tier into BOTH `personal_tier` and
// `business_tier` (NOT the `tier` column, which has no noise bucket). Each holds
// one of {core, network, acquaintance, noise}. A person is MEANINGFUL when either
// dimension is a real relationship — i.e. set and not 'noise'. Acquaintance is
// now INCLUDED (it is a real, if light, relationship); only 'noise' is excluded.
//   (personal_tier IS NOT NULL AND personal_tier != 'noise')
//   OR (business_tier IS NOT NULL AND business_tier != 'noise')
// The two dimensions are OR'd so a person who is noise on one axis but a real
// contact on the other still resolves. On the live DB this is 15,822 rows (vs
// 384,854 active) — same magnitude as the prior signal-union definition, so the
// index seek stays just as fast; this is a cleaner, explicit "not noise" rule.
//
// (The IS NOT NULL guards are defensive: on the live active set there are zero
// NULL tiers, but a future un-classified row must not slip into the search pool
// via `NULL != 'noise'` being neither true nor matchable — SQL three-valued
// logic returns UNKNOWN for `NULL != 'noise'`, which already excludes it, but the
// explicit IS NOT NULL keeps the predicate self-documenting and index-stable.)
//
// CONTRACT (load-bearing): this string MUST stay byte-identical to the WHERE
// clause of idx_people_searchable_name (currently defined by
// lib/migrations/112_people_searchable_humans_only.sql, which rebuilds the
// predicate over human-looking meaningful people). SQLite honors `INDEXED BY`
// on a partial index only when the query's WHERE textually implies the index's
// WHERE; the bounded query below pins the plan with
// `INDEXED BY idx_people_searchable_name`, so any drift between this predicate
// and the migration silently turns the index seek back into a full-table scan.
// The literals are baked into the index at migration time and therefore cannot
// move to config without a new migration; they are documented constants pinned
// to the index.
export const MEANINGFUL_PERSON_PREDICATE =
  "archived = 0 AND COALESCE(service_vendor, 0) = 0 AND display_name NOT LIKE '%@%' AND ((personal_tier IS NOT NULL AND personal_tier != 'noise') OR (business_tier IS NOT NULL AND business_tier != 'noise'))";

/** The exact index this predicate is pinned to (used by `INDEXED BY`). */
export const MEANINGFUL_PERSON_INDEX = 'idx_people_searchable_name';

/**
 * True when a person row satisfies the MEANINGFUL_PERSON_PREDICATE — i.e. it
 * belongs in the chat search/recognition candidate set rather than the
 * email-backfill noise. The rule is "include everyone except noise": a person is
 * meaningful when EITHER relationship dimension (personal_tier / business_tier)
 * is set and not 'noise'. Acquaintance/network/core all count; only 'noise' is
 * excluded. Pure function over the row fields the predicate reads; exported so
 * the unit test can assert the SQL predicate and this JS mirror agree on the same
 * rows. `archived` is treated as 0/1 (or boolean).
 *
 * Mirrors SQL three-valued logic: a NULL tier is NOT meaningful on that axis
 * (matches `tier IS NOT NULL AND tier != 'noise'`).
 *
 * @param {{archived?:number, personal_tier?:string|null,
 *          business_tier?:string|null}} row
 * @returns {boolean}
 */
export function isMeaningfulPerson(row) {
  if (!row) return false;
  if (Number(row.archived) === 1) return false;
  if (Number(row.service_vendor || 0) === 1) return false;
  if (String(row.display_name || '').includes('@')) return false;
  const notNoise = (t) => t != null && String(t) !== 'noise';
  return notNoise(row.personal_tier) || notNoise(row.business_tier);
}

/**
 * Entity search bounded to MEANINGFUL people — the CHAT recognition/search path.
 *
 * st_fd14cdd4: the PEOPLE sub-query (1) is scoped to MEANINGFUL_PERSON_PREDICATE
 * and (2) pins idx_people_searchable_name via `INDEXED BY` so the word-start LIKE
 * branch scans ~16k index entries instead of ~385k active table rows (measured
 * ~0.4 ms/lookup vs ~416 ms). Companies and places are small tables (no noise-
 * noise problem) so a real company/place still resolves in chat. This is the
 * sole entity-search query in the codebase — the unbounded variant that backed
 * the removed @-mention person-search route (/api/entities/search) was deleted
 * with that feature (st_fd14cdd4 follow-up, 2026-06-13).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} q
 * @param {number} limit
 */
export function searchMeaningfulEntities(db, q, limit) {
  const query = String(q || '').trim();
  if (!query) return [];
  if (query.length < 3 && !query.includes(' ')) return [];

  const normalizedName = normalizeNameSearchText(query);
  const tokens = normalizedName.split(' ').filter(Boolean);
  const nameVariants = buildNameSearchVariants(normalizedName);
  const primaryVariant = nameVariants[0] || normalizedName;
  const startsWith = `${primaryVariant}%`;
  const wordStartsWith = `% ${primaryVariant}%`;
  const displayPatterns = buildDisplaySearchPatterns(nameVariants);
  const displayPatternValues = displayPatterns.length ? displayPatterns : [startsWith, wordStartsWith];
  const displayPatternSql = displayPatternValues.map(() => 'display_name LIKE ?').join('\n        OR ');
  const aliasValues = nameVariants.length ? nameVariants : [normalizedName];
  const aliasPlaceholders = aliasValues.map(() => '?').join(', ');
  const companyStartsWith = `${query}%`;
  const companyWordStartsWith = `% ${query}%`;

  // INDEXED BY pins the partial index. The WHERE clause is the index predicate
  // verbatim (MEANINGFUL_PERSON_PREDICATE) so SQLite accepts the hint and runs
  // the bounded ~16k set instead of the full active table.
  const people = db.prepare(`
    SELECT id, uuid, display_name, n1, n2, 'person' as type, COALESCE(score, 0) as score,
      (
        SELECT value FROM person_identifiers
        WHERE person_id = people.id
          AND type = 'name'
          AND value IN (${aliasPlaceholders})
        ORDER BY CASE WHEN value = ? THEN 0 ELSE 1 END
        LIMIT 1
      ) AS matched_name
    FROM people INDEXED BY ${MEANINGFUL_PERSON_INDEX}
    WHERE ${MEANINGFUL_PERSON_PREDICATE}
      AND (
        ${displayPatternSql}
        OR id IN (
          SELECT person_id FROM person_identifiers
          WHERE type = 'name' AND value IN (${aliasPlaceholders})
        )
      )
    ORDER BY
      CASE
        WHEN matched_name IS NOT NULL THEN 0
        WHEN lower(display_name) = lower(?) THEN 1
        WHEN lower(display_name) LIKE lower(?) THEN 2
        WHEN lower(display_name) LIKE lower(?) THEN 3
        WHEN ? IS NOT NULL AND lower(display_name) LIKE lower(?) THEN 4
        ELSE 5
      END,
      CASE WHEN n2 IS NOT NULL THEN 0 ELSE 1 END,
      COALESCE(score, 0) DESC,
      display_name COLLATE NOCASE ASC
    LIMIT ?
  `).all(
    ...aliasValues,
    primaryVariant,
    ...displayPatternValues,
    ...aliasValues,
    query,
    startsWith,
    wordStartsWith,
    displayPatternValues.find((p) => p.includes('% ')) || null,
    displayPatternValues.find((p) => p.includes('% ')) || null,
    limit,
  );

  const companies = db.prepare(`
    SELECT id, name as display_name, n1, n2, 'company' as type, COALESCE(people_count, 0) as score
    FROM companies
    WHERE name LIKE ? OR name LIKE ?
    ORDER BY
      CASE
        WHEN lower(name) = lower(?) THEN 0
        WHEN lower(name) LIKE lower(?) THEN 1
        WHEN lower(name) LIKE lower(?) THEN 2
        ELSE 3
      END,
      CASE WHEN n2 IS NOT NULL THEN 0 ELSE 1 END,
      COALESCE(people_count, 0) DESC,
      name COLLATE NOCASE ASC
    LIMIT ?
  `).all(companyStartsWith, companyWordStartsWith, query, companyStartsWith, companyWordStartsWith, Math.max(5, limit - people.length));

  const places = db.prepare(`
    SELECT id, name as display_name, 'place' as type, frequency as score
    FROM places
    WHERE name LIKE ? OR name LIKE ?
    ORDER BY
      CASE
        WHEN lower(name) = lower(?) THEN 0
        WHEN lower(name) LIKE lower(?) THEN 1
        WHEN lower(name) LIKE lower(?) THEN 2
        ELSE 3
      END,
      COALESCE(frequency, 0) DESC,
      name COLLATE NOCASE ASC
    LIMIT ?
  `).all(companyStartsWith, companyWordStartsWith, query, companyStartsWith, companyWordStartsWith, Math.max(5, limit - people.length - companies.length));

  return [...people, ...companies, ...places].slice(0, limit);
}

function buildNameSearchVariants(normalizedName) {
  const tokens = String(normalizedName || '').split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const variants = new Set([tokens.join(' ')]);
  if (tokens.length >= 2) {
    variants.add(`${tokens[0]} ${tokens[tokens.length - 1]}`);
    for (const first of nicknameVariants(tokens[0]).slice(0, 12)) {
      variants.add([first, ...tokens.slice(1)].join(' '));
      variants.add(`${first} ${tokens[tokens.length - 1]}`);
    }
  }
  return [...variants].slice(0, 24);
}

function buildDisplaySearchPatterns(nameVariants) {
  const patterns = new Set();
  for (const variant of nameVariants) {
    if (!variant) continue;
    patterns.add(`${variant}%`);
    patterns.add(`% ${variant}%`);
    const tokens = variant.split(' ').filter(Boolean);
    if (tokens.length === 2) patterns.add(`${tokens[0]}% ${tokens[1]}%`);
  }
  return [...patterns].slice(0, 72);
}

function normalizeNameSearchText(value) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
