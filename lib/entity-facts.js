/**
 * entity-facts.js — temporal fact extraction for the entity knowledge graph.
 *
 * Facts are stored in entity_facts with valid_at / invalid_at timestamps,
 * following the Graphiti temporal fact pattern — facts are never deleted,
 * only superseded by setting invalid_at. This enables time-travel queries
 * ("what did we know about X in January 2025?").
 *
 * Initial load (bulkExtractFacts): extracts facts from structured DB columns.
 * Zero API cost — reads linkedin_title, company_id, and person_identifiers.
 *
 * Incremental (future): reads RAG chunks via Haiku for high-signal entities.
 * Not implemented in this pass — keeping the initial build deterministic and
 * zero-cost. Haiku enrichment is a follow-on story.
 *
 * WHY free-tier only for initial load: the entity_facts table starts empty.
 * A free extraction run populates it from structured columns (job_title,
 * employer, email, phone) for all N2-classified people. Haiku/Sonnet can
 * then enrich selectively on the next pass.
 *
 * INTELLIGENCE_TIER: extraction — every write in this file is deterministic
 * (structured-column reads, provenance tagging, schema DDL); no LLM call.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { markMaintenanceDirty } from './maintenance.js';
import { SOURCE_CLASS, sourceClassForModelTier } from './provenance.js';

// ── Provenance schema (runtime lazy-ensure — never a numbered migration) ────
//
// A numbered lib/migrations/*.sql file auto-applies to the LIVE db.js-managed
// database at import time on any build/QA read (applySqlMigrations() in
// lib/db.js runs every file there unconditionally) — see
// lib/email-adjudication.js's identical rationale. ensureEntityFactsProvenanceColumns
// is additive/idempotent DDL, called explicitly by tests and by the owner-run
// backfill script (scripts/backfill-entity-facts-provenance.js) — never
// implicitly. insertFact/bulkExtractFacts below never assume the columns
// exist: they check hasEntityFactsProvenanceColumns(db) (read-only) and adapt
// their INSERT shape, so both work correctly whether or not the owner has run
// the ensure/backfill step yet — no "no such column" crash on a live DB that
// hasn't been migrated, and no missed tagging once it has.

const OWNED_PROVENANCE_COLUMNS = [['source_class', 'TEXT'], ['confidence', 'REAL']];

/**
 * Idempotent additive-column ensure for entity_facts provenance
 * (source_class, confidence — design-unified-architecture.md §1.2). No
 * DEFAULT on source_class: a default would mis-tag existing sonnet/haiku rows
 * as primary-source. Existing rows stay NULL (resolveSourceClass() reads NULL
 * conservatively via the model_tier fallback) until the owner-run backfill
 * retags them.
 * @returns {{added:string[]}}
 */
