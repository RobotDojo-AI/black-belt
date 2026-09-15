// lib/timeline-recalc.js - deterministic life-timeline projection.
//
// Raw source tables remain truth. timeline_events is the fast user-facing
// projection: what happened when, across data the user connected/imported.

import { insertTimelineEventForDb } from './timeline-schema.js';
import { healthMetricTimelineEvent } from './health-timeline.js';

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
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

function clip(text, max = 220) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
}

function parseJson(text, fallback = {}) {
  try { return JSON.parse(text || '{}') || fallback; } catch { return fallback; }
}

function taskSummaryFromChunk(content) {
  const line = String(content || '').split(/\r?\n/).find((row) => /^Task:\s*/i.test(row));
  return clip((line || 'Asana task').replace(/^Task:\s*/i, '').trim() || 'Asana task');
}

function asanaCompletedFromChunk(content, metadata) {
  if (metadata.completed != null) return !!metadata.completed;
  return /^Status:\s*completed\s*$/im.test(String(content || ''));
}

export const LIFE_TIMELINE_SOURCES = [
  {
    name: 'email',
    table: 'emails',
    required: ['id', 'received_at'],
    select: `
      SELECT id, received_at AS event_date, subject, sender_email, account_id, is_newsletter
      FROM emails
      WHERE received_at IS NOT NULL AND received_at != ''
    `,
    map: (row) => ({
      sourceType: 'email',
      sourceId: String(row.id),
      eventDate: row.event_date,
      eventType: 'email',
      summary: clip(row.subject || row.sender_email || 'Email'),
      content: `${row.subject || ''}\n${row.sender_email || ''}`,
      metadata: { account_id: row.account_id || null, is_newsletter: !!row.is_newsletter },
    }),
  },
  {
    name: 'calendar',
    table: 'calendar_events',
    required: ['id', 'start_time'],
    select: `
      SELECT id, start_time AS event_date, summary, calendar_id, source, status
      FROM calendar_events
      WHERE start_time IS NOT NULL AND start_time != ''
    `,
    map: (row) => ({
      sourceType: 'calendar',
      sourceId: String(row.id),
      eventDate: row.event_date,
      eventType: 'calendar',
      summary: clip(row.summary || 'Calendar event'),
      content: `${row.summary || ''}\n${row.calendar_id || ''}`,
      metadata: { calendar_id: row.calendar_id || null, source: row.source || null, status: row.status || null },
    }),
  },
  {
    name: 'imessage',
    table: 'imessages',
    required: ['source_id', 'date'],
    select: `
      SELECT source_id, date AS event_date, handle, handle_kind, sent_count, received_count, is_group
      FROM imessages
      WHERE date IS NOT NULL AND date != ''
    `,
    map: (row) => ({
      sourceType: 'imessage',
      sourceId: String(row.source_id),
      eventDate: row.event_date,
      eventType: 'imessage',
      summary: clip(`iMessage with ${row.is_group ? 'group' : row.handle || 'contact'} (${row.sent_count || 0} sent, ${row.received_count || 0} received)`),
      content: `${row.handle || ''}:${row.sent_count || 0}:${row.received_count || 0}`,
      metadata: { handle_kind: row.handle_kind || null, is_group: !!row.is_group },
    }),
  },
  {
    name: 'transcript',
    table: 'transcripts',
    required: ['id', 'meeting_date'],
    select: `
      SELECT id, meeting_date AS event_date, title, source, topic, attendee_emails
      FROM transcripts
      WHERE meeting_date IS NOT NULL AND meeting_date != ''
    `,
    map: (row) => ({
      sourceType: row.source || 'transcript',
      sourceId: String(row.id),
      eventDate: row.event_date,
      eventType: 'meeting_transcript',
      summary: clip(row.title || 'Meeting transcript'),
      content: `${row.title || ''}\n${row.attendee_emails || ''}`,
      metadata: { topic: row.topic || null, source: row.source || null },
    }),
  },
  {
    name: 'call',
    table: 'calls',
    required: ['id', 'call_time'],
    select: `
      SELECT id, call_time AS event_date, address, name, direction, answered, duration_sec, service, source
      FROM calls
      WHERE call_time IS NOT NULL AND call_time != ''
    `,
    map: (row) => ({
      sourceType: 'call',
      sourceId: String(row.id),
      eventDate: row.event_date,
      eventType: 'call',
      summary: clip(`${row.direction || 'call'} call with ${row.name || row.address || 'unknown'}`),
      content: `${row.name || ''}\n${row.address || ''}\n${row.direction || ''}\n${row.service || ''}`,
      metadata: {
        direction: row.direction || null,
        answered: !!row.answered,
        duration_sec: row.duration_sec || 0,
        service: row.service || null,
        source: row.source || null,
      },
    }),
  },
  {
    name: 'note',
    table: 'notes',
    required: ['id', 'modified_at'],
    select: `
      SELECT id, modified_at AS event_date, created_at, title, snippet, body, folder, source
      FROM notes
      WHERE modified_at IS NOT NULL AND modified_at != ''
    `,
    map: (row) => ({
      sourceType: 'note',
      sourceId: String(row.id),
      eventDate: row.event_date,
      eventType: 'note',
      summary: clip(row.title || row.snippet || row.body || 'Note'),
      content: `${row.title || ''}\n${row.snippet || ''}\n${row.body || ''}`,
      metadata: {
        created_at: row.created_at || null,
        folder: row.folder || null,
        source: row.source || null,
      },
    }),
  },
  {
    name: 'health_note',
    table: 'health_notes',
    required: ['id', 'date'],
    select: `
      SELECT id, date AS event_date, content, tags, source
      FROM health_notes
      WHERE date IS NOT NULL AND date != ''
    `,
    map: (row) => ({
      sourceType: row.source || 'health_note',
      sourceId: String(row.id),
      eventDate: row.event_date,
      eventType: 'health_note',
      summary: clip(row.content || 'Health note'),
      content: row.content || '',
      metadata: { tags: row.tags || null, source: row.source || null },
    }),
  },
  {
    name: 'health_metric',
    table: 'health_data_points',
    required: ['id', 'date'],
    select: `
      SELECT id, marker_id, date AS event_date, value, source, source_file, excluded
      FROM health_data_points
      WHERE date IS NOT NULL AND date != ''
    `,
    map: (row) => healthMetricTimelineEvent({
      id: row.id,
      marker_id: row.marker_id,
      date: row.event_date,
      value: row.value,
      source: row.source,
      source_file: row.source_file,
      excluded: row.excluded,
    }),
  },
  {
    name: 'drive',
    table: 'drive_files',
    required: ['drive_file_id', 'modified_at'],
    select: `
      SELECT drive_file_id, modified_at AS event_date, name, mime_type, topic, account_id
      FROM drive_files
      WHERE modified_at IS NOT NULL AND modified_at != ''
    `,
    map: (row) => ({
      sourceType: 'drive',
      sourceId: String(row.drive_file_id),
      eventDate: row.event_date,
      eventType: 'document',
      summary: clip(row.name || 'Drive file'),
      content: `${row.name || ''}\n${row.topic || ''}`,
      metadata: { topic: row.topic || null, mime_type: row.mime_type || null, account_id: row.account_id || null },
    }),
  },
  {
    name: 'photo',
    table: 'photos',
    required: ['id', 'creation_time'],
    select: `
      SELECT id, creation_time AS event_date, filename, mime_type, account_id, latitude, longitude
      FROM photos
      WHERE creation_time IS NOT NULL AND creation_time != ''
    `,
    map: (row) => ({
      sourceType: 'photo',
      sourceId: String(row.id),
      eventDate: row.event_date,
      eventType: 'photo',
      summary: clip(row.filename || 'Photo'),
      content: `${row.filename || ''}\n${row.creation_time || ''}`,
      metadata: {
        mime_type: row.mime_type || null,
        account_id: row.account_id || null,
        has_location: row.latitude != null && row.longitude != null,
      },
    }),
  },
  {
    name: 'file',
    table: 'drop_folder_files',
    required: ['path', 'processed_at'],
    select: `
      SELECT path, processed_at AS event_date, original_name, doc_type, topic_t1, topic_t2, source
      FROM drop_folder_files
      WHERE processed_at IS NOT NULL AND processed_at != ''
    `,
    map: (row) => ({
      sourceType: 'file',
      sourceId: String(row.path),
      eventDate: row.event_date,
      eventType: row.doc_type || 'file',
      summary: clip(row.original_name || row.path),
      content: `${row.original_name || ''}\n${row.doc_type || ''}\n${row.topic_t1 || ''}/${row.topic_t2 || ''}`,
      metadata: { doc_type: row.doc_type || null, topic_t1: row.topic_t1 || null, topic_t2: row.topic_t2 || null, source: row.source || null },
    }),
  },
  {
    name: 'key_document',
    table: 'key_documents',
    required: ['id', 'document_date', 'received_at', 'created_at'],
    select: `
      SELECT id, source_id, source_type, doc_type, extracted_json, owner_person_id,
             COALESCE(NULLIF(document_date, ''), NULLIF(received_at, ''), created_at) AS event_date,
             document_date, received_at, extraction_confidence, extraction_model, raw_text_hash
      FROM key_documents
      WHERE COALESCE(NULLIF(document_date, ''), NULLIF(received_at, ''), created_at) IS NOT NULL
        AND COALESCE(NULLIF(document_date, ''), NULLIF(received_at, ''), created_at) != ''
    `,
    map: (row) => ({
      sourceType: 'key_document',
      sourceId: String(row.id),
      eventDate: row.event_date,
      eventType: row.doc_type || 'key_document',
      summary: clip(row.doc_type || 'Key document'),
      content: row.extracted_json || '',
      metadata: {
        source_id: row.source_id || null,
        source_type: row.source_type || null,
        owner_person_id: row.owner_person_id || null,
        document_date: row.document_date || null,
        received_at: row.received_at || null,
        extraction_confidence: row.extraction_confidence ?? null,
        extraction_model: row.extraction_model || null,
        raw_text_hash: row.raw_text_hash || null,
      },
    }),
  },
  {
    name: 'receipt',
    table: 'receipts',
    required: ['id', 'purchase_date', 'created_at'],
    select: `
      SELECT id, source_id, source_type, category, merchant, platform, purchase_date,
             amount_cents, currency, owner_person_id, extraction_confidence, extraction_model,
             raw_text_hash, items_json, created_at
      FROM receipts
      WHERE COALESCE(NULLIF(purchase_date, ''), created_at) IS NOT NULL
        AND COALESCE(NULLIF(purchase_date, ''), created_at) != ''
    `,
    map: (row) => ({
      sourceType: 'receipt',
      sourceId: String(row.id),
      eventDate: row.purchase_date || row.created_at,
      eventType: 'receipt',
      summary: clip(row.merchant || row.platform || row.category || 'Receipt'),
      content: row.items_json || '',
      metadata: {
        source_id: row.source_id || null,
        source_type: row.source_type || null,
        category: row.category || null,
        platform: row.platform || null,
        amount_cents: row.amount_cents ?? null,
        currency: row.currency || null,
        owner_person_id: row.owner_person_id || null,
        extraction_confidence: row.extraction_confidence ?? null,
        extraction_model: row.extraction_model || null,
        raw_text_hash: row.raw_text_hash || null,
      },
    }),
  },
  {
    name: 'chat',
    table: 'conversations',
    required: ['id', 'created_at'],
    select: `
      SELECT id, created_at AS event_date, title, model, topic_slug, chat_type
      FROM conversations
      WHERE created_at IS NOT NULL AND created_at != ''
    `,
    map: (row) => ({
      sourceType: 'chat',
      sourceId: String(row.id),
      eventDate: row.event_date,
      eventType: row.chat_type === 'action' ? 'action_chat' : 'chat',
      summary: clip(row.title || 'Chat'),
      content: `${row.title || ''}\n${row.topic_slug || ''}`,
      metadata: { model: row.model || null, topic_slug: row.topic_slug || null, chat_type: row.chat_type || 'chat' },
    }),
  },
  {
    name: 'asana',
    table: 'chunks',
    required: ['source_type', 'source_id', 'content', 'metadata', 'created_at'],
    select: `
      SELECT c.source_id, c.content, c.metadata, c.created_at
      FROM chunks c
      JOIN (
        SELECT source_id, MAX(id) AS id
        FROM chunks
        WHERE source_type = 'asana'
          AND created_at IS NOT NULL
          AND created_at != ''
        GROUP BY source_id
      ) latest ON latest.id = c.id
    `,
    map: (row) => {
      const metadata = parseJson(row.metadata);
      const completed = asanaCompletedFromChunk(row.content, metadata);
      return {
        sourceType: 'asana',
        sourceId: String(row.source_id),
        eventDate: metadata.modified_at || metadata.created_at || metadata.due_on || row.created_at,
        eventType: completed ? 'task_completed' : 'task',
        summary: taskSummaryFromChunk(row.content),
        content: row.content || '',
        metadata: { ...metadata, completed },
      };
    },
  },
];

