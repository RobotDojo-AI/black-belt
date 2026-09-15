/**
 * Coding-agent topic idle close.
 *
 * /topic sessions (type: work + open-payload) get the same 30-minute resume
 * write as web/mobile if the owner leaves without /close.
 *
 * Software builds (type: story | defect) do not. Hours away is normal;
 * nothing is compacted to the topic log until an explicit pipeline /close.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PIPELINE_STORIES_DIR } from './robotdojo-paths.js';
import { persistWorkSessionClose } from './topic-session.js';
import { getTopicLiveConfig } from './topic-live-thread.js';

export const INTELLIGENCE_TIER = 'extraction';

export function isSoftwareBuildRecord(meta) {
  const type = String(meta?.type || '');
  return type === 'story' || type === 'defect';
}

export function isTopicWorkRecord(meta, dir) {
  if (String(meta?.type || '') !== 'work') return false;
  if (isSoftwareBuildRecord(meta)) return false;
  return existsSync(join(dir, 'open-payload.json'));
}

export function readMeta(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function touchTopicWorkActivity(dir, now = new Date()) {
  if (!dir || !existsSync(dir)) return false;
  writeFileSync(join(dir, 'last-activity'), now.toISOString(), 'utf8');
  return true;
}

function fileMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function lastActivityStampMs(dir) {
  const path = join(dir, 'last-activity');
  try {
    const parsed = Date.parse(readFileSync(path, 'utf8').trim());
    if (Number.isFinite(parsed)) return parsed;
  } catch { /* missing or unreadable */ }
  return fileMs(path);
}

export function lastTopicWorkActivityMs(dir, meta = null) {
  const stamped = lastActivityStampMs(dir);
  if (stamped) return stamped;
  const row = meta || readMeta(dir);
  return Math.max(
    fileMs(join(dir, 'open-payload.json')),
    fileMs(join(dir, '00-scope.md')),
    Date.parse(row?.updated_at || '') || 0,
  );
}

export function listInProgressTopicWork(storiesDir = PIPELINE_STORIES_DIR) {
  if (!storiesDir || !existsSync(storiesDir)) return [];
  const out = [];
  for (const name of readdirSync(storiesDir)) {
    const dir = join(storiesDir, name);
    const meta = readMeta(dir);
    if (!meta) continue;
    if (!['in-progress', 'active'].includes(String(meta.kanban || ''))) continue;
    if (!isTopicWorkRecord(meta, dir)) continue;
    out.push({ id: name, dir, meta });
  }
  return out;
}

export function closeCodingTopicWork(dir, meta = null) {
  const row = meta || readMeta(dir);
  if (!row || !isTopicWorkRecord(row, dir)) {
    return { ok: false, reason: 'not_topic_work' };
  }
  const persisted = persistWorkSessionClose(dir);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next = {
    ...row,
    kanban: 'done',
    stage: 'idle-close',
    closed_at: now,
    updated_at: now,
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(next, null, 2), 'utf8');
  return { ok: true, persisted: Boolean(persisted?.ok), reason: persisted?.reason || 'closed' };
}

export function closeIdleCodingTopicSessions({
  storiesDir = PIPELINE_STORIES_DIR,
  now = Date.now(),
  idleMs = Number(getTopicLiveConfig().sessionIdleMs) || 30 * 60 * 1000,
} = {}) {
  let closed = 0;
  let skippedBuild = 0;
  for (const name of existsSync(storiesDir) ? readdirSync(storiesDir) : []) {
    const dir = join(storiesDir, name);
    const meta = readMeta(dir);
    if (!meta) continue;
    if (!['in-progress', 'active'].includes(String(meta.kanban || ''))) continue;
    if (isSoftwareBuildRecord(meta)) {
      skippedBuild += 1;
      continue;
    }
    if (!isTopicWorkRecord(meta, dir)) continue;
    const last = lastTopicWorkActivityMs(dir, meta);
    if (!last || (now - last) < idleMs) continue;
    const result = closeCodingTopicWork(dir, meta);
    if (result.ok) closed += 1;
  }
  return { ok: true, closed, skippedBuild };
}

export function touchActiveTopicWorkFromEnv({
  storiesDir = PIPELINE_STORIES_DIR,
  workId = process.env.ROBOTDOJO_ACTIVE_STORY_ID,
} = {}) {
  const id = String(workId || '').trim();
  if (id) {
    const dir = join(storiesDir, id);
    const meta = readMeta(dir);
    if (meta && isTopicWorkRecord(meta, dir)) return touchTopicWorkActivity(dir);
    return false;
  }
  const open = listInProgressTopicWork(storiesDir);
  if (open.length !== 1) return false;
  return touchTopicWorkActivity(open[0].dir);
}
