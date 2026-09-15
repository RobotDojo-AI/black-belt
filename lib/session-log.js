// lib/session-log.js - typed helpers for session continuity.
//
// Every turn lands in flat transcript files under user/transcripts/chat/sessions.
// End-of-session bookmarks land in the curated hash-chained memory log. This
// keeps perfect sequential replay without putting the turn firehose back into
// user/memory/log.

import { appendMemory, getLogIndex, LOG_ROOT } from './memory.js';
import db from './db.js';
import { appendMemoryEvent } from './memory-events.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { REPO_ROOT } from './robotdojo-paths.js';

/**
 * Generate a fresh thread id. Stable per conversation; used to group turns.
 * Format: yyyymmddThhmmss-<random6> — sortable, readable, collision-safe.
 */
export function newThreadId() {
  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, '').slice(0, 15);
  const rnd = randomBytes(3).toString('hex');
  return `${stamp}-${rnd}`;
}

const NAME_SAFE_RE = /[^a-z0-9-]+/g;
const OVERFLOW_DIR = join(LOG_ROOT, 'session-log-overflow');
const transcriptPathCache = new Map();
let transcriptAppendQueue = Promise.resolve();

function nameFor(prefix) {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const rnd = randomBytes(2).toString('hex');
  return `${prefix.toLowerCase().replace(NAME_SAFE_RE, '-')}-${stamp}-${rnd}`.slice(0, 80);
}

function overflowStamp(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

function shouldOverflowSessionLog(err) {
  const message = err?.message || String(err || '');
  return message.startsWith('memory:') || /fork at prev_hash|orphan\(s\)|multiple genesis|no genesis entry/i.test(message);
}

async function writeSessionLogOverflow(kind, entry, err) {
  await mkdir(OVERFLOW_DIR, { recursive: true, mode: 0o700 });
  const name = `${overflowStamp()}-${kind}-${randomBytes(4).toString('hex')}.json`;
  const path = join(OVERFLOW_DIR, name);
  const payload = {
    kind,
    captured_at: new Date().toISOString(),
    degraded: true,
    error: err?.message || String(err || ''),
    entry,
  };
  await writeFile(path, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  return { path, name };
}

async function appendSessionMemory(kind, entry) {
  try {
    return await appendMemory(entry);
  } catch (err) {
    if (!shouldOverflowSessionLog(err)) throw err;
    const overflow = await writeSessionLogOverflow(kind, entry, err);
    return {
      path: overflow.path,
      name: overflow.name,
      prevHash: null,
      selfHash: null,
      degraded: true,
      error: err?.message || String(err || ''),
    };
  }
}

function safeSegment(value, fallback = 'unknown') {
  const s = String(value || fallback)
    .toLowerCase()
    .replace(NAME_SAFE_RE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return s || fallback;
}

function dateTimeFromThreadId(threadId) {
  const m = String(threadId || '').match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?/);
  if (!m) {
    const iso = new Date().toISOString();
    return { dateStr: iso.slice(0, 10), timeStr: iso.slice(11, 16).replace(':', '') };
  }
  return {
    dateStr: `${m[1]}-${m[2]}-${m[3]}`,
    timeStr: `${m[4] || '00'}${m[5] || '00'}`,
  };
}

function frontmatterValue(value) {
  return String(value || '').replace(/"/g, '\\"');
}

function sessionTranscriptsDir() {
  const userRoot = process.env.ROBOTDOJO_USER_ROOT
    ? resolve(process.env.ROBOTDOJO_USER_ROOT)
    : join(REPO_ROOT, 'user');
  const transcriptsRoot = process.env.ROBOTDOJO_TRANSCRIPTS_ROOT
    ? resolve(process.env.ROBOTDOJO_TRANSCRIPTS_ROOT)
    : join(userRoot, 'transcripts');
  return join(transcriptsRoot, 'chat', 'sessions');
}

function sessionTranscriptPath({ threadId, source = 'unknown' }) {
  const root = sessionTranscriptsDir();
  const cacheKey = `${root}:${source}:${threadId}`;
  const cached = transcriptPathCache.get(cacheKey);
  if (cached) return cached;

  const { dateStr, timeStr } = dateTimeFromThreadId(threadId);
  const sourceSlug = safeSegment(source);
  const threadSlug = safeSegment(threadId, 'thread');
  const filePath = join(
    root,
    sourceSlug,
    `${dateStr}-${timeStr}-${sourceSlug}-${threadSlug}.md`,
  );
  transcriptPathCache.set(cacheKey, filePath);
  return filePath;
}

async function ensureSessionTranscriptFile({ filePath, threadId, source = 'unknown', title = null }) {
  if (existsSync(filePath)) return;
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const { dateStr, timeStr } = dateTimeFromThreadId(threadId);
  const hh = timeStr.slice(0, 2);
  const mm = timeStr.slice(2, 4);
  const content = [
    '---',
    `id: "session-${frontmatterValue(threadId)}"`,
    `date: "${dateStr}"`,
    `time: "${hh}:${mm}"`,
    `source: "${frontmatterValue(source)}"`,
    'type: "chat"',
    `title: "${frontmatterValue(title || `Session ${threadId}`)}"`,
    '---',
    '',
  ].join('\n');
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(tmp, filePath);
  } catch (err) {
    if (err?.code !== 'EEXIST' && !existsSync(filePath)) throw err;
  }
}

async function appendSessionTurnTranscript({
  threadId,
  role,
  content,
  source = 'unknown',
  toolName = null,
  summary = null,
}) {
  const filePath = sessionTranscriptPath({ threadId, source });
  let priorTurns = 0;
  try {
    if (existsSync(filePath)) {
      priorTurns = [...readFileSync(filePath, 'utf8').matchAll(/^\*\*(user|assistant|system|tool):\*\*/gmi)].length;
    }
  } catch {}
  await ensureSessionTranscriptFile({ filePath, threadId, source, title: summary });
  const body = role === 'tool' && toolName
    ? `tool: ${toolName}\n\n${content}`
    : String(content);
  const block = `\n**${role}:** ${body}\n`;
  await appendFile(filePath, block, { encoding: 'utf8', mode: 0o600 });
  const selfHash = createHash('sha256').update(block).digest('hex');
  return { path: filePath, prevHash: null, selfHash, name: basename(filePath), transcript: true, turnSeq: priorTurns + 1 };
}

function appendSessionMemoryEvent({
  threadId,
  eventType,
  actor,
  source,
  payload,
  idempotencyKey,
}) {
  return appendMemoryEvent(db, {
    streamType: 'session',
    streamId: threadId,
    eventType,
    actor,
    source: `session-log:${source || 'unknown'}`,
    subjectType: 'session',
    subjectId: threadId,
    idempotencyKey,
    payload,
    links: [{ targetType: 'session', targetId: threadId, role: 'source' }],
  });
}

function queueTranscriptAppend(work) {
  const result = transcriptAppendQueue.then(work);
  transcriptAppendQueue = result.catch(() => {});
  return result;
}

function parseTranscriptFrontmatter(raw) {
  if (!raw.startsWith('---\n')) return { fields: {}, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { fields: {}, body: raw };
  const block = raw.slice(4, end).trim();
  const fields = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2].trim().replace(/^"|"$/g, '').replace(/\\"/g, '"');
  }
  return { fields, body: raw.slice(end + 5).trim() };
}

function parseTranscriptTurns(raw, filePath) {
  const { fields, body } = parseTranscriptFrontmatter(raw);
  const turns = [];
  const re = /^\*\*(user|assistant|system|tool):\*\*\s*/gmi;
  const matches = [...body.matchAll(re)];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const next = matches[i + 1];
    const role = match[1].toLowerCase();
    const start = match.index + match[0].length;
    const end = next ? next.index : body.length;
    let turnContent = body.slice(start, end).trim();
    let toolName = null;
    if (role === 'tool') {
      const toolMatch = turnContent.match(/^tool:\s*([^\n]+)\n+/i);
      if (toolMatch) {
        toolName = toolMatch[1].trim();
      }
    }
    if (!turnContent) continue;
    turns.push({
      role,
      content: turnContent,
      timestamp: fields.date || null,
      source: fields.source || null,
      toolName,
      path: filePath,
    });
  }
  return { fields, turns };
}

function listSessionTranscriptFiles() {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(path);
    }
  };
  walk(sessionTranscriptsDir());
  return out;
}

