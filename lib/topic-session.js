/**
 * Topic chat sessions — same unit as coding-agent /close.
 *
 * One live conversation row per topic. Each visit is a session:
 *   Start = first message after idle, or an empty live thread.
 *   End   = idle (written then), tab close, leave the topic, or /close.
 *   The resume is written at that close, not deferred to the next open.
 *
 * Open turns (1–3) load last state, log, and timeline.
 * After that the live messages are the context unless the user names
 * a person/company/topic or asks where things left off.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { modelFor } from './model-lane.js';
import {
  getTopicLiveConfig,
  getTopicSharedState,
  syncLiveTopicStateFromMessages,
  touchWorkbenchState,
} from './topic-live-thread.js';
import { REPO_ROOT } from './robotdojo-paths.js';

export const INTELLIGENCE_TIER = 'extraction';

const RESUME_QUERY_RE = /\b(recap|catch me up|where did we leave|where are we|last (state|session|time)|pick up where|what did we (decide|conclude|agree)|remind me)\b/i;

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
  return `${text.slice(0, maxChars).trim()}…`;
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

function lastUserMessageAt(db, convId) {
  if (!convId || !hasTable(db, 'messages')) return null;
  return db.prepare(`
    SELECT created_at
      FROM messages
     WHERE conversation_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `).get(convId)?.created_at || null;
}

export function isResumeQuery(query) {
  return RESUME_QUERY_RE.test(String(query || ''));
}

export function shouldAttachTopicCorpus({
  sessionUserTurn = 1,
  query = '',
  responseMode = 'fast',
} = {}) {
  if (responseMode === 'deep') return true;
  if (isResumeQuery(query)) return true;
  const openTurns = Number(getTopicLiveConfig().sessionOpenTurns) || 3;
  return !sessionUserTurn || sessionUserTurn <= openTurns;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function mentionedTopicSlugs(db, query, currentSlug = '') {
  const text = String(query || '').trim();
  if (!text || !db || !hasTable(db, 'user_topics')) return [];
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT slug, label
        FROM user_topics
       WHERE COALESCE(visible, 1) = 1
    `).all();
  } catch {
    return [];
  }
  const current = String(currentSlug || '').trim().toLowerCase();
  const hits = [];
  for (const row of rows) {
    const slug = String(row.slug || '').trim();
    if (!slug || slug.toLowerCase() === current) continue;
    const label = String(row.label || '').trim();
    if (label.length >= 4 && new RegExp(`\\b${escapeRegExp(label)}\\b`, 'i').test(text)) {
      hits.push(slug);
      continue;
    }
    if (slug.length >= 5 && new RegExp(`\\b${escapeRegExp(slug.replace(/-/g, '[\\s-]+'))}\\b`, 'i').test(text)) {
      hits.push(slug);
    }
  }
  return [...new Set(hits)];
}

export function formatSessionCloseSynthesis({
  topic = 'Topic',
  latestState = '',
  nextAction = '',
  reason = 'session-end',
  date = new Date().toISOString().slice(0, 10),
} = {}) {
  const decision = clip(latestState, 800) || 'Session ended with no new last state.';
  const next = clip(nextAction, 420) || 'Open this topic and continue.';
  return [
    `# ${topic}`,
    '',
    `_Session: ${date}_`,
    '',
    '## Decision',
    decision,
    '',
    '## Why',
    `Closed ${reason}. Last state is the resume for the next visit.`,
    '',
    '## Citations',
    `- Topic ${topic} live thread`,
    '',
    '## Next-session anchors',
    `- ${next}`,
    '',
  ].join('\n');
}

function appendLog(rootPath, synthesis, date) {
  if (!rootPath) return false;
  const abs = resolve(REPO_ROOT, rootPath);
  mkdirSync(abs, { recursive: true });
  const logPath = join(abs, 'LOG.md');
  if (!existsSync(logPath)) {
    writeFileSync(logPath, '# Topic log\n\nAppend-only session memory.\n', 'utf8');
  }
  appendFileSync(logPath, `\n\n---\n\n## Work session ${date}\n\n${synthesis.trim()}\n`, 'utf8');
  const statusPath = join(abs, 'SESSION-STATUS.md');
  const nextLine = synthesis.match(/## Next-session anchors\n+-\s*(.+)/i)?.[1]
    || 'Continue from this log.';
  const statusBlock = `\n## Session ${date}\n\nNext-session anchor: ${nextLine}\n`;
  if (existsSync(statusPath)) appendFileSync(statusPath, statusBlock, 'utf8');
  else writeFileSync(statusPath, `# Session status\n${statusBlock}`, 'utf8');
  return true;
}

function sessionTurns(db, convId, sessionStartedAt) {
  if (!hasTable(db, 'messages')) return [];
  return db.prepare(`
    SELECT role, content, created_at
      FROM messages
     WHERE conversation_id = ?
       AND created_at >= ?
     ORDER BY created_at ASC, id ASC
  `).all(convId, sessionStartedAt);
}

function hasFourSections(text) {
  const raw = String(text || '');
  return /## Decision/i.test(raw)
    && /## Why/i.test(raw)
    && /## Citations/i.test(raw)
    && /## Next-session anchors/i.test(raw);
}

function extractSection(text, heading) {
  const re = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
  return clip(text.match(re)?.[1] || '', 800);
}

function llmText(resp) {
  const content = resp?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((block) => block?.text || '').join('').trim();
  }
  return String(resp?.text || '').trim();
}

function skipSessionCloseLlm() {
  return process.env.NODE_TEST_CONTEXT
    || process.env.ROBOTDOJO_SESSION_CLOSE_SKIP_LLM === '1';
}

export function formatSessionResumeFromTurns({
  topic = 'Topic',
  turns = [],
  reason = 'session-end',
  date = new Date().toISOString().slice(0, 10),
} = {}) {
  const lastAssistant = [...turns].reverse().find((row) => row.role === 'assistant');
  const lastUser = [...turns].reverse().find((row) => row.role === 'user');
  const userTurns = turns.filter((row) => row.role === 'user').length;
  return formatSessionCloseSynthesis({
    topic,
    latestState: lastAssistant?.content || '',
    nextAction: lastUser?.content ? `Continue from: ${lastUser.content}` : '',
    reason: `${reason}; ${userTurns} user turn${userTurns === 1 ? '' : 's'}`,
    date,
  });
}

export async function synthesizeSessionResume(db, {
  convId,
  slug,
  reason,
  sessionStartedAt,
} = {}) {
  const turns = sessionTurns(db, convId, sessionStartedAt);
  const date = new Date().toISOString().slice(0, 10);
  const fallback = formatSessionResumeFromTurns({ topic: slug, turns, reason, date });
  if (skipSessionCloseLlm() || turns.length === 0) return fallback;
  const transcript = turns
    .map((row) => `${row.role}: ${clip(row.content, 1400)}`)
    .join('\n\n');
  try {
    const { llmCreate } = await import('./llm-gateway.js');
    const resp = await llmCreate({
      model: modelFor('balanced'),
      max_tokens: 700,
      timeout_ms: 15_000,
      messages: [{
        role: 'user',
        content: [
          `Write a topic-session close for "${slug}".`,
          'Use exactly these headings, in this order:',
          '## Decision',
          '## Why',
          '## Citations',
          '## Next-session anchors',
          'Decision: what is now true. Why: the mechanism, grounded in the transcript.',
          'Citations: bullets from the transcript. Next-session anchors: what to pick up next.',
          'No preamble. No labeled recap card.',
          '',
          'Transcript:',
          transcript,
        ].join('\n'),
      }],
    }, 'topic-session-close');
    const text = llmText(resp);
    if (hasFourSections(text)) return text;
  } catch (err) {
    console.warn('[topic-session] resume synthesis failed:', err?.message || err);
  }
  return fallback;
}

export async function closeTopicChatSession(db, {
  convId,
  topicSlug,
  reason = 'idle',
  synthesize = true,
} = {}) {
  if (!db || !convId) return { ok: false, reason: 'no_conversation' };
  if (!hasColumn(db, 'conversations', 'session_started_at')) {
    return { ok: true, skipped: true, reason: 'no_session_columns' };
  }
  const row = db.prepare(`
    SELECT session_started_at, session_closed_at, topic_slug
      FROM conversations
     WHERE id = ?
  `).get(convId);
  if (!row) return { ok: false, reason: 'missing_row' };
  if (row.session_closed_at) return { ok: true, skipped: true, reason: 'already_closed' };
  if (!row.session_started_at) return { ok: true, skipped: true, reason: 'never_started' };

  const userTurns = hasTable(db, 'messages')
    ? (db.prepare(`
        SELECT COUNT(*) AS n
          FROM messages
         WHERE conversation_id = ?
           AND role = 'user'
           AND created_at >= ?
      `).get(convId, row.session_started_at)?.n || 0)
    : 0;
  if (userTurns < 1) {
    db.prepare(`
      UPDATE conversations
         SET session_closed_at = datetime('now')
       WHERE id = ?
    `).run(convId);
    return { ok: true, skipped: true, reason: 'empty_session' };
  }

  const slug = String(topicSlug || row.topic_slug || '').trim();
  const synced = slug ? syncLiveTopicStateFromMessages(db, slug) : null;
  db.prepare(`
    UPDATE conversations
       SET session_closed_at = datetime('now')
     WHERE id = ?
  `).run(convId);

  if (!slug) return { ok: true, synced, reason };
  const date = new Date().toISOString().slice(0, 10);
  const synthesis = synthesize
    ? await synthesizeSessionResume(db, {
      convId,
      slug,
      reason,
      sessionStartedAt: row.session_started_at,
    })
    : formatSessionResumeFromTurns({
      topic: slug,
      turns: sessionTurns(db, convId, row.session_started_at),
      reason,
      date,
    });
  const wb = hasTable(db, 'workbenches')
    ? db.prepare(`
        SELECT w.root_path
          FROM workbenches w
          JOIN workbench_attachments a ON a.workbench_id = w.id
         WHERE a.target_id = ?
           AND w.status != 'archived'
         ORDER BY w.updated_at DESC
         LIMIT 1
      `).get(slug)
    : null;
  appendLog(wb?.root_path, synthesis, date);
  const decision = extractSection(synthesis, 'Decision');
  const next = extractSection(synthesis, 'Next-session anchors');
  if (decision || next) {
    touchWorkbenchState(db, slug, {
      latestState: decision || undefined,
      nextAction: next || undefined,
    });
  }
  return { ok: true, synced, reason, synthesized: hasFourSections(synthesis) };
}

export function sessionActivityMs(row, lastAt) {
  return Math.max(timeMs(lastAt), timeMs(row?.session_started_at));
}

export function isSessionIdle(row, lastAt, now = Date.now()) {
  const idleMs = Number(getTopicLiveConfig().sessionIdleMs) || 30 * 60 * 1000;
  const activityMs = sessionActivityMs(row, lastAt);
  return Boolean(activityMs && (now - activityMs) >= idleMs);
}

export async function closeIdleTopicSessions(db, { now = Date.now() } = {}) {
  if (!db || !hasColumn(db, 'conversations', 'session_started_at')) {
    return { ok: true, closed: 0 };
  }
  const deletedClause = hasColumn(db, 'conversations', 'deleted_at')
    ? 'AND deleted_at IS NULL'
    : '';
  const rows = db.prepare(`
    SELECT id, topic_slug, session_started_at, session_closed_at
      FROM conversations
     WHERE session_started_at IS NOT NULL
       AND session_closed_at IS NULL
       ${deletedClause}
  `).all();
  let closed = 0;
  for (const row of rows) {
    const lastAt = lastUserMessageAt(db, row.id);
    if (!isSessionIdle(row, lastAt, now)) continue;
    const result = await closeTopicChatSession(db, {
      convId: row.id,
      topicSlug: row.topic_slug,
      reason: 'idle',
    });
    if (result.ok && !result.skipped) closed += 1;
  }
  return { ok: true, closed };
}

export async function beginTopicChatSession(db, {
  convId,
  topicSlug,
  now = Date.now(),
} = {}) {
  if (!convId) return { sessionUserTurn: 1, started: true };
  if (!hasColumn(db, 'conversations', 'session_started_at')) {
    return { sessionUserTurn: 1, started: false, untracked: true };
  }
  const row = db.prepare(`
    SELECT session_started_at, session_closed_at, topic_slug
      FROM conversations
     WHERE id = ?
  `).get(convId);
  if (!row) return { sessionUserTurn: 1, started: true };

  const lastAt = lastUserMessageAt(db, convId);
  const idle = isSessionIdle(row, lastAt, now);
  const closed = Boolean(row.session_closed_at);
  const slug = String(topicSlug || row.topic_slug || '').trim();

  // Resume is written at idle/tab-close, not here. If a close was missed,
  // close first so the next session still has a log, then start clean.
  if (row.session_started_at && !closed && idle) {
    await closeTopicChatSession(db, { convId, topicSlug: slug, reason: 'idle', synthesize: false });
  }

  if (!row.session_started_at || closed || idle) {
    db.prepare(`
      UPDATE conversations
         SET session_started_at = datetime('now'),
             session_closed_at = NULL
       WHERE id = ?
    `).run(convId);
    return { sessionUserTurn: 1, started: true, closedPrior: idle && !closed };
  }

  const n = db.prepare(`
    SELECT COUNT(*) AS n
      FROM messages
     WHERE conversation_id = ?
       AND role = 'user'
       AND created_at >= ?
  `).get(convId, row.session_started_at)?.n || 0;
  return { sessionUserTurn: n + 1, started: false };
}

function parsePayload(raw) {
  const start = String(raw || '').indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
}

export function persistWorkSessionClose(workDir) {
  const dir = String(workDir || '').trim();
  if (!dir || !existsSync(dir)) return { ok: false, reason: 'no_work_dir' };
  const payloadPath = join(dir, 'open-payload.json');
  const synthesisPath = join(dir, 'close-synthesis.md');
  const payloadFile = existsSync(payloadPath) ? parsePayload(readFileSync(payloadPath, 'utf8')) : null;
  const payload = payloadFile?.payload || payloadFile;
  const root = payload?.root;
  if (!root) return { ok: false, reason: 'no_topic_root' };

  const date = new Date().toISOString().slice(0, 10);
  let synthesis = existsSync(synthesisPath) ? readFileSync(synthesisPath, 'utf8').trim() : '';
  if (!synthesis) {
    synthesis = formatSessionCloseSynthesis({
      topic: payload?.title || payload?.attachments?.[0]?.label || 'Topic',
      latestState: payload?.latest_state || '',
      nextAction: payload?.next_action || '',
      reason: 'close',
      date,
    });
    writeFileSync(synthesisPath, synthesis, 'utf8');
  }
  const wrote = appendLog(root, synthesis, date);
  return { ok: wrote, root, date };
}
