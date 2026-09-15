/**
 * Ingest a foundation-model identity dump as a high-weight source.
 *
 * The dump is evidence, not the standing profile. Timeline + memory log
 * get it immediately. Miyagi then confirms with the user before treating
 * facts as settled.
 */
import { createHash } from 'node:crypto';
import { insertTimelineEventForDb } from './timeline-schema.js';
import { appendMemoryEvent, ensureMemoryEventsSchema } from './memory-events.js';
import { saveIdentitySeed } from './generate-user-md.js';
import { appendMemory } from './memory.js';

export const IDENTITY_DUMP_SOURCE_TYPE = 'identity_import';
export const IDENTITY_DUMP_EVENT_TYPE = 'identity_dump';
export const IDENTITY_DUMP_TOPIC = 'personal';
export const IDENTITY_DUMP_CONTENT_RANK = 0;
export const IDENTITY_DUMP_MIN_CHARS = 40;
export const IDENTITY_DUMP_MAX_CHARS = 500_000;
export const IDENTITY_DUMP_CHUNK_CHARS = 1500;

const VALUE_RANK_BASE = 1;
const VALUE_RANK_SOURCE_SIGNAL_MULT = 100_000_000_000;
const VALUE_RANK_RECENCY_MULT = 1_000_000;
const VALUE_RANK_DAYS_CAP = 60_000;
const VALUE_RANK_LENGTH_CAP = 999_999;
const SECONDS_PER_DAY = 86_400;

