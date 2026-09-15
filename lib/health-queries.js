/**
 * Data queries for routes/health.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */

/**
 * Returns all health markers joined with group names, sorted by group then name.
 * @param {import('better-sqlite3').Database} db
 * @param {boolean} teaser - if true, limits to 5 results
 */
export function listHealthMarkers(db, teaser = false) {
  return db.prepare(`
    SELECT m.*, g.name as group_name
    FROM health_markers m
    JOIN health_groups g ON m.group_id = g.id
    ORDER BY g.name, m.name
    ${teaser ? 'LIMIT 5' : ''}
  `).all();
}

/**
 * Returns data points for a marker (non-excluded, ordered by date).
 * @param {import('better-sqlite3').Database} db
 * @param {string} markerId
 */
export function listDataPointsForMarker(db, markerId) {
  return db.prepare(`
    SELECT * FROM health_data_points
    WHERE marker_id = ? AND excluded = 0
    ORDER BY date
  `).all(markerId);
}

/**
 * Returns all non-excluded data points grouped by marker. This avoids the
 * Health dashboard's old N+1 query shape when hundreds of markers exist.
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<string, Array<object>>}
 */
export function listDataPointsGroupedByMarker(db, options = {}) {
  const sources = Array.isArray(options.sources)
    ? options.sources.filter(source => typeof source === 'string' && source.trim())
    : [];
  const includeMarkerIds = Array.isArray(options.includeMarkerIds)
    ? options.includeMarkerIds.filter(markerId => typeof markerId === 'string' && markerId.trim())
    : [];
  const filters = [];
  const params = [];
  if (sources.length) {
    filters.push(`source IN (${sources.map(() => '?').join(', ')})`);
    params.push(...sources);
  }
  if (includeMarkerIds.length) {
    filters.push(`marker_id IN (${includeMarkerIds.map(() => '?').join(', ')})`);
    params.push(...includeMarkerIds);
  }
  const sourceFilter = filters.length
    ? ` AND (${filters.join(' OR ')})`
    : '';
  const rows = db.prepare(`
    SELECT marker_id, date, value, source, source_file, source_id, specimen_type
    FROM health_data_points
    WHERE excluded = 0${sourceFilter}
    ORDER BY marker_id, date, value, source, source_file, source_id
  `).all(...params);
  const byMarker = new Map();
  for (const row of rows) {
    const list = byMarker.get(row.marker_id);
    if (list) list.push(row);
    else byMarker.set(row.marker_id, [row]);
  }
  return byMarker;
}

/**
 * Returns per-marker raw point counts and chart-source counts without hydrating
 * high-volume wearable/mobile rows into the dashboard payload.
 * @param {import('better-sqlite3').Database} db
 * @param {{ chartSources?: string[] }} options
 * @returns {Map<string, {rawCount: number, chartPointCount: number}>}
 */
export function listDataPointCountsGroupedByMarker(db, options = {}) {
  const chartSources = Array.isArray(options.chartSources)
    ? options.chartSources.filter(source => typeof source === 'string' && source.trim())
    : [];
  const chartSourceExpr = chartSources.length
    ? `SUM(CASE WHEN source IN (${chartSources.map(() => '?').join(', ')}) THEN 1 ELSE 0 END)`
    : 'COUNT(*)';
  const rows = db.prepare(`
    SELECT
      marker_id,
      COUNT(*) AS raw_count,
      ${chartSourceExpr} AS chart_point_count
    FROM health_data_points
    WHERE excluded = 0
    GROUP BY marker_id
  `).all(...chartSources);
  return new Map(rows.map(row => [row.marker_id, {
    rawCount: Number(row.raw_count || 0),
    chartPointCount: Number(row.chart_point_count || 0),
  }]));
}

function healthQueryTableExists(db, table) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  } catch {
    return false;
  }
}

function healthQueryColumnExists(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
  } catch {
    return false;
  }
}

/**
 * Returns health notes ordered by date descending.
 * @param {import('better-sqlite3').Database} db
 */
export function listHealthNotes(db) {
  return db.prepare("SELECT * FROM health_notes ORDER BY date DESC").all();
}

/**
 * Returns notes eligible for chart annotations. Generic tagged notes stay
 * bounded because Oura/live-note sources can be high volume, but every
 * owner-attested history row is always included: those are Tier 1 raw source
 * facts and must not fall out of chart synthesis because they are old.
 * @param {import('better-sqlite3').Database} db
 * @param {number} limit
 */
