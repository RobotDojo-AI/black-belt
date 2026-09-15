/**
 * User-supplied timeline facts. Distinct from imported events.
 * source_type = 'user' on every topic. Also appends the fact to that
 * topic's workbench LOG.md so Recap and chat read the same source.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import db from './db.js';
import { insertTimelineEventForDb } from './timeline-schema.js';
import { REPO_ROOT } from './robotdojo-paths.js';
import { primaryWorkbenchForTarget } from './workbenches.js';

export const USER_FACT_SOURCE = 'user';
export const USER_FACT_TYPE = 'user_fact';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function clip(text, max = 1800) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
}

function normalizeIsoDate(value, { optional = false } = {}) {
  const clean = String(value || '').trim();
  if (!clean) {
    if (optional) return todayIso();
    throw new Error('Date is required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) throw new Error('Date must be YYYY-MM-DD');
  const date = new Date(`${clean}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== clean) {
    throw new Error('Date is invalid');
  }
  return clean;
}

function topicSlug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'uncategorized';
}

export function timelineOrigin(row) {
  const source = String(row?.source_type || '');
  const type = String(row?.event_type || '');
  if (source === USER_FACT_SOURCE) return 'user';
  if (type.includes('owner_attested')) return 'user';
  return 'import';
}

function shouldAppendLog(appendLog) {
  if (appendLog === true) return true;
  if (appendLog === false) return false;
  return !process.env.NODE_TEST_CONTEXT;
}

function appendFactToTopicLog({
  database,
  topic,
  eventDate,
  title,
  content,
  sourceId,
}) {
  if (!database?.prepare) return null;
  const wb = primaryWorkbenchForTarget(database, 'topic', topic);
  if (!wb?.root_path) return null;
  const abs = resolve(REPO_ROOT, wb.root_path, 'LOG.md');
  mkdirSync(dirname(abs), { recursive: true });
  if (!existsSync(abs)) {
    appendFileSync(abs, `# ${topic} Log\n\nAppend-only operational memory for sessions, events, decisions captured in the moment, and source additions.\n`, 'utf8');
  }
  const block = [
    '',
    `## Work session ${eventDate}`,
    '',
    `# ${title}`,
    '',
    '## Decision',
    '',
    content,
    '',
    '## Citations',
    '',
    `- [user] attested fact (${sourceId})`,
    '',
  ].join('\n');
  appendFileSync(abs, block.endsWith('\n') ? block : `${block}\n`, 'utf8');
  return abs;
}

export function createUserTimelineFact({
  database = db,
  topic = 'uncategorized',
  eventDate,
  content,
  title = '',
  startDate = '',
  endDate = '',
  metadata = {},
  appendLog,
} = {}) {
  const cleaned = String(content || '').trim();
  if (cleaned.length < 10) throw new Error('Fact text is too short');
  if (cleaned.length > 50_000) throw new Error('Fact text is too long; split it into smaller entries');
  const date = normalizeIsoDate(eventDate || startDate, { optional: true });
  const slug = topicSlug(topic);
  const cleanTitle = String(title || firstLine(cleaned) || 'User fact').trim().slice(0, 160);
  const hash = createHash('sha256').update(`${slug}|${date}|${cleaned}`).digest('hex').slice(0, 24);
  const sourceId = `${USER_FACT_SOURCE}:${slug}:${hash}`;
  const timeline = insertTimelineEventForDb(database, {
    sourceType: USER_FACT_SOURCE,
    sourceId,
    eventDate: date,
    eventType: USER_FACT_TYPE,
    summary: cleanTitle,
    content: cleaned,
    metadata: {
      provenance: 'user',
      topic: slug,
      title: cleanTitle,
      content_excerpt: clip(cleaned),
      start_date: startDate || date,
      end_date: endDate || null,
      ...metadata,
    },
  });
  let logPath = null;
  if (shouldAppendLog(appendLog) && timeline.inserted) {
    try {
      logPath = appendFactToTopicLog({
        database,
        topic: slug,
        eventDate: date,
        title: cleanTitle,
        content: cleaned,
        sourceId,
      });
    } catch {
      logPath = null;
    }
  }
  return {
    timelineEventId: timeline.id,
    sourceId,
    eventDate: date,
    topic: slug,
    title: cleanTitle,
    content: cleaned,
    origin: 'user',
    inserted: timeline.inserted,
    logPath,
  };
}
