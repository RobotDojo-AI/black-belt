/**
 * Timeline event graph — schema, migrations, and core accessors.
 * Content-hashed event IDs for idempotent ingestion.
 */
import { createHash } from 'node:crypto';
import db, { migrate } from './db.js';

// --- Migrations (self-executing on import) ---

migrate('timeline_events_v1', (d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      event_date TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_type, source_id)
    );

    CREATE TABLE IF NOT EXISTS timeline_event_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'participant',
      UNIQUE(event_id, person_id, role)
    );

    CREATE TABLE IF NOT EXISTS compiled_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      view_type TEXT NOT NULL,
      content TEXT NOT NULL,
      evidence_ids TEXT NOT NULL DEFAULT '[]',
      compiled_at TEXT NOT NULL DEFAULT (datetime('now')),
      stale INTEGER NOT NULL DEFAULT 0,
      UNIQUE(entity_type, entity_id, view_type)
    );

    CREATE INDEX IF NOT EXISTS idx_timeline_events_date ON timeline_events(event_date);
    CREATE INDEX IF NOT EXISTS idx_timeline_events_source ON timeline_events(source_type);
    CREATE INDEX IF NOT EXISTS idx_tee_person ON timeline_event_entities(person_id);
    CREATE INDEX IF NOT EXISTS idx_tee_event ON timeline_event_entities(event_id);
    CREATE INDEX IF NOT EXISTS idx_compiled_entity ON compiled_views(entity_type, entity_id);
  `);
});

// Indexes for timeline wire range queries and source dedup.
// UNIQUE(source_type, source_id) already exists as sqlite_autoindex from the DDL
// UNIQUE constraint — naming it explicitly with IF NOT EXISTS is a safe no-op
// that makes the index inspectable by name (e.g. in EXPLAIN QUERY PLAN).
// idx_timeline_event_date makes 30-day BETWEEN queries sub-millisecond at 800K rows.
// Lives here rather than in db.js so fresh DBs have the table before this runs.
migrate('timeline-wire-indexes', (d) => {
  d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_source ON timeline_events(source_type, source_id)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_timeline_event_date ON timeline_events(event_date)`);
});

// Add expires_at + model columns to compiled_views for TTL-based cache in routes/compiled.js.
// Must run after timeline_events_v1 which creates the table.
migrate('compiled_views_ttl', (d) => {
  try { d.exec(`ALTER TABLE compiled_views ADD COLUMN expires_at TEXT`); } catch { /* already added */ }
  try { d.exec(`ALTER TABLE compiled_views ADD COLUMN model TEXT`); } catch { /* already added */ }
  d.exec(`UPDATE compiled_views SET expires_at = datetime(compiled_at, '+24 hours') WHERE expires_at IS NULL`);
});

// --- Places migration ---

migrate('places_v1', (d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      place_type TEXT NOT NULL DEFAULT 'venue',
      parent_place_id INTEGER REFERENCES places(id),
      latitude REAL,
      longitude REAL,
      address TEXT,
      frequency INTEGER DEFAULT 0,
      first_seen TEXT,
      last_seen TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_places_name ON places(name);
    CREATE INDEX IF NOT EXISTS idx_places_type ON places(place_type);
  `);
});

// Add entity_type + entity_id columns to timeline_event_entities for generic entity linking
migrate('tee_entity_type_v1', (d) => {
  try { d.exec(`ALTER TABLE timeline_event_entities ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'person'`); } catch {}
  try { d.exec(`ALTER TABLE timeline_event_entities ADD COLUMN entity_id TEXT`); } catch {}
  d.exec(`UPDATE timeline_event_entities SET entity_id = person_id WHERE entity_id IS NULL`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_tee_entity ON timeline_event_entities(entity_type, entity_id)`);
});

// --- Content-hash ID generation ---

export function eventId(sourceType, sourceId, content) {
  return createHash('sha256')
    .update(`${sourceType}:${sourceId}:${content}`)
    .digest('hex')
    .slice(0, 32);
}

export function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

// --- Prepared statements ---

