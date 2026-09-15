import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import db from './db.js';
import { USER_WORKBENCHES_DIR } from './robotdojo-paths.js';
import { createUserTimelineFact } from './user-timeline-facts.js';
import { HEALTH_TOPIC_SLUG } from './health-timeline.js';

const HEALTH_HISTORY_SOURCE = 'owner_attested_health_history';
const HEALTH_HISTORY_QUALITY = 'tier_1_owner_attested';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function clip(text, max = 240) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
}

function sha(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
}

function deriveEventDate({ period = '', content = '', fallback = todayIso() } = {}) {
  const text = `${period}\n${content}`;
  const full = text.match(/\b(19|20)\d{2}-\d{2}-\d{2}\b/);
  if (full) return full[0];
  const year = text.match(/\b(19|20)\d{2}\b/);
  if (year) return `${year[0]}-01-01`;
  return fallback;
}

function normalizeIsoDate(value, label, { optional = false } = {}) {
  const clean = String(value || '').trim();
  if (!clean) {
    if (optional) return '';
    throw new Error(`${label} is required`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  const date = new Date(`${clean}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== clean) {
    throw new Error(`${label} is invalid`);
  }
  return clean;
}

function buildPeriod({ period = '', startDate = '', endDate = '' } = {}) {
  const cleanPeriod = String(period || '').trim();
  if (startDate) return `${startDate} to ${endDate || 'ongoing'}`;
  return cleanPeriod;
}

function healthHistoryPath() {
  return resolve(USER_WORKBENCHES_DIR, 'topics/personal/health/wk_health/substrate/owner-attested-history.md');
}

function appendOwnerAttestedHistoryFile(entry) {
  const path = healthHistoryPath();
  mkdirSync(dirname(path), { recursive: true });
  const lines = [
    '',
    `## ${entry.createdAt}`,
    '',
    `Source quality: ${HEALTH_HISTORY_QUALITY}`,
    `Health note id: ${entry.noteId}`,
    `Timeline event id: ${entry.timelineEventId}`,
    `Event date: ${entry.eventDate}`,
    entry.startDate ? `Start date: ${entry.startDate}` : null,
    entry.startDate ? (entry.endDate ? `End date: ${entry.endDate}` : 'End date: ongoing') : null,
    entry.period ? `Period: ${entry.period}` : null,
    entry.title ? `Title: ${entry.title}` : null,
    '',
    'Raw owner-attested text:',
    '',
    '```text',
    entry.content,
    '```',
    '',
  ].filter(line => line != null);
  appendFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

function insertHistoryNoteStmt(database) {
  return database.prepare(`
    INSERT INTO health_notes (date, content, tags, source, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
}

export function createOwnerAttestedHealthHistory({
  database = db,
  content,
  period = '',
  startDate = '',
  endDate = '',
  title = '',
  writeWorkbench = true,
} = {}) {
  const cleaned = String(content || '').trim();
  if (cleaned.length < 10) {
    throw new Error('History text is too short');
  }
  if (cleaned.length > 50_000) {
    throw new Error('History text is too long; split it into smaller entries');
  }

  const cleanStartDate = normalizeIsoDate(startDate, 'Start date', { optional: true });
  const cleanEndDate = normalizeIsoDate(endDate, 'End date', { optional: true });
  if (cleanEndDate && cleanStartDate && cleanEndDate < cleanStartDate) {
    throw new Error('End date must be after the start date');
  }
  const cleanPeriod = buildPeriod({ period, startDate: cleanStartDate, endDate: cleanEndDate });
  const cleanTitle = String(title || firstLine(cleaned) || 'Owner-attested health history').trim().slice(0, 160);
  const eventDate = cleanStartDate || deriveEventDate({ period: cleanPeriod, content: cleaned });
  const sourceHash = sha(`${eventDate}|${cleanPeriod}|${cleanStartDate}|${cleanEndDate}|${cleanTitle}|${cleaned}`).slice(0, 24);
  const tags = ['health_history', 'owner_attested', HEALTH_HISTORY_QUALITY];
  const metadata = {
    source_quality: HEALTH_HISTORY_QUALITY,
    provenance: 'user',
    title: cleanTitle,
    period: cleanPeriod || null,
    start_date: cleanStartDate || null,
    end_date: cleanEndDate || null,
    is_ongoing: Boolean(cleanStartDate && !cleanEndDate),
    content_excerpt: clip(cleaned, 1800),
  };

  const noteResult = insertHistoryNoteStmt(database).run(
    eventDate,
    cleaned,
    JSON.stringify(tags),
    HEALTH_HISTORY_SOURCE,
  );
  const noteId = Number(noteResult.lastInsertRowid);
  const sourceId = `${HEALTH_HISTORY_SOURCE}:${noteId}:${sourceHash}`;
  const fact = createUserTimelineFact({
    database,
    topic: HEALTH_TOPIC_SLUG,
    eventDate,
    content: cleaned,
    title: cleanTitle,
    startDate: cleanStartDate,
    endDate: cleanEndDate,
    appendLog: writeWorkbench,
    metadata: {
      ...metadata,
      note_id: noteId,
      source_id: sourceId,
      tags,
      source_quality: HEALTH_HISTORY_QUALITY,
    },
  });

  const entry = {
    noteId,
    timelineEventId: fact.timelineEventId,
    sourceId: fact.sourceId,
    eventDate,
    title: cleanTitle,
    period: cleanPeriod,
    startDate: cleanStartDate,
    endDate: cleanEndDate,
    isOngoing: Boolean(cleanStartDate && !cleanEndDate),
    content: cleaned,
    sourceQuality: HEALTH_HISTORY_QUALITY,
    createdAt: new Date().toISOString(),
    workbenchPath: null,
  };
  if (writeWorkbench) entry.workbenchPath = appendOwnerAttestedHistoryFile(entry);
  return entry;
}

export { HEALTH_HISTORY_SOURCE, HEALTH_HISTORY_QUALITY };
