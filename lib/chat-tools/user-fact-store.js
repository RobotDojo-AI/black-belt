import { randomUUID } from 'node:crypto';
import db, { computeInsertValueRank } from '../db.js';
import { embedChunkNow } from '../rag/embed.js';

const RECENT_FACT_RECALL_LIMIT = 200;
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'this', 'that',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'do', 'does', 'did', 'can', 'could', 'would', 'will', 'should',
  'i', 'me', 'my', 'you', 'your', 'we', 'our', 'us',
  'to', 'of', 'in', 'on', 'for', 'with', 'about', 'as', 'at', 'by',
  'ask', 'asked', 'tell', 'told', 'remember', 'remembered', 'memory',
  'exact', 'exactly', 'fact', 'phrase', 'word', 'only', 'answer',
  'just', 'latest', 'last', 'recent', 'recently',
]);

function nowIsoSeconds() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function tokenEstimate(text) {
  return Math.max(1, Math.ceil(String(text || '').trim().length / 4));
}

function cleanStoredFactForDisplay(value) {
  return String(value || '')
    .trim()
    .replace(/^this\s+exact(?:ly)?\s*:\s*/i, '')
    .trim();
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{1,}/g)
    ?.filter(token => !STOPWORDS.has(token))
    || [];
}

export async function storeUserFact({
  content,
  topic,
  metadata = {},
  sourceIdPrefix = 'user-fact',
} = {}) {
  const fact = String(content || '').trim();
  if (!fact) {
    return { ok: false, error: 'fact_empty' };
  }

  const sourceId = `${sourceIdPrefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const createdAt = nowIsoSeconds();
  const contentRank = 0;
  const valueRank = computeInsertValueRank(createdAt, fact, contentRank);

  let info;
  try {
    info = db.prepare(`
      INSERT INTO chunks (
        topic, source_type, source_id, chunk_index, content, metadata,
        token_count, embedded, skip_embed, created_at, event_time,
        content_rank, value_rank
      )
      VALUES (?, 'user-fact', ?, 0, ?, ?, ?, 0, 0, ?, ?, ?, ?)
    `).run(
      topic,
      sourceId,
      fact,
      JSON.stringify(metadata || {}),
      tokenEstimate(fact),
      createdAt,
      createdAt,
      contentRank,
      valueRank,
    );
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }

  const chunkId = Number(info.lastInsertRowid);
  const embedding = await embedChunkNow(chunkId, { includeAmbientShard: true });
  return {
    ok: true,
    chunk_id: chunkId,
    source_id: sourceId,
    fact,
    topic,
    searchable: embedding.ok === true,
    embedding,
  };
}

export function findSavedFactForRecall(query, {
  limit = RECENT_FACT_RECALL_LIMIT,
} = {}) {
  const queryTokens = new Set(tokenize(query));
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, topic, content, created_at
      FROM chunks
      WHERE source_type = 'user-fact'
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  if (!rows.length) return { ok: false, error: 'no_saved_facts' };

  const scored = rows.map((row, index) => {
    const fact = cleanStoredFactForDisplay(row.content);
    const contentTokens = new Set(tokenize(fact));
    let overlap = 0;
    for (const token of queryTokens) {
      if (contentTokens.has(token)) overlap += 1;
    }
    return {
      ...row,
      fact,
      overlap,
      index,
      token_count: contentTokens.size,
    };
  }).filter(row => row.fact);

  if (!scored.length) return { ok: false, error: 'no_saved_facts' };
  scored.sort((a, b) => (b.overlap - a.overlap) || (b.id - a.id));
  const top = scored[0];

  const hasSpecificQuerySignal = queryTokens.size >= 2;
  const asksLatest = /\b(just|last|latest|recent(?:ly)?)\b/i.test(String(query || ''));
  if (hasSpecificQuerySignal && top.overlap < 2) {
    return { ok: false, error: 'no_matching_saved_fact' };
  }
  if (!hasSpecificQuerySignal && !asksLatest) {
    return { ok: false, error: 'ambiguous_saved_fact_query' };
  }

  return {
    ok: true,
    chunk_id: top.id,
    topic: top.topic,
    fact: top.fact,
    overlap: top.overlap,
    matched_tokens: top.overlap,
  };
}
