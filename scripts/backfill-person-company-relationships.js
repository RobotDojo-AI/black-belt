/**
 * backfill-person-company-relationships.js — populate entity_relationships
 * from existing person→company affiliations.
 *
 * Two sources, in order:
 *
 *   Source A: people.company_id (direct affiliation)
 *     JOIN people → companies ON people.company_id = companies.id
 *     WHERE people.archived = 0 AND companies.id IS NOT NULL
 *     Writes: relationship_type='employee', source='company_affiliation_direct'
 *
 *   Source B: person_professional (company from email signature / domain)
 *     WHERE person_professional.company IS NOT NULL AND company != ''
 *     Resolves company via company_domains first; falls back to
 *     findOrCreateCompany by name. Skips rows where both paths fail
 *     (should not happen after the fallback).
 *     Writes: relationship_type='employee', source='person_professional'
 *
 * All edges are written via recordRelationship which upserts on conflict:
 * weight = MAX(excluded.weight, existing weight). Safe to re-run.
 *
 * Exits 0 on completion (even if 0 rows processed — empty DB is valid).
 *
 * Intelligence tier: extraction. No LLM calls.
 */

export const INTELLIGENCE_TIER = 'extraction';

process.env.ROBOTDOJO_ALLOW_PLAINTEXT ??= '1';

import { recordRelationship, findOrCreateCompany } from '../lib/entity-relationships.js';
import { default as db } from '../lib/db.js';

const log = (...args) => console.log('[backfill-person-company]', ...args);

let sourceACount = 0;
let sourceBCount = 0;
let sourceBSkipped = 0;

// ── Source A: people.company_id ───────────────────────────────────────────────
//
// Direct company affiliation: the person row already carries a company_id FK.
// One row = one edge.

log('Source A: people.company_id...');

const sourceARows = db.prepare(`
  SELECT p.id AS person_id, p.display_name, c.id AS company_id, c.name AS company_name
  FROM people p
  JOIN companies c ON p.company_id = c.id
  WHERE p.archived = 0
    AND p.company_id IS NOT NULL
`).all();

const upsertSourceA = db.transaction((rows) => {
  for (const row of rows) {
    recordRelationship(
      db,
      row.person_id,
      'person',
      row.company_id,
      'company',
      'employee',
      1.0,
      'company_affiliation_direct',
    );
    sourceACount++;
  }
});
upsertSourceA(sourceARows);

log(`Source A: ${sourceACount} edges written`);

// ── Source B: person_professional ─────────────────────────────────────────────
//
// Company name from email signature / domain analysis. The company field is
// free text; resolve to a company row via:
//   1. company_domain → company_domains table (most reliable — domain is canonical)
//   2. Fallback: findOrCreateCompany by name (creates if absent)
//
// WHY domain-first: the same company appears under many name variants in
// person_professional (e.g. "Google", "Google LLC", "Google Inc."). The domain
// is the stable identifier. If it resolves, we get the canonical company row
// instead of creating a near-duplicate.

log('Source B: person_professional...');

const sourceBRows = db.prepare(`
  SELECT pp.person_id, pp.company, pp.company_domain
  FROM person_professional pp
  WHERE pp.company IS NOT NULL
    AND pp.company != ''
`).all();

// Prepare domain-based lookup once (many rows may share the same domain).
const domainLookup = db.prepare(
  `SELECT company_id FROM company_domains WHERE LOWER(TRIM(domain)) = LOWER(TRIM(?)) LIMIT 1`,
);

const upsertSourceB = db.transaction((rows) => {
  for (const row of rows) {
    let companyId = null;

    // Path 1: resolve via company_domain column.
    if (row.company_domain) {
      const domainRow = domainLookup.get(row.company_domain.toLowerCase().trim());
      if (domainRow?.company_id) {
        companyId = domainRow.company_id;
      }
    }

    // Path 2: fall back to findOrCreateCompany by name.
    if (!companyId) {
      try {
        const co = findOrCreateCompany(db, row.company);
        companyId = co.id;
      } catch {
        // findOrCreateCompany only throws on empty name; we already guarded
        // against that in the WHERE clause. Skip defensively if it still fires.
        sourceBSkipped++;
        continue;
      }
    }

    recordRelationship(
      db,
      row.person_id,
      'person',
      companyId,
      'company',
      'employee',
      1.0,
      'person_professional',
    );
    sourceBCount++;
  }
});
upsertSourceB(sourceBRows);

log(`Source B: ${sourceBCount} edges written, ${sourceBSkipped} skipped`);

// ── Summary ───────────────────────────────────────────────────────────────────

const totalEdges = db.prepare(
  `SELECT COUNT(*) as n FROM entity_relationships`,
).get()?.n ?? 0;

log(`done — source_a=${sourceACount} source_b=${sourceBCount} skipped=${sourceBSkipped}`);
log(`total entity_relationships in DB: ${totalEdges}`);
process.exit(0);
