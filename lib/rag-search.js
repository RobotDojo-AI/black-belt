/**
 * Hybrid search — vector similarity + FTS5 full-text search.
 * Queries existing chunk_vec_{topic} tables (sqlite-vec) and chunks_fts (FTS5).
 * Graceful degradation: vector fails → FTS. FTS fails → empty results.
 *
 * st_566ad80b — searchAll now consults the in-process usearch HNSW
 * adapter first (annSearch) and falls back to sqlite-vec when the
 * adapter returns null (topic not loaded) or hot+full both miss.
 */
import { readFileSync } from 'node:fs';
import db, { openEmbeddingsDb } from './db.js';
import * as sqliteVec from 'sqlite-vec';
import { safeEmbed, isCircuitOpen } from './rag.js';
import {
  annSearch,
  ensureGlobalIndexAvailableForRetrieval,
  getGlobalDiskStatus,
  getGlobalStatus,
  loadGlobalIndex,
  maybeRefreshGlobalIndex,
} from './ann/usearch-adapter.js';
// Local Snowflake vectors are normalized to the ANN dimensionality before
// any global HNSW search so they match the index's HNSW_DIMS.
import { normalizeForHnsw } from './ann/matryoshka.js';
import { ANN_INLINE_REPAIR_MAX_CHUNKS } from './ann/ann-config.js';

// Load sqlite-vec extension once at import time
sqliteVec.load(db);

// st_1cfe9061 — open embeddings.db lazily; degrade gracefully to db if absent.
let embeddingsDb = null;
try { embeddingsDb = openEmbeddingsDb(); } catch { /* embeddings.db absent — degrade to FTS */ }

// st_1cfe9061 — positive-only cache for migrated topics (false is never cached
// since a topic may be mid-migration when first queried).
const migratedTopicCache = new Map();
function isMigrated(topic) {
  if (migratedTopicCache.has(topic)) return true; // positive-only cache
  if (!embeddingsDb) return false;
  try {
    const row = db.prepare('SELECT 1 FROM topic_vec_migrations WHERE topic = ?').get(topic);
    if (row) {
      migratedTopicCache.set(topic, true);
      return true;
    }
    return false; // do NOT cache false
  } catch {
    return false;
  }
}