function sourceReady(db, source) {
  if (!hasTable(db, source.table)) return false;
  return (source.required || []).every((column) => hasColumn(db, source.table, column));
}

export function recalcLifeTimeline(db, { sources = LIFE_TIMELINE_SOURCES } = {}) {
  const out = [];
  let totalRows = 0;
  let totalChanged = 0;
  for (const source of sources) {
    if (!sourceReady(db, source)) {
      out.push({ source: source.name, skipped: true, reason: 'missing_table_or_columns', rows: 0, changed: 0 });
      continue;
    }
    const rows = db.prepare(source.select).all();
    let changed = 0;
    const tx = db.transaction((items) => {
      for (const row of items) {
        const event = source.map(row);
        if (!event?.sourceType || !event?.sourceId || !event?.eventDate) continue;
        const result = insertTimelineEventForDb(db, {
          eventType: event.sourceType,
          summary: '',
          content: '',
          metadata: {},
          ...event,
          metadata: event.metadata || {},
        });
        if (result.inserted) changed++;
      }
    });
    tx(rows);
    totalRows += rows.length;
    totalChanged += changed;
    out.push({ source: source.name, skipped: false, rows: rows.length, changed });
  }
  return {
    ok: true,
    source_count: out.length,
    source_rows: totalRows,
    timeline_changed: totalChanged,
    sources: out,
  };
}

