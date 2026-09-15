/**
 * Generic source evidence propagation for non-person entities.
 *
 * timeline_event_entities is the deterministic event graph. chunks is the RAG
 * body layer. When both refer to the same raw source row, the entity should be
 * linked to that chunk too so context files and chat can pull exact source text.
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

const ENTITY_TABLE = {
  company: 'companies',
  place: 'places',
};

function uniqueStrings(values = []) {
  return [...new Set(values.map(String).map((s) => s.trim()).filter(Boolean))];
}

function genericEvidenceSchemaReady(db) {
  return hasTable(db, 'chunk_entities')
    && hasTable(db, 'chunks')
    && hasTable(db, 'timeline_events')
    && hasTable(db, 'timeline_event_entities')
    && hasColumn(db, 'chunk_entities', 'chunk_id')
    && hasColumn(db, 'chunk_entities', 'entity_id')
    && hasColumn(db, 'chunk_entities', 'entity_type')
    && hasColumn(db, 'chunks', 'id')
    && hasColumn(db, 'chunks', 'source_type')
    && hasColumn(db, 'chunks', 'source_id')
    && hasColumn(db, 'timeline_events', 'id')
    && hasColumn(db, 'timeline_events', 'source_type')
    && hasColumn(db, 'timeline_events', 'source_id')
    && hasColumn(db, 'timeline_event_entities', 'event_id')
    && hasColumn(db, 'timeline_event_entities', 'entity_type')
    && hasColumn(db, 'timeline_event_entities', 'entity_id');
}

/**
 * Link one chunk directly to one entity — the missing generic writer to
 * chunk_entities. The two other writers in this file INFER the link from a
 * timeline_event (transcript/company-evidence); this one takes an explicit
 * (chunkId, entityId, entityType) triple for research chunks and chat mentions
 * that have no timeline-event backing. Deterministic Tier-0 (extraction): no
 * LLM, idempotent via the table's (chunk_id, entity_id) PRIMARY KEY. The read
 * side (getEntityTimeline → chunkRows) is already generic across
 * person/company/place, so a linked chunk surfaces into context with no change
 * to the read path.
 */
export function linkChunkToEntity(db, chunkId, entityId, entityType) {
  if (chunkId == null || chunkId === '' || entityId == null || entityId === '') return { inserted: false };
  const type = String(entityType || '').trim().toLowerCase();
  if (!type) return { inserted: false };
  const info = db.prepare(
    'INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, entity_type) VALUES (?, ?, ?)',
  ).run(String(chunkId), String(entityId), type);
  return { inserted: info.changes > 0 };
}

export function markEntityNeedsRegenForEvidence(db, entityType, entityIds = []) {
  const type = String(entityType || '').trim().toLowerCase();
  const table = ENTITY_TABLE[type];
  const ids = uniqueStrings(entityIds);
  if (!table || !ids.length) return 0;
  if (!hasTable(db, table) || !hasColumn(db, table, 'id') || !hasColumn(db, table, 'needs_regen')) return 0;

  const archivedClause = hasColumn(db, table, 'archived')
    ? 'AND COALESCE(archived, 0) = 0'
    : '';
  const contextClause = hasColumn(db, table, 'context_file_path')
    ? "AND context_file_path IS NOT NULL AND context_file_path != ''"
    : '';
  const updatedAt = hasColumn(db, table, 'updated_at')
    ? ", updated_at = datetime('now')"
    : '';

  const update = db.prepare(`
    UPDATE ${table}
       SET needs_regen = 1${updatedAt}
     WHERE id = ?
       ${archivedClause}
       ${contextClause}
  `);
  return db.transaction(() => ids.reduce((total, id) => total + update.run(id).changes, 0))();
}

function populateTempSourceLinks(db, entityTypes) {
  const typePlaceholders = entityTypes.map(() => '?').join(', ');
  db.exec(`
    DROP TABLE IF EXISTS temp._entity_source_links;
    CREATE TEMP TABLE _entity_source_links (
      chunk_source_type TEXT NOT NULL,
      chunk_source_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      PRIMARY KEY (chunk_source_type, chunk_source_id, entity_id)
    );
  `);

  db.prepare(`
    WITH generic AS (
      SELECT DISTINCT
        CASE
          WHEN te.source_type IN ('granola', 'transcript') THEN 'transcript'
          ELSE te.source_type
        END AS chunk_source_type,
        CAST(te.source_id AS TEXT) AS raw_source_id,
        CAST(tee.entity_id AS TEXT) AS entity_id,
        tee.entity_type AS entity_type
      FROM timeline_event_entities tee
      JOIN timeline_events te ON te.id = tee.event_id
      WHERE tee.entity_type IN (${typePlaceholders})
        AND tee.entity_id IS NOT NULL
        AND tee.entity_id != ''
        AND te.source_type IS NOT NULL
        AND te.source_id IS NOT NULL
        AND te.source_id != ''
    )
    INSERT OR IGNORE INTO _entity_source_links (chunk_source_type, chunk_source_id, entity_id, entity_type)
    SELECT chunk_source_type, raw_source_id, entity_id, entity_type FROM generic
    UNION
    SELECT chunk_source_type, chunk_source_type || ':' || raw_source_id, entity_id, entity_type FROM generic
    UNION
    SELECT chunk_source_type,
           substr(raw_source_id, length(chunk_source_type) + 2),
           entity_id,
           entity_type
    FROM generic
    WHERE raw_source_id LIKE chunk_source_type || ':%'
    UNION
    SELECT 'transcript', 'transcript:' || raw_source_id, entity_id, entity_type
    FROM generic
    WHERE chunk_source_type = 'transcript'
  `).run(...entityTypes);
}

