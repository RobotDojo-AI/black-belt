/**
 * One live conversation row per topic or entity (st_c5c4e824).
 *
 * Opening a topic or person/company/place always uses that row. The composer
 * is blank. Recap reads the workbench log. History is a separate view.
 * Entity subjects are encoded in conversations.topic_slug as person:{id}.
 * Coding-agent imported rows stay history and are never auto-marked live.
 */
export const INTELLIGENCE_TIER = 'extraction';

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHAT_MODEL_KEY } from './chat-models.js';
import { VISIBLE_CONVERSATION_WHERE } from './conversation-visibility.js';
import { UNCATEGORIZED_T1 } from './topic-routing-policy.js';
import {
  formatLogSessions,
  isScaffoldProjection,
  memoryBudgetChars,
  projectionFromLog,
  readLogFile,
  selectLogSessions,
  splitLogSessions,
} from './workbench-log.js';
import {
  ensureDefaultEntityWorkbench,
  ensureDefaultTopicWorkbench,
  primaryWorkbenchForTarget,
} from './workbenches.js';
import { REPO_ROOT } from './robotdojo-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOPIC_LIVE_DEFAULTS = Object.freeze({
  compactAfterMessages: 24,
  compactKeepRecent: 4,
  atDefineMinSentenceChars: 8,
  historyPathPrefix: '/chat/history',
  deepFirstDeltaTimeoutMs: 180000,
  recapClipChars: 420,
  chunkBackfillLimit: 20,
  sessionIdleMs: 30 * 60 * 1000,
  sessionOpenTurns: 3,
});

function loadTopicLiveConfig() {
  try {
    const raw = JSON.parse(readFileSync(join(__dirname, '../config/defaults.json'), 'utf8'));
    return { ...TOPIC_LIVE_DEFAULTS, ...(raw.topicLive || {}) };
  } catch {
    return { ...TOPIC_LIVE_DEFAULTS };
  }
}

export function getTopicLiveConfig() {
  return loadTopicLiveConfig();
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

function clip(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, maxChars).trim();
}

function isCodingAgentImport(row) {
  if (!row) return false;
  if (row.thread_id) return true;
  if (row.origin != null && row.origin !== '') return true;
  return false;
}

export function parseSubject(key) {
  const raw = String(key || '').trim();
  if (!raw) return { kind: '', id: '' };
  const m = raw.match(/^(person|company|place):(.+)$/i);
  if (m) return { kind: m[1].toLowerCase(), id: m[2] };
  return { kind: 'topic', id: raw };
}

export function subjectKey(kind, id) {
  const k = String(kind || '').trim().toLowerCase();
  const i = String(id || '').trim();
  if (!i) return '';
  if (k === 'topic' || !k) return i;
  if (k === 'person' || k === 'company' || k === 'place') return `${k}:${i}`;
  return i;
}

export function buildTopicHistoryUrl(slug) {
  const prefix = String(getTopicLiveConfig().historyPathPrefix || '/chat/history').replace(/\/$/, '');
  return `${prefix}/${encodeURIComponent(String(slug || '').trim())}`;
}

export function buildSubjectHistoryUrl(kind, id) {
  if (kind === 'topic') return buildTopicHistoryUrl(id);
  const prefix = String(getTopicLiveConfig().historyPathPrefix || '/chat/history').replace(/\/$/, '');
  return `${prefix}/${encodeURIComponent(subjectKey(kind, id))}`;
}

export function buildSubjectChatUrl(kind, id) {
  const k = String(kind || 'topic').trim().toLowerCase();
  const i = String(id || '').trim();
  if (!i) return '/chat';
  if (k === 'topic') return `/chat/topic/${encodeURIComponent(i)}`;
  return `/chat/${k}/${encodeURIComponent(i)}`;
}

export function topicHistoryCiteInstruction(slug) {
  if (!slug) return '';
  const url = buildTopicHistoryUrl(slug);
  return `When you answer from the past, quote the relevant passage, then link ${url}.`;
}