export function timelineCoverage(db, { sources = LIFE_TIMELINE_SOURCES } = {}) {
  const rows = [];
  for (const source of sources) {
    if (!sourceReady(db, source)) {
      rows.push({ source: source.name, ready: false, source_rows: 0, timeline_rows: 0, missing: 0 });
      continue;
    }
    const sourceRows = db.prepare(`SELECT COUNT(*) AS n FROM (${source.select})`).get().n;
    const timelineRows = db.prepare(`
      SELECT COUNT(*) AS n
      FROM timeline_events
      WHERE source_type IN (${sourceTimelineTypes(source).map(() => '?').join(',')})
    `).get(...sourceTimelineTypes(source)).n;
    rows.push({
      source: source.name,
      ready: true,
      source_rows: sourceRows,
      timeline_rows: timelineRows,
      missing: Math.max(0, sourceRows - timelineRows),
    });
  }
  return {
    ok: rows.every((row) => !row.ready || row.missing === 0),
    sources: rows,
  };
}

function sourceTimelineTypes(source) {
  if (source.name === 'transcript') return ['granola', 'transcript'];
  if (source.name === 'health_note') return ['oura', 'eightsleep', 'health_note'];
  if (source.name === 'health_metric') {
    return [
      'apple-health', 'pdf-lab', 'pdf', 'fhir', 'manual', 'derived-lipid',
      'health_metric', 'oura-json', 'oura_sync', 'eight_sleep_sync', 'chat',
    ];
  }
  return [source.name];
}
