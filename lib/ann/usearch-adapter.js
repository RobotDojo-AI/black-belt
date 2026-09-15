/**
 * usearch HNSW adapter — unified global index + per-topic legacy fallback.
 *
 * st_8c7b7a6b D4 (unified-HNSW) on top of st_566ad80b (per-topic two-tier).
 *
 * Primary path (global, Snowflake 1024-dim):
 *
 *   ~/.robotdojo-ann/
 *     hot.usearch       — top-N globally by quality_score (1024-dim, RAM-loaded)
 *     full.usearch      — all embedded vectors (1024-dim, view()-mapped)
 *     sidecar.json      — { built_from_count, built_at, hot_size, full_size,
 *                           quality_version, dim }
 *
 *   annSearch(queryVec, k, { topicFilter })
 *     → { keys, distances } | null
 *     One HNSW pass against the global hot index; falls back to the global
 *     full index when min distance > HOT_TIER_FALLBACK_THRESHOLD. The
 *     in-memory chunkTopicMap is used to post-filter results when
 *     topicFilter is non-null (rather than per-topic fan-out).
 *
 *   loadGlobalIndex(db) / buildGlobalIndex(db) / getGlobalStatus()
 *     Boot-warmup entry points. The first call after a deploy rebuilds the
 *     global index from chunk_vec_* tables; subsequent calls reuse it.
 *
 * Fallback path (st_566ad80b — per-topic, kept as internal rollback only):
 *
 *   ~/.robotdojo-ann/<topic-slug>/{hot,full}.usearch + sidecar.json
 *   _annSearchPerTopic(topic, queryVec, k), buildIndicesForTopic(db, topic),
 *   loadAllHotIndices(db), getTopicStatus(topic)
 *
 *   These remain exported for the rollback contract (see the st_8c7b7a6b
 *   02-design.md §Rollback in the wk_robot_dojo stories tree). lib/rag-search.js
 *   uses the global path; the per-topic path is dormant.
 *
 * The chunk_vec_* sqlite-vec tables are NEVER deleted by this story — they
 * are the data backstop. Recovery from a global-index failure restores
 * from ~/.robotdojo-ann.bak/ + reverts callers (≈5 min).
 *
 * WHY view() for the full index: the full corpus file is large.
 * Mapping lets the OS page in only the neighbors actually traversed —
 * most queries touch <1% of pages. Promoting to load() costs the full
 * footprint of RSS.
 *
 * WHY sidecar.json: an HNSW index can't tell us what data it was built
 * from. The sidecar records `built_from_count` + a quality_version tag
 * + the dim — boot warmup compares against the live corpus and rebuilds
 * when they disagree, when the dim differs from HNSW_DIMS, or when the
 * embedding model id changes.
 *
 * Failure modes:
 *
 *   - usearch native binding fails to load: annSearch returns null;
 *     callers fall back to sqlite-vec MATCH. Logged once.
 *   - Index file corrupt: load() throws → sidecar deleted → full rebuild
 *     on next loadGlobalIndex(db) pass.
 *   - DB has 0 embedded chunks: skip (no index emitted).
 *   - Process killed mid-write: partial files exist on disk; the missing or
 *     mismatched sidecar on next boot triggers a clean rebuild.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  ANN_BASE_DIR_NAME,
  USEARCH_M,
  USEARCH_EF_CONSTRUCTION,
  USEARCH_EF_SEARCH,
  HOT_TIER_LATENCY_CAP_DEFAULT,
  HOT_TIER_FALLBACK_THRESHOLD,
  TOPIC_COUNT_DEFAULT,
  ANN_INLINE_REPAIR_MAX_CHUNKS,
} from './ann-config.js';
import { computeHotTierSize } from './hot-tier-sizer.js';
import { HNSW_DIMS, normalizeForHnsw } from './matryoshka.js';
import { EMBED_MODEL } from '../rag.js';
import { openEmbeddingsDb } from '../db.js';
import { activityPauseDecision, chatAppActiveDecision, getActivitySignal } from '../request-observer.js';
import { readEmbedPauseHold } from '../embed-pause-hold.js';

// Lazy-loaded usearch — keeping the import lazy means missing/broken
// native bindings degrade to "ANN disabled" instead of crashing boot.
let _Index = null;
let _IndexLoadError = null;
async function getIndexClass() {
  if (_Index) return _Index;
  if (_IndexLoadError) return null;
  try {
    const mod = await import('usearch');
    _Index = mod.Index;
    return _Index;
  } catch (err) {
    _IndexLoadError = err;
    console.warn('[ann] usearch binding unavailable:', err.message);
    return null;
  }
}

// Current quality-score formula version. Bump when computeQualityScore
// changes (recency half-life, source-tier weights). The sidecar carries
// this tag; mismatch triggers rebuild.
export const QUALITY_VERSION = 'v1-source-tier-plus-recency-365d';

// In-process index store. Each topic has { hot, full, sidecar, dim }.
// hot is `load()`-ed (resident in RAM); full is `view()`-ed (mmap).
// dim is captured per-topic so a queryVec of the wrong size is rejected
// before usearch crashes.
const indexStore = new Map();

/**
 * Resolve the base directory for ANN persistence. Test-friendly via
 * ROBOTDOJO_ANN_DIR env var (used by tests/ann/usearch-adapter.test.js).
 */
function annBaseDir() {
  return process.env.ROBOTDOJO_ANN_DIR
    || path.join(os.homedir(), ANN_BASE_DIR_NAME);
}

function topicDir(topic) {
  // WHY slug: topic names can have dots/slashes/colons in some installs;
  // mirror the safeTableName transform in rag-search.js so we never
  // collide with filesystem chars.
  const slug = String(topic).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(annBaseDir(), slug);
}

function sidecarPath(topic) {
  return path.join(topicDir(topic), 'sidecar.json');
}

function hotIndexPath(topic) {
  return path.join(topicDir(topic), 'hot.usearch');
}

function fullIndexPath(topic) {
  return path.join(topicDir(topic), 'full.usearch');
}

