/**
 * Conversations — chat history store.
 *
 * Conversations are the persistent record of every chat session. Each row
 * has a chat_type ('chat' or 'action'), tags (JSON array of topic slugs),
 * and lifecycle state (archived, deleted_at). Messages are a separate table
 * keyed by conversation_id.
 *
 * The inbox is the set of non-archived, non-deleted chat conversations.
 * inboxCount is used by the left nav badge and composed into the /api/labels
 * response by the route handler (not by getLabels — single-purpose functions).
 *
 * Chat-stream functions (upsertConversation, persistMessages, etc.) extracted
 * from routes/chat.js in st_0722d294 — route is now a thin HTTP facade.
 */
// INTELLIGENCE_TIER: synthesis — the history-compression helper below asks
// Haiku to summarize older turns in 3-5 sentences; that summary text is
// persisted and read back as compressed context on later turns.
export const INTELLIGENCE_TIER = 'synthesis';

import crypto from 'node:crypto';
import { MODELS } from './compute-tier.js';
import { DEFAULT_CHAT_MODEL_KEY } from './chat-models.js';
import { readEntryBody, getLogIndex } from './memory.js';
import { classifyIntent } from './context-router.js';
import { appendMemoryEvent, ensureMemoryEventsSchema } from './memory-events.js';
import { refocusMemoryScopesForSubject } from './memory-scope-routing.js';
import {
  memoryTopicLink,
  NON_CLASSIFIABLE_TOPIC_PREFIXES,
  NON_CLASSIFIABLE_ROOT_SLUGS,
  NON_CLASSIFIABLE_TOPIC_SLUGS,
} from './topic-routing-policy.js';
import {
  deleteVecRowForTopic,
  openSplitVectorStore,
} from './split-vector-store.js';
import { VISIBLE_CONVERSATION_WHERE } from './conversation-visibility.js';

const NON_CLASSIFIABLE_TOPIC_SQL = NON_CLASSIFIABLE_TOPIC_SLUGS.map((slug) => `'${slug}'`).join(',');
const NON_CLASSIFIABLE_TOPIC_PREFIX_SQL = NON_CLASSIFIABLE_TOPIC_PREFIXES
  .map((prefix) => `AND slug NOT LIKE '${prefix.replace(/'/g, "''")}%'`)
  .join('\n    ');
let splitVectorDb;
function getSplitVectorDb() {
  if (splitVectorDb !== undefined) return splitVectorDb;
  splitVectorDb = openSplitVectorStore();
  return splitVectorDb;
}

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

const CHAT_CHUNK_MAX_CHARS = 1_900;
const CHAT_CHUNK_SOURCE_TYPE = 'conversation';
const VALUE_RANK_BASE = 1;
const VALUE_RANK_SOURCE_SIGNAL_MULT = 100_000_000_000;
const VALUE_RANK_RECENCY_MULT = 1_000_000;
const VALUE_RANK_DAYS_CAP = 60_000;
const VALUE_RANK_LENGTH_CAP = 999_999;
const SECONDS_PER_DAY = 86_400;

function tokenEstimate(text) {
  return Math.max(1, Math.ceil(String(text || '').trim().length / 4));
}

function isoNoMs(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function computeConversationValueRank(eventTime, content, contentRank = 0) {
  let epochDays = 0;
  const et = String(eventTime || '').trim();
  if (et) {
    const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(et);
    const ms = Date.parse(hasZone ? et : `${et}Z`);
    if (Number.isFinite(ms)) {
      const days = Math.floor(ms / 1000 / SECONDS_PER_DAY);
      epochDays = Math.min(VALUE_RANK_DAYS_CAP, Math.max(0, days));
    }
  }
  const rankRaw = Number(contentRank);
  const rank = Number.isFinite(rankRaw) ? Math.min(3, Math.max(0, Math.floor(rankRaw))) : 0;
  const sourceSignal = (3 - rank) * VALUE_RANK_SOURCE_SIGNAL_MULT;
  const len = Math.min(String(content || '').length, VALUE_RANK_LENGTH_CAP);
  return VALUE_RANK_BASE + sourceSignal + (epochDays * VALUE_RANK_RECENCY_MULT) + len;
}

function compactForChatChunk(value, maxChars) {
  const compacted = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n')
    .trim();
  if (!maxChars || compacted.length <= maxChars) return compacted;
  return compacted.slice(0, maxChars).trim();
}

function buildConversationChunkContent({
  title,
  topic,
  userContent,
  assistantContent,
  toolCalls = [],
} = {}) {
  const header = [
    `Chat: ${compactForChatChunk(title || 'New conversation', 160)}`,
    `Topic: ${topic || 'general'}`,
  ].join('\n');
  const toolSummary = Array.isArray(toolCalls) && toolCalls.length
    ? `\nTools: ${toolCalls.map((tool) => String(tool?.name || 'tool')).filter(Boolean).join(', ').slice(0, 220)}`
    : '';
  const budget = Math.max(200, CHAT_CHUNK_MAX_CHARS - header.length - toolSummary.length - 28);
  const userBudget = Math.floor(budget * 0.48);
  const assistantBudget = budget - userBudget;
  const userText = compactForChatChunk(userContent, userBudget);
  const assistantText = compactForChatChunk(assistantContent, assistantBudget);
  const body = [
    header,
    userText ? `User: ${userText}` : '',
    assistantText ? `Assistant: ${assistantText}` : '',
  ].filter(Boolean).join('\n\n');
  return compactForChatChunk(`${body}${toolSummary}`, CHAT_CHUNK_MAX_CHARS);
}

function materializeRecentChatChunk(db, {
  convId,
  userContent,
  assistantContent,
  assistantSeq,
  toolCalls = [],
} = {}) {
  if (!hasTable(db, 'chunks')) return { ok: true, skipped: true, reason: 'chunks_table_missing' };
  if (!convId || !assistantContent) return { ok: true, skipped: true, reason: 'missing_content' };

  const conv = hasTable(db, 'conversations')
    ? (db.prepare('SELECT title, topic_slug FROM conversations WHERE id = ?').get(convId) || {})
    : {};
  const topic = conv.topic_slug || 'general';
  const eventTime = isoNoMs();
  const contentRank = 0;
  const content = buildConversationChunkContent({
    title: conv.title || 'New conversation',
    topic,
    userContent,
    assistantContent,
    toolCalls,
  });
  if (!content) return { ok: true, skipped: true, reason: 'empty_content' };

  const metadata = JSON.stringify({
    conversation_id: convId,
    assistant_seq: assistantSeq,
    kind: 'recent_chat_turn',
    topic,
  });
  const valueRank = computeConversationValueRank(eventTime, content, contentRank);
  db.prepare(`
    INSERT INTO chunks (
      topic, source_type, source_id, chunk_index, content, metadata,
      token_count, embedded, skip_embed, created_at, event_time, content_rank, value_rank
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'), ?, ?, ?)
    ON CONFLICT(topic, source_type, source_id, chunk_index) DO UPDATE SET
      content = excluded.content,
      metadata = excluded.metadata,
      token_count = excluded.token_count,
      embedded = CASE WHEN chunks.content IS excluded.content THEN chunks.embedded ELSE 0 END,
      skip_embed = 0,
      event_time = excluded.event_time,
      content_rank = excluded.content_rank,
      value_rank = excluded.value_rank,
      content_hash = CASE WHEN chunks.content IS excluded.content THEN chunks.content_hash ELSE NULL END,
      embedding_model_id = CASE WHEN chunks.content IS excluded.content THEN chunks.embedding_model_id ELSE NULL END,
      embedding_dim = CASE WHEN chunks.content IS excluded.content THEN chunks.embedding_dim ELSE NULL END,
      embedding_signature = CASE WHEN chunks.content IS excluded.content THEN chunks.embedding_signature ELSE NULL END,
      embedded_at = CASE WHEN chunks.content IS excluded.content THEN chunks.embedded_at ELSE NULL END
  `).run(
    topic,
    CHAT_CHUNK_SOURCE_TYPE,
    convId,
    Number(assistantSeq) || 0,
    content,
    metadata,
    tokenEstimate(content),
    eventTime,
    contentRank,
    valueRank,
  );
  return { ok: true, skipped: false, topic, value_rank: valueRank };
}

function classifiableTopicsWhereSql(db) {
  const rootSql = NON_CLASSIFIABLE_ROOT_SLUGS.map((slug) => `'${slug}'`).join(',');
  const hierarchyClause = hasColumn(db, 'user_topics', 'parent_slug')
    ? `AND (parent_slug IS NOT NULL OR slug NOT IN (${rootSql}))`
    : `AND slug NOT IN (${rootSql})`;
  return `visible=1
    AND slug NOT IN (${NON_CLASSIFIABLE_TOPIC_SQL})
    ${NON_CLASSIFIABLE_TOPIC_PREFIX_SQL}
    ${hierarchyClause}`;
}

/**
 * Create a new conversation.
 * Auto-archives import-claude-code sessions with no real topic.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ title?: string, model?: string, tags?: string[], chat_type?: string }} body
 * @returns {{ id: string, title: string, chat_type: string }}
 */
export function createConversation(db, body) {
  const id = crypto.randomUUID();
  const chatType = body.chat_type === 'action' ? 'action' : 'chat';
  const tags = body.tags || [];

  // Auto-archive Claude Code import sessions that have no real topic. Canonical
  // group roots are excluded, but flat user topics remain valid for White Belt.
  let autoArchive = 0;
  if (tags.includes('import-claude-code')) {
    const visibleLabels = db.prepare(
      `SELECT LOWER(label) as label FROM user_topics WHERE ${classifiableTopicsWhereSql(db)}`
    ).all().map(r => r.label);
    const hasRealTopic = tags.some(t => visibleLabels.includes(t.toLowerCase()));
    if (!hasRealTopic) autoArchive = 1;
  }

  db.prepare(`INSERT INTO conversations (id, title, model, tags, chat_type, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
    .run(id, body.title || 'New chat', body.model || DEFAULT_CHAT_MODEL_KEY, JSON.stringify(tags), chatType, autoArchive);

  return { id, title: body.title || 'New chat', chat_type: chatType };
}

/**
 * List conversations. Supports two modes:
 * - type='action': returns action conversations (unlimited, last 200)
 * - default: paginated chat conversations (non-archived, non-deleted)
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ type?: string, all?: string, limit?: number, offset?: number }} query
 * @returns {object[]}
 */
export function listConversations(db, query) {
  if (query.type === 'action') {
    const rows = db.prepare(`
      SELECT id, title, model, created_at, updated_at, tags, chat_type, action_status, action_summary
      FROM conversations
      WHERE deleted_at IS NULL AND chat_type = 'action'
      ORDER BY updated_at DESC
      LIMIT 200
    `).all();
    return rows.map(r => ({ ...r, tags: JSON.parse(r.tags || '[]') }));
  }

  const limit = query.all ? 500 : parseInt(query.limit || '50');
  const offset = parseInt(query.offset || '0');
  const rows = db.prepare(`
    SELECT id, title, model, created_at, updated_at, tags, coaching, chat_type, archived, pinned, topic_slug, origin
    FROM conversations
    WHERE chat_type != 'action' AND ${VISIBLE_CONVERSATION_WHERE}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  return rows.map(r => ({
    ...r,
    tags: JSON.parse(r.tags || '[]'),
    archived: r.archived || 0,
    pinned: r.pinned || 0,
    chat_type: r.chat_type || 'chat',
  }));
}

/**
 * Get a single conversation with its messages.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object|null} null if not found
 */
export function getConversation(db, id) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!conv) return null;
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at').all(conv.id);
  return {
    ...conv,
    tags: JSON.parse(conv.tags || '[]'),
    messages,
    threadCounts: {},
    archived: conv.archived || 0,
    pinned: conv.pinned || 0,
  };
}

