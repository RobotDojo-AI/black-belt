/**
 * lib/entity-claims.js — the volatile-temporal-claims store (st_553e364b,
 * design-unified-architecture.md §1.3, §4.2).
 *
 * INTELLIGENCE_TIER = 'extraction' (deterministic; no LLM call in this file).
 *
 * `entity_facts` holds stable attribute facts (job_title, employer). Volatile
 * temporal claims (a meeting date, an "active opportunity" status, a
 * headcount) are a genuinely different access pattern — high supersession,
 * staleness-prone, the exact fabrication surface reactsNullPass's old binary
 * date-or-NULL contract produced. `entity_claims` gives them a first-class,
 * provenance-tagged home: a direct mirror of the `person_relations`
 * temporal/supersede/evidence shape (migration 133), purely additive.
 *
 * LLM-write-boundary (build-conventions.md, inviolable): the LLM (reactsNullPass
 * in lib/entity-enrich.js) only ever returns TEXT proposals. recordEntityClaims()
 * below is the ONLY function that runs an INSERT against this table — the model
 * never writes a DB row directly. Every row this writer inserts is tagged
 * source_class='llm-distilled': a reactsNullPass proposal is always an
 * inference from prose, never a primary/structured source, even when it
 * carries a confident (CONFIRMED) date.
 *
 * Never a numbered lib/migrations/*.sql file: applySqlMigrations() in
 * lib/db.js auto-applies every file there to whichever DB db.js resolves at
 * import time (the LIVE db.js-managed database, by default) — see
 * lib/email-adjudication.js's identical rationale. ensureEntityClaimsSchema()
 * is a lazy, idempotent CREATE TABLE IF NOT EXISTS, called explicitly by
 * tests and by whichever future caller wires this table into a live path —
 * never implicitly at import time.
 */

import { SOURCE_CLASS } from './provenance.js';

export const INTELLIGENCE_TIER = 'extraction';

const ENTITY_TYPES = new Set(['person', 'company', 'place']);
const CLAIM_TYPES = new Set(['event', 'meeting_date', 'status', 'metric', 'general']);
const PROPOSAL_TYPES = new Set(['CONFIRMED', 'TENTATIVE']);

// Confidence per reactsNullPass proposal type (design §4.1): CONFIRMED (a
// specific date was stated/implied) is higher-confidence than TENTATIVE (an
// event is implied but there is no confident date) — both are still
// llm-distilled, neither is ever primary-source.
const PROPOSAL_CONFIDENCE = Object.freeze({ CONFIRMED: 0.8, TENTATIVE: 0.4 });

const _schemaEnsured = new WeakSet();

/**
 * Idempotent additive table create for entity_claims (design §1.3). Safe to
 * call repeatedly and safe to call on an already-migrated DB — CREATE TABLE/
 * INDEX IF NOT EXISTS only, never a destructive statement. Memoized per `db`
 * handle so a hot path calling recordEntityClaims() repeatedly against the
 * same connection doesn't re-run the DDL check every time.
 */
export function ensureEntityClaimsSchema(db) {
  if (_schemaEnsured.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_claims (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id        TEXT NOT NULL,
      entity_type      TEXT NOT NULL CHECK (entity_type IN ('person','company','place')),
      claim_type       TEXT NOT NULL CHECK (claim_type IN ('event','meeting_date','status','metric','general')),
      claim_value      TEXT NOT NULL,
      source_class     TEXT NOT NULL CHECK (source_class IN ('user-stated','primary-source','llm-distilled')),
      confidence       REAL NOT NULL DEFAULT 0.5,
      valid_at         TEXT,
      invalid_at       TEXT,
      recorded_at      TEXT NOT NULL DEFAULT (datetime('now','utc')),
      source_event_ids TEXT NOT NULL DEFAULT '[]',
      superseded_by    INTEGER,
      evidence         TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS ec_entity_current ON entity_claims(entity_id, invalid_at);
    CREATE INDEX IF NOT EXISTS ec_entity_type_current ON entity_claims(entity_id, claim_type, invalid_at);
  `);
  _schemaEnsured.add(db);
}

/**
 * Deterministic writer: reactsNullPass (the LLM) proposes text; this is the
 * ONLY code that inserts entity_claims rows (LLM-write-boundary holds). Each
 * proposal `{type: 'CONFIRMED'|'TENTATIVE', date, summary}` maps to exactly
 * one row, always source_class='llm-distilled'. TENTATIVE rows carry
 * valid_at=NULL structurally — there is no code path here that can turn a
 * TENTATIVE proposal (no confident date) into a dated row. A malformed or
 * NULL-type proposal (dropped upstream by reactsNullPass already, but checked
 * again here defensively) is skipped, never inserted, never guessed at.
 *
 * @param {Object} db
 * @param {{id:string, entity_type?:string}} entity
 * @param {Array<{type:'CONFIRMED'|'TENTATIVE', date:string|null, summary:string}>} proposals
 * @param {{claimType?:string, sourceEventIds?:string[], entityType?:string}} [options]
 * @returns {{inserted:number, ids:number[]}}
 */
export function recordEntityClaims(db, entity, proposals, options = {}) {
  const entityType = entity?.entity_type || options.entityType || 'person';
  if (!ENTITY_TYPES.has(entityType)) {
    throw new Error(`recordEntityClaims: unsupported entity_type "${entityType}"`);
  }
  if (!entity?.id) {
    throw new Error('recordEntityClaims: entity.id is required');
  }
  const claimType = options.claimType || 'event';
  if (!CLAIM_TYPES.has(claimType)) {
    throw new Error(`recordEntityClaims: unsupported claim_type "${claimType}"`);
  }

  ensureEntityClaimsSchema(db);

  const insert = db.prepare(`
    INSERT INTO entity_claims (entity_id, entity_type, claim_type, claim_value, source_class, confidence, valid_at, source_event_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sourceEventIds = JSON.stringify(options.sourceEventIds || []);

  const ids = [];
  const run = () => {
    for (const proposal of (proposals || [])) {
      if (!proposal || !PROPOSAL_TYPES.has(proposal.type)) continue; // NULL / malformed — never guessed at
      const summary = String(proposal.summary || '').trim();
      if (!summary) continue;
      const confidence = PROPOSAL_CONFIDENCE[proposal.type];
      // Structural cure for the fabrication bug: only a CONFIRMED proposal can
      // ever populate valid_at, and only with the date IT provided — TENTATIVE
      // is hard-wired to NULL here regardless of what the proposal object
      // happens to carry.
      const validAt = proposal.type === 'CONFIRMED' ? (proposal.date || null) : null;
      const info = insert.run(
        entity.id,
        entityType,
        claimType,
        summary,
        SOURCE_CLASS.LLM_DISTILLED,
        confidence,
        validAt,
        sourceEventIds,
      );
      ids.push(info.lastInsertRowid);
    }
  };
  if (typeof db.transaction === 'function') db.transaction(run)();
  else run();

  return { inserted: ids.length, ids };
}