function readSidecar(topic) {
  try {
    const raw = fs.readFileSync(sidecarPath(topic), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeSidecar(topic, data) {
  const dir = topicDir(topic);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    sidecarPath(topic),
    JSON.stringify({ ...data, written_at: Date.now() }, null, 2),
  );
}

/**
 * Stream embedded vectors + chunk_ids for one topic.
 * Returns generator yielding { chunk_id, vec: Float32Array }.
 *
 * WHY generator: a topic can have 100K rows; materializing the full
 * Float32Array array forces 1.3 GB of allocation up front. The
 * generator lets the caller process row-by-row and only the indices
 * actually being added to the HNSW are retained.
 */
function* streamTopicVectors(db, topic, { onlyHotTop = null } = {}) {
  // WHY two queries: the hot tier wants ORDER BY quality_score DESC LIMIT N,
  // the full tier wants every row (no order). Separate statements let SQLite
  // use the partial covering index for hot but a plain table scan for full
  // (which is faster than an ordered scan over 1.2M rows).
  let sql;
  let params;
  if (onlyHotTop !== null && onlyHotTop > 0) {
    sql = `
      SELECT c.id AS chunk_id, vec.embedding AS embedding
      FROM chunks c
      JOIN chunk_vec_${slug(topic)} vec ON vec.chunk_id = c.id
      WHERE c.topic = ? AND c.embedded = 1
      ORDER BY c.quality_score DESC
      LIMIT ?
    `;
    params = [topic, onlyHotTop];
  } else {
    sql = `
      SELECT c.id AS chunk_id, vec.embedding AS embedding
      FROM chunks c
      JOIN chunk_vec_${slug(topic)} vec ON vec.chunk_id = c.id
      WHERE c.topic = ? AND c.embedded = 1
    `;
    params = [topic];
  }
  let stmt;
  try {
    stmt = db.prepare(sql);
  } catch (err) {
    // chunk_vec_<topic> table missing (topic exists in chunks but never
    // had a vec table populated). Skip gracefully.
    if (String(err.message).includes('no such table')) return;
    throw err;
  }
  for (const row of stmt.iterate(...params)) {
    const buf = row.embedding;
    if (!buf || !(buf instanceof Buffer || buf instanceof Uint8Array)) continue;
    // sqlite-vec stores Float32 BLOBs row-major. We reconstruct without copy
    // by aliasing the underlying ArrayBuffer.
    const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    yield { chunk_id: row.chunk_id, vec };
  }
}

function slug(topic) {
  return String(topic).replace(/[^a-z0-9_]/gi, '_');
}

/**
 * Build (or rebuild) both hot and full indices for one topic.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} topic - chunks.topic slug
 * @param {object} [opts]
 * @param {number} [opts.totalRam=os.totalmem()]
 * @param {number} [opts.targetP99LatencyMs=HOT_TIER_LATENCY_CAP_DEFAULT]
 * @returns {Promise<{hot_size: number, full_size: number, dim: number} | null>}
 */
export async function buildIndicesForTopic(db, topic, {
  totalRam = os.totalmem(),
  targetP99LatencyMs = HOT_TIER_LATENCY_CAP_DEFAULT,
} = {}) {
  const Index = await getIndexClass();
  if (!Index) return null;

  // Count embedded chunks for this topic. WHY a separate query: streaming
  // the full table and counting on the fly would consume the iterator;
  // a COUNT(*) is one B-tree probe and lets us size the hot tier first.
  const corpusRow = db.prepare(
    'SELECT COUNT(*) AS n FROM chunks WHERE topic = ? AND embedded = 1',
  ).get(topic);
  const corpusSize = corpusRow?.n || 0;
  if (corpusSize === 0) return null;

  const hotSize = computeHotTierSize({
    totalRam,
    topicCorpusSize: corpusSize,
    targetP99LatencyMs,
  });

  // Probe dimensionality from the first row — sqlite-vec is dim-fixed per
  // table so the first row's vector length is correct for all rows.
  let dim = null;
  let firstVec = null;
  for (const { vec, chunk_id: _firstId } of streamTopicVectors(db, topic, { onlyHotTop: 1 })) {
    dim = vec.length;
    firstVec = { vec, chunk_id: _firstId };
    break;
  }
  if (!dim || !firstVec) return null;

  // Build hot — only when sizer says we should bother. corpusSize < threshold
  // returns 0 and we skip the hot tier entirely (sqlite-vec is faster there).
  let hot = null;
  if (hotSize > 0) {
    hot = new Index({
      metric: 'cos',
      dimensions: dim,
      connectivity: USEARCH_M,
      expansion_add: USEARCH_EF_CONSTRUCTION,
      expansion_search: USEARCH_EF_SEARCH,
    });
    for (const { chunk_id, vec } of streamTopicVectors(db, topic, { onlyHotTop: hotSize })) {
      hot.add(BigInt(chunk_id), vec);
    }
    // st_2cd1af73 residue B — atomic save (temp + rename) so a concurrent
    // view()-mmap'd search in the per-topic rollback path never reads a
    // half-written file. The background rebuild scheduled by loadAllHotIndices
    // overwrites these files while the old index may still be searched.
    writeIndexAtomically(hot, hotIndexPath(topic));
  }

  // Build full — always, unless corpus is below the small-topic threshold
  // (in which case the hot tier is also skipped and we don't have a full
  // either — query path falls back to sqlite-vec).
  const full = new Index({
    metric: 'cos',
    dimensions: dim,
    connectivity: USEARCH_M,
    expansion_add: USEARCH_EF_CONSTRUCTION,
    expansion_search: USEARCH_EF_SEARCH,
  });
  let fullCount = 0;
  for (const { chunk_id, vec } of streamTopicVectors(db, topic)) {
    full.add(BigInt(chunk_id), vec);
    fullCount++;
  }
  // st_2cd1af73 residue B — atomic save (temp + rename), same reason as hot above.
  writeIndexAtomically(full, fullIndexPath(topic));

  const meta = {
    hot_size: hotSize,
    full_size: fullCount,
    dim,
    embedding_model_id: EMBED_MODEL,
    built_from_count: corpusSize,
    built_from_quality_version: QUALITY_VERSION,
    built_at: Date.now(),
  };
  writeSidecar(topic, meta);

  // Update in-process store: keep hot loaded; view() the full index.
  const fullView = new Index({ metric: 'cos', dimensions: dim });
  try {
    fullView.view(fullIndexPath(topic));
  } catch (err) {
    console.warn(`[ann] view() failed for topic=${topic}:`, err.message);
  }
  indexStore.set(topic, { hot, full: fullView, dim, sidecar: meta });

  return { hot_size: hotSize, full_size: fullCount, dim };
}

/**
 * Load all hot indices into memory for every topic that has them.
 * Called from runBootWarmup. Topics without indices are skipped (a
 * later /api/ingest invocation will trigger buildIndicesForTopic).
 *
 * Topics whose sidecar mismatches the live corpus are scheduled for
 * background rebuild — load() the stale one first so first-request
 * latency stays low, then rebuild in the background.
 */
export async function loadAllHotIndices(db) {
  const Index = await getIndexClass();
  if (!Index) return { loaded: 0, skipped: 0 };

  const topics = db.prepare(
    'SELECT DISTINCT topic FROM chunks WHERE embedded = 1',
  ).all().map(r => r.topic);

  let loaded = 0;
  let skipped = 0;
  for (const topic of topics) {
    try {
      const sidecar = readSidecar(topic);
      if (!sidecar || !fs.existsSync(hotIndexPath(topic))) {
        // No persisted index — defer build until first miss; loading
        // sub-second 1.2 M-row builds at boot would block warmup.
        skipped++;
        continue;
      }

      const hot = new Index({ metric: 'cos', dimensions: sidecar.dim });
      hot.load(hotIndexPath(topic));

      let fullView = null;
      if (fs.existsSync(fullIndexPath(topic))) {
        fullView = new Index({ metric: 'cos', dimensions: sidecar.dim });
        try { fullView.view(fullIndexPath(topic)); } catch { /* full optional */ }
      }
      indexStore.set(topic, { hot, full: fullView, dim: sidecar.dim, sidecar });
      loaded++;

      // Stale-check: if corpus has grown materially, queue a background
      // rebuild. We do NOT await it — load returns immediately and the
      // background promise runs to completion on the warmup tick.
      const liveCount = db.prepare(
        'SELECT COUNT(*) AS n FROM chunks WHERE topic = ? AND embedded = 1',
      ).get(topic)?.n || 0;
      const grew = (liveCount - sidecar.built_from_count) / Math.max(sidecar.built_from_count, 1);
      const formulaStale = sidecar.built_from_quality_version !== QUALITY_VERSION;
      if (grew > REBUILD_DRIFT_THRESHOLD || formulaStale) {
        buildIndicesForTopic(db, topic).catch(err =>
          console.warn(`[ann] background rebuild ${topic} failed:`, err.message),
        );
      }
    } catch (err) {
      console.warn(`[ann] load failed for topic=${topic}:`, err.message);
      skipped++;
    }
  }
  return { loaded, skipped };
}

/**
 * Internal per-topic ANN search. Preserved as a rollback path; lib/rag-search.js
 * uses the global `annSearch(queryVec, k, opts)` path below.
 *
 * Returns null when:
 *   - usearch binding unavailable
 *   - No index loaded for this topic (caller falls back to sqlite-vec)
 *   - queryVec dimensionality mismatches the index
 *
 * @param {string} topic
 * @param {Float32Array} queryVec
 * @param {number} [k=10]
 * @returns {{ keys: BigInt[], distances: number[] } | null}
 */
export function _annSearchPerTopic(topic, queryVec, k = 10) {
  const entry = indexStore.get(topic);
  if (!entry) return null;
  if (!(queryVec instanceof Float32Array)) return null;
  if (queryVec.length !== entry.dim) return null;

  let hot = null;
  if (entry.hot) {
    try {
      hot = entry.hot.search(queryVec, k);
    } catch (err) {
      console.warn(`[ann] hot search failed topic=${topic}:`, err.message);
    }
  }

  // If hot tier returned results AND the closest match is confident,
  // use it directly. Otherwise fall through to the full tier.
  if (hot && hot.distances && hot.distances.length > 0) {
    const minDist = hot.distances[0];
    if (minDist <= HOT_TIER_FALLBACK_THRESHOLD) {
      return formatResult(hot);
    }
  }

  if (entry.full) {
    try {
      const full = entry.full.search(queryVec, k);
      if (full && full.distances && full.distances.length > 0) {
        return formatResult(full);
      }
    } catch (err) {
      console.warn(`[ann] full search failed topic=${topic}:`, err.message);
    }
  }

  // Hot was below threshold but no full index — return hot anyway. The
  // recency-rescore + confidence gate downstream will catch low-quality
  // results.
  if (hot) return formatResult(hot);

  return null;
}

// ─── Unified global index path (st_8c7b7a6b D4) ─────────────────────────────

/**
 * In-memory chunkId → topic map. Built at boot from
 * `SELECT id, topic FROM chunks WHERE embedded = 1`. Used by
 * `annSearch` to post-filter results when topicFilter is non-null —
 * avoids per-topic fan-out at search time. ~48 MB at 1.2M chunks.
 */
let _chunkTopicMap = new Map();
let _chunkTopicCounts = new Map();

/**
 * Singleton holder for the global hot + full indices and their sidecar.
 */
let _globalIndex = null; // { hot, full, sidecar, dim }
let _splitEmbeddingsDb = undefined;

// ─── ANN search-vs-rebuild crash guard (st_2cd1af73 residue B) ───────────────
//
// THE CRASH: usearch's native CompiledIndex::Search runs in C++. When the global
// index is concurrently swapped/reloaded — the boot/maintenance reload reassigns
// _globalIndex, OR the detached scripts/build-global-hnsw.js child OVERWRITES the
// on-disk full.usearch that this process has view()-mmap'd — a search traversing
// the index hits a handle whose backing memory was freed or whose mmap'd file
// bytes changed mid-traversal. usearch reacts with std::terminate → SIGABRT,
// which kills the whole server process (an uncatchable C++ abort, not a JS throw).
//
// THE FIX has two halves, both here:
//
//   1. Atomic file swap (writeIndexAtomically): the builder saves each index to a
//      TEMP path and rename()s it into place. rename() is atomic on POSIX and
//      swaps the directory entry to a NEW inode; any existing view() mmap keeps
//      pointing at the OLD inode (valid until unmapped) instead of reading a
//      half-written file. So a search in flight never sees torn bytes.
//
//   2. A reload guard (_reloading + _searchInFlight): annSearch refuses to touch
//      the index while a reload is mid-swap and returns null — the caller
//      (lib/rag-search.js) treats null as "index not loaded" and falls back to
//      the sqlite-vec / FTS path, so retrieval still works, just on the slower
//      backstop for the brief swap window. The in-process swap of _globalIndex
//      only happens AFTER the new holder is fully built, and search increments
//      _searchInFlight so a swap can observe (and a debug assert can verify) that
//      no search is mid-flight against the handle being retired.
//
// The server must NEVER crash from this race. A failed/contended search degrades
// to the fallback; it never aborts the process.
let _reloading = false;
let _searchInFlight = 0;

/**
 * Save a usearch Index to its final path ATOMICALLY: write to a unique temp file
 * in the same directory, then rename() it into place. Same-dir rename is atomic
 * on POSIX and never leaves a reader observing a partially-written file — the key
 * to not crashing a concurrent view()-mmap'd search in another process.
 *
 * @param {import('usearch').Index} index a built usearch index
 * @param {string} finalPath destination path (…/hot.usearch or …/full.usearch)
 */
export function writeIndexAtomically(index, finalPath) {
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });
  // Temp name in the SAME directory so rename() stays on one filesystem (atomic).
  const tmp = path.join(dir, `.${path.basename(finalPath)}.tmp-${process.pid}-${Date.now()}`);
  index.save(tmp);
  fs.renameSync(tmp, finalPath); // atomic swap of the directory entry
}