const HISTORY_SEARCH_STOP = new Set([
  'about', 'after', 'again', 'could', 'did', 'does', 'from', 'have', 'into',
  'just', 'like', 'more', 'some', 'than', 'that', 'their', 'them', 'then',
  'there', 'these', 'this', 'those', 'what', 'when', 'where', 'which', 'with',
  'would', 'your', 'resume',
]);

export function historySearchTokens(q) {
  return [...new Set(String(q || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 5 && !HISTORY_SEARCH_STOP.has(t)))]
    .slice(0, 6);
}

export function buildTopicRecallContext(db, slug, query) {
  const topicSlug = String(slug || '').trim();
  if (!topicSlug) return '';
  const rows = listTopicHistory(db, topicSlug, { q: query, limit: 8 });
  if (!rows.length) return topicHistoryCiteInstruction(topicSlug);
  const quotes = rows.slice(0, 6).map((r) => {
    const text = String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    return `- (${r.role}) "${text}"`;
  }).join('\n');
  return `## Topic history\n${topicHistoryCiteInstruction(topicSlug)}\n${quotes}`;
}

function findLiveRow(db, slug) {
  if (!hasColumn(db, 'conversations', 'is_live')) return null;
  return db.prepare(`
    SELECT id, title, topic_slug, is_live, origin, thread_id, updated_at
      FROM conversations
     WHERE is_live = 1
       AND topic_slug = ?
       AND deleted_at IS NULL
       AND chat_type = 'chat'
     LIMIT 1
  `).get(slug) || null;
}

function ensureWorkbenchRow(db, key) {
  const subject = parseSubject(key);
  if (!subject.id) return null;
  if (subject.kind === 'topic') {
    const existing = getPrimaryTopicWorkbench(db, subject.id)
      || primaryWorkbenchForTarget(db, 'topic', subject.id);
    if (existing) return existing;
    try {
      return ensureDefaultTopicWorkbench(db, subject.id, { repoRoot: REPO_ROOT })
        || getPrimaryTopicWorkbench(db, subject.id);
    } catch {
      return getPrimaryTopicWorkbench(db, subject.id);
    }
  }
  const existing = primaryWorkbenchForTarget(db, subject.kind, subject.id);
  if (existing) return existing;
  try {
    return ensureDefaultEntityWorkbench(db, subject.kind, subject.id, { repoRoot: REPO_ROOT })
      || primaryWorkbenchForTarget(db, subject.kind, subject.id);
  } catch {
    return primaryWorkbenchForTarget(db, subject.kind, subject.id);
  }
}

function getPrimaryTopicWorkbench(db, slug) {
  if (!hasTable(db, 'workbenches') || !hasTable(db, 'workbench_attachments')) return null;
  return db.prepare(`
    SELECT w.id, w.latest_state, w.next_action, w.last_activity_at, w.updated_at, w.root_path
      FROM workbenches w
      JOIN workbench_attachments a ON a.workbench_id = w.id
     WHERE a.target_type = 'topic'
       AND a.target_id = ?
       AND COALESCE(a.role, 'primary') = 'primary'
       AND w.status != 'archived'
     ORDER BY w.updated_at DESC
     LIMIT 1
  `).get(slug) || null;
}

export function getTopicSharedState(db, key) {
  const subject = parseSubject(key);
  const wb = subject.kind === 'topic'
    ? (getPrimaryTopicWorkbench(db, subject.id) || primaryWorkbenchForTarget(db, 'topic', subject.id))
    : primaryWorkbenchForTarget(db, subject.kind, subject.id);
  let latestState = String(wb?.latest_state || '');
  let nextAction = String(wb?.next_action || '');
  let title = '';
  try {
    const fromLog = projectionFromLog(wb?.root_path);
    const logState = fromLog.latestState && !isScaffoldProjection(fromLog.latestState)
      ? fromLog.latestState
      : '';
    const logNext = fromLog.nextAction && !isScaffoldProjection(fromLog.nextAction)
      ? fromLog.nextAction
      : '';
    if (logState) latestState = logState;
    else if (!latestState || isScaffoldProjection(latestState)) latestState = fromLog.latestState || latestState;
    if (logNext) nextAction = logNext;
    else if (!nextAction || isScaffoldProjection(nextAction)) nextAction = fromLog.nextAction || nextAction;
    title = String(fromLog.title || '').trim();
  } catch {
    /* disk log is best-effort for Recap */
  }
  return {
    latestState,
    nextAction,
    title,
    lastActivityAt: wb?.last_activity_at || null,
    workbenchId: wb?.id || null,
    rootPath: wb?.root_path || null,
  };
}