/**
 * Archive or unarchive a conversation.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {boolean} archived - true to archive, false to unarchive
 * @returns {{ ok: boolean }|null} null if not found
 */
export function archiveConversation(db, id, archived) {
  const exists = db.prepare('SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!exists) return null;
  db.prepare("UPDATE conversations SET archived = ?, updated_at = datetime('now') WHERE id = ?").run(archived ? 1 : 0, id);
  return { ok: true };
}

/**
 * Update conversation tags.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {string[]} tags
 * @returns {{ ok: boolean }}
 */
export function updateConversationTags(db, id, tags) {
  db.prepare("UPDATE conversations SET tags = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(tags || []), id);
  return { ok: true };
}

/**
 * Rename a conversation.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {string} title
 * @returns {{ ok: boolean, id: string, title: string }|null} null if not found
 */
export function updateConversationTitle(db, id, title) {
  const nextTitle = String(title || '').trim().slice(0, 160);
  if (!nextTitle) return { ok: false, error: 'title_required' };
  const result = db.prepare(`
    UPDATE conversations
    SET title = ?, updated_at = datetime('now')
    WHERE id = ? AND deleted_at IS NULL
  `).run(nextTitle, id);
  if (result.changes === 0) return null;
  return { ok: true, id, title: nextTitle };
}

/**
 * Soft-delete a conversation (sets deleted_at).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {{ ok: boolean }}
 */
export function deleteConversation(db, id) {
  db.prepare("UPDATE conversations SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").run(id);
  return { ok: true };
}

/**
 * Hard-deletes a QA test conversation and all of its child rows in one
 * transaction (threads, messages, topic links, the conversation row itself).
 * Unlike deleteConversation (a soft delete used for real user data), this
 * physically removes the QA scratch rows so the test surface leaves no residue.
 *
 * Returns the conversation's transcript file_path and whether it is now orphaned
 * (no remaining conversation rows reference it) so the caller can unlink the
 * file. The filesystem unlink stays with the caller — this function only owns
 * the DB side.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} conversationId
 * @returns {{ filePath: string | null, transcriptOrphaned: boolean }}
 */
export function purgeQaTestConversation(db, conversationId) {
  const conv = db.prepare('SELECT file_path FROM conversations WHERE id = ?').get(conversationId) || null;
  const filePath = conv?.file_path || null;
  const tx = db.transaction(() => {
    for (const sql of [
      'DELETE FROM message_threads WHERE conversation_id = ?',
      'DELETE FROM messages WHERE conversation_id = ?',
      'DELETE FROM conversation_topics WHERE conversation_id = ?',
      'DELETE FROM conversations WHERE id = ?',
    ]) {
      db.prepare(sql).run(conversationId);
    }
    // st_f67bc2eb — CHUNKS are child rows too: the chunk worker can chunk a
    // QA conversation before the purge fires, and orphaned QA chunks then
    // leak quiz phrasing into RAG and regenerated entity cards (live case:
    // a card quoting a graded quiz turn as if it were the owner's history).
    // chunk_entities rows go with them.
    try {
      db.prepare(`
        DELETE FROM chunk_entities WHERE chunk_id IN
          (SELECT id FROM chunks WHERE source_type = 'conversation' AND source_id = ?)
      `).run(conversationId);
      db.prepare("DELETE FROM chunks WHERE source_type = 'conversation' AND source_id = ?").run(conversationId);
    } catch { /* chunks table absent in minimal fixtures */ }
  });
  tx();
  let transcriptOrphaned = false;
  if (filePath) {
    const remainingRefs = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE file_path = ?').get(filePath)?.n || 0;
    transcriptOrphaned = remainingRefs === 0;
  }
  return { filePath, transcriptOrphaned };
}

/**
 * Count non-archived, non-deleted conversations for the inbox badge.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getInboxCount(db) {
  return db.prepare('SELECT COUNT(*) as count FROM conversations WHERE (archived IS NULL OR archived = 0) AND deleted_at IS NULL').get()?.count || 0;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function conversationMemoryLinks(db, convId) {
  const links = [{ targetType: 'conversation', targetId: convId, role: 'source' }];
  try {
    const conv = db.prepare('SELECT topic_slug FROM conversations WHERE id = ?').get(convId) || {};
    const topicLink = memoryTopicLink(conv.topic_slug, { fallback: true, role: 'scope' });
    if (topicLink) links.push(topicLink);
  } catch {}
  if (!links.some((link) => link.targetType === 'topic')) {
    const topicLink = memoryTopicLink(null, { fallback: true });
    if (topicLink) links.push(topicLink);
  }
  return links;
}

function recordConversationMemoryEvent(db, {
  convId,
  role = 'system',
  content = '',
  seq = null,
  messageId = null,
  streamType = 'chat',
  streamId = convId,
  eventType = `chat.message.${role}`,
  source = 'chat',
  validAt = null,
  idempotencyKey = null,
  payload = {},
  links = null,
}, { useTransaction = true } = {}) {
  const eventLinks = links || conversationMemoryLinks(db, convId);
  appendMemoryEvent(db, {
    streamType,
    streamId,
    eventType,
    actor: role,
    source,
    subjectType: 'conversation',
    subjectId: convId,
    validAt,
    idempotencyKey: idempotencyKey || `${source}:${convId}:${seq ?? 'none'}:${role}:${messageId ?? sha256(content).slice(0, 16)}`,
    payload: {
      message_id: messageId == null ? null : String(messageId),
      role,
      seq,
      content_hash: sha256(content),
      content_chars: String(content || '').length,
      ...payload,
    },
    links: eventLinks,
  }, { useTransaction });
}

/**
 * Update action_status and optional action_summary for an action conversation.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {{ status: string, summary?: string }} opts
 * @returns {object|null} Updated row, or null if not found
 */
export function updateActionStatus(db, id, { status, summary }) {
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!conv) return null;
  db.prepare("UPDATE conversations SET action_status = ?, action_summary = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, summary ?? null, id);
  const updated = db.prepare('SELECT id, title, model, created_at, updated_at, tags, chat_type, action_status, action_summary FROM conversations WHERE id = ?').get(id);
  return { ...updated, tags: JSON.parse(updated.tags || '[]') };
}

/**
 * Replace all messages for a conversation (used by action runner to persist tool output).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {{ role: string, content: string, created_at?: string }[]} messages
 * @returns {{ ok: boolean }}
 */
export function replaceMessages(db, id, messages) {
  messages = messages || [];
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
  const insert = db.prepare('INSERT INTO messages (conversation_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, datetime(?))');
  const batchHash = sha256(JSON.stringify((messages || []).map((m, i) => ({
    seq: i + 1,
    role: m.role,
    content: m.content,
    created_at: m.created_at || null,
  }))));
  const links = conversationMemoryLinks(db, id);
  recordConversationMemoryEvent(db, {
    convId: id,
    role: 'system',
    eventType: 'chat.messages.replaced',
    source: 'chat:replaceMessages',
    idempotencyKey: `chat-replace:${id}:${batchHash}`,
    payload: {
      message_count: messages.length,
      batch_hash: batchHash,
    },
    links,
  });
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const seq = i + 1;
    const result = insert.run(id, m.role, m.content, seq, m.created_at || 'now');
    recordConversationMemoryEvent(db, {
      convId: id,
      role: m.role,
      content: m.content,
      seq,
      messageId: result.lastInsertRowid,
      eventType: `chat.message.${m.role}`,
      source: 'chat:replaceMessages',
      validAt: m.created_at || null,
      idempotencyKey: `chat-replace-message:${id}:${seq}:${m.role}:${sha256(m.content)}`,
      payload: { replaced_batch_hash: batchHash },
      links,
    });
  }
  return { ok: true };
}

// ── Chat-stream functions — extracted from routes/chat.js (st_0722d294) ──────
// These follow the db-as-first-param pattern established by all other functions
// in this module. routes/chat.js is now a thin HTTP facade.

/**
 * Upsert a conversation row on every chat-stream request.
 *
 * topic_slug and title are captured on INSERT only — conversations remember
 * their topic for life, and manual renames must not be overwritten by later
 * turns. On CONFLICT (re-opening an existing conversation), we update
 * only the timestamp. The frontend sends context
 * (topic slug) on every message; we capture it only on new conversations.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string, title: string, model?: string, topicSlug: string|null, topicSlugs?: string[], tagName?: string|null }} opts
 * @returns {void}
 */
export function upsertConversation(db, { id, title, model, topicSlug, topicSlugs = [], tagName, chatType = 'chat', origin = null }) {
  // st_6360589a — `tags` is written inline at INSERT (a one-element array of
  // the topic's display name) instead of being PATCHed in a second round-trip
  // from the browser after the first turn. Same JSON shape as before; all
  // existing readers (lib/topics.js, lib/taxonomy.js, lib/imports-snapshot.js,
  // chat.js#filterConversations, the migrations) are unaffected. Eliminates
  // the race window where a brand-new chat was momentarily absent from its
  // topic's filtered view in the nav.
  const tagsJson = (typeof tagName === 'string' && tagName.length > 0)
    ? JSON.stringify([tagName])
    : '[]';
  const normalizedChatType = chatType === 'action' ? 'action' : 'chat';
  // st_abf246e4 — a qa/test chat stamps origin='test' at creation, so the
  // visibility predicate hides-and-preserves it by provenance (never a title
  // heuristic). origin is captured on INSERT only; re-opening a conversation
  // (ON CONFLICT) must never overwrite provenance. Guarded by column presence
  // so pre-migration fixtures still upsert.
  const stampOrigin = origin && hasColumn(db, 'conversations', 'origin');
  if (stampOrigin) {
    db.prepare(`
      INSERT INTO conversations (id, title, model, tags, chat_type, topic_slug, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')
    `).run(id, title, model || DEFAULT_CHAT_MODEL_KEY, tagsJson, normalizedChatType, topicSlug, origin);
  } else {
    db.prepare(`
      INSERT INTO conversations (id, title, model, tags, chat_type, topic_slug, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')
    `).run(id, title, model || DEFAULT_CHAT_MODEL_KEY, tagsJson, normalizedChatType, topicSlug);
  }

  // st_8c7b7a6b — when a topic is set on the conversation, seed the
  // conversation_topics junction so resolveTopicScope() in chat-context.js
  // can scope RAG to the right shard on the FIRST turn. Without this,
  // every fresh conversation falls back to ['general'] and the user-
  // selected topic's historical corpus is invisible — exactly the
  // "zero knowledge of me" surface caught at /chat/d472d2cb on 2026-05-13.
  // Idempotent via INSERT OR IGNORE — re-runs with same convId+topic are no-ops.
  const scopedSlugs = [...new Set([topicSlug, ...topicSlugs].filter(Boolean))];
  if (scopedSlugs.length) {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO conversation_topics (conversation_id, topic_slug, is_primary, set_method) VALUES (?, ?, ?, 'user')`
    );
    scopedSlugs.forEach((slug, idx) => stmt.run(id, slug, idx === 0 ? 1 : 0));
  }
}

/**
 * Persist user + assistant messages after a chat-stream completes.
 *
 * Sequences from the current max seq in the conversation. If userMessage is
 * present, it is inserted first; the assistant response always follows.
 * Tool calls produce an additional system summary message so the conversation
 * history reflects what actions were taken without embedding raw tool JSON.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ convId: string, userMessage: {content: string}|null, assistantContent: string, toolCalls?: {name: string, args: object}[] }} opts
 * @returns {{ ok: boolean }}
 */
export function persistMessages(db, { convId, userMessage, assistantContent, toolCalls = [] }) {
  ensureMemoryEventsSchema(db);
  const links = conversationMemoryLinks(db, convId);

  const tx = db.transaction(() => {
    const { maxSeq } = db.prepare('SELECT COALESCE(MAX(seq), 0) as maxSeq FROM messages WHERE conversation_id = ?').get(convId);
    let seq = maxSeq;

    const insertMsg = db.prepare(
      `INSERT INTO messages (conversation_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
    );

    const recordMessageEvent = ({ role, content, seq, messageId, extraPayload = {} }) => recordConversationMemoryEvent(db, {
      convId,
      role,
      content,
      seq,
      messageId,
      source: 'chat:persistMessages',
      idempotencyKey: `chat-message:${convId}:${seq}:${role}:${messageId}`,
      payload: extraPayload,
      links,
    }, { useTransaction: false });

    if (userMessage) {
      seq++;
      const result = insertMsg.run(convId, 'user', userMessage.content, seq);
      recordMessageEvent({ role: 'user', content: userMessage.content, seq, messageId: result.lastInsertRowid });
    }

    seq++;
    const assistantResult = insertMsg.run(convId, 'assistant', assistantContent, seq);
    const assistantSeq = seq;
    recordMessageEvent({ role: 'assistant', content: assistantContent, seq, messageId: assistantResult.lastInsertRowid });

    if (toolCalls.length > 0) {
      const toolSummary = toolCalls
        .map(t => `${t.name}(${JSON.stringify(t.args).slice(0, 100)})`)
        .join(', ');
      const toolSeq = seq + 1;
      const content = `[Tools used: ${toolSummary}]`;
      const toolResult = insertMsg.run(convId, 'system', content, toolSeq);
      recordMessageEvent({
        role: 'system',
        content,
        seq: toolSeq,
        messageId: toolResult.lastInsertRowid,
        extraPayload: { tool_call_count: toolCalls.length },
      });
    }

    materializeRecentChatChunk(db, {
      convId,
      userContent: userMessage?.content || '',
      assistantContent,
      assistantSeq,
      toolCalls,
    });
  });

  tx();
  return { ok: true };
}