function writeJsonAtomically(finalPath, data) {
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(finalPath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify({ ...data, written_at: Date.now() }, null, 2));
  fs.renameSync(tmp, finalPath);
}

/**
 * Atomically install a freshly-built/loaded global-index holder. The swap of the
 * module reference is a single synchronous assignment (atomic between JS ticks);
 * we flip _reloading around it so any annSearch that interleaves at an await
 * boundary in the caller sees the guard and falls back rather than racing the
 * handle. Returns the holder that was replaced (for the caller to drop/close).
 *
 * @param {{hot:any, full:any, sidecar:object, dim:number}} holder
 * @returns {object|null} the previous holder
 */
function installGlobalIndex(holder) {
  _reloading = true;
  try {
    const prev = _globalIndex;
    _globalIndex = holder; // atomic reference swap — no torn read in JS
    return prev;
  } finally {
    _reloading = false;
  }
}

/** Test/diagnostic: is a global-index reload mid-swap right now? */
export function _isReloadingForTest() { return _reloading; }
/** Test/diagnostic: how many searches are currently executing in native code? */
export function _searchInFlightForTest() { return _searchInFlight; }

function globalDir() {
  return annBaseDir();
}
function globalHotPath() {
  return path.join(globalDir(), 'hot.usearch');
}
function globalFullPath() {
  return path.join(globalDir(), 'full.usearch');
}
function globalSidecarPath() {
  return path.join(globalDir(), 'sidecar.json');
}
function readGlobalSidecar() {
  try {
    return JSON.parse(fs.readFileSync(globalSidecarPath(), 'utf8'));
  } catch { return null; }
}

export function getGlobalDiskStatus() {
  recoverGlobalArtifactsFromRuntimeSnapshot();
  reclaimStaleGlobalRebuildLock();
  const sidecar = readGlobalSidecar();
  const integrity = globalSidecarIntegrity(sidecar);
  const hot = fs.existsSync(globalHotPath());
  const full = fs.existsSync(globalFullPath());
  const hotRequired = (Number(sidecar?.hot_size) || 0) > 0;
  const compatible = !!sidecar
    && (!hotRequired || hot)
    && full
    && Number(sidecar.dim) === HNSW_DIMS
    && sidecar.embedding_model_id === EMBED_MODEL
    && integrity.ok;
  return {
    sidecar: !!sidecar,
    hot,
    full,
    building_lock: fs.existsSync(rebuildLockPath()),
    compatible,
    integrity_ok: integrity.ok,
    integrity_reason: integrity.reason,
    built_at: sidecar?.built_at ?? null,
    hot_size: sidecar?.hot_size ?? null,
    built_from_count: sidecar?.built_from_count ?? null,
    source_embedded_count: sidecar?.source_embedded_count ?? null,
    full_size: sidecar?.full_size ?? null,
    dim: sidecar?.dim ?? null,
    embedding_model_id: sidecar?.embedding_model_id ?? null,
    quality_version: sidecar?.built_from_quality_version ?? null,
  };
}

/**
 * Machine-readable launch readiness for the global ANN artifact.
 *
 * Runtime retrieval may fall back to sqlite-vec/FTS for crash protection, but
 * launch readiness still requires a usable ANN artifact when embedded vectors
 * exist. A small amount of live corpus growth is search-safe: fresh rows remain
 * covered by bounded fallback paths while the background rebuild catches up.
 * A builder lock is "repairing", not green.
 */
export function getGlobalAnnReadiness(db = null) {
  const disk = getGlobalDiskStatus();
  const status = getGlobalStatus();
  const sidecar = readGlobalSidecar();
  const liveEmbedded = db ? embeddedCorpusCount(db) : null;
  const base = {
    ready: false,
    state: 'unavailable',
    reason: 'global_index_unavailable',
    disk,
    runtime: status,
    live_embedded: liveEmbedded,
  };

  if (liveEmbedded !== null && liveEmbedded <= 0) {
    return { ...base, state: 'empty', reason: 'no_embedded_chunks' };
  }

  if (!disk.sidecar || !disk.full || ((Number(sidecar?.hot_size) || 0) > 0 && !disk.hot)) {
    return {
      ...base,
      state: disk.building_lock ? 'repairing' : 'missing',
      reason: disk.building_lock ? 'artifact_missing_repairing' : 'artifact_missing',
    };
  }

  if (!disk.compatible) {
    return {
      ...base,
      state: disk.building_lock ? 'repairing' : 'invalid',
      reason: disk.building_lock
        ? `artifact_invalid_repairing:${disk.integrity_reason || 'incompatible'}`
        : `artifact_invalid:${disk.integrity_reason || 'incompatible'}`,
    };
  }

  let freshness = null;
  if (liveEmbedded !== null) {
    freshness = globalIndexFreshness(sidecar, liveEmbedded);
    if (freshness.stale) {
      return {
        ...base,
        state: disk.building_lock ? 'repairing' : 'stale',
        reason: disk.building_lock ? 'artifact_stale_repairing' : 'artifact_stale',
        freshness,
      };
    }
  }

  return {
    ...base,
    ready: true,
    state: status?.loaded && !status.stale_on_disk ? 'ready' : 'artifact_ready',
    reason: status?.loaded && !status.stale_on_disk ? 'global_index_ready' : 'global_index_artifact_ready',
    ...(freshness ? { freshness } : {}),
  };
}

function getSplitEmbeddingsDb() {
  if (_splitEmbeddingsDb !== undefined) return _splitEmbeddingsDb;
  try {
    _splitEmbeddingsDb = openEmbeddingsDb();
  } catch {
    _splitEmbeddingsDb = null;
  }
  return _splitEmbeddingsDb;
}

function tableExists(database, tableName) {
  try {
    return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  } catch {
    return false;
  }
}
function writeGlobalSidecar(data) {
  writeJsonAtomically(globalSidecarPath(), data);
}

function sidecarMatchesRuntimeSnapshot(sidecar, runtimeSidecar) {
  if (!sidecar || !runtimeSidecar) return false;
  return Number(sidecar.dim || 0) === Number(runtimeSidecar.dim || 0)
    && Number(sidecar.hot_size || 0) === Number(runtimeSidecar.hot_size || 0)
    && Number(sidecar.full_size || 0) === Number(runtimeSidecar.full_size || 0)
    && Number(sidecar.built_from_count || 0) === Number(runtimeSidecar.built_from_count || 0)
    && sidecar.embedding_model_id === runtimeSidecar.embedding_model_id
    && sidecar.built_from_quality_version === runtimeSidecar.built_from_quality_version;
}

function assertGlobalArtifactsReadyForSidecar(meta) {
  const missing = [];
  if ((Number(meta?.hot_size) || 0) > 0 && !fs.existsSync(globalHotPath())) missing.push('hot.usearch');
  if (!fs.existsSync(globalFullPath())) missing.push('full.usearch');
  if (missing.length > 0) {
    throw new Error(`global HNSW sidecar publish blocked; missing ${missing.join(', ')}`);
  }
}

function recoverGlobalArtifactsFromRuntimeSnapshot() {
  if (!_globalIndex?.sidecar) return false;
  const dir = globalDir();
  const bak = `${dir}.bak`;
  let changed = false;
  let bakSidecar = null;
  try {
    bakSidecar = JSON.parse(fs.readFileSync(path.join(bak, 'sidecar.json'), 'utf8'));
  } catch { /* no compatible backup */ }
  if (!sidecarMatchesRuntimeSnapshot(bakSidecar, _globalIndex.sidecar)) return false;
  for (const name of ['hot.usearch', 'full.usearch']) {
    const target = path.join(dir, name);
    const source = path.join(bak, name);
    try {
      if (!fs.existsSync(target) && fs.existsSync(source)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(source, target);
        changed = true;
      }
    } catch (err) {
      console.warn(`[ann] ${name} runtime restore failed:`, err.message);
    }
  }
  try {
    if (!readGlobalSidecar() && fs.existsSync(globalHotPath()) && fs.existsSync(globalFullPath())) {
      writeGlobalSidecar(_globalIndex.sidecar);
      changed = true;
    }
  } catch (err) {
    console.warn('[ann] sidecar runtime restore failed:', err.message);
  }
  return changed;
}

// st_d142f701 AC14: auto-rebuild stale global HNSW in the background.
// WHY detached + .unref(): the rebuild can take 10–30 minutes on a large
// corpus. The app must stay responsive (serve stale-but-loaded index)
// while the new artifact builds; the next loadGlobalIndex() picks up the
// fresh artifact.
// WHY .building lock: prevents two concurrent rebuilds during a churning corpus
// while still allowing recovery from a rebuild that crashed without removing its
// lock. Staleness is owner-liveness based, not clock-only: a valid 10–30 minute
// corpus rebuild must not be mistaken for a dead builder.
const REBUILD_LOCK_STALE_MS = (() => {
  const raw = Number(process.env.ROBOTDOJO_ANN_REBUILD_LOCK_STALE_MS || '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60 * 60_000;
})();
const REBUILD_PENDING_LOCK_STALE_MS = (() => {
  const raw = Number(process.env.ROBOTDOJO_ANN_REBUILD_PENDING_LOCK_STALE_MS || '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2 * 60_000;
})();

function rebuildLockPath() {
  return globalSidecarPath() + '.building';
}

function readRebuildLock(lockPath) {
  try { return fs.readFileSync(lockPath, 'utf8').trim(); } catch { return null; }
}

function lockOwnerPid(token) {
  const parts = String(token || '').split(':');
  const raw = parts[0] === 'pending' || parts[0] === 'child' ? parts[1] : parts[0];
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function lockIdFromToken(token) {
  const parts = String(token || '').split(':');
  return parts.length >= 3 ? parts.at(-1) : '';
}

function lockOwnerAlive(token) {
  const pid = lockOwnerPid(token);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function lockOwnerCommand(token) {
  const pid = lockOwnerPid(token);
  if (!pid) return '';
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (cmdline) return cmdline.replaceAll('\0', ' ');
  } catch { /* macOS has no /proc */ }
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1000,
    });
    return String(result.stdout || '').trim();
  } catch { /* best-effort diagnostics only */ }
  return '';
}