const INBOX_RESUME_SLUGS = new Set(['all', 'general', 'uncategorized', 'needs-routing']);

export const TOPIC_CHAT_VOICE = [
  'These notes are source data. They feed every reply. They are not the reply.',
  'You are Miyagi. Every reply is spoken chat prose in the usual voice. Never labeled fields. Never dump the notes as a list of facts.',
].join('\n');

export function listTopicTimelineEvents(db, topicSlug, { limit = 6 } = {}) {
  if (!hasTable(db, 'timeline_events')) return [];
  const slug = String(topicSlug || '').trim();
  if (!slug) return [];
  const cap = Math.max(1, Math.min(Number(limit) || 6, 24));
  try {
    return db.prepare(`
      SELECT event_date, event_type, summary, source_type, source_id
        FROM timeline_events
       WHERE COALESCE(source_type, '') NOT IN ('chat', 'calendar', 'apple-health')
         AND COALESCE(source_type, '') NOT LIKE 'calendar%'
         AND COALESCE(event_type, '') NOT IN ('health_metric', 'chat', 'lab_result')
         AND (
           json_extract(metadata, '$.topic') = ?
           OR json_extract(metadata, '$.topic_slug') = ?
         )
       ORDER BY event_date DESC, rowid DESC
       LIMIT ?
    `).all(slug, slug, cap);
  } catch {
    return [];
  }
}

function formatTopicLogBlock(rootPath, { query = '', responseMode = 'fast', historyUrl = '' } = {}) {
  const sessions = splitLogSessions(readLogFile(rootPath));
  if (!sessions.length) return '';
  const picked = selectLogSessions(sessions, query, {
    budgetChars: memoryBudgetChars(responseMode),
    maxSessions: responseMode === 'deep' ? 8 : 4,
  });
  return formatLogSessions(picked, {
    historyUrl,
    sessionChars: responseMode === 'deep' ? 1800 : 700,
    heading: 'Log',
  });
}

function formatTopicTimelineBlock(db, key, { responseMode = 'fast' } = {}) {
  const subject = parseSubject(key);
  if (subject.kind !== 'topic' || !subject.id || INBOX_RESUME_SLUGS.has(subject.id)) return '';
  const rows = listTopicTimelineEvents(db, subject.id, {
    limit: responseMode === 'deep' ? 12 : 6,
  });
  if (!rows.length) return '';
  const lines = rows.map((row) => {
    const day = String(row.event_date || '').slice(0, 10);
    const summary = String(row.summary || '').replace(/\s+/g, ' ').trim();
    return `- ${[day, summary].filter(Boolean).join(' ')}`;
  });
  return ['## Timeline', ...lines].join('\n');
}

export function formatTopicResumeBlock(db, slug, { query = '', responseMode = 'fast' } = {}) {
  const key = String(slug || '').trim();
  if (!key) return '';
  const subject = parseSubject(key);
  if (subject.kind === 'topic' && INBOX_RESUME_SLUGS.has(subject.id)) return '';
  const state = getTopicSharedState(db, key);
  const last = String(state.latestState || '').trim();
  const next = String(state.nextAction || '').trim();
  const logBlock = formatTopicLogBlock(state.rootPath, {
    query,
    responseMode,
    historyUrl: subject.kind === 'topic' ? buildTopicHistoryUrl(subject.id) : '',
  });
  const timelineBlock = formatTopicTimelineBlock(db, key, { responseMode });
  if (!last && !next && !logBlock && !timelineBlock) return '';
  const lines = [];
  if (last || next) {
    lines.push('## Last state');
    if (last) lines.push(last);
    if (next) {
      lines.push('');
      lines.push('## Next');
      lines.push(next);
    }
  }
  if (logBlock) {
    if (lines.length) lines.push('');
    lines.push(logBlock);
  }
  if (timelineBlock) {
    if (lines.length) lines.push('');
    lines.push(timelineBlock);
  }
  lines.push('');
  lines.push(TOPIC_CHAT_VOICE);
  return lines.join('\n');
}

