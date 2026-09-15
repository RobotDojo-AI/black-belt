/**
 * Move existing email chunks, timeline events, and entity links onto
 * domain-routed topics. One path for Integrations picker + owner domains.
 */
import { contentHash, embeddingSignature, EMBED_DIM, EMBED_MODEL } from './rag.js';
import {
  deleteVecRowForTopic,
  openSplitVectorStore,
  readVecRowForTopic,
  upsertVecRowForTopic,
} from './split-vector-store.js';

function deserializeEmbedding(buf) {
  if (!buf || !(buf instanceof Buffer || buf instanceof Uint8Array)) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
import { topicForSourceAccount, loadSourceTopicRoutingConfig } from './topic-source-routing.js';
import { PERSONAL_TOPIC } from './topic-routing-policy.js';
import { linkChunkToEntity } from './entity-source-evidence.js';
import { insertTimelineEventForDb, linkGenericEntityToEvent } from './timeline-schema.js';
import { ensureDefaultEntityWorkbench } from './workbenches.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { REPO_ROOT } from './robotdojo-paths.js';
import { revealMappedWorkTopics, seedAccountTopicsFromDomains } from './account-topic.js';

function hasTable(db, name) {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  catch { return false; }
}

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function emailIdFromSource(sourceId) {
  return String(sourceId || '').replace(/^email:/, '');
}

function fetchVector(db, embeddingsDb, chunkId, topicSlug) {
  const row = readVecRowForTopic(topicSlug, chunkId, {
    database: db,
    embeddingsDb,
    requireReadable: true,
  });
  return row?.embedding ? deserializeEmbedding(row.embedding) : null;
}

function moveChunk(db, embeddingsDb, { id, fromTopic, toTopic, vec }) {
  const chunkMeta = db.prepare('SELECT content, content_hash, source_type, source_id, chunk_index FROM chunks WHERE id = ?').get(id);
  if (!chunkMeta) return { moved: 0, deduped: 0 };
  const conflict = db.prepare(`
    SELECT id FROM chunks
     WHERE topic = ? AND source_type = ? AND source_id = ? AND chunk_index = ? AND id != ?
     LIMIT 1
  `).get(toTopic, chunkMeta.source_type, chunkMeta.source_id, chunkMeta.chunk_index, id);
  if (conflict) {
    deleteVecRowForTopic(fromTopic, String(id), { database: db, embeddingsDb });
    db.prepare('DELETE FROM chunks WHERE id = ?').run(id);
    return { moved: 0, deduped: 1 };
  }
  if (vec && embeddingsDb) {
    const buf = Buffer.from(vec.buffer);
    try { upsertVecRowForTopic(toTopic, String(id), buf, { database: db, embeddingsDb, dim: EMBED_DIM }); } catch { /* daemon re-embeds */ }
  }
  if (embeddingsDb) {
    try { deleteVecRowForTopic(fromTopic, String(id), { database: db, embeddingsDb }); } catch { /* old vec is stale */ }
  }
  const hash = chunkMeta.content_hash || contentHash(chunkMeta.content || '');
  const signature = hash
    ? embeddingSignature({ content_hash: hash, topic: toTopic, modelId: EMBED_MODEL, dim: EMBED_DIM })
    : null;
  db.prepare(`
    UPDATE chunks
       SET topic = ?,
           embedding_model_id = ?,
           embedding_dim = ?,
           embedding_signature = ?,
           embedded = CASE WHEN ? IS NOT NULL THEN 1 ELSE embedded END,
           content_hash = COALESCE(content_hash, ?)
     WHERE id = ?
  `).run(toTopic, EMBED_MODEL, EMBED_DIM, signature, vec ? 1 : null, hash, id);
  return { moved: 1, deduped: 0 };
}

function resolveCompanyId(db, topicSlug, config) {
  const name = config.companies?.[topicSlug];
  if (!name || !hasTable(db, 'companies')) return null;
  const exact = db.prepare(`
    SELECT id FROM companies
     WHERE lower(name) = lower(?)
       AND COALESCE(archived, 0) = 0
     ORDER BY COALESCE(people_count, 0) DESC, COALESCE(entity_rank, 0) DESC
     LIMIT 1
  `).get(name);
  if (exact) return String(exact.id);
  const fuzzy = db.prepare(`
    SELECT id FROM companies
     WHERE lower(name) LIKE lower(?)
       AND COALESCE(archived, 0) = 0
     ORDER BY COALESCE(people_count, 0) DESC, COALESCE(entity_rank, 0) DESC
     LIMIT 1
  `).get(name);
  return fuzzy ? String(fuzzy.id) : null;
}

function appendEntityLog(db, companyId, topicSlug, count) {
  if (!count) return;
  const wb = ensureDefaultEntityWorkbench(db, 'company', companyId, { repoRoot: REPO_ROOT });
  if (!wb?.root_path) return;
  const abs = resolve(REPO_ROOT, wb.root_path, 'LOG.md');
  mkdirSync(dirname(abs), { recursive: true });
  if (!existsSync(abs)) {
    appendFileSync(abs, `# ${topicSlug} entity log\n\nAppend-only operational memory.\n`, 'utf8');
  }
  const date = new Date().toISOString().slice(0, 10);
  const marker = `source mail on ${topicSlug}`;
  try {
    if (existsSync(abs) && readFileSync(abs, 'utf8').includes(marker)) return;
  } catch {
    /* append anyway */
  }
  appendFileSync(abs, [
    '',
    `## Work session ${date}`,
    '',
    `# ${topicSlug} source mail`,
    '',
    '## Decision',
    '',
    `${count} emails from this domain now sit on this entity timeline.`,
    '',
    '## Citations',
    '',
    `- ${count} email chunks linked (${marker})`,
    '',
  ].join('\n'), 'utf8');
}

export function bulkMigrateEmailTopics(db) {
  const config = loadSourceTopicRoutingConfig();
  const revealed = revealMappedWorkTopics(db);
  const seeded = seedAccountTopicsFromDomains(db);
  const skip = new Set([PERSONAL_TOPIC, 'robot-dojo', 'acme', 'school']);
  const movedBy = {};
  let moved = 0;
  const updById = db.prepare(`
    UPDATE chunks
       SET topic = ?, embedded = 0
     WHERE source_type = 'email'
       AND topic != ?
       AND source_id IN (SELECT id FROM emails WHERE lower(sender_email) LIKE ?)
  `);
  const updByPrefixed = db.prepare(`
    UPDATE chunks
       SET topic = ?, embedded = 0
     WHERE source_type = 'email'
       AND topic != ?
       AND source_id IN (SELECT 'email:' || id FROM emails WHERE lower(sender_email) LIKE ?)
  `);
  const tx = db.transaction(() => {
    for (const [domain, slug] of Object.entries(config.domains || {})) {
      if (!slug || skip.has(slug)) continue;
      const patterns = domain.includes('.') ? [`%@${domain}`, `%.${domain}`] : [`%.${domain}`];
      let n = 0;
      for (const like of patterns) {
        n += updById.run(slug, slug, like.toLowerCase()).changes;
        n += updByPrefixed.run(slug, slug, like.toLowerCase()).changes;
      }
      if (n) {
        moved += n;
        movedBy[slug] = (movedBy[slug] || 0) + n;
        const companyId = resolveCompanyId(db, slug, config);
        if (companyId) {
          db.prepare(`
            INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, entity_type)
            SELECT id, ?, 'company' FROM chunks WHERE topic = ? AND source_type = 'email'
          `).run(companyId, slug);
        }
      }
    }
  });
  tx();
  for (const [slug, count] of Object.entries(movedBy)) {
    try {
      const companyId = resolveCompanyId(db, slug, config);
      if (companyId) appendEntityLog(db, companyId, slug, count);
    } catch { /* */ }
  }
  return { ok: true, moved, by_topic: movedBy, revealed: revealed.revealed, seeded: seeded.updated, mode: 'bulk' };
}

export function migrateSourceTopics(db, { limit = 400, embeddingsDb = null, skipVec = false } = {}) {
  const config = loadSourceTopicRoutingConfig();
  const revealed = revealMappedWorkTopics(db);
  const seeded = seedAccountTopicsFromDomains(db);
  if (!hasTable(db, 'chunks') || !hasTable(db, 'emails')) {
    return { ok: true, moved: 0, linked: 0, revealed: revealed.revealed, seeded: seeded.updated };
  }
  if (!skipVec && !embeddingsDb) {
    try { embeddingsDb = openSplitVectorStore({ busyTimeoutMs: 5000 }); }
    catch { embeddingsDb = null; }
  }
  if (skipVec) embeddingsDb = null;

  const hasAccountTopic = hasColumn(db, 'accounts', 'topic_slug');
  const domainRows = collectRoutableEmailChunks(db, config, hasAccountTopic, limit);
  const embeddings = embeddingsDb;
  let moved = 0;
  let deduped = 0;
  const linkedByTopic = new Map();
  for (const row of domainRows) {
    const target = topicForSourceAccount({
      senderEmail: row.senderEmail,
      accountEmail: row.accountEmail,
      accountTopic: row.accountTopic,
    }, config);
    if (!target || target === row.topic || target === PERSONAL_TOPIC) continue;
    let vec = null;
    if (row.embedded && embeddings) {
      try { vec = fetchVector(db, embeddings, row.id, row.topic); } catch { vec = null; }
    }
    let result = { moved: 0, deduped: 0 };
    try {
      result = moveChunk(db, embeddings, {
        id: row.id,
        fromTopic: row.topic,
        toTopic: target,
        vec,
      });
    } catch {
      continue;
    }
    moved += result.moved;
    deduped += result.deduped;
    if (!result.moved) continue;
    linkedByTopic.set(target, (linkedByTopic.get(target) || 0) + 1);
    try {
      const companyId = resolveCompanyId(db, target, config);
      if (companyId) {
        linkChunkToEntity(db, row.id, companyId, 'company');
        const event = insertTimelineEventForDb(db, {
          sourceType: 'email',
          sourceId: emailIdFromSource(row.source_id),
          eventDate: row.receivedAt || new Date().toISOString().slice(0, 10),
          eventType: 'email',
          summary: String(row.subject || row.senderEmail || 'Email').slice(0, 180),
          content: row.senderEmail || '',
          metadata: { topic: target, account_id: row.accountId || null },
        });
        if (event?.id) linkGenericEntityToEvent(event.id, 'company', companyId, 'source');
      }
    } catch {
      /* chunk already moved */
    }
  }

  for (const [slug, count] of linkedByTopic) {
    try {
      const companyId = resolveCompanyId(db, slug, config);
      if (companyId) appendEntityLog(db, companyId, slug, count);
    } catch {
      /* log write is best-effort */
    }
  }

  return {
    ok: true,
    moved,
    deduped,
    linked: [...linkedByTopic.values()].reduce((n, x) => n + x, 0),
    by_topic: Object.fromEntries(linkedByTopic),
    revealed: revealed.revealed,
    seeded: seeded.updated,
  };
}

function collectRoutableEmailChunks(db, config, hasAccountTopic, limit) {
  const cap = Math.max(1, Math.min(Number(limit) || 400, 2000));
  const topicSelect = hasAccountTopic ? ', a.topic_slug AS accountTopic' : '';
  const sql = `
    SELECT c.id, c.topic, c.embedded, c.source_id,
           e.sender_email AS senderEmail,
           e.received_at AS receivedAt,
           e.subject AS subject,
           e.account_id AS accountId,
           a.email AS accountEmail
           ${topicSelect}
      FROM emails e
      JOIN chunks c ON c.source_type = 'email'
       AND (c.source_id = e.id OR c.source_id = 'email:' || e.id)
      LEFT JOIN accounts a ON a.id = e.account_id
     WHERE lower(e.sender_email) LIKE ?
       AND c.topic != ?
     ORDER BY e.received_at DESC
     LIMIT ?
  `;
  const stmt = db.prepare(sql);
  const seen = new Set();
  const out = [];
  const push = (row) => {
    if (!row || seen.has(row.id) || out.length >= cap) return;
    seen.add(row.id);
    out.push(row);
  };
  const skip = new Set([PERSONAL_TOPIC, 'robot-dojo', 'acme', 'school']);
  for (const [domain, slug] of Object.entries(config.domains || {})) {
    if (out.length >= cap) break;
    if (!slug || skip.has(slug)) continue;
    const patterns = domain.includes('.')
      ? [`%@${domain}`, `%.${domain}`]
      : [`%.${domain}`];
    for (const like of patterns) {
      for (const row of stmt.all(like.toLowerCase(), slug, cap - out.length)) push(row);
    }
  }
  if (hasAccountTopic && out.length < cap) {
    const mailboxRows = db.prepare(`
      SELECT c.id, c.topic, c.embedded, c.source_id,
             e.sender_email AS senderEmail,
             e.received_at AS receivedAt,
             e.subject AS subject,
             e.account_id AS accountId,
             a.email AS accountEmail,
             a.topic_slug AS accountTopic
        FROM emails e
        JOIN chunks c ON c.source_type = 'email'
         AND (c.source_id = e.id OR c.source_id = 'email:' || e.id)
        JOIN accounts a ON a.id = e.account_id
       WHERE a.topic_slug IS NOT NULL
         AND a.topic_slug != ''
         AND c.topic != a.topic_slug
       ORDER BY e.received_at DESC
       LIMIT ?
    `).all(cap - out.length);
    for (const row of mailboxRows) push(row);
  }
  return out;
}
