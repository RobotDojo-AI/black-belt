/**
 * Entity timeline evidence feed.
 *
 * Read-only projection over:
 *   - timeline_events + timeline_event_entities: deterministic source events
 *   - chunk_entities + chunks: linked RAG/embedding evidence for body mentions
 *
 * The output is entity-type aware and safe for both context-file enrichment and
 * chat-time prompt enrichment. No LLM calls. No DB writes.
 */

const DEFAULT_LIMIT = 20;
const DEFAULT_CHUNK_LIMIT = 40;

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

function normalizeEntityType(type) {
  const raw = String(type || '').trim().toLowerCase();
  if (raw === 'people') return 'person';
  if (raw === 'companies') return 'company';
  if (raw === 'places') return 'place';
  return raw || 'person';
}

function cleanText(text, max = 220) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
}

function sourceLabel(sourceType) {
  const t = String(sourceType || '').trim().toLowerCase();
  if (t === 'imessage') return 'iMessage';
  if (t === 'calendar') return 'calendar';
  if (t === 'email') return 'email';
  if (t === 'granola' || t === 'transcript') return 'meeting transcript';
  if (t === 'call') return 'call';
  if (t === 'note') return 'note';
  if (t === 'drive') return 'document';
  if (t === 'asana') return 'task';
  if (t === 'photo') return 'photo';
  if (t === 'health_note') return 'health note';
  if (t === 'health_metric') return 'health metric';
  if (t === 'key_document') return 'key document';
  if (t === 'receipt') return 'receipt';
  if (t === 'file') return 'file';
  if (t === 'chat') return 'chat';
  // st_483361e2 — chat chunk source_types surface as clean labels in an entity's
  // timeline instead of the raw internal strings. 'llm_export' is imported chat
  // transcript history; 'conversation' is in-app live chat.
  if (t === 'llm_export') return 'chat import';
  if (t === 'conversation') return 'chat';
  return t || 'source';
}

function canonicalSourceType(sourceType) {
  const type = String(sourceType || '').trim().toLowerCase();
  return type === 'granola' ? 'transcript' : type;
}

