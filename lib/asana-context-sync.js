/**
 * Asana context sync.
 *
 * Reads the user's Asana tasks/projects and writes deterministic RAG chunks.
 * This is user memory context, separate from lib/asana.js which only creates
 * internal build-board notification tasks.
 */

import crypto from 'node:crypto';
import db from './db.js';
import { secret } from './config.js';
import { insertTimelineEventForDb } from './timeline-schema.js';

const ASANA_BASE = 'https://app.asana.com/api/1.0';

function normalizeAsanaProvider(provider = 'asana') {
  return provider === 'asana_secondary' ? 'asana_secondary' : 'asana';
}

function stableTaskId(task, provider = 'asana') {
  const gid = String(task.gid || task.permalink_url || task.name || crypto.randomUUID());
  return `${normalizeAsanaProvider(provider)}:${crypto.createHash('sha256').update(gid).digest('hex').slice(0, 24)}`;
}

function renderTask(task) {
  const fields = [
    `Task: ${task.name || 'Untitled'}`,
    task.completed ? 'Status: completed' : 'Status: open',
    task.due_on ? `Due: ${task.due_on}` : null,
    task.workspace?.name ? `Workspace: ${task.workspace.name}` : null,
    Array.isArray(task.projects) && task.projects.length ? `Projects: ${task.projects.map((p) => p.name).filter(Boolean).join(', ')}` : null,
    task.notes ? `Notes: ${task.notes}` : null,
    task.permalink_url ? `URL: ${task.permalink_url}` : null,
  ].filter(Boolean);
  return fields.join('\n');
}

async function asanaGet(path, token, fetchImpl = fetch) {
  const res = await fetchImpl(`${ASANA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Asana ${res.status}: ${body?.errors?.[0]?.message || res.statusText}`);
  return body.data;
}

