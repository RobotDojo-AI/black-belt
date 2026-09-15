// lib/memory-events.js - append-only bitemporal memory event substrate.
//
// Truth is the immutable event/episode stream. Context docs, synthesis files,
// latest-state fields, timelines, and embeddings are projections over this.

import crypto from 'node:crypto';
import { appEvents } from './app-events.js';

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS memory_events (
  global_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  stream_type TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  actor TEXT NOT NULL DEFAULT 'system',
  source TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  valid_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL,
  pii_class TEXT NOT NULL DEFAULT 'private',
  UNIQUE(stream_type, stream_id, stream_sequence),
  UNIQUE(source, idempotency_key)
);

CREATE TABLE IF NOT EXISTS memory_event_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES memory_events(event_id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'subject',
  UNIQUE(event_id, target_type, target_id, role)
);

CREATE TABLE IF NOT EXISTS memory_projection_runs (
  id TEXT PRIMARY KEY,
  projection_name TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source_event_from INTEGER,
  source_event_to INTEGER,
  source_set_hash TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  prompt_version TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  generated_at TEXT NOT NULL,
  generated_by TEXT NOT NULL DEFAULT 'system',
  output_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(projection_name, target_type, target_id, source_event_to, source_set_hash)
);

CREATE INDEX IF NOT EXISTS idx_memory_events_stream
  ON memory_events(stream_type, stream_id, stream_sequence);
CREATE INDEX IF NOT EXISTS idx_memory_events_valid_at
  ON memory_events(valid_at);
CREATE INDEX IF NOT EXISTS idx_memory_events_recorded_at
  ON memory_events(recorded_at);