function rebuildLockIsReclaimable(lockPath, token) {
  if (!token) return true;
  let ageMs = Infinity;
  try { ageMs = Date.now() - fs.statSync(lockPath).mtimeMs; } catch {}
  const pending = String(token).startsWith('pending:');
  const ownerAlive = lockOwnerAlive(token);
  if (pending) return !ownerAlive || ageMs >= REBUILD_PENDING_LOCK_STALE_MS;
  if (!ownerAlive) return true;
  const ownerCommand = lockOwnerCommand(token);
  if (ownerCommand && ownerCommand.includes('build-global-hnsw')) return false;
  return ageMs >= REBUILD_LOCK_STALE_MS;
}

export function reclaimStaleGlobalRebuildLock(lockPath = rebuildLockPath()) {
  const token = readRebuildLock(lockPath);
  if (!token) return { reclaimed: false, reason: 'lock_absent', lock_path: lockPath };
  if (!rebuildLockIsReclaimable(lockPath, token)) {
    return {
      reclaimed: false,
      reason: 'lock_owner_active',
      lock_path: lockPath,
      token,
      owner_pid: lockOwnerPid(token),
    };
  }
  try {
    fs.unlinkSync(lockPath);
    return {
      reclaimed: true,
      reason: 'stale_rebuild_lock_reclaimed',
      lock_path: lockPath,
      token,
      owner_pid: lockOwnerPid(token),
    };
  } catch (err) {
    return {
      reclaimed: false,
      reason: 'stale_rebuild_lock_reclaim_failed',
      lock_path: lockPath,
      token,
      owner_pid: lockOwnerPid(token),
      error: err?.message || String(err),
    };
  }
}

function maybeSpawnGlobalHnswRebuild() {
  const lockPath = rebuildLockPath();
  const existingToken = readRebuildLock(lockPath);
  if (existingToken) {
    if (!rebuildLockIsReclaimable(lockPath, existingToken)) return false;
    try { fs.unlinkSync(lockPath); } catch {}
  }

  // Write the lock atomically BEFORE spawning so a near-instant second
  // loadGlobalIndex call sees the lock and skips. The child claims this
  // pending token with its own PID as soon as it starts; only the final
  // child-owned token may clear the lock on exit. This prevents duplicate
  // builders and avoids treating the parent server process as the rebuild owner.
  const lockId = randomUUID();
  const token = `pending:${process.pid}:${Date.now()}:${lockId}`;
  let fd;
  try {
    fs.mkdirSync(globalDir(), { recursive: true });
    fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, token);
  } catch (err) {
    if (err.code !== 'EEXIST') console.warn('[ann] rebuild lock write failed:', err.message);
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  // Canonical non-blocking child-process spawn (see build-conventions.md).
  // Absolute path to the build script; detached + stdio:'ignore' + unref()
  // means the parent process exits cleanly without waiting.
  const here = path.dirname(fileURLToPath(import.meta.url));
  // lib/ann/usearch-adapter.js → ../../scripts/build-global-hnsw.js
  const scriptPath = path.resolve(here, '..', '..', 'scripts', 'build-global-hnsw.js');
  try {
    const child = spawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ROBOTDOJO_ANN_REBUILD_LOCK_TOKEN: token,
      },
    });
    const childToken = `child:${child.pid}:${Date.now()}:${lockId}`;
    try {
      if (readRebuildLock(lockPath) === token) fs.writeFileSync(lockPath, childToken);
    } catch (claimErr) {
      console.warn('[ann] rebuild lock child-claim failed:', claimErr.message);
    }
    child.unref();
    return true;
  } catch (err) {
    console.warn('[ann] rebuild spawn failed:', err.message);
    // Clean up the lock so a future stale-detect can retry.
    try {
      if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath);
    } catch {}
    return false;
  }
}

// st_2cd1af73 AC-1 (final layer) — periodic global-index freshness hook.
//
// The embed daemon backfills continuously (currently ~3.6K of 340K embedded
// and climbing). loadGlobalIndex() only stale-checks at BOOT, so without a
// running re-check the index would freeze at its boot-time corpus and drift
// for days as embeddings land — chat would keep retrieving against a
// few-thousand-vector slice while the FTS supplement carried the rest. The
// maintenance worker already ticks every ~15s in the quiet window; it calls
// this on a throttled cadence so the index tracks the growing corpus without
// any LLM cost and without ever blocking a chat turn (the rebuild is the same
// detached, lock-gated child process loadGlobalIndex spawns).
//
// Fires a background rebuild when EITHER:
//   - the global artifact is MISSING (e.g. a fresh machine, or the dir was
//     removed out-of-band), OR
//   - the embedded-chunk count has drifted past the scaled freshness threshold
//     vs the sidecar's built_from_count, OR the quality-formula version changed.
//
// Bounded by the existing .building lock (one rebuild at a time, 10-min stale
// recovery). Returns { spawned, reason } for the worker's status log.
//
// @param {import('better-sqlite3').Database} db
// @returns {{ spawned: boolean, reason: string }}
const REBUILD_DRIFT_THRESHOLD = (() => {
  const raw = parseFloat(process.env.ROBOTDOJO_ANN_REBUILD_DRIFT || '');
  return Number.isFinite(raw) && raw > 0 ? raw : 0.005; // 0.5% growth
})();
const REBUILD_MIN_NEW_CHUNKS = (() => {
  const raw = Number(process.env.ROBOTDOJO_ANN_REBUILD_MIN_CHUNKS || '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 64;
})();
const REBUILD_FOREGROUND_QUIET_MS = (() => {
  const raw = Number(process.env.ROBOTDOJO_ANN_REBUILD_FOREGROUND_QUIET_MS || '');
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15 * 60_000;
})();

function globalRebuildGrowthThreshold(builtFrom) {
  return Math.max(REBUILD_MIN_NEW_CHUNKS, Math.ceil(Math.max(builtFrom, 1) * REBUILD_DRIFT_THRESHOLD));
}

function isNonNegativeFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

function globalSidecarIntegrity(sidecar) {
  if (!sidecar) return { ok: false, reason: 'missing_sidecar' };
  const hotSize = Number(sidecar.hot_size) || 0;
  const fullSize = Number(sidecar.full_size) || 0;
  const builtFrom = Number(sidecar.built_from_count) || 0;
  const sourceEmbedded = Number(sidecar.source_embedded_count) || 0;
  if (fullSize <= 0 || builtFrom <= 0) return { ok: false, reason: 'empty_or_unbuilt_sidecar' };
  if (hotSize < 0 || hotSize > fullSize) return { ok: false, reason: 'hot_size_out_of_range' };
  if (fullSize !== builtFrom) return { ok: false, reason: 'full_size_built_from_mismatch' };
  if (sourceEmbedded !== builtFrom) return { ok: false, reason: 'source_embedded_count_mismatch' };
  return { ok: true, reason: 'ok' };
}

function globalIndexFreshness(sidecar, liveCount, {
  maxAllowedNewChunks = null,
  requireExactNewChunks = false,
} = {}) {
  const sidecarCount = Number(sidecar?.built_from_count) || 0;
  const builtFrom = Math.max(sidecarCount, 1);
  const live = Number(liveCount) || 0;
  const corpusDelta = live - sidecarCount;
  const newChunks = Math.max(0, corpusDelta);
  const removedChunks = Math.max(0, -corpusDelta);
  const absoluteDriftChunks = Math.abs(corpusDelta);
  const drift = newChunks / builtFrom;
  const removedDrift = removedChunks / builtFrom;
  const growthThreshold = sidecarCount > 0 ? globalRebuildGrowthThreshold(builtFrom) : 1;
  const hasExactThreshold = isNonNegativeFiniteNumber(maxAllowedNewChunks);
  const exactThreshold = hasExactThreshold ? Number(maxAllowedNewChunks) : null;
  const formulaStale = sidecar?.built_from_quality_version !== QUALITY_VERSION;
  const integrity = globalSidecarIntegrity(sidecar);
  const exactNewChunksStale = requireExactNewChunks
    && hasExactThreshold
    && newChunks > Math.floor(exactThreshold);
  const missingNewChunksStale = newChunks >= growthThreshold || exactNewChunksStale;
  const deletedSupersetStale = removedChunks >= growthThreshold;
  return {
    sidecarCount,
    liveCount: live,
    corpusDelta,
    newChunks,
    removedChunks,
    absoluteDriftChunks,
    drift,
    removedDrift,
    growthThreshold,
    maxAllowedNewChunks: hasExactThreshold ? Math.floor(exactThreshold) : null,
    requireExactNewChunks: Boolean(requireExactNewChunks),
    formulaStale,
    integrityOk: integrity.ok,
    integrityReason: integrity.reason,
    missingNewChunksStale,
    exactNewChunksStale,
    deletedSupersetStale,
    deletedSuperset: removedChunks > 0 && newChunks === 0,
    searchSafe: integrity.ok && !formulaStale && !missingNewChunksStale && !deletedSupersetStale,
    stale: !integrity.ok
      || missingNewChunksStale
      || deletedSupersetStale
      || formulaStale,
  };
}

function annRebuildSpawnDecision(db) {
  const hold = readEmbedPauseHold();
  if (hold.active) return { ok: false, reason: hold.reason || 'embed-pause-hold' };
  const pending = pendingEmbeddingBacklogCount(db);
  if (pending > 0) return { ok: false, reason: `embedding_backlog_pending:${pending}` };
  if (process.env.ROBOTDOJO_ANN_REBUILD_REQUIRE_FOREGROUND_IDLE === '0') {
    return { ok: true, reason: 'foreground-gate-disabled' };
  }
  const signal = getActivitySignal(db);
  if (chatAppActiveDecision(signal)) return { ok: false, reason: 'chat-app-open' };
  const activity = activityPauseDecision(signal, { pauseMs: REBUILD_FOREGROUND_QUIET_MS });
  if (activity.pause) return { ok: false, reason: activity.reason };
  return { ok: true, reason: 'foreground-quiet' };
}

function embeddedCorpusCount(db) {
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1').get()?.n || 0;
  } catch {
    return 0;
  }
}