function bulkSourceEvidenceRows(db, entityTypes) {
  populateTempSourceLinks(db, entityTypes);
  try {
    return db.prepare(`
      INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, entity_type)
      SELECT c.id, l.entity_id, l.entity_type
      FROM _entity_source_links l
      JOIN chunks c ON c.source_type = l.chunk_source_type
                   AND c.source_id = l.chunk_source_id
      RETURNING entity_id, entity_type
    `).all();
  } finally {
    try { db.exec('DROP TABLE IF EXISTS temp._entity_source_links'); } catch { /* best effort */ }
  }
}

function stripSourcePrefix(sourceType, sourceId) {
  const type = String(sourceType || '').trim();
  const id = String(sourceId || '').trim();
  const prefix = `${type}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function timelineSourceCandidates(chunkSourceType, chunkSourceId) {
  const chunkType = String(chunkSourceType || '').trim();
  const rawId = String(chunkSourceId || '').trim();
  if (!chunkType || !rawId) return [];
  const stripped = stripSourcePrefix(chunkType, rawId);
  const sourceTypes = chunkType === 'transcript' ? ['transcript', 'granola'] : [chunkType];
  const ids = uniqueStrings([rawId, stripped]);
  return sourceTypes.map((sourceType) => ({ sourceType, ids }));
}

function singleChunkSourceEvidenceRows(db, chunkId, entityTypes) {
  const chunk = db.prepare('SELECT source_type, source_id FROM chunks WHERE id = ?').get(chunkId);
  const candidates = timelineSourceCandidates(chunk?.source_type, chunk?.source_id);
  if (!candidates.length) return [];

  const clauses = [];
  const params = [...entityTypes];
  for (const candidate of candidates) {
    const idPlaceholders = candidate.ids.map(() => '?').join(', ');
    clauses.push(`(te.source_type = ? AND CAST(te.source_id AS TEXT) IN (${idPlaceholders}))`);
    params.push(candidate.sourceType, ...candidate.ids);
  }

  return db.prepare(`
    INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, entity_type)
    SELECT ?, CAST(tee.entity_id AS TEXT), tee.entity_type
    FROM timeline_event_entities tee
    JOIN timeline_events te ON te.id = tee.event_id
    WHERE tee.entity_type IN (${entityTypes.map(() => '?').join(', ')})
      AND tee.entity_id IS NOT NULL
      AND tee.entity_id != ''
      AND (${clauses.join(' OR ')})
    RETURNING entity_id, entity_type
  `).all(chunkId, ...params);
}

function rowsToResult(db, rows, { markNeedsRegen }) {
  const entityIdsByType = {};
  for (const row of rows || []) {
    const type = String(row.entity_type || '').trim().toLowerCase();
    if (!type) continue;
    if (!entityIdsByType[type]) entityIdsByType[type] = [];
    entityIdsByType[type].push(String(row.entity_id));
  }
  for (const [type, ids] of Object.entries(entityIdsByType)) {
    entityIdsByType[type] = uniqueStrings(ids);
  }

  const markedByType = {};
  if (markNeedsRegen) {
    for (const [type, ids] of Object.entries(entityIdsByType)) {
      markedByType[type] = markEntityNeedsRegenForEvidence(db, type, ids);
    }
  }

  return {
    inserted: rows.length,
    entityIdsByType,
    markedByType,
  };
}

export function linkTimelineChunkEvidence(db, {
  entityTypes = ['company', 'place'],
  markNeedsRegen = false,
} = {}) {
  if (!genericEvidenceSchemaReady(db)) {
    return { inserted: 0, entityIdsByType: {}, markedByType: {} };
  }

  const types = uniqueStrings(entityTypes).map((s) => s.toLowerCase());
  if (!types.length) return { inserted: 0, entityIdsByType: {}, markedByType: {} };

  const rows = bulkSourceEvidenceRows(db, types);
  return rowsToResult(db, rows, { markNeedsRegen });
}

export function linkTimelineChunkEvidenceForChunk(db, chunkId, {
  entityTypes = ['company', 'place'],
  markNeedsRegen = false,
} = {}) {
  if (!genericEvidenceSchemaReady(db) || chunkId == null) {
    return { inserted: 0, entityIdsByType: {}, markedByType: {} };
  }

  const types = uniqueStrings(entityTypes).map((s) => s.toLowerCase());
  if (!types.length) return { inserted: 0, entityIdsByType: {}, markedByType: {} };

  const rows = singleChunkSourceEvidenceRows(db, chunkId, types);
  return rowsToResult(db, rows, { markNeedsRegen });
}