function lastLiveMessageAt(db, liveId) {
  if (!liveId || !hasTable(db, 'messages')) return null;
  return db.prepare(`
    SELECT created_at
      FROM messages
     WHERE conversation_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `).get(liveId)?.created_at || null;
}

function timeMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
    ? raw
    : `${raw.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

export function isRecapStale(db, slug, liveId = null) {
  const id = liveId || findLiveRow(db, slug)?.id;
  if (!id) return false;
  const lastAt = lastLiveMessageAt(db, id);
  if (!lastAt) return false;
  const state = getTopicSharedState(db, slug);
  if (!String(state.latestState || '').trim()) return true;
  if (!state.lastActivityAt) return true;
  return timeMs(lastAt) > timeMs(state.lastActivityAt);
}

function topicLabel(db, slug) {
  if (!hasTable(db, 'user_topics')) return slug;
  return db.prepare('SELECT label FROM user_topics WHERE slug = ?').get(slug)?.label || slug;
}

function subjectLabel(db, key) {
  const subject = parseSubject(key);
  if (!subject.id) return key;
  if (subject.kind === 'topic') return topicLabel(db, subject.id);
  try {
    if (subject.kind === 'person') {
      return db.prepare('SELECT display_name AS label FROM people WHERE id = ?').get(subject.id)?.label || subject.id;
    }
    if (subject.kind === 'company') {
      return db.prepare('SELECT name AS label FROM companies WHERE id = ?').get(subject.id)?.label || subject.id;
    }
    if (subject.kind === 'place') {
      return db.prepare('SELECT name AS label FROM places WHERE CAST(id AS TEXT) = ?').get(subject.id)?.label || subject.id;
    }
  } catch {
    /* */
  }
  return subject.id;
}

function insertLiveConversation(db, slug) {
  const id = crypto.randomUUID();
  const title = subjectLabel(db, slug);
  const tagsJson = JSON.stringify([title]);
  const cols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
  const hasOrigin = cols.includes('origin');
  const hasIsLive = cols.includes('is_live');
  const fields = ['id', 'title', 'model', 'tags', 'chat_type', 'topic_slug', 'created_at', 'updated_at'];
  const values = [id, title, DEFAULT_CHAT_MODEL_KEY, tagsJson, 'chat', slug];
  if (hasIsLive) {
    fields.splice(6, 0, 'is_live');
    values.push(1);
  }
  if (hasOrigin) {
    // web live rows stay origin NULL (owner-visible, not a coding-agent import)
  }
  const placeholders = fields.map((f) => (f === 'created_at' || f === 'updated_at' ? "datetime('now')" : '?')).join(', ');
  db.prepare(`INSERT INTO conversations (${fields.join(', ')}) VALUES (${placeholders})`).run(...values);
  if (hasTable(db, 'conversation_topics')) {
    try {
      db.prepare(
        `INSERT OR IGNORE INTO conversation_topics (conversation_id, topic_slug, is_primary, set_method) VALUES (?, ?, 1, 'user')`,
      ).run(id, slug);
    } catch {
      db.prepare(
        `INSERT OR IGNORE INTO conversation_topics (conversation_id, topic_slug) VALUES (?, ?)`,
      ).run(id, slug);
    }
  }
  return id;
}

function livePayload(db, slug, conversationId) {
  const state = getTopicSharedState(db, slug);
  const subject = parseSubject(slug);
  return {
    conversationId,
    topicSlug: slug,
    subjectKey: slug,
    kind: subject.kind,
    id: subject.id,
    latestState: state.latestState,
    nextAction: state.nextAction,
    title: state.title || '',
    recapStale: isRecapStale(db, slug, conversationId),
    workbenchId: state.workbenchId,
  };
}

/**
 * Find or create the single live conversation for a topic slug.
 * Does not return messages. Does not run a model.
 */
export function findOrCreateLiveConversation(db, slug) {
  const topicSlug = String(slug || '').trim();
  if (!topicSlug) {
    const err = new Error('topic_slug_required');
    err.code = 'topic_slug_required';
    throw err;
  }
  ensureWorkbenchRow(db, topicSlug);
  const existing = findLiveRow(db, topicSlug);
  if (existing) return livePayload(db, topicSlug, existing.id);

  try {
    const id = insertLiveConversation(db, topicSlug);
    return livePayload(db, topicSlug, id);
  } catch (err) {
    const message = String(err?.message || '');
    if (/UNIQUE|unique/i.test(message)) {
      const raced = findLiveRow(db, topicSlug);
      if (raced) return livePayload(db, topicSlug, raced.id);
    }
    throw err;
  }
}

export function touchWorkbenchState(db, slug, { latestState, nextAction, lastActivityAt } = {}) {
  const wb = ensureWorkbenchRow(db, slug) || getPrimaryTopicWorkbench(db, slug);
  if (!wb) return { ok: false, reason: 'no_workbench' };
  const clipChars = getTopicLiveConfig().recapClipChars || 420;
  const nextLs = latestState != null ? clip(latestState, clipChars) : wb.latest_state;
  const nextNa = nextAction != null ? clip(nextAction, clipChars) : wb.next_action;
  const activityAt = lastActivityAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  db.prepare(`
    UPDATE workbenches
       SET latest_state = ?,
           next_action = ?,
           last_activity_at = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(nextLs, nextNa, activityAt, wb.id);
  return { ok: true, workbenchId: wb.id, latestState: nextLs, nextAction: nextNa };
}