const stmts = {
  insertEvent: db.prepare(`
    INSERT OR IGNORE INTO timeline_events (id, source_type, source_id, event_date, event_type, summary, content_hash, metadata)
    VALUES (@id, @sourceType, @sourceId, @eventDate, @eventType, @summary, @contentHash, @metadata)
  `),

  linkEntity: db.prepare(`
    INSERT OR IGNORE INTO timeline_event_entities (event_id, person_id, role)
    VALUES (@eventId, @personId, @role)
  `),

  personTimeline: db.prepare(`
    SELECT te.* FROM timeline_events te
    JOIN timeline_event_entities tee ON tee.event_id = te.id
    WHERE tee.person_id = @personId
    ORDER BY te.event_date DESC
    LIMIT @limit OFFSET @offset
  `),

  personTimelineByType: db.prepare(`
    SELECT te.* FROM timeline_events te
    JOIN timeline_event_entities tee ON tee.event_id = te.id
    WHERE tee.person_id = @personId AND te.source_type = @sourceType
    ORDER BY te.event_date DESC
    LIMIT @limit OFFSET @offset
  `),

  linkGenericEntity: db.prepare(`
    INSERT OR IGNORE INTO timeline_event_entities (event_id, person_id, role, entity_type, entity_id)
    VALUES (@eventId, @personId, @role, @entityType, @entityId)
  `),

  // --- Place statements ---

  findPlaceByName: db.prepare(`SELECT * FROM places WHERE name = @name COLLATE NOCASE`),

  insertPlace: db.prepare(`
    INSERT INTO places (name, place_type, parent_place_id, address, frequency, first_seen, last_seen)
    VALUES (@name, @placeType, @parentPlaceId, @address, 1, @firstSeen, @lastSeen)
  `),

  updatePlaceFrequency: db.prepare(`
    UPDATE places SET frequency = frequency + 1,
      last_seen = CASE WHEN @eventDate > last_seen THEN @eventDate ELSE last_seen END,
      first_seen = CASE WHEN @eventDate < first_seen THEN @eventDate ELSE first_seen END
    WHERE id = @id
  `),

  allPlaces: db.prepare(`SELECT * FROM places ORDER BY frequency DESC`),

  placeById: db.prepare(`SELECT * FROM places WHERE id = @id`),

  placeChildren: db.prepare(`SELECT * FROM places WHERE parent_place_id = @parentId ORDER BY frequency DESC`),

  placeEvents: db.prepare(`
    SELECT te.* FROM timeline_events te
    JOIN timeline_event_entities tee ON tee.event_id = te.id
    WHERE tee.entity_type = 'place' AND tee.entity_id = @placeId
    ORDER BY te.event_date DESC
    LIMIT @limit
  `),

  placePeople: db.prepare(`
    SELECT DISTINCT tee2.person_id, p.display_name, COUNT(*) as shared_events
    FROM timeline_event_entities tee
    JOIN timeline_event_entities tee2 ON tee2.event_id = tee.event_id AND tee2.entity_type = 'person'
    JOIN people p ON p.id = tee2.person_id
    WHERE tee.entity_type = 'place' AND tee.entity_id = @placeId
    GROUP BY tee2.person_id
    ORDER BY shared_events DESC
    LIMIT @limit
  `),

  placeStats: db.prepare(`SELECT place_type, COUNT(*) as count FROM places GROUP BY place_type`),

  stats: db.prepare(`
    SELECT source_type, COUNT(*) as count FROM timeline_events GROUP BY source_type
  `),

  totalCount: db.prepare(`SELECT COUNT(*) as total FROM timeline_events`),
};

const timelineInsertCache = new WeakMap();

function timelineInsertStmt(targetDb) {
  let stmt = timelineInsertCache.get(targetDb);
  if (stmt) return stmt;
  stmt = targetDb.prepare(`
    INSERT INTO timeline_events (id, source_type, source_id, event_date, event_type, summary, content_hash, metadata)
    VALUES (@id, @sourceType, @sourceId, @eventDate, @eventType, @summary, @contentHash, @metadata)
    ON CONFLICT(source_type, source_id) DO UPDATE SET
      event_date = excluded.event_date,
      event_type = excluded.event_type,
      summary = excluded.summary,
      content_hash = excluded.content_hash,
      metadata = excluded.metadata
  `);
  timelineInsertCache.set(targetDb, stmt);
  return stmt;
}

// --- Exports ---

/**
 * Insert a timeline event. Idempotent via content-hash dedup.
 * @param {{ sourceType, sourceId, eventDate, eventType, summary, content, metadata }} event
 * @returns {{ inserted: boolean }}
 */
export function insertTimelineEvent(event) {
  return insertTimelineEventForDb(db, event);
}

/**
 * Insert/update a timeline event against an explicit DB. This is projection
 * code: source rows remain canonical, timeline_events is the rebuilt read model.
 * @param {import('better-sqlite3').Database} targetDb
 * @param {{ sourceType, sourceId, eventDate, eventType, summary, content, metadata }} event
 * @returns {{ inserted: boolean, id: string }}
 */
export function insertTimelineEventForDb(targetDb, event) {
  const hash = contentHash(event.content || event.summary || '');
  const id = eventId(event.sourceType, event.sourceId, hash);
  const result = timelineInsertStmt(targetDb).run({
    id,
    sourceType: event.sourceType,
    sourceId: event.sourceId,
    eventDate: event.eventDate,
    eventType: event.eventType,
    summary: event.summary || '',
    contentHash: hash,
    metadata: JSON.stringify(event.metadata || {}),
  });
  return { inserted: result.changes > 0, id };
}

/**
 * Link a person to a timeline event with a role.
 */
