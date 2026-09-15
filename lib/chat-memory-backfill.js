// lib/chat-memory-backfill.js - replay existing chat rows into memory_events.
//
// Live chat writes append memory events at turn time. This module is the
// historical backfill: if a DB already has messages, or old chat imports arrive,
// replay them into the immutable memory ledger without duplicating live writes.

import crypto from 'node:crypto';
import { appendMemoryEvent, ensureMemoryEventsSchema } from './memory-events.js';
import { memoryTopicLink } from './topic-routing-policy.js';

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

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

function parseTags(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
}

function memoryLinks(row) {
  const links = [{ targetType: 'conversation', targetId: row.conversation_id, role: 'source' }];
  const topics = new Set();
  if (row.topic_slug) topics.add(String(row.topic_slug));
  for (const tag of parseTags(row.tags)) topics.add(tag);
  for (const topic of topics) {
    const link = memoryTopicLink(topic, { role: 'scope' });
    if (link) links.push(link);
  }
  if (!links.some((link) => link.targetType === 'topic')) {
    links.push(memoryTopicLink(null, { fallback: true }));
  }
  return links;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function appendMemoryEventWithRetry(db, args, { attempts = 20, baseDelayMs = 250 } = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return appendMemoryEvent(db, args);
    } catch (err) {
      if (err?.code !== 'SQLITE_BUSY') throw err;
      lastError = err;
      sleepMs(baseDelayMs * (i + 1));
    }
  }
  throw lastError;
}

function messageMemoryExists(db, row) {
  const messageId = String(row.id);
  try {
    const existing = db.prepare(`
      SELECT 1
      FROM memory_events
      WHERE subject_type = 'conversation'
        AND subject_id = ?
        AND event_type = ?
        AND json_extract(payload_json, '$.message_id') = ?
      LIMIT 1
    `).get(row.conversation_id, `chat.message.${row.role}`, messageId);
    if (existing) return true;
  } catch {
    const needle = `"message_id":"${messageId.replace(/"/g, '\\"')}"`;
    const existing = db.prepare(`
      SELECT 1
      FROM memory_events
      WHERE subject_type = ?
        AND subject_id = ?
        AND event_type = ?
        AND payload_json LIKE ?
      LIMIT 1
    `).get('conversation', row.conversation_id, `chat.message.${row.role}`, `%${needle}%`);
    if (existing) return true;
  }
  return false;
}

function selectMessages(db, { limit = null, conversationId = null } = {}) {
  const hasTopicSlug = hasColumn(db, 'conversations', 'topic_slug');
  const hasTags = hasColumn(db, 'conversations', 'tags');
  const hasTitle = hasColumn(db, 'conversations', 'title');
  const hasConvCreated = hasColumn(db, 'conversations', 'created_at');
  const hasMsgCreated = hasColumn(db, 'messages', 'created_at');
  const hasSeq = hasColumn(db, 'messages', 'seq');
  const clauses = [];
  const params = {};
  if (conversationId) {
    clauses.push('m.conversation_id = @conversationId');
    params.conversationId = String(conversationId);
  }
  if (limit) params.limit = Math.max(1, Number(limit) || 1);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT
      m.id,
      m.conversation_id,
      m.role,
      m.content,
      ${hasSeq ? 'm.seq' : 'm.id'} AS seq,
      ${hasMsgCreated ? 'm.created_at' : 'NULL'} AS created_at,
      ${hasTitle ? 'c.title' : 'NULL'} AS title,
      ${hasTopicSlug ? 'c.topic_slug' : 'NULL'} AS topic_slug,
      ${hasTags ? 'c.tags' : "'[]'"} AS tags,
      ${hasConvCreated ? 'c.created_at' : 'NULL'} AS conversation_created_at
    FROM messages m
    LEFT JOIN conversations c ON c.id = m.conversation_id
    ${where}
    ORDER BY
      COALESCE(${hasConvCreated ? 'c.created_at' : 'NULL'}, ${hasMsgCreated ? 'm.created_at' : 'NULL'}, ''),
      m.conversation_id,
      COALESCE(${hasSeq ? 'm.seq' : 'NULL'}, m.id),
      m.id
    ${limit ? 'LIMIT @limit' : ''}
  `).all(params);
}

export function backfillChatMemoryEvents(db, { limit = null, conversationId = null } = {}) {
  if (!db || !hasTable(db, 'messages') || !hasTable(db, 'conversations')) {
    return { ok: true, scanned: 0, inserted: 0, skipped_existing: 0, skipped_missing_tables: true };
  }
  try { db.pragma('busy_timeout = 30000'); } catch {}
  ensureMemoryEventsSchema(db);
  const rows = selectMessages(db, { limit, conversationId });
  const stats = { ok: true, scanned: rows.length, inserted: 0, skipped_existing: 0 };

  for (const row of rows) {
    if (!row?.conversation_id || !row?.role) continue;
    if (messageMemoryExists(db, row)) {
      stats.skipped_existing++;
      continue;
    }
    appendMemoryEventWithRetry(db, {
      streamType: 'chat',
      streamId: row.conversation_id,
      eventType: `chat.message.${row.role}`,
      actor: row.role,
      source: 'chat:messages-backfill',
      subjectType: 'conversation',
      subjectId: row.conversation_id,
      validAt: row.created_at || row.conversation_created_at || new Date().toISOString(),
      idempotencyKey: `chat-message-backfill:${row.id}`,
      payload: {
        message_id: String(row.id),
        role: row.role,
        seq: row.seq ?? null,
        content_hash: sha256(row.content),
        content_chars: String(row.content || '').length,
        conversation_title: row.title || null,
        backfilled: true,
      },
      links: memoryLinks(row),
    });
    stats.inserted++;
  }
  return stats;
}