function pendingEmbeddingBacklogCount(db) {
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE COALESCE(embedded, 0) != 1').get()?.n || 0;
  } catch {
    return 0;
  }
}

function repairableLoadReason(reason) {
  return /(?:artifact_missing|artifact_invalid_sidecar|artifact_incompatible|stale|load_error)/.test(String(reason || ''));
}

export function maybeRefreshGlobalIndex(db) {
  recoverGlobalArtifactsFromRuntimeSnapshot();
  const sidecar = readGlobalSidecar();
  const hotExists = fs.existsSync(globalHotPath());
  const fullExists = fs.existsSync(globalFullPath());
  const hotRequired = (Number(sidecar?.hot_size) || 0) > 0;

  // Missing or incomplete artifact — build it. WHY check here too (not only at
  // boot): a machine that imported data but never ran the build, or a dir that
  // was removed out-of-band, would otherwise leave chat on the bounded fallback
  // indefinitely. The worker is the steady-state owner that heals it.
  if (!sidecar || (hotRequired && !hotExists) || !fullExists) {
    const foreground = annRebuildSpawnDecision(db);
    if (!foreground.ok) return { spawned: false, reason: `artifact_missing_foreground_active:${foreground.reason}` };
    const spawned = maybeSpawnGlobalHnswRebuild();
    return { spawned, reason: spawned ? 'artifact_missing' : 'artifact_missing_locked' };
  }

  let liveCount = 0;
  try {
    liveCount = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1').get()?.n || 0;
  } catch (err) {
    return { spawned: false, reason: `count_failed:${err.message}` };
  }

  const sidecarCount = Number(sidecar.built_from_count) || 0;
  const { newChunks, removedChunks, absoluteDriftChunks, drift, growthThreshold, formulaStale, stale } =
    globalIndexFreshness(sidecar, liveCount);

  if (stale) {
    const foreground = annRebuildSpawnDecision(db);
    if (!foreground.ok) {
      return {
        spawned: false,
        reason: `stale_foreground_active:${foreground.reason} new_chunks=${newChunks} removed_chunks=${removedChunks} abs_drift=${absoluteDriftChunks} threshold=${growthThreshold} drift=${(drift * 100).toFixed(2)}% formula_stale=${formulaStale}`,
      };
    }
    const spawned = maybeSpawnGlobalHnswRebuild();
    return {
      spawned,
      reason: spawned
        ? `stale new_chunks=${newChunks} removed_chunks=${removedChunks} abs_drift=${absoluteDriftChunks} threshold=${growthThreshold} drift=${(drift * 100).toFixed(2)}% formula_stale=${formulaStale}`
        : 'stale_locked',
    };
  }

  return { spawned: false, reason: `fresh new_chunks=${newChunks} removed_chunks=${removedChunks} abs_drift=${absoluteDriftChunks} threshold=${growthThreshold} drift=${(drift * 100).toFixed(2)}%` };
}

/**
 * Ensure a usable global ANN artifact for retrieval. Small/QA corpora repair
 * inline before falling back; large corpora queue the detached builder and
 * remain visibly degraded until it finishes. True missing prerequisites
 * (no embedded chunks, no vector rows, no usearch binding) return unavailable.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.synchronousMaxChunks]
 * @param {boolean} [opts.forceSynchronous]
 * @param {number|null} [opts.maxAllowedDriftChunks] - Optional launch/QA
 *   freshness cap. Runtime uses the scaled rebuild threshold; launch can pass
 *   0 to prove the sidecar includes every embedded chunk at check time.
 * @param {number} [opts.yieldEveryN]
 * @param {Function|null} [opts.onProgress]
 * @param {string} [opts.reason]
 * @returns {Promise<object>}
 */
export async function ensureGlobalIndexAvailableForRetrieval(db, {
  synchronousMaxChunks = ANN_INLINE_REPAIR_MAX_CHUNKS,
  forceSynchronous = false,
  maxAllowedDriftChunks = null,
  yieldEveryN = 1000,
  onProgress = null,
  reason = 'retrieval',
} = {}) {
  const hasLaunchFreshnessCap = isNonNegativeFiniteNumber(maxAllowedDriftChunks);
  let liveEmbedded = null;
  const getLiveEmbedded = () => {
    if (liveEmbedded === null) liveEmbedded = embeddedCorpusCount(db);
    return liveEmbedded;
  };

  const runtime = getGlobalStatus();
  if (runtime && !runtime.stale_on_disk) {
    const freshness = hasLaunchFreshnessCap
      ? globalIndexFreshness(_globalIndex?.sidecar, getLiveEmbedded(), {
        maxAllowedNewChunks: maxAllowedDriftChunks,
        requireExactNewChunks: true,
      })
      : null;
    if (freshness?.stale) {
      // Fall through to the repair path. Runtime uses bounded drift; launch can
      // demand an exact sidecar so the proof never hides fresh embedded rows.
    } else {
      return {
        loaded: true,
        reason: 'global_index_runtime_ready',
        repair: { mode: 'none', reason: 'runtime_ready', trigger: reason },
        ...(freshness ? { freshness } : {}),
        ...runtime,
      };
    }
  }

  const probed = await loadGlobalIndex(db, { repairMode: 'none', maxAllowedDriftChunks });
  if (probed?.loaded) {
    return {
      ...probed,
      repair: { mode: 'none', reason: 'loaded_from_disk', trigger: reason },
    };
  }

  liveEmbedded = getLiveEmbedded();
  if (liveEmbedded <= 0) {
    return {
      loaded: false,
      reason: 'global_index_unavailable_no_embedded_chunks',
      repair: { mode: 'unavailable', prerequisite: 'embedded_chunks', trigger: reason },
    };
  }

  if (!repairableLoadReason(probed?.reason)) {
    return {
      ...probed,
      loaded: false,
      reason: probed?.reason || 'global_index_unavailable',
      repair: { mode: 'unavailable', prerequisite: 'ann_runtime', trigger: reason },
    };
  }

  const maxInline = forceSynchronous
    ? Infinity
    : Math.max(0, Number(synchronousMaxChunks) || 0);
  if (liveEmbedded <= maxInline) {
    const meta = await buildGlobalIndex(db, { yieldEveryN, onProgress });
    if (meta?.full_size > 0) {
      return {
        loaded: true,
        reason: 'global_index_repaired_inline',
        repair: {
          mode: 'inline',
          trigger: probed?.reason || reason,
          live_embedded: liveEmbedded,
          built_from_count: meta.built_from_count,
          full_size: meta.full_size,
        },
        hot_size: meta.hot_size,
        full_size: meta.full_size,
        dim: meta.dim,
      };
    }
    return {
      loaded: false,
      reason: 'global_index_repair_unavailable_no_vector_rows',
      repair: {
        mode: 'unavailable',
        prerequisite: 'vector_rows',
        trigger: probed?.reason || reason,
        live_embedded: liveEmbedded,
      },
    };
  }

  const queued = await loadGlobalIndex(db, { repairMode: 'spawn', maxAllowedDriftChunks });
  const queuedReason = queued?.reason || probed?.reason || 'global_index_repair_queued';
  const queuedMode = String(queuedReason).includes('foreground_active')
    ? 'deferred'
    : String(queuedReason).includes('rebuild_locked')
      ? 'locked'
      : String(queuedReason).includes('rebuild_spawned')
        ? 'queued'
        : 'unavailable';
  return {
    ...queued,
    loaded: false,
    reason: queuedReason,
    repair: {
      mode: queuedMode,
      trigger: probed?.reason || reason,
      live_embedded: liveEmbedded,
      synchronous_max_chunks: Number.isFinite(maxInline) ? maxInline : null,
    },
  };
}

/**
 * Refresh the chunkId → topic map from the live DB. Called from
 * loadGlobalIndex() and exported so the ingest pipeline can refresh after
 * batch chunk inserts without rebuilding the entire HNSW index.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} the refreshed map's size
 */
export function refreshChunkTopicMap(db) {
  const map = new Map();
  const counts = new Map();
  try {
    // st_d142f701 AC15: filter on `embedded = 1`. The semantic predicate
    // we want is "this chunk has a vector in the HNSW index — include it
    // in the topic post-filter map." The previous filter on the legacy
    // quality-score column was load-bearing only by accident: in the
    // current corpus every row has quality_score set (DEFAULT 0.0), so
    // the map covered what we needed. On a future corpus where the
    // quality-score column lags embedding (or where the column is wiped
    // during a quality-formula migration), the old filter would silently
    // drop embedded chunks from the post-filter and produce empty
    // topic-scoped retrievals.
    const rows = db.prepare(
      'SELECT id, topic FROM chunks WHERE embedded = 1',
    ).iterate();
    for (const row of rows) {
      if (!row.topic) continue;
      map.set(row.id, row.topic);
      counts.set(row.topic, (counts.get(row.topic) || 0) + 1);
    }
  } catch (err) {
    console.warn('[ann] refreshChunkTopicMap failed:', err.message);
  }
  _chunkTopicMap = map;
  _chunkTopicCounts = counts;
  return map.size;
}

