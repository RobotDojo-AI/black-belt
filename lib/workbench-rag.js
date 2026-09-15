import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readTextPrefix, scanWorkbenchRoot } from './workbench-files.js';
import { getWorkbench, upsertWorkbenchItems } from './workbenches.js';
import { splitLogSessions } from './workbench-log.js';

export function primaryTopicForWorkbench(workbench) {
  const primaryTopic = workbench.attachments?.find(a => a.target_type === 'topic' && a.role === 'primary')
    || workbench.attachments?.find(a => a.target_type === 'topic');
  return primaryTopic?.target_id || 'general';
}

export function chunkMetadata(workbench, item, options = {}) {
  const primaryAttachment = workbench.attachments?.find(a => a.role === 'primary') || workbench.attachments?.[0] || {};
  return {
    workbench_id: workbench.id,
    attachment_type: primaryAttachment.target_type || '',
    attachment_id: primaryAttachment.target_id || '',
    attachment_role: primaryAttachment.role || '',
    kind: item.kind,
    promotion_status: item.status === 'promoted' ? 'promoted' : 'unpromoted',
    content_hash: item.content_hash,
    path: item.path,
    updated_at: new Date().toISOString(),
    ...options.metadata,
  };
}

export function buildWorkbenchChunks(workbench, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const items = options.items || workbench.items || scanWorkbenchRoot(workbench.root_path, { repoRoot });
  const topic = primaryTopicForWorkbench(workbench);
  const chunks = [];
  for (const item of items) {
    let content = item.content || '';
    if (!content && existsSync(resolve(repoRoot, item.path))) {
      try { content = readTextPrefix(resolve(repoRoot, item.path)); } catch { content = ''; }
    }
    if (!content.trim()) continue;
    const isLog = item.kind === 'log' || /(?:^|\/)LOG\.md$/i.test(String(item.path || ''));
    if (isLog) {
      const sessions = splitLogSessions(content).filter((session) => session.body);
      sessions.forEach((session, i) => {
        const body = String(session.body || '').slice(0, 4999);
        if (!body.trim()) return;
        chunks.push({
          topic,
          source_type: 'workbench',
          source_id: `${workbench.id}:${item.id}:s${i + 1}`,
          chunk_index: i,
          content: body,
          metadata: { ...chunkMetadata(workbench, item), session_date: session.date || '' },
          token_count: Math.ceil(body.length / 4),
          embedded: 0,
          skip_embed: options.skipEmbed ? 1 : 0,
        });
      });
      continue;
    }
    chunks.push({
      topic,
      source_type: 'workbench',
      source_id: `${workbench.id}:${item.id}`,
      chunk_index: 0,
      content,
      metadata: chunkMetadata(workbench, item),
      token_count: Math.ceil(content.length / 4),
      embedded: 0,
      skip_embed: options.skipEmbed ? 1 : 0,
    });
  }
  return chunks;
}

export function indexWorkbench(db, idOrSlug, options = {}) {
  const workbench = typeof idOrSlug === 'object' ? idOrSlug : getWorkbench(db, idOrSlug);
  if (!workbench) throw new Error(`workbench not found: ${idOrSlug}`);
  const repoRoot = options.repoRoot || REPO_ROOT;
  const scanned = scanWorkbenchRoot(workbench.root_path, { repoRoot });
  const rootPrefix = `${workbench.root_path.replace(/\/+$/, '')}/`;
  const linkedExisting = (workbench.items || []).filter(item => item.path && !item.path.startsWith(rootPrefix));
  const itemByPath = new Map();
  for (const item of linkedExisting) itemByPath.set(item.path, item);
  for (const item of scanned) itemByPath.set(item.path, item);
  const items = [...itemByPath.values()];
  const chunks = buildWorkbenchChunks({ ...workbench, items }, { ...options, repoRoot });

  if (options.dryRun || !db) {
    return { dry_run: true, workbench_id: workbench.id, chunks, items };
  }

  const tx = db.transaction(() => {
    if (scanned.length) upsertWorkbenchItems(db, workbench.id, scanned);
    const sourceIds = chunks.map(chunk => chunk.source_id);
    if (sourceIds.length) {
      const placeholders = sourceIds.map(() => '?').join(',');
      db.prepare(`
        DELETE FROM chunks
        WHERE source_type = 'workbench'
          AND source_id LIKE ?
          AND source_id NOT IN (${placeholders})
      `).run(`${workbench.id}:%`, ...sourceIds);
    } else {
      db.prepare(`
        DELETE FROM chunks
        WHERE source_type = 'workbench'
          AND source_id LIKE ?
      `).run(`${workbench.id}:%`);
    }
    const insert = db.prepare(`
      INSERT INTO chunks
        (topic, source_type, source_id, chunk_index, content, metadata, token_count, embedded, skip_embed, created_at)
      VALUES
        (@topic, @source_type, @source_id, @chunk_index, @content, @metadata, @token_count, @embedded, @skip_embed, datetime('now'))
      ON CONFLICT(topic, source_type, source_id, chunk_index) DO UPDATE SET
        content=excluded.content,
        metadata=excluded.metadata,
        token_count=excluded.token_count,
        embedded=CASE WHEN chunks.content IS excluded.content AND chunks.skip_embed IS excluded.skip_embed THEN chunks.embedded ELSE 0 END,
        skip_embed=excluded.skip_embed,
        content_hash=CASE WHEN chunks.content IS excluded.content AND chunks.skip_embed IS excluded.skip_embed THEN chunks.content_hash ELSE NULL END,
        embedding_model_id=CASE WHEN chunks.content IS excluded.content AND chunks.skip_embed IS excluded.skip_embed THEN chunks.embedding_model_id ELSE NULL END,
        embedding_dim=CASE WHEN chunks.content IS excluded.content AND chunks.skip_embed IS excluded.skip_embed THEN chunks.embedding_dim ELSE NULL END,
        embedding_signature=CASE WHEN chunks.content IS excluded.content AND chunks.skip_embed IS excluded.skip_embed THEN chunks.embedding_signature ELSE NULL END,
        embedded_at=CASE WHEN chunks.content IS excluded.content AND chunks.skip_embed IS excluded.skip_embed THEN chunks.embedded_at ELSE NULL END
    `);
    for (const chunk of chunks) {
      insert.run({ ...chunk, metadata: JSON.stringify(chunk.metadata) });
    }
  });
  tx();

  // st_d142f701 AC13: kick off the embed worker so workbench chunks get
  // vectors without a manual second step. Canonical non-blocking child-
  // process spawn (build-conventions.md): detached + stdio:'ignore' + unref().
  // The embed worker is idempotent — it processes any chunks with
  // embedded=0 AND skip_embed=0, then exits.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = resolve(here, '..', 'scripts', 'chunk-embed-worker.js');
    if (existsSync(scriptPath)) {
      const child = spawn(process.execPath, [scriptPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
  } catch (err) {
    console.warn(`[workbench-rag] embed worker spawn failed: ${err.message}`);
  }

  return { dry_run: false, workbench_id: workbench.id, chunks: chunks.length, items: items.length };
}

export function loadChunkContent(path, repoRoot = REPO_ROOT) {
  const abs = resolve(repoRoot, path);
  if (!existsSync(abs)) return '';
  return readFileSync(abs, 'utf8');
}