// The ambient breadth scope. resolveTopicScope() (lib/chat-context.js) returns
// ['general'] for a first-turn conversation with no conversation_topics rows.
// It is NOT a real chunks.topic — no chunk is tagged 'general'; it names the
// cross-topic `chunk_vec_general` breadth shard. searchAll treats a scope of
// exactly this token as "unscoped/ambient": the global HNSW pass runs
// unfiltered (the index already spans all topics) and the sqlite-vec fallback,
// if the index is cold, reads ONLY this one shard table. Env-overridable per
// build conventions (no hardcoded tunable in lib/).
const AMBIENT_TOPIC = process.env.ROBOTDOJO_AMBIENT_TOPIC || 'general';
const ANN_LOAD_RETRY_MS = Number(process.env.ROBOTDOJO_ANN_LOAD_RETRY_MS || 30_000);
const FTS_FAST_SCORE = (() => {
  const raw = Number(process.env.ROBOTDOJO_FTS_FAST_SCORE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.95;
})();
const RAG_SEARCH_DEFAULTS = (() => {
  try {
    const raw = readFileSync(new URL('../config/defaults.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.ragSearch && typeof parsed.ragSearch === 'object' ? parsed.ragSearch : {};
  } catch {
    return {};
  }
})();
const FRESH_VECTOR_OVERLAY_K = (() => {
  const raw = Number(process.env.ROBOTDOJO_FRESH_VECTOR_OVERLAY_K);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  const cfg = Number(RAG_SEARCH_DEFAULTS.freshVectorOverlayK);
  return Number.isFinite(cfg) && cfg > 0 ? Math.floor(cfg) : 96;
})();
const FRESH_VECTOR_OVERLAY_GRACE_MS = (() => {
  const raw = Number(process.env.ROBOTDOJO_FRESH_VECTOR_OVERLAY_GRACE_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  const cfg = Number(RAG_SEARCH_DEFAULTS.freshVectorOverlayGraceMs);
  return Number.isFinite(cfg) && cfg >= 0 ? Math.floor(cfg) : 2_000;
})();
let lastAnnLoadAttemptAt = 0;
let lastAnnLoadAttemptMarker = null;

function annDiskMarker(status, disk) {
  return [
    status?.built_at ?? 'unloaded',
    status?.stale_on_disk === true ? 'stale' : 'not-stale',
    disk?.sidecar ? 1 : 0,
    disk?.hot ? 1 : 0,
    disk?.full ? 1 : 0,
    disk?.compatible ? 1 : 0,
    disk?.built_at ?? 0,
    disk?.built_from_count ?? 0,
    disk?.full_size ?? 0,
  ].join(':');
}

async function ensureGlobalAnnLoaded(onTiming = null) {
  const status = getGlobalStatus();
  if (status && !status.stale_on_disk) return true;
  const disk = getGlobalDiskStatus();
  const marker = annDiskMarker(status, disk);
  const now = Date.now();
  if (marker === lastAnnLoadAttemptMarker && now - lastAnnLoadAttemptAt < ANN_LOAD_RETRY_MS) return false;
  lastAnnLoadAttemptAt = now;
  lastAnnLoadAttemptMarker = marker;
  const repairStarted = Date.now();
  try {
    const loaded = await ensureGlobalIndexAvailableForRetrieval(db, {
      synchronousMaxChunks: ANN_INLINE_REPAIR_MAX_CHUNKS,
      reason: 'chat-retrieval',
    });
    if (typeof onTiming === 'function') {
      const mode = loaded?.repair?.mode || (loaded?.loaded ? 'none' : 'unavailable');
      const phase = mode === 'inline'
        ? 'rag.ann_repair_inline'
        : mode === 'queued'
          ? 'rag.ann_repair_queued'
          : mode === 'deferred'
            ? 'rag.ann_repair_deferred'
            : mode === 'locked'
              ? 'rag.ann_repair_locked'
              : mode === 'unavailable'
                ? 'rag.ann_unavailable'
                : 'rag.ann_load';
      try { onTiming(phase, repairStarted); } catch {}
    }
    if (loaded?.loaded) {
      lastAnnLoadAttemptMarker = null;
      return true;
    }
    return false;
  } catch (err) {
    console.warn('[search] global ann load attempt failed:', err.message);
    return false;
  }
}

function requestGlobalAnnRepairForFallback(onTiming = null) {
  const status = getGlobalStatus();
  if (status && !status.stale_on_disk) return;

  const started = Date.now();
  try {
    const result = maybeRefreshGlobalIndex(db);
    if (typeof onTiming !== 'function') return;

    const reason = String(result?.reason || '');
    let phase = null;
    if (reason.includes('foreground_active')) phase = 'rag.ann_repair_deferred';
    else if (reason.includes('locked')) phase = 'rag.ann_repair_locked';
    else if (result?.spawned) phase = 'rag.ann_repair_queued';
    else if (reason.includes('artifact_missing')) phase = 'rag.ann_unavailable';

    if (phase) {
      try { onTiming(phase, started); } catch {}
    }
  } catch (err) {
    console.warn('[search] global ann repair request failed:', err.message);
  }
}

// --- Prepared statements (reused across searches) ---
const stmts = {
  chunkById: db.prepare('SELECT * FROM chunks WHERE id = ?'),
  allTopics: db.prepare('SELECT DISTINCT topic FROM chunks WHERE embedded = 1'),
};

function hasVectorTable(database, tableName) {
  try {
    return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  } catch {
    return false;
  }
}

function vectorStoresForTopic(topic, tableName = safeTableName(topic)) {
  const stores = [];
  const add = (database, name) => {
    if (!database || stores.some((store) => store.database === database)) return;
    if (hasVectorTable(database, tableName)) stores.push({ database, name, tableName });
  };

  if (isMigrated(topic)) {
    add(embeddingsDb, 'embeddings');
    add(db, 'legacy');
  } else {
    add(db, 'legacy');
    add(embeddingsDb, 'embeddings');
  }

  return stores;
}

function sqlDateTimeFromMs(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

const freshOverlayExists = db.prepare(`
  SELECT 1
  FROM chunks
  WHERE embedded = 1
    AND source_type = 'user-fact'
    AND embedded_at >= ?
  LIMIT 1
`);

function freshOverlaySince(status) {
  const builtAt = Number(status?.built_at || status?.disk_built_at || getGlobalDiskStatus()?.built_at || 0);
  if (!Number.isFinite(builtAt) || builtAt <= 0) return null;
  const sinceMs = Math.max(0, builtAt - FRESH_VECTOR_OVERLAY_GRACE_MS);
  const sinceSql = sqlDateTimeFromMs(sinceMs);
  try {
    if (!freshOverlayExists.get(sinceSql)) return null;
  } catch {
    return null;
  }
  return { sinceMs, sinceSql };
}

function freshOverlayChunks(sinceSql) {
  try {
    return db.prepare(`
      SELECT id, topic
      FROM chunks
      WHERE embedded = 1
        AND source_type = 'user-fact'
        AND embedded_at >= ?
        AND topic IS NOT NULL
      ORDER BY id DESC
      LIMIT ?
    `).all(sinceSql, FRESH_VECTOR_OVERLAY_K).filter(r => r?.id && r?.topic);
  } catch {
    return [];
  }
}

function cosineDistanceFromBuffer(queryVec, buf) {
  if (!(queryVec instanceof Float32Array)) return null;
  if (!buf || !(buf instanceof Buffer || buf instanceof Uint8Array)) return null;
  const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const len = Math.min(queryVec.length, vec.length);
  if (len <= 0) return null;
  let dot = 0;
  let qNorm = 0;
  let vNorm = 0;
  for (let i = 0; i < len; i++) {
    const q = queryVec[i];
    const v = vec[i];
    dot += q * v;
    qNorm += q * q;
    vNorm += v * v;
  }
  if (qNorm <= 0 || vNorm <= 0) return null;
  const cosine = dot / Math.sqrt(qNorm * vNorm);
  return 1 - Math.max(-1, Math.min(1, cosine));
}

function searchFreshVectorOverlay(queryVec, {
  sinceSql,
}) {
  const rows = [];
  const seen = new Set();
  for (const chunk of freshOverlayChunks(sinceSql)) {
    if (rows.length >= FRESH_VECTOR_OVERLAY_K) break;
    const chunkId = Number(chunk.id);
    if (!Number.isSafeInteger(chunkId) || seen.has(chunkId)) continue;

    const candidates = [
      ...vectorStoresForTopic(chunk.topic, safeTableName(chunk.topic)),
      ...vectorStoresForTopic(AMBIENT_TOPIC, safeTableName(AMBIENT_TOPIC)),
    ];
    const stores = [];
    for (const store of candidates) {
      if (!store?.database || stores.some((seenStore) =>
        seenStore.database === store.database && seenStore.tableName === store.tableName
      )) continue;
      stores.push(store);
    }

    for (const store of stores) {
      if (rows.length >= FRESH_VECTOR_OVERLAY_K) break;
      let vecRow;
      try {
        vecRow = store.database.prepare(`
          SELECT embedding
          FROM ${store.tableName}
          WHERE chunk_id = ?
        `).get(String(chunkId));
      } catch (err) {
        console.error(`[search] Fresh vector overlay failed for topic ${chunk.topic} in ${store.name}:`, err.message);
        continue;
      }
      const distance = cosineDistanceFromBuffer(queryVec, vecRow?.embedding);
      if (distance == null) continue;
      seen.add(chunkId);
      rows.push({ chunk_id: chunkId, distance, fresh_user_fact: true });
      break;
    }
  }
  return rows.sort((a, b) => a.distance - b.distance).slice(0, FRESH_VECTOR_OVERLAY_K);
}

/**
 * Hybrid search — combines vector and FTS results.
 * @param {string} query - Search query text
 * @param {object} options - { topic, limit, threshold, mode }
 * @returns {Promise<Array>} Ranked search results
 */
export async function search(query, { topic = null, limit = 10, threshold = 0.3, mode = 'hybrid' } = {}) {
  if (mode === 'fts') return searchFTS(query, { topic, limit });
  if (mode === 'vector') {
    if (!topic) throw new Error('Vector search requires a topic');
    return searchVector(query, topic, limit);
  }

  // Hybrid: try vector + FTS, merge results
  const vectorResults = topic && !isCircuitOpen()
    ? await searchVector(query, topic, limit).catch(err => {
        console.error('[search] Vector search failed, falling back to FTS:', err.message);
        return [];
      })
    : [];

  const ftsResults = searchFTS(query, { topic, limit });

  if (!vectorResults.length) return ftsResults.slice(0, limit);
  if (!ftsResults.length) return vectorResults.slice(0, limit);

  return mergeResults(vectorResults, ftsResults, limit);
}

/**
 * Vector search against chunk_vec_{topic} using sqlite-vec MATCH.
 * @param {string} query - Query text (will be embedded)
 * @param {string} topic - Topic to search within
 * @param {number} limit - Max results
 * @returns {Promise<Array>} Vector search results sorted by similarity
 */
export async function searchVector(query, topic, limit = 10) {
  const tableName = safeTableName(topic);
  const stores = vectorStoresForTopic(topic, tableName);
  if (!stores.length) return [];

  const queryVec = await safeEmbed(query, { inputType: 'query' });
  if (!queryVec) return []; // circuit open or embed failed

  const queryBuf = Buffer.from(queryVec.buffer);
  const rows = [];
  for (const store of stores) {
    try {
      rows.push(...store.database.prepare(`
        SELECT chunk_id, distance
        FROM ${tableName}
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance
      `).all(queryBuf, limit * 2)); // overfetch to handle missing chunks
    } catch (err) {
      console.error(`[search] Vector search failed for topic ${topic} in ${store.name}:`, err.message);
    }
  }
  rows.sort((a, b) => a.distance - b.distance);

  const results = [];
  const seen = new Set();
  for (const row of rows) {
    if (results.length >= limit) break;
    const chunkId = Number(row.chunk_id);
    if (!Number.isSafeInteger(chunkId) || seen.has(chunkId)) continue;
    seen.add(chunkId);
    const chunk = stmts.chunkById.get(chunkId);
    if (!chunk) continue;
    if (chunk.topic !== topic || Number(chunk.embedded) !== 1) continue;
    const score = 1 - row.distance;
    results.push(formatResult(chunk, score));
  }
  return results;
}

/**
 * FTS5 full-text search on chunks_fts.
 * @param {string} query - Search query (special chars stripped)
 * @param {object} options - { topic, limit }
 * @returns {Array} FTS search results sorted by rank
 */
export function searchFTS(query, { topic = null, limit = 10 } = {}) {
  const escaped = sanitizeFtsQuery(query);
  if (!escaped) return [];

  // Warn once if FTS index is unpopulated — silent degradation is hard to diagnose
  if (!searchFTS._warnedEmpty) {
    const docCount = db.prepare('SELECT COUNT(*) as n FROM chunks_fts_docsize').get().n;
    if (docCount === 0) {
      console.warn('[search] chunks_fts is empty — FTS search degraded, keyword retrieval disabled');
      searchFTS._warnedEmpty = true;
    }
  }

  try {
    let sql = `
      SELECT c.*, rank
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.rowid
      WHERE chunks_fts MATCH ?
    `;
    const params = [escaped];

    if (topic) {
      sql += ` AND c.topic = ?`;
      params.push(topic);
    }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params).map(r => formatResult(r, normalizeRank(r.rank), 'fts'));
  } catch (err) {
    // FTS table might not exist or query might be malformed
    console.error('[search] FTS search failed:', err.message);
    return [];
  }
}

/**
 * Cross-topic search: fan out vector search across all topic tables.
 *
 * WHY topicScope (st_74f45a1a R2): the live corpus is 1.2 M chunks across
 * 39 topic vec tables. better-sqlite3 is synchronous on the main thread,
 * so a 39-table fan-out is serial — Promise.allSettled does NOT parallelize
 * sync DB queries. The fix is to scan fewer tables. layerRAG resolves the
 * scope from conversation_topics; callers that need the full corpus pass
 * topicScope=null (default, backward-compatible).
 *
 * @param {string} query - Search query text
 * @param {object} options
 * @param {number} [options.limit=10] - Max results
 * @param {number} [options.maxPerSource=3] - Per-source cap
 * @param {string[]|null} [options.topicScope=null] - When non-null and
 *   non-empty, restrict the inner loop to these topic names. Names match
 *   the `topic` column in `chunks` (post-safeTableName slug, not display).
 * @param {boolean} [options.forceSemanticSearch=false] - When true, do not
 *   let a perfect FTS hit short-circuit the ANN leg. Used by launch proof; the
 *   product chat path keeps the fast exact-match return.
 * @returns {Promise<Array>} Merged results from the scoped (or all) topics
 */
export async function searchAll(query, {
  limit = 10,
  maxPerSource = 3,
  topicScope = null,
  onTiming = null,
  forceSemanticSearch = false,
} = {}) {
  const emitTiming = (phase, started) => {
    if (typeof onTiming === 'function') {
      try { onTiming({ phase, ms: Date.now() - started }); } catch {}
    }
  };

  // st_2cd1af73 AC-1 (final layer) — ambient-scope handling. The chat path
  // resolves a first-turn conversation (no conversation_topics rows yet) to
  // topicScope=['general']: the ambient breadth shard. But NO chunk carries
  // topic='general' — the general shard is a cross-topic COPY of vectors under
  // a synthetic table. So annSearch({topicFilter:['general']}) post-filters
  // every candidate out (0 keys), annHit stays false, and the first turn of
  // EVERY new conversation drops into the sqlite-vec fallback — the exact
  // serial-decrypt block this story kills. Fix: treat the ambient-only scope
  // as "no real topic filter" and run the global index UNFILTERED. The global
  // index already holds every embedded vector, so an unfiltered top-k IS the
  // correct ambient-breadth result — the same role chunk_vec_general served,
  // now served by the HNSW fast path. A real scope (anything beyond bare
  // 'general') still post-filters normally.
  const requestedScope = Array.isArray(topicScope) && topicScope.length > 0
    ? topicScope
    : null;
  const realScope = requestedScope
    ? requestedScope.filter(t => t && t !== AMBIENT_TOPIC)
    : null;
  // topicFilter drives the HNSW post-filter AND bounds the fallback fan-out.
  // null = ambient/unscoped → unfiltered HNSW + (fallback) general shard only.
  const topicFilter = realScope && realScope.length > 0 ? realScope : null;

  // FTS supplement runs BEFORE query embedding. WHY: exact local text should not
  // wait behind the local embedding model or ANN load. If FTS finds a very strong
  // exact hit, that is enough first-turn context for this request. It is NOT
  // launch readiness proof; launch still requires the semantic/ANN data-plane
  // invariant to pass.
  const ftsStarted = Date.now();
  const ftsResults = topicFilter && topicFilter.length > 0
    ? topicFilter.flatMap(topic => searchFTS(query, { topic, limit }))
    : searchFTS(query, { limit });
  emitTiming('rag.fts_supplement', ftsStarted);
  if (!forceSemanticSearch && ftsResults[0]?.score >= FTS_FAST_SCORE) {
    requestGlobalAnnRepairForFallback(emitTiming);
    return ftsResults.slice(0, limit);
  }

  if (isCircuitOpen()) return ftsResults.slice(0, limit);

  const embedStarted = Date.now();
  const queryVec = await safeEmbed(query, { inputType: 'query' });
  emitTiming('rag.embed', embedStarted);
  if (!queryVec) return ftsResults.slice(0, limit);

  // Single global HNSW pass with a normalized 1024-dim Snowflake query.
  // Replaces the per-topic fan-out for-loop: one annSearch call against
  // the unified index serves any number of topics. Topic
  // filtering is applied inside annSearch via the in-memory chunkTopicMap.
  const queryBuf = Buffer.from(queryVec.buffer);

  const candidates = [];
  let annHit = false;
  let annLoaded = true;
  try {
    const annStarted = Date.now();
    const normalized = normalizeForHnsw(queryVec);
    let annResult = annSearch(normalized, limit, topicFilter ? { topicFilter } : undefined);
    if (annResult === null && await ensureGlobalAnnLoaded(emitTiming)) {
      annResult = annSearch(normalized, limit, topicFilter ? { topicFilter } : undefined);
    }
    // annSearch returns null ONLY when the global index is not loaded (or the
    // usearch binding is unavailable / the query dim mismatches). An empty-but-
    // non-null result means "index searched, nothing matched the filter" — a
    // real answer, not a reason to fan out across every topic table.
    if (annResult === null) {
      annLoaded = false;
    } else if (annResult.keys.length > 0) {
      for (let i = 0; i < annResult.keys.length; i++) {
        candidates.push({
          chunk_id: Number(annResult.keys[i]),
          distance: annResult.distances[i],
        });
      }
      annHit = true;
    }
    emitTiming('rag.ann', annStarted);
  } catch (err) {
    console.warn('[search] global annSearch path failed:', err.message);
    annLoaded = false;
  }

  // Fresh-vector overlay: the global ANN index is deliberately rebuilt in
  // batches, not on every single foreground fact. Rows embedded after the loaded
  // ANN sidecar are searched through a tiny sqlite-vec overlay so "remember X"
  // can be recalled on the next turn while ANN remains the primary path.
  if (annLoaded) {
    const overlay = freshOverlaySince(getGlobalStatus());
    if (overlay) {
      const overlayStarted = Date.now();
      candidates.push(...searchFreshVectorOverlay(queryVec, {
        sinceSql: overlay.sinceSql,
      }));
      emitTiming('rag.fresh_vector_overlay', overlayStarted);
    }
  }

  // Fallback: ONLY when the global index is not loaded (fresh boot before the
  // boot-warmup load lands, a build in progress, or a usearch binding failure).
  // When the index IS loaded, an empty result is authoritative and we never
  // fall through — the previous code fanned out on every miss, which re-armed
  // the serial-decrypt block on the very path the HNSW exists to retire.
  //
  // BOUNDED BY CONTRACT: the fan-out is capped to the scoped tables, never the
  // full topic set. With a real scope we read exactly those tables; with the
  // ambient/unscoped path we read ONLY the `chunk_vec_general` breadth shard.
  // A chat turn therefore never serially MATCH-scans + SQLCipher-decrypts all
  // ~39 per-topic vec tables on the request thread — the dominant TTFT term.
  if (!annHit && !annLoaded) {
    const fallbackStarted = Date.now();
    const fallbackTopics = topicFilter
      ? topicFilter
      : [AMBIENT_TOPIC];
    for (const topic of fallbackTopics) {
      const tableName = safeTableName(topic);
      for (const store of vectorStoresForTopic(topic, tableName)) {
        try {
          const rows = store.database.prepare(`
            SELECT chunk_id, distance
            FROM ${tableName}
            WHERE embedding MATCH ? AND k = ?
            ORDER BY distance
          `).all(queryBuf, limit);
          candidates.push(...rows);
        } catch (err) {
          console.error(`[search] Vector search failed for topic ${topic} in ${store.name}:`, err.message);
        }
      }
    }
    emitTiming('rag.sqlite_vec_fallback', fallbackStarted);
  }

  candidates.sort((a, b) => a.distance - b.distance);

  const hydrateStarted = Date.now();
  const results = [];
  const seen = new Set();
  const sourceCounts = {};

  for (const row of candidates) {
    if (results.length >= limit) break;
    if (seen.has(row.chunk_id)) continue;
    seen.add(row.chunk_id);

    const chunk = stmts.chunkById.get(row.chunk_id);
    if (!chunk) continue;
    if (topicFilter && !topicFilter.includes(chunk.topic) && !row.fresh_user_fact) continue;

    const sourceKey = `${chunk.source_type}:${chunk.source_id}`;
    sourceCounts[sourceKey] = (sourceCounts[sourceKey] || 0) + 1;
    if (sourceCounts[sourceKey] > maxPerSource) continue;

    results.push(formatResult(chunk, 1 - row.distance));
  }
  emitTiming('rag.hydrate', hydrateStarted);

  // FTS supplement: always merge cheap exact-keyword evidence with vector/ANN
  // evidence. WHY this matters during install/backfill: HNSW covers only the
  // embedded subset. An exact newly-ingested fact can be unembedded for a few
  // minutes; if ANN returns unrelated candidates, a zero-only FTS fallback would
  // hide the user's literal words. One indexed FTS query keeps fresh local text
  // retrievable while embeddings catch up.
  if (!results.length) return ftsResults.slice(0, limit);
  if (!ftsResults.length) return results;
  return mergeResults(results, ftsResults, limit);
}

// --- Merge vector + FTS results ---
function mergeResults(vectorResults, ftsResults, limit) {
  const merged = new Map();

  // Vector results weighted 0.7
  for (const r of vectorResults) {
    merged.set(r.id, { ...r, score: r.score * 0.7 });
  }

  // FTS results weighted 0.3, combined if overlapping. A chunk surfaced by
  // BOTH vector and FTS is re-tagged 'hybrid' (st_b50005df Phase 5): it is
  // both semantically close and an exact keyword match, so it earns the
  // strongest confidence — the gate treats it at least as leniently as a pure
  // FTS hit. FTS-only chunks keep their 'fts' tag from formatResult.
  for (const r of ftsResults) {
    if (merged.has(r.id)) {
      const existing = merged.get(r.id);
      existing.score += r.score * 0.3;
      existing.method = 'hybrid';
    } else {
      merged.set(r.id, { ...r, score: r.score * 0.3 });
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Multi-query fan-out search across all topic tables.
 * Embeds all queries in one batch, fans out per-query per-topic, keeps
 * the best (lowest) distance per chunk_id across all query × topic pairs,
 * deduplicates by source, and returns results sorted by distance.
 *
 * @param {string[]} queries - Array of search query strings
 * @param {object} options
 * @param {number} options.limit - Max results to return (default 30)
 * @param {number} options.maxPerSource - Max chunks per source (default 5)
 * @param {string[]|null} options.topicFilter - Restrict to these topics (null = all)
 * @param {Float32Array[]|null} options.precomputedVectors - Skip embedding if provided
 * @returns {Promise<Array>} Merged, deduplicated, distance-sorted results
 */
export async function searchMultiQuery(queries, {
  limit = 30,
  maxPerSource = 5,
  topicFilter = null,
  precomputedVectors = null,
} = {}) {
  if (!queries.length) return [];

  // Embed all queries in one batch (or use precomputed)
  let vectors = precomputedVectors;
  if (!vectors) {
    if (isCircuitOpen()) {
      // Circuit open: FTS fallback for all queries merged
      const merged = new Map();
      for (const q of queries) {
        const results = searchFTS(q, { limit: Math.ceil(limit / queries.length) });
        for (const r of results) {
          if (!merged.has(r.id)) merged.set(r.id, r);
        }
      }
      return [...merged.values()].slice(0, limit);
    }
    // Batch embed queries
    try {
      const { embedBatch } = await import('./rag.js');
    vectors = await embedBatch(queries, 32, null, { inputType: 'query' });
      // Record success on the shared circuit breaker
      const { recordSuccess } = await import('./rag.js');
      recordSuccess();
    } catch (err) {
      const { recordFailure } = await import('./rag.js');
      recordFailure();
      console.error('[search] Multi-query batch embed failed:', err.message);
      // FTS fallback
      const merged = new Map();
      for (const q of queries) {
        for (const r of searchFTS(q, { limit: Math.ceil(limit / queries.length) })) {
          if (!merged.has(r.id)) merged.set(r.id, r);
        }
      }
      return [...merged.values()].slice(0, limit);
    }
  }

  // Determine which topics to search
  const topics = topicFilter
    ? topicFilter
    : stmts.allTopics.all().map(r => r.topic);

  // Fan-out: for each query vector, search each topic table.
  // Keep best (lowest) distance per chunk_id across all (query, topic) pairs.
  const chunkMap = new Map(); // chunk_id → { chunk, distance }

  for (let qi = 0; qi < queries.length; qi++) {
    const queryBuf = Buffer.from(vectors[qi].buffer);
    for (const topic of topics) {
      const tableName = safeTableName(topic);
      for (const store of vectorStoresForTopic(topic, tableName)) {
        try {
          const rows = store.database.prepare(`
            SELECT chunk_id, distance
            FROM ${tableName}
            WHERE embedding MATCH ? AND k = ?
            ORDER BY distance
          `).all(queryBuf, Math.ceil(limit / Math.max(topics.length, 1)) + limit);

          for (const row of rows) {
            const chunkId = Number(row.chunk_id);
            if (!Number.isSafeInteger(chunkId)) continue;
            if (chunkMap.has(chunkId)) {
              const existing = chunkMap.get(chunkId);
              if (row.distance < existing.distance) existing.distance = row.distance;
            } else {
              const chunk = stmts.chunkById.get(chunkId);
              if (!chunk) continue;
              if (topicFilter && !topicFilter.includes(chunk.topic)) continue;
              chunkMap.set(chunkId, { chunk, distance: row.distance });
            }
          }
        } catch (err) {
          console.error(`[search] searchMultiQuery topic=${topic} store=${store.name} qi=${qi}:`, err.message);
        }
      }
    }
  }

  // Sort by best distance, apply per-source cap, build result array
  const sorted = [...chunkMap.values()].sort((a, b) => a.distance - b.distance);
  const results = [];
  const sourceCounts = {};

  for (const { chunk, distance } of sorted) {
    if (results.length >= limit) break;
    const sourceKey = `${chunk.source_type}:${chunk.source_id}`;
    sourceCounts[sourceKey] = (sourceCounts[sourceKey] || 0) + 1;
    if (sourceCounts[sourceKey] > maxPerSource) continue;
    results.push(formatResult(chunk, 1 - distance));
  }

  return results;
}

// --- Helpers ---

function safeTableName(topic) {
  return `chunk_vec_${topic.replace(/[^a-z0-9_]/g, '_')}`;
}

// WHY `method` (st_b50005df Phase 5, AC-1c): the confidence gate in
// retrieve.js was mode-blind — it multiplied every score by a recency factor
// and dropped anything under one threshold, which silently discarded an
// exact-but-OLD keyword (FTS) hit even though it is the user's literal words.
// Tagging each result with the retrieval method that produced it lets the gate
// apply a lower threshold to exact FTS matches than to fuzzy vector matches.
// Values: 'vector' (sqlite-vec / ANN similarity), 'fts' (FTS5 keyword), or
// 'hybrid' (a chunk surfaced by BOTH and score-blended in mergeResults).
// Default 'vector' so any caller that omits it inherits the strict gate —
// the safe, pre-existing behavior.
function formatResult(chunk, score, method = 'vector') {
  return {
    id: chunk.id,
    topic: chunk.topic,
    content: chunk.content,
    score,
    method,
    source_type: chunk.source_type,
    source_id: chunk.source_id,
    metadata: JSON.parse(chunk.metadata || '{}'),
    token_count: chunk.token_count,
  };
}

const FTS_QUERY_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has',
  'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'me', 'my',
  'of', 'on', 'or', 'our', 'please', 'should', 'that', 'the', 'their',
  'there', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

/**
 * Sanitize FTS5 query — strip special chars that break MATCH syntax and drop
 * non-retrieval question words before FTS5 ANDs every remaining term.
 */
function sanitizeFtsQuery(query) {
  // FTS5 bare terms are ANDed. Passing the whole question makes a word like
  // "what" veto a perfect local hit, so keep only retrieval-bearing tokens.
  const tokens = String(query || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !FTS_QUERY_STOPWORDS.has(token));
  if (!tokens.length) return null;
  return tokens.join(' ');
}

/**
 * Normalize FTS5 rank (negative, lower = better) to 0-1 score (higher = better).
 * FTS5 rank is typically in range [-25, 0] for reasonable queries.
 */
function normalizeRank(rank) {
  return Math.min(1, Math.abs(rank) / 25);
}