const DEFAULT_CHAT_PERSIST_BUSY_RETRY_MS = [100, 250, 500, 1000, 2000, 4000, 8000];
const DEFAULT_CHAT_PERSIST_BUSY_TIMEOUT_MS = 200;

function chatPersistBusyRetryMs() {
  const raw = process.env.ROBOTDOJO_CHAT_PERSIST_BUSY_RETRY_MS;
  if (!raw) return DEFAULT_CHAT_PERSIST_BUSY_RETRY_MS;
  const parsed = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length ? parsed : DEFAULT_CHAT_PERSIST_BUSY_RETRY_MS;
}

function isSqliteBusyError(err) {
  const message = String(err?.message || err?.code || err || '');
  return err?.code === 'SQLITE_BUSY'
    || err?.code === 'SQLITE_LOCKED'
    || /SQLITE_(BUSY|LOCKED)|database is locked|database locked/i.test(message);
}

function chatPersistBusyTimeoutMs() {
  const value = process.env.ROBOTDOJO_CHAT_PERSIST_BUSY_TIMEOUT_MS;
  if (value == null || value === '') return DEFAULT_CHAT_PERSIST_BUSY_TIMEOUT_MS;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_CHAT_PERSIST_BUSY_TIMEOUT_MS;
}

function withChatPersistBusyTimeout(db, fn) {
  let prevTimeout;
  let shouldRestore = false;
  try {
    try {
      prevTimeout = db.pragma('busy_timeout', { simple: true });
      shouldRestore = prevTimeout !== undefined;
    } catch { /* fake/test DB or driver without pragma */ }
    try { db.pragma(`busy_timeout = ${chatPersistBusyTimeoutMs()}`); } catch {}
    return fn();
  } finally {
    if (shouldRestore) {
      try { db.pragma(`busy_timeout = ${prevTimeout}`); } catch {}
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWithChatBusyRetry(db, fn, {
  retryMs = chatPersistBusyRetryMs(),
  label = 'chat:write',
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return withChatPersistBusyTimeout(db, fn);
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt >= retryMs.length) throw err;
      const waitMs = retryMs[attempt];
      console.warn(`[conversations] SQLITE_BUSY on ${label}; retry ${attempt + 1}/${retryMs.length} after ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}

export async function persistMessagesWithBusyRetry(db, opts, {
  retryMs = chatPersistBusyRetryMs(),
  label = 'chat:persistMessages',
} = {}) {
  return runWithChatBusyRetry(db, () => persistMessages(db, opts), { retryMs, label });
}

/**
 * Get all thread messages for a given parent sequence number.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} convId
 * @param {number} parentSeq
 * @returns {object[]}
 */
export function getThreads(db, convId, parentSeq) {
  return db.prepare(
    'SELECT id, role, content, seq, created_at FROM message_threads WHERE conversation_id = ? AND parent_seq = ? ORDER BY seq ASC'
  ).all(convId, parentSeq);
}

/**
 * Build context for a new thread reply and persist the user message.
 *
 * Does 4 DB ops in sequence:
 *   1. Load the parent message from the messages table
 *   2. Get the max seq already in message_threads for this parent
 *   3. INSERT the user thread message at threadSeq
 *   4. SELECT prior thread messages with seq < threadSeq for context
 *
 * Returns contextMessages ready to pass to streamChat — includes the parent
 * message (with [Parent message] prefix), prior thread messages, and the new
 * user message.
 *
 * WHY: bundling the DB work and the context assembly in one function keeps
 * the route handler free of persistence logic. The route only needs to
 * stream the response and call appendThreadMessage.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} convId
 * @param {number} parentSeq
 * @param {string} userContent
 * @returns {{ threadSeq: number, contextMessages: {role: string, content: string}[] }}
 */
export function getThreadContext(db, convId, parentSeq, userContent) {
  const parentMsg = db.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? AND seq = ?'
  ).get(convId, parentSeq);

  const { ms: maxSeq } = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) as ms FROM message_threads WHERE conversation_id = ? AND parent_seq = ?'
  ).get(convId, parentSeq);
  const threadSeq = maxSeq + 1;

  const result = db.prepare(
    'INSERT INTO message_threads (conversation_id, parent_seq, seq, role, content) VALUES (?, ?, ?, ?, ?)'
  ).run(convId, parentSeq, threadSeq, 'user', userContent);
  recordConversationMemoryEvent(db, {
    convId,
    role: 'user',
    content: userContent,
    seq: threadSeq,
    messageId: result.lastInsertRowid,
    streamType: 'chat_thread',
    streamId: `${convId}:${parentSeq}`,
    eventType: 'chat.thread.message.user',
    source: 'chat:getThreadContext',
    idempotencyKey: `chat-thread:${convId}:${parentSeq}:${threadSeq}:user:${result.lastInsertRowid}`,
    payload: {
      parent_seq: parentSeq,
      thread_seq: threadSeq,
    },
  });

  const priorThreads = db.prepare(
    'SELECT role, content FROM message_threads WHERE conversation_id = ? AND parent_seq = ? AND seq < ? ORDER BY seq ASC'
  ).all(convId, parentSeq, threadSeq);

  const contextMessages = [];
  if (parentMsg) {
    contextMessages.push({ role: parentMsg.role, content: `[Parent message]: ${parentMsg.content}` });
  }
  for (const t of priorThreads) {
    contextMessages.push({ role: t.role, content: t.content });
  }
  contextMessages.push({ role: 'user', content: userContent });

  return { threadSeq, contextMessages };
}

/**
 * Append a message (typically assistant reply) to a message thread.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ convId: string, parentSeq: number, seq: number, role: string, content: string }} opts
 * @returns {void}
 */
export function appendThreadMessage(db, { convId, parentSeq, seq, role, content }) {
  const result = db.prepare(
    'INSERT INTO message_threads (conversation_id, parent_seq, seq, role, content) VALUES (?, ?, ?, ?, ?)'
  ).run(convId, parentSeq, seq, role, content);
  recordConversationMemoryEvent(db, {
    convId,
    role,
    content,
    seq,
    messageId: result.lastInsertRowid,
    streamType: 'chat_thread',
    streamId: `${convId}:${parentSeq}`,
    eventType: `chat.thread.message.${role}`,
    source: 'chat:appendThreadMessage',
    idempotencyKey: `chat-thread:${convId}:${parentSeq}:${seq}:${role}:${result.lastInsertRowid}`,
    payload: {
      parent_seq: parentSeq,
      thread_seq: seq,
    },
  });
}

/**
 * Delete a single thread message by its row ID.
 *
 * Scoped to convId + parentSeq to prevent cross-conversation deletes even if
 * a threadId were guessable.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ convId: string, parentSeq: number, threadId: number }} opts
 * @returns {void}
 */
export function deleteThreadMessage(db, { convId, parentSeq, threadId }) {
  db.prepare(
    'DELETE FROM message_threads WHERE id = ? AND conversation_id = ? AND parent_seq = ?'
  ).run(threadId, convId, parentSeq);
}

/**
 * Compress a conversation by summarizing old messages with Haiku and keeping
 * only the most recent N messages.
 *
 * Uses Haiku (Tier 1) for summarization — the summary is internal scaffolding,
 * not user-facing synthesis, so Sonnet is not warranted.
 *
 * Returns null if the conversation doesn't exist or is deleted.
 * Returns { ok: false, error } if the Anthropic call fails.
 * Returns { ok: true, summary, keptMessages } on success.
 *
 * st_74f45a1a R2: the third argument is now an optional provider object
 * (from lib/llm/index.js#getProvider). If absent, resolves the default
 * Anthropic provider lazily so existing callers that pass undefined still
 * work. Direct getAnthropicClient imports were eliminated per AC 10.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} convId
 * @param {object} [provider] - lib/llm provider; defaults to Anthropic
 * @returns {Promise<{ok: boolean, summary: string|null, keptMessages: number, message?: string}|null>}
 */
export async function compressConversation(db, convId, provider) {
  // Verify conversation exists and is not deleted
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND deleted_at IS NULL').get(convId);
  if (!conv) return null;

  const allMessages = db.prepare(
    'SELECT id, seq, role, content FROM messages WHERE conversation_id = ? ORDER BY seq ASC'
  ).all(convId);

  if (allMessages.length <= 5) {
    return {
      ok: true,
      summary: null,
      keptMessages: allMessages.length,
      message: 'Not enough messages to compress',
    };
  }

  const keepCount = 4;
  const toSummarize = allMessages.slice(0, allMessages.length - keepCount);
  const toKeep = allMessages.slice(allMessages.length - keepCount);

  const historyText = toSummarize.map(m => `${m.role}: ${m.content}`).join('\n\n');
  const summaryPrompt = `Summarize this conversation history in 3-5 sentences, preserving key facts and decisions:\n\n${historyText}`;

  let summary;
  try {
    // Resolve the active spend provider lazily so callers can pass undefined.
    if (!provider) {
      const { selectProvider } = await import('./llm/index.js');
      const { modelFor } = await import('./model-lane.js');
      provider = await selectProvider({ model: modelFor('fast') });
    }
    const { modelFor } = await import('./model-lane.js');
    const resp = await provider.complete({
      model: modelFor('fast'),
      max_tokens: 512,
      messages: [{ role: 'user', content: summaryPrompt }],
    });
    summary = resp.content?.[0]?.text?.trim() || '';
  } catch (err) {
    return { ok: false, error: `Summarization failed: ${err.message}` };
  }

  // Delete summarized messages
  const idsToDelete = toSummarize.map(m => m.id);
  const placeholders = idsToDelete.map(() => '?').join(',');
  db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...idsToDelete);

  // Insert summary as a system message at seq=1
  db.prepare(
    `INSERT INTO messages (conversation_id, role, content, seq, created_at) VALUES (?, 'system', ?, 1, datetime('now'))`
  ).run(convId, `[Conversation summary: ${summary}]`);

  // Re-sequence the kept messages starting at seq=2
  const reseqStmt = db.prepare('UPDATE messages SET seq = ? WHERE id = ?');
  const reseqTx = db.transaction((msgs) => {
    for (let i = 0; i < msgs.length; i++) {
      reseqStmt.run(i + 2, msgs[i].id);
    }
  });
  reseqTx(toKeep);

  return { ok: true, summary, keptMessages: keepCount + 1 };
}

// Per-slug keyword seeds for Tier-0 topic inference. Catches domain terms that
// don't appear in topic labels or descriptions (e.g. specific medications, lab names).
const TOPIC_KEYWORD_SEEDS = {
  health: ['vitamin', 'dose', 'mg', 'blood', 'lab', 'supplement', 'medication', 'result', 'clinical', 'chlorthalidone', 'prescription', 'cholesterol', 'thyroid', 'glucose', 'testosterone'],
  // Engineering/code chats — keyed to the generic ontology's 'side-projects'
  // (the old 'technical' slug was removed in the single-source consolidation).
  'side-projects': ['code', 'bug', 'build', 'deploy', 'error', 'commit', 'function', 'module', 'npm', 'git', 'typescript', 'javascript', 'python', 'database', 'api'],
  finances: ['invoice', 'payment', 'expense', 'budget', 'tax', 'cost', 'price', 'fee', 'dollar', 'bank', 'transaction', 'invest'],
};

// Function words filtered out of description/label keyword extraction so rich,
// prose-y descriptions cannot trigger false topic matches via common words.
const TOPIC_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'over', 'your', 'you',
  'are', 'was', 'were', 'has', 'have', 'had', 'not', 'but', 'their', 'them', 'they',
  'its', 'our', 'out', 'off', 'all', 'any', 'can', 'will', 'how', 'who', 'what', 'when',
  'where', 'which', 'about', 'other', 'than', 'then', 'these', 'those', 'such', 'each',
  'per', 'via', 'etc', 'including', 'general', 'misc', 'miscellaneous', 'content', 'news',
]);

/**
 * Infer the best matching topic for a block of text using Tier-0 keyword matching.
 * Checks topic label, description keywords, and per-slug seed terms.
 * Returns { slug, label } for first match, or null if no topic matches.
 *
 * WHY Tier-0 only: topic inference for session log is a best-effort, free operation.
 * False positives are acceptable; LLM classification would add latency and cost to
 * every session end. The seed map is extensible without schema changes.
 */
export function inferTopicFromContent(text, db) {
  const lower = text.toLowerCase();
  // T2 topics and flat user-created topics are eligible. Generic group roots
  // stay out so Claude Code sessions do not land in a bucket instead of a topic.
  const topics = db.prepare(
    `SELECT slug, label, description FROM user_topics WHERE ${classifiableTopicsWhereSql(db)} ORDER BY sort_order, label`
  ).all();

  // Tokenize the text once. Single-word keywords match on a word boundary (a
  // Set membership), not as a substring — so 'lab' no longer matches 'label'
  // and stopwords in rich descriptions ('and', 'the', 'over') cannot trigger a
  // false topic hit. Multi-word phrases still match as substrings.
  //
  // Score instead of "first match wins": a broad word like "workbench" in an
  // earlier-sorted topic must not beat the explicit phrase "Robot Dojo".
  const textWords = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  const addWord = (set, w, weight = 1) => {
    if (w.length >= 3 && !TOPIC_STOPWORDS.has(w)) {
      set.set(w, Math.max(set.get(w) || 0, weight));
    }
  };
  const normalizePhrase = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let best = null;
  for (const { slug, label, description } of topics) {
    const words = new Map();   // single-word keyword → weight
    const phrases = [];        // { phrase, weight }
    const labelPhrase = normalizePhrase(label);
    const slugPhrase = normalizePhrase(String(slug).replace(/[-_]+/g, ' '));
    if (labelPhrase && labelPhrase.includes(' ')) phrases.push({ phrase: labelPhrase, weight: 8 });
    if (slugPhrase && slugPhrase.includes(' ') && slugPhrase !== labelPhrase) phrases.push({ phrase: slugPhrase, weight: 8 });
    labelPhrase.split(/\s+/).forEach(w => addWord(words, w, 4));
    slugPhrase.split(/\s+/).forEach(w => addWord(words, w, 4));
    if (description) {
      for (const seg of description.split(',')) {
        const phrase = normalizePhrase(seg);
        if (!phrase) continue;
        if (phrase.includes(' ')) phrases.push({ phrase, weight: 2 });
        phrase.split(/\s+/).forEach(w => addWord(words, w, 1));
      }
    }
    (TOPIC_KEYWORD_SEEDS[slug] || []).forEach(k => addWord(words, normalizePhrase(k), 5));

    let score = 0;
    for (const [w, weight] of words) {
      if (textWords.has(w)) score += weight;
    }
    for (const { phrase, weight } of phrases) {
      if (lower.includes(phrase)) score += weight;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { slug, label, score };
    }
  }
  return best ? { slug: best.slug, label: best.label } : null;
}

/**
 * Return the list of topics eligible for Tier 1 (Haiku) classification.
 * Queried at runtime so newly created topics are immediately classifiable
 * without code changes. Excludes the canary-test-row sentinel.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{slug: string, label: string, description: string}[]}
 */
export function getClassifiableTopics(db) {
  return db.prepare(
    `SELECT slug, label, description FROM user_topics WHERE ${classifiableTopicsWhereSql(db)} ORDER BY sort_order, label`
  ).all();
}

/**
 * Classify a single conversation against the live topic list using a tier
 * ladder (Tier 0 keyword → Tier 1 Haiku). Writes primary assignment to
 * conversations.topic_slug + topic_set_method, secondary assignments to
 * the conversation_topics junction, and updates chunks.topic + archived
 * accordingly.
 *
 * Guards:
 *   - topic_set_method = 'user' → no-op (returns false). User overrides are sacred.
 *   - No user messages → no-op (returns false).
 *
 * `classifier` is injected only by the spec test. Production passes nothing
 * and the real classifyIntent fires when Tier 0 misses.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} conversationId
 * @param {Function} [classifier] - injectable test mock; defaults to classifyIntent
 * @returns {Promise<boolean>} true on a successful assignment, false on a guarded skip
 */
export async function classifyConversationTopic(db, conversationId, classifier) {
  const conv = db.prepare('SELECT topic_set_method FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return false;
  if (conv.topic_set_method === 'user') return false;

  const msgs = db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY seq").all(conversationId);
  if (!msgs.length) return false;

  const combined = msgs.map(m => m.content || '').join('\n').slice(0, 4000);

  // Tier 0 — keyword match against all visible topics
  const tier0 = inferTopicFromContent(combined, db);
  let primarySlug = null;
  let method = null;
  let secondarySlugs = [];

  if (tier0) {
    primarySlug = tier0.slug;
    method = 'keyword';
  } else {
    // Tier 1 — Haiku classifyIntent. Use injected classifier when present (test mode).
    const classifyFn = classifier ?? classifyIntent;
    const topics = getClassifiableTopics(db);
    let res;
    try {
      res = await classifyFn({
        userMessage: combined,
        topics: topics.map(t => ({ slug: t.slug, label: t.label, description: t.description })),
        history: [],
        hasThread: false,
      });
    } catch (e) {
      console.warn('[classifyConversationTopic] classifier failed:', e.message);
      return false;
    }
    const topicSlugs = Array.isArray(res?.topics) ? res.topics : [];
    if (topicSlugs.length === 0) return false;
    primarySlug = topicSlugs[0];
    method = 'haiku';
    secondarySlugs = topicSlugs.slice(1);
  }

  if (!primarySlug) return false;

  // Write primary to conversations + junction
  db.prepare("UPDATE conversations SET topic_slug = ?, topic_set_method = ?, updated_at = datetime('now') WHERE id = ?")
    .run(primarySlug, method, conversationId);
  db.prepare(`INSERT OR REPLACE INTO conversation_topics (conversation_id, topic_slug, is_primary, set_method) VALUES (?, ?, 1, ?)`)
    .run(conversationId, primarySlug, method);

  // Write secondary candidates (haiku tier only — Tier 0 keyword produces just one slug)
  for (const slug of secondarySlugs) {
    if (!slug || slug === primarySlug) continue;
    db.prepare(`INSERT OR REPLACE INTO conversation_topics (conversation_id, topic_slug, is_primary, set_method) VALUES (?, ?, 0, 'haiku')`)
      .run(conversationId, slug);
  }

  // Sync chunks.topic to the primary slug. Only reset embedded=0 when the topic
  // actually changed — otherwise we'd needlessly re-embed every chunk every run.
  const changedChunks = db.prepare(`
    SELECT id, topic
    FROM chunks
    WHERE source_type = 'conversation'
      AND source_id = ?
      AND (topic IS NULL OR topic != ?)
  `).all(conversationId, primarySlug);
  db.prepare("UPDATE chunks SET topic = ?, embedded = 0 WHERE source_type = 'conversation' AND source_id = ? AND (topic IS NULL OR topic != ?)")
    .run(primarySlug, conversationId, primarySlug);
  for (const chunk of changedChunks) {
    if (!chunk.topic) continue;
    try { deleteVecRowForTopic(chunk.topic, chunk.id, { database: db, embeddingsDb: getSplitVectorDb() }); }
    catch { /* embedding pass + split-vector repair will reconcile */ }
  }

  refocusMemoryScopesForSubject(db, {
    subjectType: 'conversation',
    subjectId: conversationId,
    toTopic: primarySlug,
    actor: 'conversation-topic-classifier',
    reason: `conversation classified by ${method}`,
    correlationId: conversationId,
  });

  // st_f1a40461: VISIBLE BY DEFAULT. Previously conversations with < 2 chunks
  // were auto-archived ("thin one-liners"), which wrongly HID imported history —
  // real threads that simply weren't chunked yet (1,779 of 2,017 hidden). Imports
  // and classified conversations surface by definition; the user manages archiving
  // manually. Never auto-archive here.
  const deletedAtClause = hasColumn(db, 'conversations', 'deleted_at') ? ' AND deleted_at IS NULL' : '';
  // st_abf246e4 — show/hide and tags are INDEPENDENT mechanisms. Topic
  // classification must never change visibility for rows whose hidden state is
  // owned by classification (origin subagent/test) or by the coding-agent
  // materialize logic (one-sided sessions stay hidden). Only genuine
  // owner/import conversations are surfaced-by-default here. Guarded so the
  // reconcile → reclassify path can no longer un-hide agent or one-sided rows.
  const originGuard = hasColumn(db, 'conversations', 'origin')
    ? " AND (origin IS NULL OR origin = 'owner')" : '';
  db.prepare(
    `UPDATE conversations SET archived = 0 WHERE id = ? AND archived = 1${deletedAtClause}`
    + ` AND (model IS NULL OR model != 'claude-code')`
    + ` AND (thread_id IS NULL OR thread_id NOT LIKE 'claude-code:%')${originGuard}`,
  ).run(conversationId);

  return true;
}

/**
 * Shared Tier-0 → Tier-1 topic classifier for materialization.
 *
 * Tier 0 keyword (inferTopicFromContent, free) → Tier 1 Haiku (classifyIntent,
 * only on Tier-0 miss). Falls back gracefully when Haiku is unreachable: the
 * row lands with topic_slug = NULL and the maint_reclassify routine retries it.
 * The LLM only classifies; deterministic code writes the row (LLM write boundary).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} combined — combined user text (≤4000 chars)
 * @returns {Promise<{topicSlug: string|null, topicLabel: string|null, method: string}>}
 */
async function classifyTopicFromText(db, combined) {
  const tier0 = inferTopicFromContent(combined, db);
  if (tier0) return { topicSlug: tier0.slug, topicLabel: tier0.label, method: 'keyword' };
  try {
    const topics = getClassifiableTopics(db);
    if (topics.length) {
      const res = await classifyIntent({
        userMessage: combined,
        topics: topics.map(t => ({ slug: t.slug, label: t.label, description: t.description })),
        history: [],
        hasThread: false,
      });
      const slugs = Array.isArray(res?.topics) ? res.topics : [];
      if (slugs[0]) {
        const t = topics.find(x => x.slug === slugs[0]);
        return { topicSlug: slugs[0], topicLabel: t?.label || null, method: 'haiku' };
      }
    }
  } catch (e) {
    console.warn('[materialize] classifyIntent failed:', e.message);
  }
  return { topicSlug: null, topicLabel: null, method: 'keyword' };
}

/**
 * INSERT a materialized conversation row. Guards the `origin` column so
 * pre-migration fixtures still insert, and binds jsonl timestamps when supplied
 * (so recovered history sorts by its real dates, not "now").
 */
function insertMaterializedConversation(db, {
  id, title, tags, archived, threadId, topicSlug, method,
  origin = null, model = 'claude-code', createdAt = null, updatedAt = null,
}) {
  const originCol = origin != null && hasColumn(db, 'conversations', 'origin');
  const cols = ['id', 'title', 'model', 'tags', 'chat_type', 'archived', 'thread_id', 'topic_slug', 'topic_set_method'];
  const vals = [id, title, model, JSON.stringify(tags), 'chat', archived, threadId, topicSlug, method];
  const placeholders = cols.map(() => '?');
  if (originCol) { cols.push('origin'); vals.push(origin); placeholders.push('?'); }
  cols.push('created_at');
  placeholders.push(createdAt ? 'datetime(?)' : "datetime('now')");
  if (createdAt) vals.push(createdAt);
  cols.push('updated_at');
  placeholders.push(updatedAt ? 'datetime(?)' : "datetime('now')");
  if (updatedAt) vals.push(updatedAt);
  db.prepare(
    `INSERT INTO conversations (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`
  ).run(...vals);
}

/** Replace a conversation's message rows in strict order. */
function insertMaterializedMessages(db, convId, messages) {
  const insertMsg = db.prepare(
    'INSERT INTO messages (conversation_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, datetime(?))'
  );
  messages.forEach((m, i) => {
    insertMsg.run(convId, m.role, m.content, i + 1, m.created_at || 'now');
  });
}

/**
 * Materialize a session into a conversation row from user-message content.
 *
 * WHY idempotent INSERT: the stop hook can fire multiple times for the same
 * session (Claude Code upstream issue #29881). The thread_id UNIQUE index
 * makes the first call authoritative; subsequent calls are no-ops.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} threadId
 * @param {Array<{content: string, created_at?: string|null}>} userMessages
 * @param {{origin?: string|null, forceArchived?: number|null}} [opts]
 * @returns {Promise<{materialized: boolean}>}
 */
async function materializeFromUserMessages(db, threadId, userMessages, { origin = null, forceArchived = null } = {}) {
  // Idempotency guard — thread already materialized
  const existing = db.prepare('SELECT id FROM conversations WHERE thread_id = ?').get(threadId);
  if (existing) return { materialized: false };

  userMessages = (userMessages || []).filter((m) => m?.content && String(m.content).trim());
  if (!userMessages.length) return { materialized: false };

  // Title from first user message (100 chars max)
  const title = userMessages[0].content.slice(0, 100);
  const combined = userMessages.map(m => m.content).join(' ').slice(0, 4000);
  const { topicSlug, topicLabel, method } = await classifyTopicFromText(db, combined);

  const tags = ['import-claude-code'];
  if (topicLabel) tags.push(topicLabel);

  // Archived when there's no classified topic (the maint_reclassify pass
  // unarchives once a topic is assigned), OR forced hidden by the caller
  // (a user-only fallback row is one-sided and hidden per AC3/OOS#5).
  const archived = forceArchived != null ? forceArchived : (topicSlug ? 0 : 1);

  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    insertMaterializedConversation(db, { id, title, tags, archived, threadId, topicSlug, method, origin });
    if (topicSlug) {
      db.prepare(
        `INSERT OR REPLACE INTO conversation_topics (conversation_id, topic_slug, is_primary, set_method) VALUES (?, ?, 1, ?)`
      ).run(id, topicSlug, method);
    }
    insertMaterializedMessages(db, id, userMessages.map((m) => ({ role: 'user', content: m.content, created_at: m.created_at })));
  });
  tx();

  return { materialized: true };
}

/**
 * Materialize a two-sided coding-agent session from a parsed native jsonl.
 *
 * The keystone write of st_abf246e4: it stores the owner's turns AND the agent's
 * replies (terminal/tool stripped by the parser), classifies the topic, and
 * files the row by provenance. INSERT when new; UPSERT-enrich when the row
 * already exists AND the parse carries more messages than the stored row — a
 * truncated live-Stop row, or a one-sided row now recovered two-sided. Enrich
 * replaces messages, corrects created_at from the jsonl, re-classifies, and
 * unarchives when it is now two-sided with a topic — never touching id/thread_id.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} threadId — always `claude-code:<sessionId>` (never NULL: the
 *   partial unique index is the dedup guard and NULL bypasses it)
 * @param {{messages: {role:string,content:string,created_at?:string|null}[],
 *          hasAssistant: boolean, firstTs: string|null, lastTs: string|null}} parsed
 * @param {{origin?: string, source?: string}} [opts]
 * @returns {Promise<{materialized: boolean, enriched: boolean}>}
 */
// st_abf246e4 — a spawned Robot Dojo persona session runs as its OWN top-level
// Claude Code session (isSidechain=false), so the caller's origin defaults to
// 'owner' and the session would wrongly surface. Detect the persona brief by
// its first-message content and classify it as a sub-agent. Content match is
// safe here because these are exact machine-authored briefs no owner types
// ("You are Bunshin (分身)…"); classification (origin) drives show/hide
// independently of tags.
const SPAWNED_AGENT_BRIEF = /^\s*(?:you are (?:bunshin|tantei|katagami|ori|hakase|miyagi)\b|you are running the nightly|you are an expert at upholding safety and compliance)/i;
export function isSpawnedAgentSession(firstText) {
  const t = String(firstText || '').trim();
  if (!t) return false;
  if (SPAWNED_AGENT_BRIEF.test(t)) return true;
  // Codex ambient-suggestion brief.
  if (/^#\s*overview\b/i.test(t) && /hyperpersonalized/i.test(t)) return true;
  return false;
}

export async function materializeFromJsonl(db, threadId, parsed, { origin = 'owner', source = 'native-jsonl' } = {}) {
  const messages = (parsed?.messages || []).filter((m) => m?.content && String(m.content).trim());
  if (!messages.length) return { materialized: false, enriched: false };

  // Enrich-guard FIRST (before any classification): when the row exists and the
  // parse carries no new messages, it is a no-op — skip the topic classifier so
  // repeated reconcile passes over already-complete rows cost nothing.
  const existing = db.prepare('SELECT id FROM conversations WHERE thread_id = ?').get(threadId);
  if (existing) {
    const storedCount = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(existing.id).c;
    if (messages.length <= storedCount) return { materialized: false, enriched: false };
  }

  const hasAssistant = messages.some((m) => m.role === 'assistant');
  const firstUser = messages.find((m) => m.role === 'user');
  const title = (firstUser?.content || messages[0].content).slice(0, 100);
  const userText = messages.filter((m) => m.role === 'user').map((m) => m.content).join(' ').trim();
  const combined = (userText || messages.map((m) => m.content).join(' ')).slice(0, 4000);
  const { topicSlug, topicLabel, method } = await classifyTopicFromText(db, combined);

  // Spawned persona sessions (isSidechain=false, so origin came in as 'owner')
  // are reclassified as sub-agents by their brief content — origin, not tags,
  // controls whether they surface.
  const effectiveOrigin = isSpawnedAgentSession(firstUser?.content || title) ? 'subagent' : origin;

  // Two-sided with a topic ⇒ surfaced; one-sided OR no topic ⇒ hidden (reversible).
  const archived = (hasAssistant && topicSlug) ? 0 : 1;
  const firstTs = parsed.firstTs || messages[0].created_at || null;
  const lastTs = parsed.lastTs || messages[messages.length - 1].created_at || null;

  if (existing) {
    // Enrich (the parse carries strictly more messages than stored — the
    // "DO UPDATE only to enrich" contract that makes at-least-once safe).
    const originCol = effectiveOrigin != null && hasColumn(db, 'conversations', 'origin');
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(existing.id);
      insertMaterializedMessages(db, existing.id, messages);
      const setParts = ['topic_slug = ?', 'topic_set_method = ?', 'archived = ?'];
      const params = [topicSlug, method, archived];
      setParts.push(`created_at = ${firstTs ? 'datetime(?)' : 'created_at'}`);
      if (firstTs) params.push(firstTs);
      setParts.push(`updated_at = ${lastTs ? 'datetime(?)' : "datetime('now')"}`);
      if (lastTs) params.push(lastTs);
      if (originCol) { setParts.push('origin = ?'); params.push(effectiveOrigin); }
      params.push(existing.id);
      db.prepare(`UPDATE conversations SET ${setParts.join(', ')} WHERE id = ?`).run(...params);
      if (topicSlug) {
        db.prepare(
          `INSERT OR REPLACE INTO conversation_topics (conversation_id, topic_slug, is_primary, set_method) VALUES (?, ?, 1, ?)`
        ).run(existing.id, topicSlug, method);
      }
    });
    tx();
    return { materialized: false, enriched: true };
  }

  const id = crypto.randomUUID();
  const tags = ['import-claude-code'];
  if (topicLabel) tags.push(topicLabel);
  const tx = db.transaction(() => {
    insertMaterializedConversation(db, {
      id, title, tags, archived, threadId, topicSlug, method, origin: effectiveOrigin,
      createdAt: firstTs, updatedAt: lastTs,
    });
    if (topicSlug) {
      db.prepare(
        `INSERT OR REPLACE INTO conversation_topics (conversation_id, topic_slug, is_primary, set_method) VALUES (?, ?, 1, ?)`
      ).run(id, topicSlug, method);
    }
    insertMaterializedMessages(db, id, messages);
  });
  tx();
  return { materialized: true, enriched: false };
}

/**
 * Materialize a legacy memory-log-backed session into a conversation row.
 * Takes pre-fetched memory-log entries for the thread.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} threadId
 * @param {Array<{tags: string[], path: string, timestamp: string|null}>} entries
 * @returns {Promise<{materialized: boolean}>}
 */
export async function materializeFromEntries(db, threadId, entries) {
  // Filter to user-role turns only; reverse to chronological order (getLogIndex returns newest-first).
  const userEntries = (entries || [])
    .filter(e => Array.isArray(e.tags) && e.tags.includes('role:user'))
    .reverse();
  const userMessages = [];
  for (const entry of userEntries) {
    try {
      const body = await readEntryBody(entry.path);
      if (body && body.trim()) {
        userMessages.push({ content: body.trim(), created_at: entry.timestamp });
      }
    } catch { /* skip unreadable entries */ }
  }
  return materializeFromUserMessages(db, threadId, userMessages);
}

/**
 * Orchestrator: prefer the native jsonl (the ONLY store with the agent's
 * replies) so the forward live path is two-sided-and-classified with no schema
 * change; fall back to the transcript-store user-only path only when no jsonl
 * survives (one-sided, hidden per AC3/OOS#5); finally the legacy memory-log
 * entries for pre-st_b9ec1b7c imports.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} threadId
 * @returns {Promise<{materialized: boolean}>}
 */
export async function materializeSession(db, threadId) {
  const sessionId = typeof threadId === 'string' && threadId.startsWith('claude-code:')
    ? threadId.slice('claude-code:'.length)
    : null;
  if (sessionId) {
    try {
      const { findLocalSessionJsonl, parseSessionJsonl } = await import('./claude-code-jsonl.js');
      const jsonlPath = findLocalSessionJsonl(sessionId);
      if (jsonlPath) {
        const parsed = parseSessionJsonl(jsonlPath);
        if (parsed && parsed.messages.length) {
          return materializeFromJsonl(db, threadId, parsed, {
            origin: parsed.isSidechain ? 'subagent' : 'owner',
            source: 'native-jsonl',
          });
        }
      }
    } catch (e) {
      console.warn('[materializeSession] native jsonl path failed:', e.message);
      // fall through to the transcript-store fallback
    }
  }

  try {
    const { getThread } = await import('./session-log.js');
    const turns = await getThread(threadId);
    const userMessages = turns
      .filter((turn) => turn.role === 'user')
      .map((turn) => ({ content: turn.content, created_at: turn.timestamp }));
    // One-sided by definition (no agent side survives) → hidden + origin='owner'.
    if (userMessages.length) return materializeFromUserMessages(db, threadId, userMessages, { origin: 'owner', forceArchived: 1 });
  } catch {
    // Fall through to the legacy memory-log materializer.
  }
  const allEntries = await getLogIndex();
  const threadEntries = allEntries.filter(e => e.threadId === threadId);
  return materializeFromEntries(db, threadId, threadEntries);
}