function filesForThread(threadId) {
  const slug = safeSegment(threadId, 'thread');
  return listSessionTranscriptFiles().filter((path) => basename(path).includes(slug));
}

/**
 * Log a single chat turn (a user prompt, or an assistant response, or a
 * tool invocation + result).
 *
 * @param {object} opts
 * @param {string} opts.threadId   conversation grouping key
 * @param {'user'|'assistant'|'tool'|'system'} opts.role
 * @param {string} opts.content    raw text. For tool calls, JSON-stringify the args/result.
 * @param {string} [opts.source]   'robotdojo' | 'claude-code' | 'codex' | 'cursor' | ...
 * @param {string} [opts.toolName] when role=tool, the tool's identifier
 * @param {string} [opts.summary]  one-line for index; auto-truncated from content if missing
 * @param {string} [opts.author]   default 'chat'
 */
export async function logTurn({
  threadId, role, content,
  source = 'robotdojo', toolName = null, summary = null, author = 'chat',
}) {
  if (!threadId) throw new Error('logTurn: threadId is required');
  if (!role) throw new Error('logTurn: role is required');
  if (content === undefined || content === null) throw new Error('logTurn: content is required');

  const result = await queueTranscriptAppend(() => appendSessionTurnTranscript({
    threadId,
    role,
    content,
    source,
    toolName,
    summary,
    author,
  }));
  appendSessionMemoryEvent({
    threadId,
    eventType: `session.turn.${role}`,
    actor: role,
    source,
    idempotencyKey: `session-turn:${threadId}:${source}:${result.turnSeq}:${role}:${result.selfHash}`,
    payload: {
      role,
      source,
      author,
      tool_name: toolName,
      summary,
      transcript_path: result.path,
      transcript_hash: result.selfHash,
      turn_seq: result.turnSeq,
      content_hash: createHash('sha256').update(String(content || '')).digest('hex'),
      content_chars: String(content || '').length,
    },
  });
  return result;
}