export async function fetchAsanaTasks({ token = secret('ASANA_PAT'), workspaceGid = null, limit = 100, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('ASANA_PAT not configured');
  let workspace = workspaceGid;
  if (!workspace) {
    const me = await asanaGet('/users/me', token, fetchImpl);
    workspace = me?.workspaces?.[0]?.gid;
  }
  if (!workspace) throw new Error('No Asana workspace found for token');

  const params = new URLSearchParams({
    workspace,
    assignee: 'me',
    completed_since: 'now',
    limit: String(Math.min(Math.max(Number(limit) || 100, 1), 100)),
    opt_fields: 'gid,name,notes,completed,due_on,permalink_url,workspace.name,projects.name,modified_at,created_at',
  });
  return asanaGet(`/tasks?${params.toString()}`, token, fetchImpl);
}

function taskMetadata(task, provider) {
  return JSON.stringify({
    provider: normalizeAsanaProvider(provider),
    account_label: normalizeAsanaProvider(provider) === 'asana_secondary' ? 'Secondary' : 'Primary',
    gid: task.gid,
    url: task.permalink_url || null,
    completed: !!task.completed,
    due_on: task.due_on || null,
    created_at: task.created_at || null,
    modified_at: task.modified_at || null,
    workspace: task.workspace?.name || null,
    projects: Array.isArray(task.projects) ? task.projects.map((p) => p.name).filter(Boolean) : [],
  });
}

function taskSummaryFromContent(content) {
  const taskLine = String(content || '').split(/\r?\n/).find((line) => /^Task:\s*/i.test(line));
  return (taskLine || 'Asana task').replace(/^Task:\s*/i, '').trim() || 'Asana task';
}

function recordAsanaTimeline(database, task, sourceId, content, metadataJson) {
  let metadata = {};
  try { metadata = JSON.parse(metadataJson || '{}') || {}; } catch {}
  const eventDate = task.modified_at || task.created_at || task.due_on || new Date().toISOString();
  try {
    insertTimelineEventForDb(database, {
      sourceType: 'asana',
      sourceId,
      eventDate,
      eventType: task.completed ? 'task_completed' : 'task',
      summary: taskSummaryFromContent(content),
      content,
      metadata: {
        ...metadata,
        completed: !!task.completed,
        due_on: task.due_on || null,
      },
    });
  } catch {
    // Minimal test DBs may omit timeline_events; Asana RAG sync must still land.
  }
}

function migrateLegacyAsanaChunk(database, task, provider, content, metadata) {
  const normalizedProvider = normalizeAsanaProvider(provider);
  if (normalizedProvider === 'asana') return;

  const legacySourceId = stableTaskId(task, 'asana');
  const sourceId = stableTaskId(task, normalizedProvider);
  const legacy = database.prepare(`
    SELECT id, content, metadata
      FROM chunks
     WHERE source_type='asana'
       AND source_id=?
       AND chunk_index=0
  `).get(legacySourceId);
  if (!legacy) return;

  const existingTarget = database.prepare(`
    SELECT id FROM chunks
     WHERE source_type='asana'
       AND source_id=?
       AND chunk_index=0
  `).get(sourceId);

  if (!existingTarget) {
    database.prepare(`
      UPDATE chunks
         SET source_id = ?,
             content = ?,
             metadata = ?,
             embedded = CASE WHEN content IS ? THEN embedded ELSE 0 END,
             content_hash = CASE WHEN content IS ? THEN content_hash ELSE NULL END,
             embedding_model_id = CASE WHEN content IS ? THEN embedding_model_id ELSE NULL END,
             embedding_dim = CASE WHEN content IS ? THEN embedding_dim ELSE NULL END,
             embedding_signature = CASE WHEN content IS ? THEN embedding_signature ELSE NULL END,
             embedded_at = CASE WHEN content IS ? THEN embedded_at ELSE NULL END,
             skip_embed = 0
       WHERE id = ?
    `).run(sourceId, content, metadata, content, content, content, content, content, content, legacy.id);
    return;
  }

  let legacyMetadata = {};
  try { legacyMetadata = JSON.parse(legacy.metadata || '{}') || {}; } catch { legacyMetadata = {}; }
  database.prepare(`
    UPDATE chunks
       SET metadata = ?,
           skip_embed = 1
     WHERE id = ?
  `).run(JSON.stringify({
    ...legacyMetadata,
    provider: 'asana_migrated',
    migrated_to: sourceId,
    migrated_provider: normalizedProvider,
  }), legacy.id);
}

export async function syncAsanaContext({ token = secret('ASANA_PAT'), workspaceGid = null, limit = 100, fetchImpl = fetch, database = db, provider = 'asana' } = {}) {
  const normalizedProvider = normalizeAsanaProvider(provider);
  const tasks = await fetchAsanaTasks({ token, workspaceGid, limit, fetchImpl });
  const upsert = database.prepare(`
    INSERT INTO chunks (topic, source_type, source_id, chunk_index, content, metadata, embedded, skip_embed)
    VALUES ('work', 'asana', ?, 0, ?, ?, 0, 0)
    ON CONFLICT(topic, source_type, source_id, chunk_index) DO UPDATE SET
      content = excluded.content,
      metadata = excluded.metadata,
      embedded = CASE
        WHEN chunks.content IS excluded.content
        THEN chunks.embedded
        ELSE 0
      END,
      content_hash = CASE WHEN chunks.content IS excluded.content THEN chunks.content_hash ELSE NULL END,
      embedding_model_id = CASE WHEN chunks.content IS excluded.content THEN chunks.embedding_model_id ELSE NULL END,
      embedding_dim = CASE WHEN chunks.content IS excluded.content THEN chunks.embedding_dim ELSE NULL END,
      embedding_signature = CASE WHEN chunks.content IS excluded.content THEN chunks.embedding_signature ELSE NULL END,
      embedded_at = CASE WHEN chunks.content IS excluded.content THEN chunks.embedded_at ELSE NULL END,
      skip_embed = 0
    WHERE chunks.content IS NOT excluded.content
       OR chunks.metadata IS NOT excluded.metadata
       OR chunks.skip_embed IS NOT 0
  `);
  const tx = database.transaction((rows) => {
    for (const task of rows) {
      const sourceId = stableTaskId(task, normalizedProvider);
      const content = renderTask(task);
      const metadata = taskMetadata(task, normalizedProvider);
      migrateLegacyAsanaChunk(database, task, normalizedProvider, content, metadata);
      upsert.run(
        sourceId,
        content,
        metadata,
      );
      recordAsanaTimeline(database, task, sourceId, content, metadata);
    }
  });
  tx(tasks);
  return { ok: true, imported: tasks.length };
}