/**
 * Stream every chunk_vec_* row across all topics, yielding
 * `{ chunk_id, vec: Float32Array (normalized to HNSW_DIMS) }`.
 *
 * We iterate per-topic at the SQL layer (one query per chunk_vec_* table)
 * because the table names are dynamic — there is no single union surface.
 * Inside the generator we normalize for HNSW so the global index is uniformly
 * Snowflake 1024-dimensional.
 */
function* streamAllVectorsNormalized(db) {
  const topics = db.prepare(
    'SELECT DISTINCT topic FROM chunks WHERE embedded = 1 AND topic IS NOT NULL',
  ).all().map(r => r.topic);
  const splitDb = getSplitEmbeddingsDb();
  for (const topic of topics) {
    const tableName = `chunk_vec_${slug(topic)}`;
    const remainingIds = new Set(
      db.prepare('SELECT id FROM chunks WHERE topic = ? AND embedded = 1')
        .all(topic)
        .map((row) => String(row.id)),
    );
    if (remainingIds.size === 0) continue;

    // st_1cfe9061 — vectors may live in the split embeddings.db while chunk
    // truth stays in robotdojo.db. Prefer the split store when present, then
    // fill any remaining embedded chunks from the legacy main-DB table. This
    // makes the global HNSW artifact cover the real embedded corpus during and
    // after migration instead of indexing only the leftover legacy tables.
    const sources = [];
    if (splitDb && tableExists(splitDb, tableName)) sources.push(splitDb);
    if (tableExists(db, tableName)) sources.push(db);

    for (const sourceDb of sources) {
      if (remainingIds.size === 0) break;
      let stmt;
      try {
        stmt = sourceDb.prepare(`SELECT chunk_id, embedding FROM ${tableName}`);
      } catch (err) {
        if (String(err.message).includes('no such table')) continue;
        throw err;
      }
      for (const row of stmt.iterate()) {
        const chunkId = String(row.chunk_id);
        if (!remainingIds.has(chunkId)) continue;
        const numericId = Number(chunkId);
        if (!Number.isSafeInteger(numericId)) {
          remainingIds.delete(chunkId);
          continue;
        }
        const buf = row.embedding;
        if (!buf || !(buf instanceof Buffer || buf instanceof Uint8Array)) continue;
        const source = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        if (source.length < HNSW_DIMS) continue; // skip malformed rows
        try {
          const out = normalizeForHnsw(source);
          remainingIds.delete(chunkId);
          yield { chunk_id: numericId, vec: out };
        } catch (err) {
          console.warn(`[ann] normalize failed for chunk=${chunkId}:`, err.message);
        }
      }
    }
  }
}

/**
 * Build (or rebuild) the global hot + full HNSW indices from the entire
 * chunks corpus. Idempotent; safe to call after a fresh deploy.
 *
 * Creates an `~/.robotdojo-ann.bak/` snapshot of the existing directory
 * before any write so a Phase-4 rollback can restore the pre-D4 per-topic
 * layout. Per the design (02-design.md §Rollback) the chunk_vec_* DB
 * tables are NEVER deleted.
 *
 * Returns { hot_size, full_size, dim, built_from_count, built_at } on
 * success, or null if no embedded chunks exist.
 */
export async function buildGlobalIndex(db, opts = {}) {
  const {
    totalRam = os.totalmem(),
    targetP99LatencyMs = HOT_TIER_LATENCY_CAP_DEFAULT,
  } = opts;
  const Index = await getIndexClass();
  if (!Index) return null;

  // ── Snapshot for rollback (per design §Rollback). Cheap: only persists
  //    when the source dir actually exists.
  try {
    const src = annBaseDir();
    if (fs.existsSync(src)) {
      const bak = src + '.bak';
      // Defensive: remove a stale .bak from a prior aborted build so the
      // current snapshot is the freshest restore target.
      if (fs.existsSync(bak)) fs.rmSync(bak, { recursive: true, force: true });
      fs.cpSync(src, bak, { recursive: true });
    } else {
      fs.mkdirSync(src, { recursive: true });
    }
  } catch (err) {
    console.warn('[ann] backup snapshot failed (continuing):', err.message);
  }

  // ── Refresh the chunkTopicMap up front so the hot-tier selection knows
  //    every chunk's topic for diagnostics + later post-filter.
  const mapSize = refreshChunkTopicMap(db);
  if (mapSize === 0) return null;

  // ── Count globally embedded chunks; size the hot tier from the global
  //    corpus (not per-topic). hot-tier-sizer uses topicCount=1 because
  //    the budget is whole-corpus.
  const corpusRow = db.prepare(
    'SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1',
  ).get();
  const corpusSize = corpusRow?.n || 0;
  if (corpusSize === 0) return null;

  const hotSize = computeHotTierSize({
    totalRam,
    topicCorpusSize: corpusSize,
    targetP99LatencyMs,
    topicCount: 1, // global single index — full budget at one place
  });

  // ── Collect all vectors + their quality_score so we can sort and pick
  //    the top hotSize for the hot index. The full index gets everything.
  //
  // st_cc25425e: yield to the event loop every YIELD_EVERY vectors so a
  // 10–30 min full rebuild doesn't block app.listen / SSE streams /
  // anything else on the main loop. Cost of yielding: ~1ms per 1000
  // vectors at this granularity (queue + drain). Critical for the script
  // path; non-script callers can pass yieldEveryN=0 to opt out.
  const YIELD_EVERY = typeof opts.yieldEveryN === 'number' ? opts.yieldEveryN : 1000;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  // st_fd14cdd4 — optional chat-yield at the slice boundary. The build is a
  // 10–30 min CPU-bound loop (each ~1000-vector slice is a bounded ~0.5s unit on
  // the live corpus); an additive-budget measurement caught a 16.9s warm-turn
  // spike on the first turn that arrived during a rebuild, because this detached
  // child cannot be SIGTERM'd and had ZERO chat awareness. The SCRIPT path
  // (scripts/build-global-hnsw.js) passes chatYield = a pause-poll on the
  // chat-app-active signal, so the build PAUSES at the next slice boundary while
  // a human has chat open and RESUMES the instant the app closes — the index
  // still builds fully when chat is idle. In-process callers (none today; boot
  // loads, never builds) omit chatYield, so this is a no-op for them. Awaited at
  // the SAME cadence as the event-loop yield so the longest uninterruptible unit
  // stays one slice (~0.5s), well inside the "bound it to a few seconds" rule.
  const chatYield = typeof opts.chatYield === 'function' ? opts.chatYield : null;
  const tick = async (n, phase) => {
    if (YIELD_EVERY > 0 && n > 0 && n % YIELD_EVERY === 0) {
      if (onProgress) onProgress({ phase, n });
      await new Promise(r => setImmediate(r));
      if (chatYield) await chatYield(phase, n);
    }
  };

  const all = [];
  const normalizedById = new Map(); // chunk_id → Float32Array (avoid second read)
  const qsRows = db.prepare(
    'SELECT id, quality_score FROM chunks WHERE embedded = 1',
  ).all();
  const qsById = new Map();
  for (const r of qsRows) qsById.set(r.id, r.quality_score ?? 0);

  let collected = 0;
  for (const { chunk_id, vec } of streamAllVectorsNormalized(db)) {
    normalizedById.set(chunk_id, vec);
    all.push({ chunk_id, score: qsById.get(chunk_id) ?? 0 });
    collected++;
    await tick(collected, 'collect');
  }
  if (all.length === 0) return null;

  // Hot = top hotSize by quality_score (global, not per-topic).
  let hot = null;
  if (hotSize > 0) {
    all.sort((a, b) => b.score - a.score);
    const hotSlice = all.slice(0, Math.min(hotSize, all.length));
    hot = new Index({
      metric: 'cos',
      dimensions: HNSW_DIMS,
      connectivity: USEARCH_M,
      expansion_add: USEARCH_EF_CONSTRUCTION,
      expansion_search: USEARCH_EF_SEARCH,
    });
    let added = 0;
    for (const { chunk_id } of hotSlice) {
      const v = normalizedById.get(chunk_id);
      if (v) hot.add(BigInt(chunk_id), v);
      added++;
      await tick(added, 'build-hot');
    }
    // st_2cd1af73 residue B — atomic save: write to a temp file + rename so a
    // server process that has the previous hot.usearch view()-mmap'd never reads
    // a half-written file mid-search (the SIGABRT race).
    writeIndexAtomically(hot, globalHotPath());
  }

  // Full = every embedded chunk.
  const full = new Index({
    metric: 'cos',
    dimensions: HNSW_DIMS,
    connectivity: USEARCH_M,
    expansion_add: USEARCH_EF_CONSTRUCTION,
    expansion_search: USEARCH_EF_SEARCH,
  });
  let addedFull = 0;
  for (const [chunk_id, vec] of normalizedById) {
    full.add(BigInt(chunk_id), vec);
    addedFull++;
    await tick(addedFull, 'build-full');
  }
  // st_2cd1af73 residue B — atomic save (temp + rename), same reason as hot above.
  writeIndexAtomically(full, globalFullPath());

  const meta = {
    hot_size: hot ? Math.min(hotSize, all.length) : 0,
    full_size: normalizedById.size,
    dim: HNSW_DIMS,
    embedding_model_id: EMBED_MODEL,
    built_from_count: normalizedById.size,
    // Describe the artifact snapshot that was actually published. The live
    // embed daemon may add rows while this build is streaming vectors; freshness
    // drift against the post-build DB count is tracked separately.
    source_embedded_count: normalizedById.size,
    built_from_quality_version: QUALITY_VERSION,
    built_at: Date.now(),
  };
  assertGlobalArtifactsReadyForSidecar(meta);
  writeGlobalSidecar(meta);

  // mmap the full index for the runtime path; keep hot in RAM.
  const fullView = new Index({ metric: 'cos', dimensions: HNSW_DIMS });
  try { fullView.view(globalFullPath()); }
  catch (err) { console.warn('[ann] global view() failed:', err.message); }
  // st_2cd1af73 residue B — atomic guarded swap: install the fully-built holder
  // in one shot (the _reloading flag brackets the reference swap so an
  // interleaving annSearch falls back instead of racing the retired handle).
  installGlobalIndex({ hot, full: fullView, sidecar: meta, dim: HNSW_DIMS });

  return meta;
}

