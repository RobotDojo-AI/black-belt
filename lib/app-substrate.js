/**
 * Apps on the substrate.
 *
 * Ingest writes timeline facts in the same pass as any structured store.
 * Reasoned intelligence (Decision / Why / Next) writes the topic log.
 * Charts and insights are views. Apps do not fork a second memory.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { insertTimelineEventForDb } from './timeline-schema.js';
import { REPO_ROOT } from './robotdojo-paths.js';
import { primaryWorkbenchForTarget } from './workbenches.js';

export const APP_SUBSTRATE_CONTRACT = Object.freeze({
  order: Object.freeze(['ingest', 'timeline', 'log', 'views']),
  rule: 'The app layer specializes; it does not fork the intelligence system.',
});

function hasTable(database, name) {
  if (!database?.prepare) return false;
  try {
    return !!database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(name);
  } catch {
    return false;
  }
}

function clip(text, max = 1200) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
}

export function extractMarkdownSection(text, heading) {
  const re = new RegExp(`(?:^|\\n)##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i');
  const match = String(text || '').match(re);
  return match ? match[1].trim() : '';
}

export function recordAppTimelineFact(database, event = {}) {
  if (!hasTable(database, 'timeline_events')) return null;
  const sourceType = String(event.sourceType || '').trim();
  const sourceId = String(event.sourceId || '').trim();
  const eventDate = String(event.eventDate || '').trim();
  if (!sourceType || !sourceId || !eventDate) return null;
  const metadata = { ...(event.metadata || {}) };
  if (event.topic && !metadata.topic) metadata.topic = String(event.topic);
  if (event.app && !metadata.app) metadata.app = String(event.app);
  return insertTimelineEventForDb(database, {
    sourceType,
    sourceId,
    eventDate,
    eventType: event.eventType || sourceType,
    summary: event.summary || '',
    content: event.content || event.summary || '',
    metadata,
  });
}

function topicLogPath(database, topic) {
  if (!hasTable(database, 'workbenches')) return null;
  let wb;
  try {
    wb = primaryWorkbenchForTarget(database, 'topic', topic);
  } catch {
    return null;
  }
  if (!wb?.root_path) return null;
  return resolve(REPO_ROOT, wb.root_path, 'LOG.md');
}

export function appendTopicLogSession({
  database,
  topic,
  date,
  title,
  decision,
  why = '',
  citations = '',
  next = '',
  marker = '',
  logPath = null,
} = {}) {
  const slug = String(topic || '').trim();
  const body = String(decision || '').trim();
  if (!slug || !body) return null;
  const abs = logPath ? resolve(logPath) : topicLogPath(database, slug);
  if (!abs) return null;
  const stamp = String(date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const hash = createHash('sha256')
    .update(`${slug}|${stamp}|${title || ''}|${body}|${why}|${next}`)
    .digest('hex')
    .slice(0, 16);
  const token = `${String(marker || `app-log:${slug}`)}:${hash}`;
  mkdirSync(dirname(abs), { recursive: true });
  if (existsSync(abs)) {
    try {
      if (readFileSync(abs, 'utf8').includes(token)) return { skipped: true, path: abs, marker: token };
    } catch {
      /* write anyway */
    }
  } else {
    appendFileSync(
      abs,
      `# ${slug} Log\n\nAppend-only operational memory for sessions, events, decisions captured in the moment, and source additions.\n`,
      'utf8',
    );
  }
  const lines = [
    '',
    `## Work session ${stamp}`,
    '',
    `# ${String(title || slug).trim()}`,
    '',
    '## Decision',
    '',
    clip(body, 1600),
    '',
  ];
  if (why) lines.push('## Why', '', clip(why, 1600), '');
  lines.push('## Citations', '', citations ? String(citations).trim() : '', `- [${token}]`, '');
  if (next) lines.push('## Next-session anchors', '', clip(next, 800), '');
  const block = lines.join('\n');
  appendFileSync(abs, block.endsWith('\n') ? block : `${block}\n`, 'utf8');
  return { skipped: false, path: abs, marker: token };
}