export function listChartHealthNotes(db, limit = 500) {
  return db.prepare(`
    WITH owner_history AS (
      SELECT id, 0 AS chart_note_priority
      FROM health_notes
      WHERE source = 'owner_attested_health_history'
         OR tags LIKE '%health_history%'
         OR tags LIKE '%owner_attested%'
         OR tags LIKE '%tier_1_owner_attested%'
    ),
    bounded_tagged AS (
      SELECT id, 1 AS chart_note_priority
      FROM health_notes
      WHERE COALESCE(tags, '[]') NOT IN ('', '[]')
      ORDER BY date DESC, id DESC
      LIMIT ?
    ),
    selected AS (
      SELECT id, MIN(chart_note_priority) AS chart_note_priority
      FROM (
        SELECT id, chart_note_priority FROM owner_history
        UNION ALL
        SELECT id, chart_note_priority FROM bounded_tagged
      )
      GROUP BY id
    )
    SELECT health_notes.*, selected.chart_note_priority
    FROM health_notes
    JOIN selected ON selected.id = health_notes.id
    ORDER BY selected.chart_note_priority, health_notes.date DESC, health_notes.id DESC
  `).all(limit);
}

function clipHealthContext(value, max = 8000) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trimEnd()}...`;
}

function syntheticHealthContextNote({ id, date, content, source, createdAt }) {
  return {
    id,
    date,
    content: clipHealthContext(content),
    tags: JSON.stringify(['health_history', 'health_workbench_context', 'tier_1_user_supplied_insight']),
    source,
    created_at: createdAt || date,
    chart_note_priority: -1,
  };
}

/**
 * Returns compact user/workbench health context as chart-eligible notes. These
 * are not raw labs; they are the user's durable health synthesis substrate.
 * The chart layer can match marker terms inside them so graphs carry the
 * user's medical-engineer context, not only imported numeric data.
 * @param {import('better-sqlite3').Database} db
 * @param {number} limit
 */
export function listHealthWorkbenchContextNotes(db, limit = 8) {
  const notes = [];
  try {
    const topic = db.prepare(`
      SELECT slug, context_md, updated_at
      FROM user_topics
      WHERE slug = 'health'
        AND NULLIF(TRIM(COALESCE(context_md, '')), '') IS NOT NULL
    `).get();
    if (topic?.context_md) {
      notes.push(syntheticHealthContextNote({
        id: 'health-topic-context',
        date: String(topic.updated_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
        content: `Health topic context:\n\n${topic.context_md}`,
        source: 'health_workbench_context',
        createdAt: topic.updated_at,
      }));
    }
  } catch {}

  try {
    const rows = db.prepare(`
      SELECT id, content, source, created_at
      FROM topic_context_history
      WHERE topic_slug = 'health'
        AND source IN ('synthesis', 'workbench-synthesis:wk_health')
        AND NULLIF(TRIM(COALESCE(content, '')), '') IS NOT NULL
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
    for (const row of rows) {
      notes.push(syntheticHealthContextNote({
        id: `health-topic-history-${row.id}`,
        date: String(row.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
        content: `Health workbench synthesis ${row.id}:\n\n${row.content}`,
        source: row.source || 'health_workbench_context',
        createdAt: row.created_at,
      }));
    }
  } catch {}
  return notes;
}

/**
 * Returns curated medications ordered by status then name.
 * @param {import('better-sqlite3').Database} db
 */
export function listMedications(db) {
  return db.prepare("SELECT * FROM curated_medications ORDER BY status, name").all();
}

/**
 * Returns all health groups ordered by name.
 * @param {import('better-sqlite3').Database} db
 */
export function listHealthGroups(db) {
  return db.prepare('SELECT id, name, description FROM health_groups ORDER BY name').all();
}

/**
 * Returns data points for a marker since a given date.
 * @param {import('better-sqlite3').Database} db
 * @param {string} markerId
 * @param {string} since - ISO date string
 */
export function listDataPointsSince(db, markerId, since) {
  return db.prepare(`
    SELECT * FROM health_data_points
    WHERE marker_id = ? AND date >= ? AND excluded = 0
    ORDER BY date
  `).all(markerId, since);
}

/**
 * Returns all medications (no ordering).
 * @param {import('better-sqlite3').Database} db
 */
export function listMedicationsRaw(db) {
  return db.prepare(`SELECT * FROM curated_medications ORDER BY status, name`).all();
}

/**
 * Returns the most recent health notes (limited).
 * @param {import('better-sqlite3').Database} db
 * @param {number} limit
 */
export function listRecentHealthNotes(db, limit = 50) {
  return db.prepare("SELECT * FROM health_notes ORDER BY date DESC LIMIT ?").all(limit);
}

/**
 * Returns PRAGMA table_info rows for a table, used to probe optional columns.
 * The table name is interpolated into the PRAGMA (SQLite cannot bind an
 * identifier), so anything that is not a bare identifier is rejected up front
 * and yields [] — keeping the interpolation injection-safe.
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @returns {Array<{ name: string }>}
 */
export function healthTableColumns(db, table) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) return [];
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

/**
 * Computes the marker ontology signature — a stable digest of every
 * health_markers row over the supplied column projection. The projection is
 * built by the caller from a fixed column allowlist.
 * @param {import('better-sqlite3').Database} db
 * @param {string} projection - SQL expression producing each row's signature
 * @returns {string}
 */
