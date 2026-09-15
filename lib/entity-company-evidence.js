/**
 * Deterministic company evidence propagation.
 *
 * Person chunk links are source-backed RAG evidence. When a resolved person has
 * a company_id, the company should inherit that same chunk evidence so company
 * context and chat enrichment stay current without waiting for a separate full
 * entity-link pass.
 */

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function hasCompanyChunkSchema(db) {
  return hasTable(db, 'chunk_entities')
    && hasTable(db, 'people')
    && hasTable(db, 'companies')
    && hasColumn(db, 'chunk_entities', 'chunk_id')
    && hasColumn(db, 'chunk_entities', 'entity_id')
    && hasColumn(db, 'chunk_entities', 'entity_type')
    && hasColumn(db, 'people', 'id')
    && hasColumn(db, 'people', 'company_id')
    && hasColumn(db, 'companies', 'id');
}

export function markCompanyNeedsRegenForEvidence(db, companyIds = []) {
  const ids = [...new Set((companyIds || []).map(String).filter(Boolean))];
  if (!ids.length) return 0;
  if (!hasTable(db, 'companies') || !hasColumn(db, 'companies', 'needs_regen')) return 0;
  if (!hasColumn(db, 'companies', 'context_file_path')) return 0;

  const archivedClause = hasColumn(db, 'companies', 'archived')
    ? 'AND COALESCE(archived, 0) = 0'
    : '';
  const update = db.prepare(`
    UPDATE companies
       SET needs_regen = 1, updated_at = datetime('now')
     WHERE id = ?
       ${archivedClause}
       AND context_file_path IS NOT NULL
       AND context_file_path != ''
  `);
  return db.transaction(() => ids.reduce((total, id) => total + update.run(id).changes, 0))();
}

export function linkCompanyChunkEvidence(db, { markNeedsRegen = false } = {}) {
  if (!hasCompanyChunkSchema(db)) {
    return { inserted: 0, companyIds: [], marked: 0 };
  }

  const rows = db.prepare(`
    INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, entity_type)
    SELECT candidate.chunk_id, candidate.company_id, 'company'
    FROM (
      SELECT DISTINCT ce.chunk_id, p.company_id
      FROM chunk_entities ce
      JOIN people p ON p.id = CAST(ce.entity_id AS TEXT)
      JOIN companies c ON c.id = p.company_id
      WHERE ce.entity_type = 'person'
        AND p.company_id IS NOT NULL
        AND p.company_id != ''
    ) candidate
    WHERE NOT EXISTS (
      SELECT 1
      FROM chunk_entities existing
      WHERE existing.chunk_id = candidate.chunk_id
        AND CAST(existing.entity_id AS TEXT) = CAST(candidate.company_id AS TEXT)
    )
    RETURNING entity_id
  `).all();
  const companyIds = [...new Set(rows.map((row) => String(row.entity_id)).filter(Boolean))];
  const marked = markNeedsRegen ? markCompanyNeedsRegenForEvidence(db, companyIds) : 0;
  return { inserted: rows.length, companyIds, marked };
}

export function linkCompanyForPersonChunk(db, chunkId, personId, { markNeedsRegen = false } = {}) {
  if (!hasCompanyChunkSchema(db) || chunkId == null || !personId) {
    return { inserted: 0, companyId: null, marked: 0 };
  }

  const row = db.prepare(`
    SELECT p.company_id AS company_id
    FROM people p
    JOIN companies c ON c.id = p.company_id
    WHERE p.id = ?
      AND p.company_id IS NOT NULL
      AND p.company_id != ''
    LIMIT 1
  `).get(String(personId));
  if (!row?.company_id) return { inserted: 0, companyId: null, marked: 0 };

  const inserted = db.prepare(`
    INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, entity_type)
    VALUES (?, ?, 'company')
  `).run(chunkId, row.company_id).changes;
  const companyId = String(row.company_id);
  const marked = markNeedsRegen && inserted > 0
    ? markCompanyNeedsRegenForEvidence(db, [companyId])
    : 0;
  return { inserted, companyId, marked };
}