/**
 * Load the global index from disk into the in-process holder. If the
 * sidecar disagrees with the live corpus (scaled count drift, dim mismatch,
 * or stale quality_version), trigger a background rebuild.
 *
 * Returns { loaded: true, hot_size, full_size, dim } or { loaded: false }.
 */
export async function loadGlobalIndex(db, { repairMode = 'spawn', maxAllowedDriftChunks = null } = {}) {
  const Index = await getIndexClass();
  if (!Index) return { loaded: false };
  recoverGlobalArtifactsFromRuntimeSnapshot();
  const allowSpawnRepair = repairMode !== 'none';
  const hasLaunchFreshnessCap = isNonNegativeFiniteNumber(maxAllowedDriftChunks);

  // Pre-check the artifact BEFORE the chunkTopicMap refresh. The map is
  // a 1.2M-row SELECT + Map construction (~500ms CPU); only useful when
  // the global index is actually loaded — the per-topic fallback path
  // doesn't read the map. Without this guard, boots when no artifact
  // exists pay the SELECT cost for no benefit and stall app.listen.
  const sidecar = readGlobalSidecar();
  const hotExists = fs.existsSync(globalHotPath());
  const fullExists = fs.existsSync(globalFullPath());
  const hotRequired = (Number(sidecar?.hot_size) || 0) > 0;
  const integrity = globalSidecarIntegrity(sidecar);
  const missingArtifact = !sidecar || (hotRequired && !hotExists) || !fullExists;
  const incompatibleArtifact = !!sidecar && (Number(sidecar.dim) !== HNSW_DIMS || sidecar.embedding_model_id !== EMBED_MODEL);
  const invalidSidecar = !!sidecar && !missingArtifact && !incompatibleArtifact && !integrity.ok;
  const artifactProblem = missingArtifact
    ? 'artifact_missing'
    : incompatibleArtifact
      ? 'artifact_incompatible'
      : invalidSidecar
        ? 'artifact_invalid_sidecar'
        : '';
  const artifactProblemDetail = invalidSidecar ? integrity.reason : '';

  if (artifactProblem) {
    // Missing/incompatible/internally inconsistent artifact: spawn the detached
    // builder, never build inside boot. The builder is chat-aware and lock-gated,
    // so a fresh install self-heals to the HNSW fast path instead of waiting for
    // an operator or a server restart.
    let spawned = false;
    let deferredReason = '';
    let liveCount = 0;
    try {
      liveCount = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1').get()?.n || 0;
      if (allowSpawnRepair && liveCount > 0) {
        const foreground = annRebuildSpawnDecision(db);
        if (foreground.ok) spawned = maybeSpawnGlobalHnswRebuild();
        else deferredReason = foreground.reason;
      }
    } catch { /* count best-effort; fallback remains safe */ }
    return {
      loaded: false,
      reason: spawned
        ? `global_index_${artifactProblem}_rebuild_spawned${artifactProblemDetail ? `:${artifactProblemDetail}` : ''}`
        : deferredReason
          ? `global_index_${artifactProblem}_foreground_active:${deferredReason}${artifactProblemDetail ? `:${artifactProblemDetail}` : ''}`
          : allowSpawnRepair && liveCount > 0
            ? `global_index_${artifactProblem}_rebuild_locked${artifactProblemDetail ? `:${artifactProblemDetail}` : ''}`
          : `global_index_${artifactProblem}${artifactProblemDetail ? `:${artifactProblemDetail}` : ''}`,
    };
  }

  try {
    const liveCount = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1').get()?.n || 0;
    const freshness = globalIndexFreshness(sidecar, liveCount, {
      maxAllowedNewChunks: maxAllowedDriftChunks,
      requireExactNewChunks: hasLaunchFreshnessCap,
    });
    if (freshness.stale) {
      console.warn(`[ann] global index stale before load: new_chunks=${freshness.newChunks} removed_chunks=${freshness.removedChunks} abs_drift=${freshness.absoluteDriftChunks} threshold=${freshness.growthThreshold} drift=${(freshness.drift * 100).toFixed(2)}% formula_stale=${freshness.formulaStale} — using fallback while repair is requested`);
      const foreground = annRebuildSpawnDecision(db);
      const spawned = allowSpawnRepair && foreground.ok ? maybeSpawnGlobalHnswRebuild() : false;
      return {
        loaded: false,
        reason: spawned
          ? 'global_index_stale_rebuild_spawned'
          : !allowSpawnRepair
            ? 'global_index_stale'
            : foreground.ok
              ? 'global_index_stale_rebuild_locked'
              : `global_index_stale_foreground_active:${foreground.reason}`,
      };
    }
  } catch (err) {
    console.warn('[ann] global index live-count freshness check failed:', err?.message || String(err));
  }

  // Artifact present — populate the post-filter map.
  const mapSize = refreshChunkTopicMap(db);

  try {
    let hot = null;
    if ((Number(sidecar.hot_size) || 0) > 0) {
      hot = new Index({ metric: 'cos', dimensions: sidecar.dim });
      hot.load(globalHotPath());
    }
    const fullView = new Index({ metric: 'cos', dimensions: sidecar.dim });
    try { fullView.view(globalFullPath()); }
    catch (err) { console.warn('[ann] global view() failed:', err.message); }
    // st_2cd1af73 residue B — atomic guarded swap (see installGlobalIndex). The
    // new holder is fully loaded BEFORE the reference swap, so annSearch never
    // observes a half-installed index; _reloading covers the swap instant.
    installGlobalIndex({ hot, full: fullView, sidecar, dim: sidecar.dim });
  } catch (err) {
    // Load failed on a corrupt artifact. Treat corruption like absence: the DB
    // vector tables are the source of truth, so launch should start a repair
    // instead of asking the operator to rebuild by hand.
    console.warn('[ann] global index load failed:', err.message);
    let spawned = false;
    let deferredReason = '';
    try {
      const liveCount = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1').get()?.n || 0;
      if (allowSpawnRepair && liveCount > 0) {
        const foreground = annRebuildSpawnDecision(db);
        if (foreground.ok) spawned = maybeSpawnGlobalHnswRebuild();
        else deferredReason = foreground.reason;
      }
    } catch { /* count best-effort; fallback remains safe */ }
    return {
      loaded: false,
      reason: spawned
        ? 'global_index_load_error_rebuild_spawned'
        : deferredReason
          ? `global_index_load_error_foreground_active:${deferredReason}`
          : 'global_index_load_error_rebuild_locked',
      error: err.message,
    };
  }

  // Stale-check: emit a hint to stderr so ops sees that a rebuild is due,
  // AND spawn the rebuild script as a detached non-blocking child process.
  // The current index keeps serving requests while the rebuild runs; the
  // next loadGlobalIndex() call after the rebuild picks up the fresh
  // artifact.
  //
  // st_d142f701 AC14: previously only logged a hint and required operator
  // intervention. The .building lock file (artifact path + .building suffix)
  // gates concurrent spawns: if it exists and is fresher than 10 min, skip
  // — otherwise spawn. Stale-lock recovery is automatic: after 10 min the
  // next stale detection retries even if a previous build crashed without
  // cleaning the lock.
  try {
    const liveCount = db.prepare(
      'SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1',
    ).get()?.n || 0;
    const freshness = globalIndexFreshness(sidecar, liveCount);
    if (freshness.stale) {
      console.warn(`[ann] global index stale: new_chunks=${freshness.newChunks} threshold=${freshness.growthThreshold} drift=${(freshness.drift * 100).toFixed(2)}% formula_stale=${freshness.formulaStale} — spawning background rebuild`);
      maybeSpawnGlobalHnswRebuild();
    }
  } catch { /* stale-check is best-effort */ }

  return {
    loaded: true,
    hot_size: sidecar.hot_size,
    full_size: sidecar.full_size,
    dim: sidecar.dim,
    chunkTopicMap_size: mapSize,
  };
}

/**
 * Diagnostic snapshot for the global index. Returns null if not loaded.
 */
export function getGlobalStatus() {
  if (!_globalIndex) return null;
  const diskSidecar = readGlobalSidecar();
  const staleOnDisk = globalIndexStaleOnDisk(_globalIndex, diskSidecar);
  return {
    loaded: true,
    hot_size: _globalIndex.sidecar?.hot_size ?? 0,
    full_size: _globalIndex.sidecar?.full_size ?? 0,
    built_at: _globalIndex.sidecar?.built_at ?? null,
    dim: _globalIndex.dim,
    chunk_topic_map_size: _chunkTopicMap.size,
    stale_on_disk: staleOnDisk,
    disk_built_at: diskSidecar?.built_at ?? null,
    disk_built_from_count: diskSidecar?.built_from_count ?? null,
  };
}