export function syncLiveTopicStateFromMessages(db, slug) {
  const live = findLiveRow(db, slug);
  if (!live) return { ok: false, reason: 'no_live' };
  const lastAssistant = db.prepare(`
    SELECT content FROM messages
     WHERE conversation_id = ? AND role = 'assistant'
     ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(live.id);
  const lastUser = db.prepare(`
    SELECT content FROM messages
     WHERE conversation_id = ? AND role = 'user'
     ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(live.id);
  const clipChars = getTopicLiveConfig().recapClipChars || 420;
  const latestState = clip(lastAssistant?.content || lastUser?.content || '', clipChars);
  const nextAction = lastUser?.content
    ? clip(`Continue from: ${lastUser.content}`, clipChars)
    : '';
  if (!latestState && !nextAction) return { ok: true, updated: false };
  const lastAt = lastLiveMessageAt(db, live.id);
  return { ...touchWorkbenchState(db, slug, { latestState, nextAction, lastActivityAt: lastAt }), updated: true };
}

export async function recapTopic(db, slug, { synthesizer, reasoner } = {}) {
  const live = findOrCreateLiveConversation(db, slug);
  if (!live.recapStale) {
    return {
      latestState: live.latestState,
      nextAction: live.nextAction,
      synthesized: false,
    };
  }
  const subject = parseSubject(slug);
  const target = subject.kind === 'topic' || !subject.kind
    ? { type: 'topic', id: subject.id || slug, label: topicLabel(db, subject.id || slug) }
    : { type: subject.kind, id: subject.id, label: subjectLabel(db, slug) };
  let reasoned = false;
  try {
    const { reasonOneLog } = await import('./workbench-log-reason.js');
    const result = await reasonOneLog(db, target, { reasoner, force: true });
    reasoned = Boolean(result?.reasoned);
  } catch {
    /* Recap still returns the last Decision; never paste the raw last message. */
  }
  if (typeof synthesizer === 'function') {
    await synthesizer(db, slug);
  }
  const lastAt = lastLiveMessageAt(db, live.conversationId);
  const next = getTopicSharedState(db, slug);
  touchWorkbenchState(db, slug, {
    latestState: next.latestState,
    nextAction: next.nextAction,
    lastActivityAt: lastAt || undefined,
  });
  const after = getTopicSharedState(db, slug);
  return {
    latestState: after.latestState,
    nextAction: after.nextAction,
    synthesized: reasoned,
  };
}

export function listTopicHistory(db, slug, { q = '', limit = 80 } = {}) {
  const topicSlug = String(slug || '').trim();
  if (!topicSlug) return [];
  const tokens = historySearchTokens(q);
  const bounded = Math.max(1, Math.min(Number(limit) || 80, 200));
  const hasOrigin = hasColumn(db, 'conversations', 'origin');
  const hasIsLive = hasColumn(db, 'conversations', 'is_live');
  const originClause = hasOrigin
    ? "AND (c.origin IS NULL OR c.origin = 'owner')"
    : '';
  const liveSelect = hasIsLive ? 'c.is_live' : '0 AS is_live';
  const tokenClause = tokens.length
    ? `AND (${tokens.map(() => 'lower(m.content) LIKE ?').join(' OR ')})`
    : '';
  const sql = `
    SELECT m.role, m.content, m.created_at, m.conversation_id,
           c.title, c.topic_slug, ${liveSelect} AS is_live
           ${hasOrigin ? ', c.origin, c.thread_id' : ''}
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
     WHERE c.topic_slug = ?
       AND c.deleted_at IS NULL
       AND c.chat_type = 'chat'
       ${originClause}
       ${tokenClause}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT ?
  `;
  const fetchLimit = tokens.length ? Math.min(200, Math.max(bounded * 10, 80)) : bounded;
  const args = [topicSlug, ...tokens.map((t) => `%${t}%`), fetchLimit];
  const rows = db.prepare(sql).all(...args)
    .filter((row) => {
      const text = String(row.content || '');
      return !text.includes('<task-notification>') && !text.includes('<command-message>');
    });
  if (!tokens.length) return rows.reverse();
  const scored = rows.map((row) => {
    const text = String(row.content || '').toLowerCase();
    const score = tokens.reduce((n, token) => n + (text.includes(token) ? 1 : 0), 0);
    return { row, score };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(b.row.created_at).localeCompare(String(a.row.created_at)));
  return scored.slice(0, bounded).map((item) => item.row)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

export async function maybeCompactLiveConversation(db, convId, provider) {
  if (!hasColumn(db, 'conversations', 'is_live')) return { ok: true, skipped: true, reason: 'no_is_live' };
  const row = db.prepare(
    'SELECT id, is_live, topic_slug FROM conversations WHERE id = ? AND deleted_at IS NULL',
  ).get(convId);
  if (!row?.is_live) return { ok: true, skipped: true, reason: 'not_live' };
  const after = Number(getTopicLiveConfig().compactAfterMessages) || 24;
  const n = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(convId)?.n || 0;
  if (n <= after) return { ok: true, skipped: true, reason: 'under_threshold', count: n };
  const { compressConversation } = await import('./conversations.js');
  const result = await compressConversation(db, convId, provider);
  if (result?.ok && row.topic_slug) syncLiveTopicStateFromMessages(db, row.topic_slug);
  return result;
}

export function backfillTopicStateFromChunks(db, slug) {
  if (!hasTable(db, 'chunks')) return { ok: false, reason: 'no_chunks' };
  const limit = Number(getTopicLiveConfig().chunkBackfillLimit) || 20;
  const rows = db.prepare(`
    SELECT content, source_type, event_time, created_at
      FROM chunks
     WHERE topic = ?
     ORDER BY COALESCE(event_time, created_at) DESC
     LIMIT ?
  `).all(slug, limit);
  if (!rows.length) return { ok: true, updated: false, reason: 'no_rows' };
  const clipChars = getTopicLiveConfig().recapClipChars || 420;
  const latestState = clip(rows[0].content, clipChars);
  const nextAction = 'Review the latest source material and continue.';
  const touched = touchWorkbenchState(db, slug, { latestState, nextAction });
  return { ...touched, updated: Boolean(touched.ok), sourceTypes: [...new Set(rows.map((r) => r.source_type))] };
}

export function isInboxNavLabel(label) {
  if (label == null) return true;
  if (label === 'all' || label === 'starred' || label === 'actions') return true;
  return false;
}

export { isCodingAgentImport, UNCATEGORIZED_T1, VISIBLE_CONVERSATION_WHERE };
