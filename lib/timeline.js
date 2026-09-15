/**
 * lib/timeline.js — Query interface for the timeline_events table.
 *
 * WHY sync instead of async: better-sqlite3 is a synchronous driver by design.
 * All statement execution is synchronous — awaiting a sync function is a no-op
 * but valid; callers that use `await queryRange(...)` work correctly.
 *
 * Prepared statements are created at module load time (not lazily) to surface
 * any schema errors immediately at startup rather than at first query call.
 * Carmack rule: no mystery — if the schema is wrong, it blows up at boot.
 */

import db from './db.js';

// --- Prepared statements (created once at module load) ---

// WHY BETWEEN: SQLite uses the idx_timeline_event_date index for BETWEEN
// comparisons on ISO-8601 strings because lexicographic order matches
// chronological order for the UTC format we store (YYYY-MM-DDTHH:MM:SS.sssZ).
const stmtRange = db.prepare(
  `SELECT * FROM timeline_events WHERE event_date BETWEEN ? AND ? ORDER BY event_date ASC`
);
const stmtRangeFiltered = db.prepare(
  `SELECT * FROM timeline_events WHERE event_date BETWEEN ? AND ? AND source_type = ? ORDER BY event_date ASC`
);

// WHY OR on person_id / entity_id: timeline_event_entities has two entity
// columns — the legacy person_id (FK to people) and the newer entity_id
// (generic entity type). Entity context queries need both covered so a
// person linked via either column is returned.
const stmtEntity = db.prepare(`
  SELECT DISTINCT te.* FROM timeline_events te
  JOIN timeline_event_entities tee ON tee.event_id = te.id
  WHERE tee.person_id = ? OR tee.entity_id = ?
  ORDER BY te.event_date DESC
  LIMIT ?
`);

// --- Exports ---

/**
 * Query timeline events in a date range.
 *
 * @param {Date|string} start   - Range start. Date object or ISO-8601 string.
 * @param {Date|string} end     - Range end. Date object or ISO-8601 string.
 * @param {{ source_type?: string }} [filters] - Optional source filter.
 * @returns {Array} timeline_events rows ordered by event_date ASC.
 */
export function queryRange(start, end, filters = {}) {
  // Convert Date objects to ISO strings — SQLite BETWEEN compares strings,
  // and Date.prototype.toISOString() produces the UTC format we store.
  const startStr = start instanceof Date ? start.toISOString() : start;
  const endStr   = end   instanceof Date ? end.toISOString()   : end;

  if (filters.source_type) {
    return stmtRangeFiltered.all(startStr, endStr, filters.source_type);
  }
  return stmtRange.all(startStr, endStr);
}

/**
 * Query timeline events linked to an entity (person or generic entity).
 *
 * @param {string|number} entity_id  - people.id or generic entity_id.
 * @param {number} [limit=50]        - Max rows to return.
 * @returns {Array} timeline_events rows ordered by event_date DESC.
 */
export function queryEntity(entity_id, limit = 50) {
  // Pass entity_id twice — once for person_id match, once for entity_id match.
  // Returns empty array (not null) when no entity links exist — callers can
  // safely iterate without a null check.
  return stmtEntity.all(entity_id, entity_id, limit);
}