export function linkEntityToEvent(eventId, personId, role = 'participant') {
  stmts.linkEntity.run({ eventId, personId, role });
}

/**
 * Link a generic entity (person, place, etc.) to a timeline event.
 * For non-person entities, temporarily relaxes FK checks since person_id
 * is a legacy column with a FK constraint to people(id).
 */
export function linkGenericEntityToEvent(eventId, entityType, entityId, role = 'location') {
  if (entityType === 'person') {
    stmts.linkGenericEntity.run({
      eventId, personId: entityId, role, entityType, entityId: String(entityId),
    });
  } else {
    // Non-person entity: person_id FK would fail, so bypass temporarily.
    // Use entityType:entityId as person_id for UNIQUE constraint dedup.
    db.pragma('foreign_keys = OFF');
    try {
      stmts.linkGenericEntity.run({
        eventId, personId: `${entityType}:${entityId}`, role, entityType, entityId: String(entityId),
      });
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}

// --- Place functions ---

/**
 * Find or create a place. Returns { id, created }.
 * Does NOT auto-increment frequency — caller manages that via updatePlaceStats().
 */
export function findOrCreatePlace({ name, placeType = 'venue', parentPlaceId = null, address = null, eventDate = null }) {
  const existing = stmts.findPlaceByName.get({ name });
  if (existing) {
    return { id: existing.id, created: false };
  }
  const result = stmts.insertPlace.run({
    name,
    placeType,
    parentPlaceId,
    address,
    firstSeen: eventDate || new Date().toISOString(),
    lastSeen: eventDate || new Date().toISOString(),
  });
  return { id: result.lastInsertRowid, created: true };
}

/**
 * Recompute frequency and date range for all places from timeline_event_entities.
 */
export function recomputePlaceFrequencies() {
  db.exec(`
    UPDATE places SET frequency = (
      SELECT COUNT(*) FROM timeline_event_entities tee
      JOIN timeline_events te ON te.id = tee.event_id
      WHERE tee.entity_type = 'place' AND CAST(tee.entity_id AS INTEGER) = places.id
    ),
    first_seen = COALESCE((
      SELECT MIN(te.event_date) FROM timeline_event_entities tee
      JOIN timeline_events te ON te.id = tee.event_id
      WHERE tee.entity_type = 'place' AND CAST(tee.entity_id AS INTEGER) = places.id
    ), places.first_seen),
    last_seen = COALESCE((
      SELECT MAX(te.event_date) FROM timeline_event_entities tee
      JOIN timeline_events te ON te.id = tee.event_id
      WHERE tee.entity_type = 'place' AND CAST(tee.entity_id AS INTEGER) = places.id
    ), places.last_seen)
  `);
  // Also recompute city frequencies as sum of child place frequencies
  db.exec(`
    UPDATE places SET frequency = (
      SELECT COALESCE(SUM(p2.frequency), 0) FROM places p2 WHERE p2.parent_place_id = places.id
    ) WHERE place_type = 'city' AND (
      SELECT COUNT(*) FROM places p2 WHERE p2.parent_place_id = places.id
    ) > 0
  `);
}

/**
 * List all places, optionally filtered by type.
 */
export function getPlaces({ placeType, placeSubtype, useful, limit = 100, offset = 0 } = {}) {
  const where = [], params = [];
  if (placeType) { where.push('place_type = ?'); params.push(placeType); }
  if (placeSubtype) { where.push('place_subtype = ?'); params.push(placeSubtype); }
  if (useful != null) { where.push('useful = ?'); params.push(useful); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM places ${clause} ORDER BY frequency DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
}

/**
 * Get place detail with linked events and people.
 */
export function getPlaceDetail(placeId) {
  const place = stmts.placeById.get({ id: placeId });
  if (!place) return null;

  const children = stmts.placeChildren.all({ parentId: placeId });
  const events = stmts.placeEvents.all({ placeId: String(placeId), limit: 50 });
  const people = stmts.placePeople.all({ placeId: String(placeId), limit: 50 });

  return { ...place, children, events, people };
}

/**
 * Place counts by type.
 */
export function getPlaceStats() {
  return stmts.placeStats.all();
}

/**
 * Get timeline events for a person, optionally filtered by source type.
 * @param {string} personId
 * @param {{ limit?, offset?, sourceType? }} options
 */
export function getPersonTimeline(personId, options = {}) {
  const limit = options.limit || 100;
  const offset = options.offset || 0;
  if (options.sourceType) {
    return stmts.personTimelineByType.all({ personId, sourceType: options.sourceType, limit, offset });
  }
  return stmts.personTimeline.all({ personId, limit, offset });
}

/**
 * Event counts by source type + total.
 */
export function getTimelineStats() {
  const bySource = stmts.stats.all();
  const { total } = stmts.totalCount.get();
  return { total, bySource };
}