/**
 * Log an end-of-session bookmark — the "where we left off" entry that lets
 * the next session pick up with full context.
 *
 * @param {object} opts
 * @param {string} opts.threadId
 * @param {string} opts.summary     1-3 sentences on what happened this session
 * @param {string[]} [opts.decisions] bullet list of decisions made
 * @param {string[]} [opts.nextSteps] bullet list of what to tackle next session
 * @param {string[]} [opts.openQuestions]
 * @param {string} [opts.source]    default 'robotdojo'
 * @param {string} [opts.author]    default 'miyagi'
 */
export async function logBookmark({
  threadId, summary,
  decisions = [], nextSteps = [], openQuestions = [],
  source = 'robotdojo', author = 'miyagi',
}) {
  if (!threadId) throw new Error('logBookmark: threadId is required');
  if (!summary) throw new Error('logBookmark: summary is required');

  const parts = [`## Summary`, '', summary.trim(), ''];
  if (decisions.length) {
    parts.push('## Decisions', '', ...decisions.map((d) => `- ${d}`), '');
  }
  if (nextSteps.length) {
    parts.push('## Next Steps', '', ...nextSteps.map((s) => `- ${s}`), '');
  }
  if (openQuestions.length) {
    parts.push('## Open Questions', '', ...openQuestions.map((q) => `- ${q}`), '');
  }

  const body = parts.join('\n').trim();
  const description = truncate(stripMarkdown(summary), 140);

  const result = await appendSessionMemory('bookmark', {
    type: 'session-bookmark',
    name: nameFor(`bookmark-${source}`),
    description,
    author,
    body,
    threadId,
    source,
  });
  appendSessionMemoryEvent({
    threadId,
    eventType: 'session.bookmark',
    actor: author,
    source,
    idempotencyKey: `session-bookmark:${threadId}:${source}:${result.selfHash || result.name}`,
    payload: {
      summary_hash: createHash('sha256').update(summary.trim()).digest('hex'),
      decisions_count: decisions.length,
      next_steps_count: nextSteps.length,
      open_questions_count: openQuestions.length,
      memory_path: result.path,
      memory_name: result.name,
    },
  });
  return result;
}

/**
 * Reconstruct a full thread in chronological (oldest-first) order.
 * @returns {Promise<Array<{ role, content, timestamp, source, toolName?, path }>>}
 */
export async function getThread(threadId) {
  if (!threadId) return [];
  const out = [];
  for (const filePath of filesForThread(threadId)) {
    const parsed = parseTranscriptTurns(readFileSync(filePath, 'utf8'), filePath);
    out.push(...parsed.turns);
  }
  return out;
}

/**
 * Return the N most recent threads with their bookmark (if any) + turn count.
 * Used by the context-router to pull in prior-session context.
 */
export async function recentThreads(n = 10) {
  const byThread = new Map();
  for (const filePath of listSessionTranscriptFiles()) {
    const raw = readFileSync(filePath, 'utf8');
    const { fields, turns } = parseTranscriptTurns(raw, filePath);
    const threadId = (fields.id || '').replace(/^session-/, '') || basename(filePath).replace(/\.md$/i, '');
    const stat = statSync(filePath);
    byThread.set(threadId, {
      threadId,
      source: fields.source || null,
      turns: turns.length,
      bookmark: null,
      lastTimestamp: stat.mtime.toISOString(),
    });
  }

  try {
    const index = await getLogIndex();
    for (const e of index) {
      if (!e.threadId || e.type !== 'session-bookmark') continue;
      const bucket = byThread.get(e.threadId) || {
        threadId: e.threadId,
        source: e.source,
        turns: 0,
        bookmark: null,
        lastTimestamp: null,
      };
      if (!bucket.bookmark) bucket.bookmark = e;
      if (!bucket.lastTimestamp || (e.timestamp || '') > bucket.lastTimestamp) {
        bucket.lastTimestamp = e.timestamp;
      }
      byThread.set(e.threadId, bucket);
    }
  } catch { /* unhealthy memory chain must not break context routing */ }

  const threads = [...byThread.values()];
  threads.sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));
  return threads.slice(0, n);
}

/**
 * Return the most recent bookmark across all threads from a given source.
 * Useful for "what were we working on in my last Claude Code session?".
 */
export async function latestBookmark(source = null) {
  try {
    const index = await getLogIndex();
    return index.find((e) =>
      e.type === 'session-bookmark' && (!source || e.source === source),
    ) || null;
  } catch {
    return null;
  }
}

function stripMarkdown(s) {
  return String(s)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}