function globalIndexStaleOnDisk(holder = _globalIndex, diskSidecar = readGlobalSidecar()) {
  if (!holder) return false;
  if (!diskSidecar) return true;
  if (!globalSidecarIntegrity(diskSidecar).ok) return true;
  const hotRequired = (Number(diskSidecar?.hot_size) || 0) > 0;
  if ((hotRequired && !fs.existsSync(globalHotPath())) || !fs.existsSync(globalFullPath())) return true;
  const loaded = holder.sidecar || {};
  if (!globalSidecarIntegrity(loaded).ok) return true;
  const liveMapSize = _chunkTopicMap?.size || 0;
  if (liveMapSize > 0 && globalIndexFreshness(loaded, liveMapSize).stale) return true;
  return Number(diskSidecar.built_at || 0) > Number(loaded.built_at || 0)
    || Number(diskSidecar.built_from_count || 0) !== Number(loaded.built_from_count || 0)
    || Number(diskSidecar.full_size || 0) !== Number(loaded.full_size || 0)
    || diskSidecar.embedding_model_id !== loaded.embedding_model_id
    || diskSidecar.built_from_quality_version !== loaded.built_from_quality_version
    || Number(diskSidecar.dim || 0) !== Number(loaded.dim || holder.dim || 0);
}

/**
 * Run a global ANN search. One HNSW pass against the hot index; falls
 * back to the full index when min distance > HOT_TIER_FALLBACK_THRESHOLD.
 *
 * When `opts.topicFilter` is a non-empty array, results are post-filtered
 * via the in-memory chunkTopicMap (O(1) per candidate). The caller
 * should overscan (`k * factor`) to compensate for filter loss.
 *
 * Returns null when:
 *   - usearch binding unavailable
 *   - global index not loaded (call loadGlobalIndex(db) first)
 *   - queryVec is not a Float32Array of length HNSW_DIMS
 *
 * @param {Float32Array} queryVec - already normalized to HNSW_DIMS
 * @param {number} [k=10]
 * @param {object} [opts]
 * @param {string[]} [opts.topicFilter] - restrict results to these topics
 * @returns {{ keys: BigInt[], distances: number[] } | null}
 */
export function annSearch(queryVec, k = 10, opts = {}) {
  // st_2cd1af73 residue B — NEVER search an index that is mid-reload/swap. The
  // global-index reload flips _reloading around the reference swap; while it is
  // set we return null so the caller falls back to sqlite-vec/FTS instead of
  // touching a handle that may be getting retired (the SIGABRT race). Pin the
  // holder into a local const up front so the rest of this synchronous call
  // reads ONE stable reference even if a later tick swaps the module field.
  if (_reloading) return null;
  const idx = _globalIndex;
  if (!idx) return null;
  if (globalIndexStaleOnDisk(idx)) return null;
  if (!(queryVec instanceof Float32Array)) return null;
  if (queryVec.length !== idx.dim) return null;

  const topicFilter = Array.isArray(opts.topicFilter) && opts.topicFilter.length > 0
    ? new Set(opts.topicFilter)
    : null;

  // Hot tier first. If we have a topic filter, overscan enough global
  // neighbors that small real topics are not probabilistically filtered away.
  // A fixed topicsTotal/topicsInScope factor works for similarly sized topics,
  // but fails for launch-real scopes like robot-dojo: 28 chunks inside a
  // 78K-vector index. The topic counts are refreshed with the chunkTopicMap, so
  // this remains a single HNSW pass with no per-topic SQL on the hot path.
  const overscanK = topicFilter
    ? topicFilterOverscanK(k, topicFilter, idx.sidecar?.full_size)
    : k;

  // Track this search as in-flight for the whole native-call span so a reload
  // can observe that a handle is being read. annSearch is synchronous, so the
  // ++/-- bracket the entire .search() work; the finally guarantees the counter
  // is restored even if a .search() throws.
  _searchInFlight++;
  try {
    let hot = null;
    if (idx.hot) {
      try {
        hot = idx.hot.search(queryVec, overscanK);
      } catch (err) {
        console.warn('[ann] global hot search failed:', err.message);
      }
    }

    if (hot && hot.distances && hot.distances.length > 0) {
      const minDist = hot.distances[0];
      if (minDist <= HOT_TIER_FALLBACK_THRESHOLD) {
        return applyTopicFilter(hot, topicFilter, k);
      }
    }

    if (idx.full) {
      try {
        const full = idx.full.search(queryVec, overscanK);
        if (full && full.distances && full.distances.length > 0) {
          return applyTopicFilter(full, topicFilter, k);
        }
      } catch (err) {
        console.warn('[ann] global full search failed:', err.message);
      }
    }
    if (hot) return applyTopicFilter(hot, topicFilter, k);
    return null;
  } finally {
    _searchInFlight--;
  }
}

/**
 * Filter usearch results by the in-memory chunkTopicMap and truncate to k.
 * When topicFilter is null, this is a fast no-op formatResult().
 */
function applyTopicFilter(r, topicFilter, k) {
  if (!topicFilter) {
    const formatted = formatResult(r);
    if (formatted.keys.length > k) {
      formatted.keys = formatted.keys.slice(0, k);
      formatted.distances = formatted.distances.slice(0, k);
    }
    return formatted;
  }
  const keys = [];
  const distances = [];
  const rawKeys = Array.from(r.keys || []);
  const rawDist = Array.from(r.distances || []);
  for (let i = 0; i < rawKeys.length && keys.length < k; i++) {
    const id = Number(rawKeys[i]);
    const topic = _chunkTopicMap.get(id);
    if (topic && topicFilter.has(topic)) {
      keys.push(rawKeys[i]);
      distances.push(rawDist[i]);
    }
  }
  return { keys, distances };
}

function topicFilterOverscanK(k, topicFilter, fullSize) {
  const requested = Math.max(1, Math.floor(Number(k) || 1));
  const base = Math.max(
    requested * 2,
    requested * Math.ceil(TOPIC_COUNT_DEFAULT / Math.max(topicFilter.size, 1)),
  );
  const total = Math.max(
    Number(fullSize) || 0,
    _chunkTopicMap.size,
    base,
  );
  let scopedCount = 0;
  for (const topic of topicFilter) {
    scopedCount += _chunkTopicCounts.get(topic) || 0;
  }
  if (scopedCount <= 0 || total <= 0) return Math.min(base, total);

  const scarcityFactor = (() => {
    const raw = Number(process.env.ROBOTDOJO_ANN_TOPIC_FILTER_OVERSCAN_FACTOR || '');
    return Number.isFinite(raw) && raw >= 1 ? raw : 3;
  })();
  const scarcityAdjusted = Math.ceil((requested * total * scarcityFactor) / scopedCount);
  const maxOverscan = (() => {
    const raw = Number(process.env.ROBOTDOJO_ANN_TOPIC_FILTER_OVERSCAN_MAX || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5000;
  })();
  return Math.min(total, Math.max(base, Math.min(scarcityAdjusted, maxOverscan)));
}

// ─── Test hooks for the unified-HNSW test (tests/chat/unified-hnsw.test.js) ─

/**
 * Test-only: install a synthetic global index directly. Lets the unit test
 * build a small in-memory index without writing files. Production code MUST
 * NOT call this — use buildGlobalIndex/loadGlobalIndex instead.
 *
 * @param {object} entry { hot, full, sidecar?, dim }
 * @param {Map<number,string>} [chunkTopicMap]
 */
export function _installGlobalIndexForTest(entry, chunkTopicMap) {
  const meta = {
    hot_size: entry?.sidecar?.hot_size ?? 0,
    full_size: entry?.sidecar?.full_size ?? 0,
    dim: entry?.sidecar?.dim ?? entry?.dim ?? HNSW_DIMS,
    embedding_model_id: entry?.sidecar?.embedding_model_id ?? EMBED_MODEL,
    built_from_count: entry?.sidecar?.built_from_count ?? entry?.sidecar?.full_size ?? 0,
    source_embedded_count: entry?.sidecar?.source_embedded_count ?? entry?.sidecar?.built_from_count ?? entry?.sidecar?.full_size ?? 0,
    built_from_quality_version: entry?.sidecar?.built_from_quality_version ?? QUALITY_VERSION,
    built_at: entry?.sidecar?.built_at ?? Date.now(),
  };
  _globalIndex = { ...entry, sidecar: meta, dim: entry?.dim ?? meta.dim };
  if (chunkTopicMap instanceof Map) {
    _chunkTopicMap = chunkTopicMap;
    const counts = new Map();
    for (const topic of chunkTopicMap.values()) {
      counts.set(topic, (counts.get(topic) || 0) + 1);
    }
    _chunkTopicCounts = counts;
  }
  try {
    fs.mkdirSync(globalDir(), { recursive: true });
    if (!fs.existsSync(globalHotPath())) fs.writeFileSync(globalHotPath(), 'test-hot');
    if (!fs.existsSync(globalFullPath())) fs.writeFileSync(globalFullPath(), 'test-full');
    writeGlobalSidecar(meta);
  } catch { /* test hook best-effort only */ }
}
export function _clearGlobalIndexForTest() {
  _globalIndex = null;
  _chunkTopicMap = new Map();
  _chunkTopicCounts = new Map();
}

function formatResult(r) {
  const keys = Array.from(r.keys || []);
  const distances = Array.from(r.distances || []);
  return { keys, distances };
}

/**
 * Diagnostic snapshot for one topic. Returns null when the topic has
 * no in-process state.
 */
export function getTopicStatus(topic) {
  const entry = indexStore.get(topic);
  if (!entry) return null;
  return {
    loaded: true,
    hot_size: entry.sidecar?.hot_size ?? 0,
    full_size: entry.sidecar?.full_size ?? 0,
    built_at: entry.sidecar?.built_at ?? null,
    quality_version: entry.sidecar?.built_from_quality_version ?? null,
  };
}

/**
 * Test hook — wipe in-process state. Used between unit tests to start fresh.
 * Never call from product code.
 */
export function _clearIndexStore() {
  indexStore.clear();
}