export function ensureEntityFactsProvenanceColumns(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(entity_facts)').all().map((c) => c.name));
  const added = [];
  for (const [name, type] of OWNED_PROVENANCE_COLUMNS) {
    if (!existing.has(name)) {
      db.prepare(`ALTER TABLE entity_facts ADD COLUMN ${name} ${type}`).run();
      added.push(name);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS ef_source_class ON entity_facts(source_class)');
  return { added };
}

/**
 * Read-only presence check — never mutates. Fresh every call (never cached)
 * because a live db (columns absent until the owner runs the backfill) and an
 * already-migrated test db can differ within the same process — mirrors
 * lib/email-adjudication.js's hasAuditColumns() convention exactly.
 */
export function hasEntityFactsProvenanceColumns(db) {
  let cols;
  try { cols = db.prepare('PRAGMA table_info(entity_facts)').all(); }
  catch { return false; }
  const names = new Set(cols.map((c) => c.name));
  return OWNED_PROVENANCE_COLUMNS.every(([name]) => names.has(name));
}

/**
 * OWNER-RUN core logic (thin CLI wrapper: scripts/backfill-entity-facts-provenance.js).
 * Backfills source_class/confidence for legacy rows (NULL — pre-dating the
 * provenance columns), grouped and tagged by model_tier via the same
 * sourceClassForModelTier() mapping insertFact/bulkExtractFacts use for new
 * writes (design §1.2: free→primary-source/1.0, haiku/sonnet→llm-distilled/0.6).
 * Idempotent (`WHERE source_class IS NULL`) — safe to re-run. Defaults to
 * dry-run (apply:false): computes and returns the plan without writing.
 *
 * @param {Object} db
 * @param {{apply?:boolean}} [opts]
 * @returns {{apply:boolean, plan:Array<{model_tier:string,count:number,source_class:string,confidence:number}>, updated:number, totalPending:number}}
 */
export function backfillEntityFactsProvenance(db, { apply = false } = {}) {
  ensureEntityFactsProvenanceColumns(db);

  const rows = db.prepare(`
    SELECT model_tier, COUNT(*) AS n
    FROM entity_facts
    WHERE source_class IS NULL
    GROUP BY model_tier
  `).all();

  const plan = rows.map((r) => {
    const { sourceClass, confidence } = sourceClassForModelTier(r.model_tier);
    return { model_tier: r.model_tier, count: r.n, source_class: sourceClass, confidence };
  });

  let updated = 0;
  if (apply) {
    const update = db.prepare(`
      UPDATE entity_facts SET source_class = ?, confidence = ?
      WHERE source_class IS NULL AND model_tier = ?
    `);
    const run = () => {
      for (const p of plan) {
        updated += update.run(p.source_class, p.confidence, p.model_tier).changes;
      }
    };
    if (typeof db.transaction === 'function') db.transaction(run)();
    else run();
  }

  return { apply, plan, updated, totalPending: plan.reduce((sum, p) => sum + p.count, 0) };
}

/**
 * Insert a single fact into entity_facts.
 * Callers should batch inside a transaction for performance.
 *
 * @param {Object} db
 * @param {string} entityId
 * @param {string} entityType - 'person'|'company'|'place'
 * @param {string} factType - 'job_title'|'employer'|'email'|'phone'|etc.
 * @param {string} factValue
 * @param {string[]} sourceEventIds
 * @param {string|null} validAt
 * @param {string} modelTier - 'free'|'haiku'|'sonnet'
 */
export function insertFact(db, entityId, entityType, factType, factValue, sourceEventIds, validAt, modelTier, options = {}) {
  if (hasEntityFactsProvenanceColumns(db)) {
    // Derive from model_tier — mirrors resolveSourceClass()'s entity_facts
    // mapping and the backfill's confidence defaults, so a future Haiku/
    // Sonnet-tier insertFact call is tagged llm-distilled, not blanket
    // primary-source (a hardcoded constant here would silently defeat the
    // whole point of the provenance work the moment incremental LLM
    // enrichment lands).
    const { sourceClass, confidence } = sourceClassForModelTier(modelTier);
    db.prepare(`
      INSERT INTO entity_facts (entity_id, entity_type, fact_type, fact_value, source_event_ids, valid_at, model_tier, source_class, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entityId, entityType, factType, factValue, JSON.stringify(sourceEventIds || []), validAt || null, modelTier, sourceClass, confidence);
  } else {
    db.prepare(`
      INSERT INTO entity_facts (entity_id, entity_type, fact_type, fact_value, source_event_ids, valid_at, model_tier)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(entityId, entityType, factType, factValue, JSON.stringify(sourceEventIds || []), validAt || null, modelTier);
  }
  if (options.markDirty) {
    markEntityContextDirty(db, entityId, entityType, options.reason || 'entity-fact-inserted', {
      factType,
      modelTier,
      sourceEventIds,
    });
  }
}

export function markEntityContextDirty(db, entityId, entityType, reason = 'entity-fact-updated', metadata = {}) {
  const type = entityType === 'person' ? 'person' : entityType === 'company' ? 'company' : entityType === 'place' ? 'place' : null;
  if (!type) throw new Error(`unsupported entity type for dirty marker: ${entityType}`);
  return markMaintenanceDirty(db, {
    targetType: type,
    targetId: entityId,
    reason,
    priority: 70,
    metadata,
  });
}

/**
 * Bulk extract facts from structured DB columns (free tier — no model calls).
 *
 * Extracts for each N2-classified, non-archived person:
 *   - job_title    → from linkedin_title
 *   - employer     → from people.company_id JOIN companies.name
 *   - email        → from person_identifiers WHERE type='email'
 *   - phone        → from person_identifiers WHERE type='phone'
 *
 * WHY only N2-classified people: entities without N2 are Acquaintance-or-below
 * and haven't been classified yet. Their facts can be extracted on the next pipeline
 * run after classification.
 *
 * WHY valid_at = first_seen: linkedin_title and company are typically set at the
 * time of first contact, making first_seen the best available approximation for
 * when the fact became valid.
 *
 * @param {Object} db
 * @param {Function} log
 * @returns {number} count of facts inserted
 */
export function bulkExtractFacts(db, log) {
  log('=== Phase 9: entity_facts extraction (free tier) ===');
  const ownedFactTypes = ['job_title', 'employer', 'email', 'phone'];
  const ownedFactTypePlaceholders = ownedFactTypes.map(() => '?').join(',');

  const people = db.prepare(`
    SELECT p.id, p.display_name, p.linkedin_title, p.company_id, p.first_seen,
           c.name as company_name
    FROM people p
    LEFT JOIN companies c ON c.id = p.company_id
    WHERE p.n2 IS NOT NULL AND p.archived = 0
  `).all();

  const identifiers = db.prepare(`
    SELECT person_id, type, value FROM person_identifiers WHERE type IN ('email', 'phone')
  `).all();

  // Group identifiers by person — single scan, O(n) grouping
  const idsByPerson = {};
  for (const id of identifiers) {
    if (!idsByPerson[id.person_id]) idsByPerson[id.person_id] = [];
    idsByPerson[id.person_id].push(id);
  }

  const desired = [];
  for (const p of people) {
    if (p.linkedin_title) {
      desired.push({
        entity_id: p.id,
        entity_type: 'person',
        fact_type: 'job_title',
        fact_value: p.linkedin_title,
        source_event_ids: '[]',
        valid_at: p.first_seen || null,
        model_tier: 'free',
      });
    }
    if (p.company_name) {
      desired.push({
        entity_id: p.id,
        entity_type: 'person',
        fact_type: 'employer',
        fact_value: p.company_name,
        source_event_ids: '[]',
        valid_at: p.first_seen || null,
        model_tier: 'free',
      });
    }
    for (const id of (idsByPerson[p.id] || [])) {
      desired.push({
        entity_id: p.id,
        entity_type: 'person',
        fact_type: id.type === 'email' ? 'email' : 'phone',
        fact_value: id.value,
        source_event_ids: '[]',
        valid_at: p.first_seen || null,
        model_tier: 'free',
      });
    }
  }

  const keyOf = (f) => [
    f.entity_id,
    f.entity_type,
    f.fact_type,
    f.fact_value,
    f.source_event_ids || '[]',
    f.valid_at || '',
    f.model_tier,
  ].join('\u0000');

  const desiredByKey = new Map();
  for (const fact of desired) desiredByKey.set(keyOf(fact), fact);

  const current = db.prepare(`
    SELECT id, entity_id, entity_type, fact_type, fact_value, source_event_ids, valid_at, model_tier
    FROM entity_facts
    WHERE model_tier = 'free'
      AND entity_type = 'person'
      AND fact_type IN (${ownedFactTypePlaceholders})
      AND invalid_at IS NULL
  `).all(...ownedFactTypes);

  const keptKeys = new Set();
  const staleIds = [];
  for (const fact of current) {
    const key = keyOf(fact);
    if (desiredByKey.has(key) && !keptKeys.has(key)) {
      keptKeys.add(key);
    } else {
      staleIds.push(fact.id);
    }
  }

  // Provenance columns may not exist yet on a live DB that hasn't run the
  // owner backfill (scripts/backfill-entity-facts-provenance.js) — check ONCE
  // per invocation (not per row) and pick the matching INSERT shape, so this
  // scheduled pipeline phase never crashes with "no such column" regardless
  // of migration timing, and tags every new free-tier row primary-source/1.0
  // the moment the columns exist (design §1.2 — "effective immediately with
  // zero backfill").
  const withProvenance = hasEntityFactsProvenanceColumns(db);
  const insert = withProvenance
    ? db.prepare(`
        INSERT INTO entity_facts (entity_id, entity_type, fact_type, fact_value, source_event_ids, valid_at, model_tier, source_class, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
    : db.prepare(`
        INSERT INTO entity_facts (entity_id, entity_type, fact_type, fact_value, source_event_ids, valid_at, model_tier)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
  const invalidate = db.prepare(`
    UPDATE entity_facts SET invalid_at = datetime('now','utc')
    WHERE id = ? AND invalid_at IS NULL
  `);

  let inserted = 0;
  let invalidated = 0;
  db.transaction(() => {
    for (const [key, fact] of desiredByKey) {
      if (keptKeys.has(key)) continue;
      if (withProvenance) {
        // bulkExtractFacts only ever extracts from structured DB columns
        // (linkedin_title, companies.name, person_identifiers) — every row it
        // writes is unambiguously primary-source/1.0, never derived from
        // model_tier here (fact.model_tier is always the literal 'free' this
        // function hardcodes above, so the two are equivalent; primary-source
        // is written directly for clarity, not routed through the model_tier
        // fallback used by insertFact's more generic future callers).
        insert.run(
          fact.entity_id,
          fact.entity_type,
          fact.fact_type,
          fact.fact_value,
          fact.source_event_ids,
          fact.valid_at,
          fact.model_tier,
          SOURCE_CLASS.PRIMARY_SOURCE,
          1.0,
        );
      } else {
        insert.run(
          fact.entity_id,
          fact.entity_type,
          fact.fact_type,
          fact.fact_value,
          fact.source_event_ids,
          fact.valid_at,
          fact.model_tier,
        );
      }
      inserted++;
    }
    for (const id of staleIds) invalidated += invalidate.run(id).changes;
  })();

  const count = db.prepare('SELECT COUNT(*) as n FROM entity_facts WHERE invalid_at IS NULL').get().n;
  log(`entity_facts: ${count} current facts extracted (free tier, ${people.length} people; ${inserted} inserted, ${invalidated} invalidated)`);
  bulkExtractFacts.lastStats = {
    count,
    people: people.length,
    inserted,
    invalidated,
    changed: inserted + invalidated,
  };
  return count;
}