CREATE INDEX IF NOT EXISTS idx_memory_events_subject
  ON memory_events(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_memory_events_type
  ON memory_events(event_type);
CREATE INDEX IF NOT EXISTS idx_memory_event_links_target
  ON memory_event_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_memory_projection_target
  ON memory_projection_runs(projection_name, target_type, target_id, generated_at);

CREATE TRIGGER IF NOT EXISTS memory_events_no_update
BEFORE UPDATE ON memory_events
BEGIN
  SELECT RAISE(ABORT, 'memory_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS memory_events_no_delete
BEFORE DELETE ON memory_events
BEGIN
  SELECT RAISE(ABORT, 'memory_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS memory_projection_runs_no_update
BEFORE UPDATE ON memory_projection_runs
BEGIN
  SELECT RAISE(ABORT, 'memory_projection_runs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS memory_projection_runs_no_delete
BEFORE DELETE ON memory_projection_runs
BEGIN
  SELECT RAISE(ABORT, 'memory_projection_runs is append-only');
END;
`;

const ensured = new WeakSet();

function isoNow() {
  return new Date().toISOString();
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = normalize(value[key]);
    }
    return out;
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(normalize(value ?? {}));
}

export function memorySourceSetHash(rows = []) {
  const ids = rows
    .map((row) => `${row.global_sequence || ''}:${row.event_hash || row.event_id || ''}`)
    .sort();
  return sha256(ids.join('\n'));
}

export function ensureMemoryEventsSchema(db) {
  if (!db || ensured.has(db)) return;
  db.exec(MIGRATION_SQL);
  ensured.add(db);
}

function normalizeLinks(subjectType, subjectId, links = []) {
  const normalized = [];
  if (subjectType && subjectId) {
    normalized.push({ targetType: subjectType, targetId: subjectId, role: 'subject' });
  }
  for (const link of links || []) {
    const targetType = link.targetType || link.target_type;
    const targetId = link.targetId || link.target_id;
    if (!targetType || !targetId) continue;
    normalized.push({
      targetType: String(targetType),
      targetId: String(targetId),
      role: String(link.role || 'related'),
    });
  }
  const seen = new Set();
  return normalized.filter((link) => {
    const key = `${link.targetType}\0${link.targetId}\0${link.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function requireText(value, name) {
  const out = String(value || '').trim();
  if (!out) throw new Error(`appendMemoryEvent: ${name} is required`);
  return out;
}

function emitMemoryContextChange(payload) {
  try {
    appEvents.emit('memory-context-change', payload);
  } catch {
    // Cache invalidation is best-effort; append-only writes remain canonical.
  }
}

function insertMemoryEvent(db, args) {
  const streamType = requireText(args.streamType || args.stream_type, 'streamType');
  const streamId = requireText(args.streamId || args.stream_id, 'streamId');
  const eventType = requireText(args.eventType || args.event_type, 'eventType');
  const source = requireText(args.source, 'source');
  const actor = String(args.actor || 'system');
  const subjectType = args.subjectType || args.subject_type || null;
  const subjectId = args.subjectId || args.subject_id || null;
  const validAt = String(args.validAt || args.valid_at || args.sourceTime || args.source_time || isoNow());
  const recordedAt = String(args.recordedAt || args.recorded_at || isoNow());
  const payloadJson = stableJson(args.payload || {});
  const contentHash = sha256(payloadJson);
  const idempotencyKey = String(
    args.idempotencyKey
      || args.idempotency_key
      || sha256(stableJson({
        streamType, streamId, eventType, source, subjectType, subjectId, validAt, contentHash,
      })),
  );

  const existing = db.prepare(`
    SELECT * FROM memory_events WHERE source = ? AND idempotency_key = ?
  `).get(source, idempotencyKey);
  if (existing) return { inserted: false, event: rowToEvent(existing) };

  const last = db.prepare(`
    SELECT stream_sequence, event_hash
    FROM memory_events
    WHERE stream_type = ? AND stream_id = ?
    ORDER BY stream_sequence DESC
    LIMIT 1
  `).get(streamType, streamId);
  const streamSequence = (last?.stream_sequence || 0) + 1;
  const previousEventHash = last?.event_hash || null;
  const eventId = `me_${sha256(`${source}|${idempotencyKey}`).slice(0, 32)}`;
  const base = {
    event_id: eventId,
    stream_type: streamType,
    stream_id: streamId,
    stream_sequence: streamSequence,
    event_type: eventType,
    schema_version: Number(args.schemaVersion || args.schema_version || 1),
    actor,
    source,
    subject_type: subjectType || null,
    subject_id: subjectId || null,
    valid_at: validAt,
    recorded_at: recordedAt,
    causation_id: args.causationId || args.causation_id || null,
    correlation_id: args.correlationId || args.correlation_id || null,
    idempotency_key: idempotencyKey,
    payload_json: payloadJson,
    content_hash: contentHash,
    previous_event_hash: previousEventHash,
    pii_class: args.piiClass || args.pii_class || 'private',
  };
  const eventHash = sha256(stableJson(base));

  db.prepare(`
    INSERT INTO memory_events (
      event_id, stream_type, stream_id, stream_sequence, event_type,
      schema_version, actor, source, subject_type, subject_id, valid_at,
      recorded_at, causation_id, correlation_id, idempotency_key, payload_json,
      content_hash, previous_event_hash, event_hash, pii_class
    )
    VALUES (
      @event_id, @stream_type, @stream_id, @stream_sequence, @event_type,
      @schema_version, @actor, @source, @subject_type, @subject_id, @valid_at,
      @recorded_at, @causation_id, @correlation_id, @idempotency_key, @payload_json,
      @content_hash, @previous_event_hash, @event_hash, @pii_class
    )
  `).run({ ...base, event_hash: eventHash });

  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO memory_event_links (event_id, target_type, target_id, role)
    VALUES (?, ?, ?, ?)
  `);
  for (const link of normalizeLinks(subjectType, subjectId, args.links)) {
    insertLink.run(eventId, link.targetType, link.targetId, link.role);
  }

  const row = db.prepare('SELECT * FROM memory_events WHERE event_id = ?').get(eventId);
  return { inserted: true, event: rowToEvent(row) };
}

export function appendMemoryEvent(db, args, options = {}) {
  ensureMemoryEventsSchema(db);
  const result = options.useTransaction === false
    ? insertMemoryEvent(db, args)
    : db.transaction(() => insertMemoryEvent(db, args))();
  if (result?.inserted) {
    emitMemoryContextChange({
      kind: 'memory_event',
      event_type: result.event?.event_type || null,
      target_type: result.event?.subject_type || null,
      target_id: result.event?.subject_id || null,
      source: result.event?.source || 'memory-events',
    });
  }
  return result;
}

function rowToEvent(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch {}
  return {
    ...row,
    payload,
  };
}

export function listMemoryEvents(db, filters = {}) {
  ensureMemoryEventsSchema(db);
  const clauses = [];
  const params = {};
  let join = '';
  if (filters.streamType) {
    clauses.push('e.stream_type = @streamType');
    params.streamType = filters.streamType;
  }
  if (filters.streamId) {
    clauses.push('e.stream_id = @streamId');
    params.streamId = filters.streamId;
  }
  if (filters.eventType) {
    clauses.push('e.event_type = @eventType');
    params.eventType = filters.eventType;
  }
  if (filters.asOf) {
    clauses.push('e.valid_at <= @asOf');
    params.asOf = String(filters.asOf);
  }
  if (filters.targetType || filters.targetId) {
    join = 'JOIN memory_event_links l ON l.event_id = e.event_id';
    if (filters.targetType) {
      clauses.push('l.target_type = @targetType');
      params.targetType = filters.targetType;
    }
    if (filters.targetId) {
      clauses.push('l.target_id = @targetId');
      params.targetId = filters.targetId;
    }
  }
  params.limit = Math.max(1, Math.min(Number(filters.limit || 20), 200));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT DISTINCT e.*
    FROM memory_events e
    ${join}
    ${where}
    ORDER BY e.valid_at DESC, e.global_sequence DESC
    LIMIT @limit
  `).all(params);
  return rows.map(rowToEvent);
}

export function recordProjectionRun(db, args) {
  ensureMemoryEventsSchema(db);
  const generatedAt = String(args.generatedAt || args.generated_at || isoNow());
  const metadataJson = stableJson(args.metadata || {});
  const projectionName = requireText(args.projectionName || args.projection_name, 'projectionName');
  const targetType = requireText(args.targetType || args.target_type, 'targetType');
  const targetId = requireText(args.targetId || args.target_id, 'targetId');
  const sourceSetHash = requireText(args.sourceSetHash || args.source_set_hash, 'sourceSetHash');
  const projectionVersion = requireText(args.projectionVersion || args.projection_version, 'projectionVersion');
  const id = args.id || `mpr_${sha256(stableJson({
    projectionName,
    targetType,
    targetId,
    sourceEventTo: args.sourceEventTo || args.source_event_to || null,
    sourceSetHash,
    projectionVersion,
    generatedAt,
  })).slice(0, 32)}`;
  const info = db.prepare(`
    INSERT OR IGNORE INTO memory_projection_runs (
      id, projection_name, target_type, target_id, source_event_from,
      source_event_to, source_set_hash, projection_version, prompt_version,
      model, status, generated_at, generated_by, output_hash, metadata_json
    )
    VALUES (
      @id, @projectionName, @targetType, @targetId, @sourceEventFrom,
      @sourceEventTo, @sourceSetHash, @projectionVersion, @promptVersion,
      @model, @status, @generatedAt, @generatedBy, @outputHash, @metadataJson
    )
  `).run({
    id,
    projectionName,
    targetType,
    targetId,
    sourceEventFrom: args.sourceEventFrom || args.source_event_from || null,
    sourceEventTo: args.sourceEventTo || args.source_event_to || null,
    sourceSetHash,
    projectionVersion,
    promptVersion: args.promptVersion || args.prompt_version || null,
    model: args.model || null,
    status: args.status || 'success',
    generatedAt,
    generatedBy: args.generatedBy || args.generated_by || 'system',
    outputHash: args.outputHash || args.output_hash || null,
    metadataJson,
  });
  const row = db.prepare('SELECT * FROM memory_projection_runs WHERE id = ?').get(id);
  if (info.changes > 0) {
    emitMemoryContextChange({
      kind: 'projection_run',
      projection_name: projectionName,
      target_type: targetType,
      target_id: targetId,
      source: 'memory-projection-runs',
    });
  }
  return row;
}

export function latestProjectionRuns(db, filters = {}) {
  ensureMemoryEventsSchema(db);
  const clauses = [];
  const params = {};
  if (filters.projectionName) {
    clauses.push('projection_name = @projectionName');
    params.projectionName = filters.projectionName;
  }
  if (filters.targetType) {
    clauses.push('target_type = @targetType');
    params.targetType = filters.targetType;
  }
  if (filters.targetId) {
    clauses.push('target_id = @targetId');
    params.targetId = filters.targetId;
  }
  if (filters.asOf) {
    clauses.push('generated_at <= @asOf');
    params.asOf = String(filters.asOf);
  }
  params.limit = Math.max(1, Math.min(Number(filters.limit || 10), 100));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT *
    FROM memory_projection_runs
    ${where}
    ORDER BY generated_at DESC
    LIMIT @limit
  `).all(params);
}