function sha256(text) {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function isoNoMs(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function hasTable(database, name) {
  try {
    return !!database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch {
    return false;
  }
}

function hasColumn(database, table, column) {
  try {
    return database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function tokenEstimate(text) {
  return Math.max(1, Math.ceil(String(text || '').trim().length / 4));
}

function valueRank(eventTime, content, contentRank = IDENTITY_DUMP_CONTENT_RANK) {
  let epochDays = 0;
  const ms = Date.parse(eventTime);
  if (Number.isFinite(ms)) {
    epochDays = Math.min(VALUE_RANK_DAYS_CAP, Math.max(0, Math.floor(ms / 1000 / SECONDS_PER_DAY)));
  }
  const rank = Math.min(3, Math.max(0, Number(contentRank) || 0));
  const sourceSignal = (3 - rank) * VALUE_RANK_SOURCE_SIGNAL_MULT;
  const len = Math.min(String(content || '').length, VALUE_RANK_LENGTH_CAP);
  return VALUE_RANK_BASE + sourceSignal + (epochDays * VALUE_RANK_RECENCY_MULT) + len;
}

function splitChunks(text, size = IDENTITY_DUMP_CHUNK_CHARS) {
  const body = String(text || '').trim();
  if (!body) return [];
  if (body.length <= size) return [body];
  const parts = [];
  let remaining = body;
  while (remaining.length) {
    if (remaining.length <= size) {
      parts.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n\n', size);
    if (cut < size * 0.45) cut = remaining.lastIndexOf('\n', size);
    if (cut < size * 0.45) cut = size;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return parts.filter(Boolean);
}

function insertIdentityChunks(database, { sourceId, content, conversationId, now }) {
  if (!hasTable(database, 'chunks')) return 0;
  const parts = splitChunks(content);
  const eventTime = isoNoMs(now);
  const withRank = hasColumn(database, 'chunks', 'content_rank');
  const withValue = hasColumn(database, 'chunks', 'value_rank');
  const withEventTime = hasColumn(database, 'chunks', 'event_time');
  let inserted = 0;
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i];
    const metadata = JSON.stringify({
      kind: 'identity_dump',
      weight: 'high',
      provenance: 'foundation-model-dump',
      conversation_id: conversationId || null,
    });
    const cols = ['topic', 'source_type', 'source_id', 'chunk_index', 'content', 'metadata', 'token_count', 'embedded', 'skip_embed'];
    const values = [IDENTITY_DUMP_TOPIC, IDENTITY_DUMP_SOURCE_TYPE, sourceId, i, chunk, metadata, tokenEstimate(chunk), 0, 0];
    if (withEventTime) {
      cols.push('event_time');
      values.push(eventTime);
    }
    if (withRank) {
      cols.push('content_rank');
      values.push(IDENTITY_DUMP_CONTENT_RANK);
    }
    if (withValue) {
      cols.push('value_rank');
      values.push(valueRank(eventTime, chunk, IDENTITY_DUMP_CONTENT_RANK));
    }
    const placeholders = cols.map(() => '?').join(', ');
    database.prepare(`
      INSERT INTO chunks (${cols.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT(topic, source_type, source_id, chunk_index) DO UPDATE SET
        content = excluded.content,
        metadata = excluded.metadata,
        token_count = excluded.token_count,
        embedded = 0,
        skip_embed = 0
    `).run(...values);
    inserted += 1;
  }
  return inserted;
}

/**
 * Persist a pasted identity dump as high-weight source material.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.database
 * @param {string} opts.text
 * @param {string} [opts.conversationId]
 * @param {function} [opts.saveSeed]
 * @param {function} [opts.appendLog]
 * @param {Date} [opts.now]
 * @returns {Promise<{ ok: boolean, sourceId?: string, timelineEventId?: string, chars?: number, chunks?: number, error?: string }>}
 */
export async function ingestIdentityDump({
  database,
  text,
  conversationId = null,
  saveSeed = saveIdentitySeed,
  appendLog = appendMemory,
  now = new Date(),
} = {}) {
  const body = String(text || '').trim();
  if (body.length < IDENTITY_DUMP_MIN_CHARS) {
    return { ok: false, error: 'paste the memory dump from your foundation model first' };
  }
  if (body.length > IDENTITY_DUMP_MAX_CHARS) {
    return { ok: false, error: 'dump is too long; split it and paste again' };
  }
  if (!database) return { ok: false, error: 'database required' };

  const hash = sha256(body);
  const sourceId = `${IDENTITY_DUMP_SOURCE_TYPE}:${hash.slice(0, 24)}`;
  const date = todayIso(now);

  const saved = await saveSeed(body);
  if (!saved?.ok) return { ok: false, error: saved?.error || 'seed_failed' };

  const timeline = insertTimelineEventForDb(database, {
    sourceType: IDENTITY_DUMP_SOURCE_TYPE,
    sourceId,
    eventDate: date,
    eventType: IDENTITY_DUMP_EVENT_TYPE,
    summary: 'Identity dump from another AI',
    content: body,
    metadata: {
      provenance: 'foundation-model-dump',
      weight: 'high',
      status: 'source',
      conversation_id: conversationId || null,
      chars: body.length,
      content_hash: hash,
    },
  });

  await appendLog({
    type: 'user',
    name: `identity-dump-${hash.slice(0, 8)}`,
    description: 'Identity dump from another AI',
    author: 'user',
    body,
    tags: ['identity-import', 'high-weight'],
    sessionId: conversationId || null,
  });

  try {
    ensureMemoryEventsSchema(database);
    appendMemoryEvent(database, {
      streamType: 'identity',
      streamId: 'user',
      eventType: 'identity.dump.ingested',
      actor: 'user',
      source: 'identity-dump',
      subjectType: 'user',
      subjectId: 'self',
      validAt: isoNoMs(now),
      idempotencyKey: `identity-dump:${hash}`,
      payload: {
        source_id: sourceId,
        timeline_event_id: timeline.id,
        conversation_id: conversationId || null,
        chars: body.length,
        weight: 'high',
        status: 'source',
      },
      links: [
        { targetType: 'timeline_event', targetId: timeline.id, role: 'source' },
      ],
    });
  } catch {
    // memory_events is additive; timeline + log already hold the dump
  }

  let chunks = 0;
  try {
    chunks = insertIdentityChunks(database, { sourceId, content: body, conversationId, now });
  } catch {
    chunks = 0;
  }

  return {
    ok: true,
    sourceId,
    timelineEventId: timeline.id,
    chars: body.length,
    chunks,
    seeded: true,
  };
}