function normalizedSourceId(sourceType, sourceId) {
  const type = canonicalSourceType(sourceType);
  let id = String(sourceId ?? '').trim();
  if (!type || !id) return id;
  const prefixes = type === 'transcript'
    ? ['transcript:', 'granola:']
    : [`${type}:`];
  for (const prefix of prefixes) {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  return id;
}

function sourceKey(row) {
  if (!row?.source_type || row?.source_id == null) return null;
  const type = canonicalSourceType(row.source_type);
  const id = normalizedSourceId(type, row.source_id);
  return type && id ? `${type}:${id}` : null;
}

function dateOf(row) {
  return row?.event_date || row?.eventTime || row?.created_at || '';
}

function eventSort(a, b) {
  return String(dateOf(b)).localeCompare(String(dateOf(a)))
    || String(b.id || '').localeCompare(String(a.id || ''));
}

function dedupePush(list, value) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function timelineRows(db, entityType, entityId, limit) {
  if (!hasTable(db, 'timeline_events') || !hasTable(db, 'timeline_event_entities')) return [];
  if (!hasColumn(db, 'timeline_events', 'event_date')) return [];
  const metadataExpr = hasColumn(db, 'timeline_events', 'metadata') ? 'te.metadata' : "'{}' AS metadata";

  const hasGeneric = hasColumn(db, 'timeline_event_entities', 'entity_type')
    && hasColumn(db, 'timeline_event_entities', 'entity_id');
  const id = String(entityId);
  const clauses = [];
  const params = [];
  if (hasGeneric) {
    clauses.push('(tee.entity_type = ? AND CAST(tee.entity_id AS TEXT) = ?)');
    params.push(entityType, id);
  }
  if (entityType === 'person' && hasColumn(db, 'timeline_event_entities', 'person_id')) {
    clauses.push('tee.person_id = ?');
    params.push(id);
  }
  if (!clauses.length) return [];

  try {
    return db.prepare(`
      SELECT DISTINCT
        te.id,
        te.source_type,
        te.source_id,
        te.event_date,
        te.event_type,
        te.summary,
        ${metadataExpr},
        tee.role
      FROM timeline_event_entities tee
      JOIN timeline_events te ON te.id = tee.event_id
      WHERE ${clauses.join(' OR ')}
      ORDER BY te.event_date DESC
      LIMIT ?
    `).all(...params, limit);
  } catch {
    return [];
  }
}

function chunkRows(db, entityType, entityId, limit) {
  if (!hasTable(db, 'chunks') || !hasTable(db, 'chunk_entities')) return [];
  const eventTimeExpr = hasColumn(db, 'chunks', 'event_time')
    ? "NULLIF(c.event_time, '')"
    : 'NULL';
  const createdExpr = hasColumn(db, 'chunks', 'created_at')
    ? "NULLIF(c.created_at, '')"
    : 'NULL';
  const embeddedExpr = hasColumn(db, 'chunks', 'embedded') ? 'c.embedded' : '0';
  const valueRankExpr = hasColumn(db, 'chunks', 'value_rank') ? 'c.value_rank' : '0';
  const qualityScoreExpr = hasColumn(db, 'chunks', 'quality_score') ? 'c.quality_score' : '0';

  try {
    return db.prepare(`
      SELECT
        ce.chunk_id,
        c.source_type,
        c.source_id,
        COALESCE(${eventTimeExpr}, ${createdExpr}) AS event_date,
        c.content,
        ${createdExpr} AS created_at,
        ${embeddedExpr} AS embedded,
        ${valueRankExpr} AS value_rank,
        ${qualityScoreExpr} AS quality_score
      FROM chunk_entities ce
      JOIN chunks c ON c.id = ce.chunk_id
      WHERE ce.entity_type = ?
        AND CAST(ce.entity_id AS TEXT) = ?
      ORDER BY COALESCE(${eventTimeExpr}, ${createdExpr}) DESC,
               COALESCE(${valueRankExpr}, 0) DESC,
               c.id DESC
      LIMIT ?
    `).all(entityType, String(entityId), limit);
  } catch {
    return [];
  }
}

function eventFromTimeline(row) {
  return {
    id: row.id,
    eventId: row.id,
    evidenceType: 'timeline_event',
    event_date: row.event_date,
    date: String(row.event_date || '').slice(0, 10),
    event_type: row.event_type || row.source_type || 'event',
    source_type: row.source_type || null,
    source_id: row.source_id == null ? null : String(row.source_id),
    role: row.role || 'participant',
    summary: cleanText(row.summary || row.event_type || sourceLabel(row.source_type)),
    body: '',
    sourceLabel: sourceLabel(row.source_type),
    evidenceIds: [row.id],
    chunkIds: [],
    hasTimelineEvent: true,
    hasLinkedRag: false,
  };
}

function eventFromChunk(row) {
  const label = sourceLabel(row.source_type);
  const summary = cleanText(row.content || label);
  return {
    id: `chunk:${row.chunk_id}`,
    eventId: null,
    evidenceType: 'body_mention',
    event_date: row.event_date || row.created_at || '',
    date: String(row.event_date || row.created_at || '').slice(0, 10),
    event_type: 'body_mention',
    source_type: row.source_type || null,
    source_id: row.source_id == null ? null : String(row.source_id),
    role: 'mentioned',
    summary,
    body: summary,
    sourceLabel: `Mentioned in ${label}`,
    evidenceIds: [`chunk:${row.chunk_id}`],
    chunkIds: [row.chunk_id],
    hasTimelineEvent: false,
    hasLinkedRag: true,
    embedded: Number(row.embedded || 0) === 1,
    valueRank: Number(row.value_rank || 0),
    qualityScore: Number(row.quality_score || 0),
  };
}

function mergeChunkIntoEvent(event, row) {
  dedupePush(event.evidenceIds, `chunk:${row.chunk_id}`);
  dedupePush(event.chunkIds, row.chunk_id);
  event.hasLinkedRag = true;
  event.embedded = event.embedded || Number(row.embedded || 0) === 1;
  event.valueRank = Math.max(Number(event.valueRank || 0), Number(row.value_rank || 0));
  event.qualityScore = Math.max(Number(event.qualityScore || 0), Number(row.quality_score || 0));
  if (!event.body) event.body = cleanText(row.content || '');
}

/**
 * Build a merged event feed for an entity from deterministic timeline links and
 * linked RAG chunks.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ entityType: string, entityId: string|number, limit?: number, chunkLimit?: number }} opts
 * @returns {Array<object>}
 */
export function getEntityTimeline(db, {
  entityType = 'person',
  entityId,
  limit = DEFAULT_LIMIT,
  chunkLimit = DEFAULT_CHUNK_LIMIT,
} = {}) {
  if (entityId == null || entityId === '') return [];
  const type = normalizeEntityType(entityType);
  const eventLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
  const ragLimit = Number.isFinite(chunkLimit) && chunkLimit > 0 ? Math.floor(chunkLimit) : DEFAULT_CHUNK_LIMIT;
  const byKey = new Map();
  const loose = [];

  for (const row of timelineRows(db, type, entityId, Math.max(eventLimit, ragLimit))) {
    const event = eventFromTimeline(row);
    const key = sourceKey(row) || `event:${row.id}`;
    byKey.set(key, event);
  }

  for (const row of chunkRows(db, type, entityId, ragLimit)) {
    const key = sourceKey(row);
    if (key && byKey.has(key)) {
      mergeChunkIntoEvent(byKey.get(key), row);
    } else {
      loose.push(eventFromChunk(row));
    }
  }

  return [...byKey.values(), ...loose]
    .filter((event) => event.date || event.summary)
    .sort(eventSort)
    .slice(0, eventLimit);
}

export function formatEntityTimelineLines(events, { maxEvents = 10 } = {}) {
  const rows = (events || []).slice(0, maxEvents);
  return rows.map((event) => {
    const date = event.date || String(event.event_date || '').slice(0, 10) || 'unknown date';
    const summary = cleanText(event.summary || event.body || event.event_type || 'Event', 180);
    const label = event.sourceLabel || (event.source_type ? sourceLabel(event.source_type) : '');
    const evidence = [
      label,
      event.hasTimelineEvent && event.hasLinkedRag ? 'timeline + linked RAG' : null,
      !event.hasTimelineEvent && event.hasLinkedRag ? 'linked RAG' : null,
      event.embedded ? 'embedded' : null,
    ].filter(Boolean).join('; ');
    return `- ${date}: ${summary}${evidence ? ` (${evidence})` : ''}`;
  });
}

export function formatEntityTimelineSection(events, {
  heading = 'Relationship Timeline',
  maxEvents = 15,
  empty = '- No source-backed timeline events yet.',
} = {}) {
  const lines = formatEntityTimelineLines(events, { maxEvents });
  const body = lines.length ? lines.join('\n') : empty;
  return heading ? `## ${heading}\n\n${body}\n` : body;
}