export function markerOntologySignature(db, projection) {
  return db.prepare(`
    SELECT COALESCE(group_concat(row_sig, char(30)), '') AS signature
    FROM (
      SELECT ${projection} AS row_sig
      FROM health_markers
      ORDER BY id
    )
  `).get()?.signature || '';
}

/**
 * Computes the health_groups ontology signature (id/name/description digest).
 * @param {import('better-sqlite3').Database} db
 * @returns {string}
 */
export function groupOntologySignature(db) {
  return db.prepare(`
    SELECT COALESCE(group_concat(row_sig, char(30)), '') AS signature
    FROM (
      SELECT COALESCE(id, '') || char(31) || COALESCE(name, '') || char(31) || COALESCE(description, '') AS row_sig
      FROM health_groups
      ORDER BY id
    )
  `).get()?.signature || '';
}

/**
 * Reads the aggregate DB signature the health-marker payload cache keys on:
 * max ids, row counts, and max timestamps across every table whose change must
 * bust the cache. One query so the snapshot is transactionally consistent.
 * @param {import('better-sqlite3').Database} db
 * @returns {object}
 */
export function healthMarkersCacheDbSignature(db) {
  return db.prepare(`
    SELECT
      (SELECT COALESCE(MAX(id), 0) FROM health_data_points) AS point_max_id,
      (SELECT COUNT(*) FROM health_data_points) AS point_count,
      (SELECT COALESCE(MAX(updated_at), '') FROM health_data_points) AS point_updated_at,
      (SELECT COUNT(*) FROM health_markers) AS marker_count,
      (SELECT COALESCE(MAX(rowid), 0) FROM health_markers) AS marker_max_rowid,
      (SELECT COUNT(*) FROM health_groups) AS group_count,
      (SELECT COALESCE(MAX(rowid), 0) FROM health_groups) AS group_max_rowid,
      (SELECT COALESCE(MAX(id), 0) FROM health_notes) AS note_max_id,
      (SELECT COALESCE(MAX(id), 0) FROM curated_medications) AS med_max_id,
      (SELECT COALESCE(MAX(updated_at), '') FROM curated_medications) AS med_updated_at,
      (SELECT COUNT(*) FROM health_chart_archive_preferences) AS chart_archive_pref_count,
      (SELECT COALESCE(MAX(updated_at), '') FROM health_chart_archive_preferences) AS chart_archive_pref_updated_at,
      (SELECT COUNT(*) FROM health_ingestion_log) AS health_ingestion_log_count,
      (SELECT COALESCE(MAX(created_at), '') FROM health_ingestion_log) AS health_ingestion_log_created_at,
      (SELECT COUNT(*) FROM timeline_events WHERE source_type IN ('health', 'user') AND event_type NOT IN ('lab_draw', 'lab_result', 'health_metric')) AS health_event_count,
      (SELECT COALESCE(MAX(rowid), 0) FROM timeline_events WHERE source_type IN ('health', 'user') AND event_type NOT IN ('lab_draw', 'lab_result', 'health_metric')) AS health_event_max_rowid,
      (SELECT COUNT(*) FROM health_marker_copy) AS marker_copy_count,
      (SELECT COALESCE(MAX(generated_at), '') FROM health_marker_copy) AS marker_copy_generated_at,
      (SELECT COALESCE(SUM(LENGTH(definition) + LENGTH(trend)
             + LENGTH(action) + LENGTH(narrative)), 0) FROM health_marker_copy) AS marker_copy_content_len
  `).get();
}

/**
 * Reads every generated copy row (markers and body-area narratives).
 * At most ~62 rows, so a full scan with no index is the right shape.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<object>}
 */
export function listHealthMarkerCopyRows(db) {
  return db.prepare(`
    SELECT scope, subject_id, definition, trend, action, narrative,
           omitted, omitted_reason, input_signature, model, generated_at
    FROM health_marker_copy
  `).all();
}

/**
 * Reads all chart archive preference rows (marker_id, archived, updated_at).
 * The caller keys them into a Map by marker_id.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{ marker_id: string, archived: number, updated_at: string }>}
 */
export function readHealthChartArchivePreferences(db) {
  return db.prepare(`
    SELECT marker_id, archived, updated_at
    FROM health_chart_archive_preferences
  `).all();
}

/**
 * Upserts the archive preference for a set of marker ids in one transaction.
 * A single prepared statement is reused across every id in the batch.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} markerIds
 * @param {boolean} archived
 */
export function writeHealthChartArchivePreferences(db, markerIds, archived) {
  const upsert = db.prepare(`
    INSERT INTO health_chart_archive_preferences (marker_id, archived, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(marker_id) DO UPDATE SET
      archived = excluded.archived,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((ids) => {
    for (const id of ids) upsert.run(id, archived ? 1 : 0);
  });
  tx(markerIds);
}
