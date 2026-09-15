/**
 * entity-relationships.js — typed, weighted relationship edges between entities.
 *
 * Records manual relationships between persons, places, and companies with
 * approved types and a weight. Validates that the relationship type is in the
 * approved set before writing — new types require owner approval.
 *
 * Intelligence tier: extraction. Deterministic SQL only; no LLM calls.
 *
 * UNIQUE constraint: (entity_id_a, entity_id_b, relationship_type, source).
 * Upsert on conflict: weight = MAX(excluded.weight, existing weight) so that
 * the strongest observed signal wins and weaker re-recordings never downgrade.
 */

import { randomUUID } from 'node:crypto';

export const INTELLIGENCE_TIER = 'extraction';

/**
 * Approved relationship types (owner approval required to extend this set).
 *
 * WHY a Set: closed vocabulary prevents silent misspellings accumulating as
 * orphaned edge types. New types require an explicit code change, which gates
 * them behind the normal review and commit path.
 */
export const APPROVED_RELATIONSHIP_TYPES = new Set([
  // Employment
  'employee',              // entity_a is currently employed by entity_b
  'former-employee',
  'founder',               // entity_a founded entity_b
  'former-founder',
  'co-founder',
  'former-co-founder',
  'board-member',
  'former-board-member',
  'advisor',
  'former-advisor',
  'partner',               // business partner
  'former-partner',

  // Investment
  'invested-in',           // entity_a invested in entity_b (current position)
  'former-invested-in',    // entity_a exited their investment in entity_b

  // Commercial
  'customer',
  'former-customer',
  'vendor',
  'former-vendor',

  // Education
  'classmate',
  'former-classmate',
  'mentor',
  'former-mentor',
  'mentee',
  'former-mentee',

  // Personal / social (also formalizes auto-generated types)
  'colleague',
  'former-colleague',
  'friend',
  'former-friend',
  'acquaintance',
  'former-acquaintance',
  'romantic-partner',
  'former-romantic-partner',
  'spouse',
  'former-spouse',
  'family',
  'former-family',
  // st_df0a8d71 D2 — pets are people rows (relation_tag='pet'); their
  // owner-anchored edge is typed 'pet' so edge consumers can distinguish a
  // pet from a human family edge without re-reading the tag.
  'pet',
]);

/**
 * Record a typed, weighted relationship edge between two entities.
 *
 * The edge is written idempotently — the UNIQUE constraint on
 * (entity_id_a, entity_id_b, relationship_type, source) is exploited via
 * ON CONFLICT DO UPDATE. On conflict, weight is kept at the MAX of the
 * existing value and the new value so weaker re-recordings never downgrade.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} entityA     - ID of the first entity
 * @param {string}        entityTypeA - 'person' | 'company' | 'place'
 * @param {string|number} entityB     - ID of the second entity
 * @param {string}        entityTypeB - 'person' | 'company' | 'place'
 * @param {string}        type        - must be in APPROVED_RELATIONSHIP_TYPES
 * @param {number}        [weight=1.0]
 * @param {string}        [source='manual']
 * @returns {import('better-sqlite3').RunResult}
 * @throws {Error} if type is not in APPROVED_RELATIONSHIP_TYPES
 */
export function recordRelationship(
  db,
  entityA,
  entityTypeA,
  entityB,
  entityTypeB,
  type,
  weight = 1.0,
  source = 'manual',
) {
  if (!APPROVED_RELATIONSHIP_TYPES.has(type)) {
    throw new Error(
      `Unknown relationship type "${type}". Approved types: ${[...APPROVED_RELATIONSHIP_TYPES].join(', ')}`,
    );
  }

  const now = new Date().toISOString();

  return db.prepare(`
    INSERT INTO entity_relationships
      (entity_id_a, entity_id_b, entity_type_a, entity_type_b,
       relationship_type, weight, first_seen, last_seen, source,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(entity_id_a, entity_id_b, relationship_type, source) DO UPDATE SET
      weight     = MAX(excluded.weight, weight),
      last_seen  = excluded.last_seen,
      updated_at = datetime('now')
  `).run(
    String(entityA),
    String(entityB),
    entityTypeA,
    entityTypeB,
    type,
    weight,
    now,
    now,
    source,
  );
}

/**
 * Find a company by name (case-insensitive, trimmed) or create one if absent.
 *
 * WHY case-insensitive: company names arrive from multiple sources (email
 * signatures, manual CLI input, LinkedIn titles) with inconsistent casing.
 * Deduplicating at lookup time prevents phantom duplicates in the company
 * table. The rule: LOWER(TRIM(name)) uniqueness.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} name - company display name
 * @returns {object} the company row (always present after this call)
 */
export function findOrCreateCompany(db, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('findOrCreateCompany: name must be non-empty');

  // Lookup first (case-insensitive).
  const existing = db.prepare(
    `SELECT * FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1`,
  ).get(trimmed);
  if (existing) return existing;

  // Create: minimal viable company row. n1='Company', n2='Network' matches the
  // default ontology classification for a freshly-created company entity.
  const id = randomUUID();
  db.prepare(`
    INSERT INTO companies (id, name, n1, n2, archived, created_at, updated_at)
    VALUES (?, ?, 'Company', 'Network', 0, datetime('now'), datetime('now'))
  `).run(id, trimmed);

  return db.prepare(`SELECT * FROM companies WHERE id = ?`).get(id);
}
