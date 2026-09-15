#!/usr/bin/env node
/**
 * scripts/ingest/05-reclassify-chunks.js — st_8c7b7a6b
 *
 * Iterative chunk → T2-topic reclassification using cosine similarity to
 * each T2's description_embedding (the "Round 2" path designed in
 * migration 058 and referenced throughout the codebase, never built
 * until now).
 *
 * INPUT INVARIANT (Pass 0, given):
 *   Every chunk already has an initial topic from the ingest pipeline (often a
 *   doc-type default or keyword guess — see route-llm-export.js / the drop-folder
 *   routers). That initial T1 is a starting point, not a verdict.
 *
 * RE-DERIVES T1 (st_fcdbe84f AC3): in the full-corpus pass every chunk is
 *   compared against EVERY T2 across the WHOLE ontology, not just its current
 *   T1's children, so a chunk can migrate across T1 (e.g. an import dumped in
 *   `personal` moving to `work/current-role`). Users reshape the ontology over
 *   time, so placement must keep following content. A hysteresis margin
 *   (RECLASSIFY_REDERIVE_MARGIN) means a chunk only moves when the best global
 *   T2 beats its CURRENT topic by that margin — preventing thrashing of chunks
 *   that are already well placed.
 *
 * ALGORITHM:
 *   Pass 1 (full corpus): For every embedded chunk, compute cosine similarity
 *           from its embedding to every T2's description_embedding (global
 *           candidates). If the best global T2 clears THRESHOLD and beats the
 *           chunk's current topic by RECLASSIFY_REDERIVE_MARGIN, reassign:
 *           UPDATE chunks.topic + INSERT vec into chunk_vec_<newT2> + DELETE vec
 *           from chunk_vec_<old>. All three writes in one tx. (Scoped/edit-driven
 *           runs via RECLASSIFY_SCOPE_T1/T2 stay narrow — one branch only.)
 *
 *   Pass 2+: For each T2 that gained chunks in Pass 1, recompute its
 *            description_embedding as a centroid of [original
 *            description_embedding, mean of newly-assigned chunk vectors].
 *            Re-run Pass 1 on chunks still in T1. Stop when a pass moves
 *            fewer than CONVERGE_FRACTION of remaining T1 chunks.
 *
 *   Pass N+1: For each T2 that changed in any pass, call
 *             generateTopicContext(slug) to rewrite context_md from the
 *             now-correctly-assigned chunks. This is the "rewrite the
 *             topic-md and left-nav description" finishing step.
 *
 * RUN:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 \
 *     ANTHROPIC_API_KEY="$(security find-generic-password -s 'robotdojo-ANTHROPIC_API_KEY' -w)" \
 *     node scripts/ingest/05-reclassify-chunks.js [--dry-run] [--no-regen] [--max-seconds N]
 *
 * --max-seconds N (st_2cd1af73): bound a single run to ~N seconds of wall clock.
 *   The deadline is polled at SAFE BOUNDARIES ONLY — between source topics inside
 *   a pass and between passes — never mid-transaction, so a slice always stops on
 *   committed state. Every move is already committed by applyMovesBatch the moment
 *   its source topic finishes, so a deadline-stopped slice loses no work and the
 *   next maintenance fire resumes from wherever `personal` (and the rest) still sit.
 *   This is what lets the full-corpus reclassify ride maintenance as a bounded phase
 *   instead of a single unbounded multi-hour pass. Without --max-seconds the script
 *   runs to convergence as before (the manual/edit-driven paths are unchanged).
 *
 * INTELLIGENCE_TIER: extraction (no LLM calls in Pass 1+; Pass N+1 uses
 * Sonnet via generateTopicContext but that's gated by --no-regen). The
 * bounded phase always passes --no-regen, so the bounded path is cosine-only.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import db from '../../lib/db.js';
import { inferTopicFromContent } from '../../lib/conversations.js';
import { EMBED_DIM, EMBED_MODEL, contentHash, embeddingSignature } from '../../lib/rag.js';
import { generateTopicContext, generateTopicEmbedding } from '../../lib/topic-context.js';
import { getActivitySignal, chatAppActiveDecision } from '../../lib/request-observer.js';
import {
  deleteVecRowForTopic,
  openSplitVectorStore,
  readVecRowForTopic,
  tableExists,
  upsertVecRowForTopic,
  vectorStoreForTopic,
} from '../../lib/split-vector-store.js';
import {
  NEEDS_ROUTING_TOPIC,
  PERSONAL_TOPIC,
  personalScopeNeedsRoutingSourceType,
  topicSlugIsClassifiable,
} from '../../lib/topic-routing-policy.js';
import { topicForSourceAccount } from '../../lib/topic-source-routing.js';

const isDryRun = process.argv.includes('--dry-run');
const skipRegen = process.argv.includes('--no-regen');
const resultFile = argValue('--result-file') || process.env.ROBOTDOJO_RECLASSIFY_RESULT_FILE || null;

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function atomicWriteJson(path, payload) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}

function writeReclassifyResult(payload) {
  atomicWriteJson(resultFile, {
    ok: true,
    dry_run: isDryRun,
    skip_regen: skipRegen,
    threshold: THRESHOLD,
    max_passes: MAX_PASSES,
    written_at: new Date().toISOString(),
    ...payload,
  });
}

// st_fd14cdd4 AC9 — bound the WRITE GRANULARITY of one source topic.
//
// THE CONTENTION BUG THIS FIXES: foldBatch() used to call applyMovesBatch() with
// ALL of a source topic's moves in ONE transaction. For `personal` (the ~99% pile,
// hundreds of thousands of chunks) that single transaction held the single SQLite
// writer for the WHOLE topic — measured 7.7–12s of chat-turn wait while
// RECLASSIFY_CHUNKS ran, because the --max-seconds deadline is only polled at
// source-topic boundaries and `personal` is ONE topic. The slice cut never landed
// inside it.
//
// FIX: flush each source topic's moves in bounded sub-batches of MOVE_BATCH_SIZE,
// and BETWEEN sub-batches (a) poll the slice deadline and (b) yield to chat the
// instant the chat app opens. Each applyMovesBatch transaction now writes at most
// MOVE_BATCH_SIZE rows, so the writer-hold per commit is small (well under ~1s) and
// a chat turn never waits on a giant topic-wide transaction. The moves already
// committed are durable; the rest of the topic resumes on the next maintenance
// fire (the same idempotent-resume contract the source-topic boundary cut relies
// on). Tunable; 250 rows ≈ a few hundred ms of vec0 writes — small enough to yield
// fast, large enough that the per-transaction overhead stays amortized.
const MOVE_BATCH_SIZE = Number(process.env.ROBOTDOJO_RECLASSIFY_MOVE_BATCH_SIZE) || 250;
const SCAN_BATCH_SIZE = Number(process.env.ROBOTDOJO_RECLASSIFY_SCAN_BATCH_SIZE) || 1000;

// st_fd14cdd4 AC9 — is the chat app open right now? RECLASSIFY_CHUNKS is the
// off-process maintenance writer that most contends chat (extraction tier, no LLM
// — reading the cross-process activity row is the deterministic yield signal the
// embedder and maintenance worker already use). When the chat app is open, the
// pass stops at the next sub-batch boundary so the writer is free before the user's
// first turn — the same chat-app-active signal the embedder drops its lanes on.
// Always false when --max-seconds was not passed (a manual/edit-driven run is not
// gated; it has no maintenance worker yielding above it).
const chatAppOpen = () => SLICE_DEADLINE_MS !== null && chatAppActiveDecision(getActivitySignal(db));

// st_2cd1af73 — optional per-run wall-clock bound. Returns the deadline epoch ms,
// or null when --max-seconds was not passed (run-to-convergence, legacy behavior).
const SLICE_DEADLINE_MS = (() => {
  const i = process.argv.indexOf('--max-seconds');
  if (i < 0) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Date.now() + Math.floor(n) * 1000 : null;
})();
/** True once the per-run wall clock has elapsed. Always false when --max-seconds
 *  was not passed, so the convergence loop is unchanged on the unbounded path. */
const sliceExpired = () => SLICE_DEADLINE_MS !== null && Date.now() >= SLICE_DEADLINE_MS;

// Tuning knobs — conservative defaults so we don't move chunks on weak
// matches. Bump via env when iterating empirically.
const THRESHOLD = Number(process.env.RECLASSIFY_THRESHOLD || 0.55);
// "2x through": categorize → refresh topic embeddings → recategorize. Convergence
// usually stops earlier; this is the cap.
const MAX_PASSES = Number(process.env.RECLASSIFY_MAX_PASSES || 2);
const CONVERGE_FRACTION = Number(process.env.RECLASSIFY_CONVERGE_FRACTION || 0.01);
// Hysteresis: a chunk only re-homes when the best global T2 beats its CURRENT
// topic by this margin. Stops well-placed chunks from churning across T1.
const REDERIVE_MARGIN = Number(process.env.RECLASSIFY_REDERIVE_MARGIN || 0.05);
const RECLASSIFY_BUSY_TIMEOUT_MS = Math.max(5000, Number(process.env.RECLASSIFY_BUSY_TIMEOUT_MS || 120000));
const RECLASSIFY_BUSY_RETRIES = Math.max(0, Number(process.env.RECLASSIFY_BUSY_RETRIES || 8));

db.pragma(`busy_timeout = ${RECLASSIFY_BUSY_TIMEOUT_MS}`);
const embeddingsDb = openSplitVectorStore({ busyTimeoutMs: RECLASSIFY_BUSY_TIMEOUT_MS });

// ── Helpers ───────────────────────────────────────────────────────────────

function isSqliteBusy(err) {
  return err?.code === 'SQLITE_BUSY'
    || err?.code === 'SQLITE_LOCKED'
    || /SQLITE_(BUSY|LOCKED)|database is locked|database locked/i.test(err?.message || String(err || ''));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function busyRetry(label, fn) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RECLASSIFY_BUSY_RETRIES; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusy(err) || attempt >= RECLASSIFY_BUSY_RETRIES) throw err;
      lastErr = err;
      const waitMs = Math.min(15000, 750 * Math.pow(1.7, attempt));
      console.warn(`[reclassify] SQLITE_BUSY during ${label}; retry ${attempt + 1}/${RECLASSIFY_BUSY_RETRIES} after ${Math.round(waitMs)}ms`);
      sleepSync(waitMs);
    }
  }
  throw lastErr;
}

function cosine(a, b) {
  // Both Float32Array, same length expected. Local Snowflake vectors are
  // near-unit-norm; normalize defensively anyway.
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Decide where a chunk should be re-homed (st_fcdbe84f AC3). Pure — no DB — so
 * the re-derivation logic is unit-testable without sqlite-vec.
 *
 * @param {Float32Array} vec               the chunk's embedding
 * @param {{slug:string, vec:Float32Array}[]} candidates  ALL T2s (whole ontology)
 * @param {string} currentSlug             the chunk's current topic
 * @param {Float32Array|null} currentVec   the current topic's description embedding (or null)
 * @returns {{slug:string, sim:number}|null}  target T2, or null to leave in place
 */
export function chooseReclassifyTarget(
  vec, candidates, currentSlug, currentVec,
  { threshold = THRESHOLD, margin = REDERIVE_MARGIN } = {},
) {
  let best = { slug: null, sim: -1 };
  for (const c of candidates) {
    if (!c.vec) continue;
    const s = cosine(vec, c.vec);
    if (s > best.sim) best = { slug: c.slug, sim: s };
  }
  if (!best.slug || best.slug === currentSlug) return null;
  if (best.sim < threshold) return null;
  // Hysteresis: require a margin of improvement over the current placement so a
  // chunk that is already well placed (incl. across a different T1) does not churn.
  const currentSim = currentVec ? cosine(vec, currentVec) : -1;
  if (best.sim - currentSim < margin) return null;
  return best;
}

export function chooseReclassifyFallbackTarget({ currentSlug, sourceType } = {}) {
  if (currentSlug === PERSONAL_TOPIC && personalScopeNeedsRoutingSourceType(sourceType)) {
    return {
      slug: NEEDS_ROUTING_TOPIC,
      sim: null,
      fallback: 'personal_import_needs_routing',
    };
  }
  return null;
}

function loadTopics() {
  const rows = db.prepare(
    'SELECT slug, label, parent_slug, description_embedding FROM user_topics'
  ).all();
  const t1 = new Map();   // slug → row
  const t2 = new Map();   // slug → row
  for (const r of rows) {
    if (!topicSlugIsClassifiable(r.slug)) continue;
    if (r.parent_slug) t2.set(r.slug, r);
    else t1.set(r.slug, r);
  }
  return { t1, t2, all: new Map(rows.map(r => [r.slug, r])) };
}

function deserializeEmbedding(buf) {
  if (!buf || !(buf instanceof Buffer || buf instanceof Uint8Array)) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function fetchVectorForChunk(chunkId, topicSlug) {
  const row = readVecRowForTopic(topicSlug, chunkId, {
    database: db,
    embeddingsDb,
    requireReadable: true,
  });
  return row?.embedding ? deserializeEmbedding(row.embedding) : null;
}

// st_2cd1af73 — chunks carries UNIQUE(topic, source_type, source_id, chunk_index).
// When the reclassifier moves a chunk to a topic that ALREADY holds a row with the
// same (source_type, source_id, chunk_index) — a different `id`, but identical
// content identity — the `UPDATE chunks SET topic` collides on that UNIQUE and
// SQLite raises "UNIQUE constraint failed: chunks.topic, ...". That is not a fault:
// it means this source chunk is duplicate content already correctly homed at the
// target. The right resolution is to DELETE the source row (and its vec entry)
// rather than move it, and count it as deduped. This predicate decides that case.
//
// Returns the conflicting target row's id (the survivor) when a collision exists,
// else null. We compare ON the source row's OWN identity tuple so a chunk only
// dedupes against a genuine content twin, never against an unrelated chunk.
const dedupeConflictStmt = db.prepare(`
  SELECT t.id AS id
    FROM chunks AS s
    JOIN chunks AS t
      ON t.topic = ?
     AND t.source_type = s.source_type
     AND t.source_id   = s.source_id
     AND t.chunk_index = s.chunk_index
     AND t.id <> s.id
   WHERE s.id = ?
   LIMIT 1
`);
export function dedupeConflictId(toTopic, sourceId) {
  const row = dedupeConflictStmt.get(toTopic, sourceId);
  return row ? row.id : null;
}

function moveChunkToTopic(chunkId, fromTopic, toTopic, vec) {
  // Atomic transaction: insert vec into new table, delete from old, update flag.
  const buf = Buffer.from(vec.buffer);
  const chunkMeta = db.prepare('SELECT content, content_hash FROM chunks WHERE id = ?');
  const updateMovedChunk = db.prepare(`
    UPDATE chunks
       SET topic = ?,
           embedding_model_id = ?,
           embedding_dim = ?,
           embedding_signature = ?
     WHERE id = ?
  `);
  const restoreMovedEmbedding = db.prepare(`
    UPDATE chunks
       SET embedded = 1,
           content_hash = ?,
           embedding_model_id = ?,
           embedding_dim = ?,
           embedding_signature = ?,
           embedded_at = datetime('now')
     WHERE id = ?
  `);
  const tx = db.transaction(() => {
    // st_2cd1af73 dedupe: if an identical-identity row already lives at the target,
    // this source chunk is a duplicate — delete it (and its old vec) instead of
    // moving it onto the UNIQUE collision. (Legacy per-chunk path; the live bounded
    // slice runs through applyMovesBatch, which reports the deduped count.)
    if (dedupeConflictId(toTopic, chunkId) !== null) {
      deleteVecRowForTopic(fromTopic, chunkId, { database: db, embeddingsDb });
      db.prepare('DELETE FROM chunks WHERE id = ?').run(chunkId);
      return;
    }
    upsertVecRowForTopic(toTopic, chunkId, buf, { database: db, embeddingsDb, dim: EMBED_DIM });
    deleteVecRowForTopic(fromTopic, chunkId, { database: db, embeddingsDb });
    const chunk = chunkMeta.get(chunkId) || {};
    const hash = chunk.content_hash || contentHash(chunk.content || '');
    const nextSignature = hash
      ? embeddingSignature({ content_hash: hash, topic: toTopic, modelId: EMBED_MODEL, dim: EMBED_DIM })
      : null;
    updateMovedChunk.run(toTopic, EMBED_MODEL, EMBED_DIM, nextSignature, chunkId);
    restoreMovedEmbedding.run(hash, EMBED_MODEL, EMBED_DIM, nextSignature, chunkId);
  });
  tx();
}

/**
 * Apply a list of chunk moves in a single transaction. ~100x faster
 * than calling moveChunkToTopic per-chunk because we skip the
 * per-statement overhead. Prepared statements are cached across the
 * batch via the closures. Tables are CREATE-IF-NOT-EXISTS once per
 * unique target.
 *
 * st_2cd1af73 DEDUPE: a move whose target topic already holds a row with the same
 * (source_type, source_id, chunk_index) would crash the whole batch on
 * `UNIQUE constraint failed: chunks.topic, chunks.source_type, chunks.source_id,
 * chunks.chunk_index` (observed live at this function). Such a source chunk is
 * duplicate content already correctly homed at the target, so instead of moving it
 * onto the collision we DELETE the source row + its old vec entry and count it as
 * deduped. The dedupe is decided per-move BEFORE writing the target vec, so we never
 * leave an orphan vec row for a chunk we then delete. Returns a `{moved, deduped}`
 * tally so the pass/run stats can report both.
 *
 * @param {Array<{id:number, fromTopic:string, toTopic:string, vec:Float32Array}>} moves
 * @returns {{moved:number, deduped:number, movedByTarget:Map<string,number>}}
 *   movedByTarget counts ONLY chunks that actually moved to each target — a deduped
 *   chunk is excluded because the target's identical twin was already there, so the
 *   target's content did not change and it does not need a context refresh on that
 *   chunk's account.
 */
export function applyMovesBatch(moves) {
  const chunkMeta = db.prepare('SELECT content, content_hash FROM chunks WHERE id = ?');
  const updTopic = db.prepare(`
    UPDATE chunks
       SET topic = ?,
           embedding_model_id = ?,
           embedding_dim = ?,
           embedding_signature = ?
     WHERE id = ?
  `);
  const restoreEmbedded = db.prepare(`
    UPDATE chunks
       SET embedded = 1,
           content_hash = ?,
           embedding_model_id = ?,
           embedding_dim = ?,
           embedding_signature = ?,
           embedded_at = datetime('now')
     WHERE id = ?
  `);
  const delChunk = db.prepare('DELETE FROM chunks WHERE id = ?');
  let moved = 0;
  let deduped = 0;
  const movedByTarget = new Map();
  const tx = db.transaction(() => {
    for (const m of moves) {
      const idStr = String(m.id);

      // st_2cd1af73 dedupe: an identical-identity row already at the target means
      // this source chunk is a duplicate. Delete the source chunk + its old vec
      // instead of moving it onto the UNIQUE collision. Decided before any target
      // write so no orphan target vec is created.
      if (dedupeConflictId(m.toTopic, m.id) !== null) {
        deleteVecRowForTopic(m.fromTopic, idStr, { database: db, embeddingsDb });
        delChunk.run(m.id);
        deduped++;
        continue;
      }

      const buf = Buffer.from(m.vec.buffer);
      upsertVecRowForTopic(m.toTopic, idStr, buf, { database: db, embeddingsDb, dim: EMBED_DIM });
      deleteVecRowForTopic(m.fromTopic, idStr, { database: db, embeddingsDb });
      const chunk = chunkMeta.get(m.id) || {};
      const hash = chunk.content_hash || contentHash(chunk.content || '');
      const nextSignature = hash
        ? embeddingSignature({ content_hash: hash, topic: m.toTopic, modelId: EMBED_MODEL, dim: EMBED_DIM })
        : null;
      updTopic.run(m.toTopic, EMBED_MODEL, EMBED_DIM, nextSignature, m.id);
      restoreEmbedded.run(hash, EMBED_MODEL, EMBED_DIM, nextSignature, m.id);
      moved++;
      movedByTarget.set(m.toTopic, (movedByTarget.get(m.toTopic) || 0) + 1);
    }
  });
  busyRetry(`move batch (${moves.length} chunks)`, () => tx());
  return { moved, deduped, movedByTarget };
}

// ── Pass 1+ ───────────────────────────────────────────────────────────────

async function ensureTopicEmbeddings(topics) {
  // Make sure every T2 has a description_embedding. Without it we can't
  // do cosine similarity. Skip topics whose description is empty.
  let regenerated = 0;
  for (const [slug, row] of topics.t2) {
    if (row.description_embedding) continue;
    if (isDryRun) {
      console.warn(`  skip ${slug}: missing description_embedding (dry-run is read-only)`);
      continue;
    }
    try {
      const vec = await generateTopicEmbedding(slug, db);
      if (vec) {
        row.description_embedding = Buffer.from(vec.buffer);
        regenerated++;
        console.log(`  generated description_embedding for ${slug}`);
      }
    } catch (e) {
      console.warn(`  skip ${slug}: ${e.message}`);
    }
  }
  if (regenerated > 0) console.log(`[reclassify] generated ${regenerated} description_embeddings`);
}

function reclassifyPass(topics, passNum) {
  // Reload topic embeddings (Pass 2+ has them refreshed by recomputeTopicEmbedding)
  for (const [slug, row] of topics.t2) {
    const fresh = db.prepare('SELECT description_embedding FROM user_topics WHERE slug=?').get(slug);
    row.description_embedding = fresh?.description_embedding;
  }

  // Scope env (set by scripts/topic-edit-watcher.js): when present, only
  // consider chunks in T1_SCOPE and only the named T2 as candidate target.
  // This keeps an "edit-driven" recategorize narrow — just walk the branch
  // that changed, not the whole corpus.
  const scopeT1 = process.env.RECLASSIFY_SCOPE_T1 || '';
  const scopeT2 = process.env.RECLASSIFY_SCOPE_T2 || '';

  // Build a map: T1 parent slug → [T2 candidates]
  const t2sByParent = new Map();
  for (const [slug, row] of topics.t2) {
    if (!row.description_embedding) continue;
    if (scopeT2 && slug !== scopeT2) continue; // narrow to one T2
    const k = row.parent_slug;
    if (!t2sByParent.has(k)) t2sByParent.set(k, []);
    t2sByParent.get(k).push({ slug, vec: deserializeEmbedding(row.description_embedding) });
  }
  // For 'general' (and other parent-less topics that hold chunks), candidates = all T2s.
  const allT2Candidates = [];
  for (const [slug, row] of topics.t2) {
    if (!row.description_embedding) continue;
    if (scopeT2 && slug !== scopeT2) continue;
    allT2Candidates.push({ slug, vec: deserializeEmbedding(row.description_embedding) });
  }

  let moved = 0;
  let deduped = 0; // st_2cd1af73 — chunks deleted as duplicates already homed at target
  let considered = 0;
  let stoppedEarly = false; // st_2cd1af73: set when the --max-seconds deadline cut the pass short
  const movedByTarget = new Map();
  // Source topics that LOST chunks — their context.md is now stale too, so they
  // get regenerated alongside the gaining topics (st_fcdbe84f AC5).
  const affectedSources = new Set();

  // st_2cd1af73 — fold one applyMovesBatch result (or, in dry-run, the candidate
  // moves) into the pass tallies. The batch is authoritative: it splits real moves
  // from dedupes and reports per-target moves, so movedByTarget never counts a
  // deduped chunk as a target gain. Dry-run never writes, so every candidate counts
  // as a would-be move there.
  //
  // st_fd14cdd4 AC9 — flush in BOUNDED sub-batches (MOVE_BATCH_SIZE) so one source
  // topic's writer-hold is split into small commits instead of one topic-wide
  // transaction (the `personal` 7.7–12s contention). BETWEEN sub-batches, poll the
  // slice deadline AND the chat-app-open signal: either one stops the flush at a
  // committed boundary and sets `stoppedEarly` so the run reports a partial slice and
  // the next fire resumes. Returns true when the flush was cut short (the caller then
  // breaks out of the source-topic loop — no point scanning more topics this slice).
  const foldBatch = (candidateMoves) => {
    if (!candidateMoves.length) return false;
    affectedSources.add(candidateMoves[0].fromTopic);
    if (isDryRun) {
      for (const m of candidateMoves) {
        moved++;
        movedByTarget.set(m.toTopic, (movedByTarget.get(m.toTopic) || 0) + 1);
      }
      return false;
    }
    for (let off = 0; off < candidateMoves.length; off += MOVE_BATCH_SIZE) {
      // Yield BEFORE opening the next sub-batch transaction (never mid-transaction —
      // a started commit always finishes, so the writer-hold is bounded to one
      // MOVE_BATCH_SIZE commit). The first sub-batch always writes so the topic makes
      // forward progress every fire.
      if (off > 0 && (sliceExpired() || chatAppOpen())) {
        stoppedEarly = true;
        const why = chatAppOpen() ? 'chat app open' : '--max-seconds deadline';
        console.log(`[reclassify] pass ${passNum}: ${why} — stopping mid-topic at a sub-batch boundary (wrote ${off} of ${candidateMoves.length} moves for "${candidateMoves[0].fromTopic}")`);
        return true;
      }
      const res = applyMovesBatch(candidateMoves.slice(off, off + MOVE_BATCH_SIZE));
      moved += res.moved;
      deduped += res.deduped;
      for (const [slug, n] of res.movedByTarget) movedByTarget.set(slug, (movedByTarget.get(slug) || 0) + n);
    }
    return false;
  };

  // Materialize chunk IDs with .all() — an open .iterate() cursor blocks the
  // writer transaction inside applyMovesBatch ("database is busy"). For a topic
  // with 500K chunks the id array is ~4MB — well under memory pressure.
  const chunksFor = (topic) =>
    db.prepare('SELECT id, source_type FROM chunks WHERE topic = ? AND embedded = 1 ORDER BY id').all(topic);

  const processTopicChunks = (fromTopic, candidates, currentVec) => {
    const chunks = chunksFor(fromTopic);
    for (let off = 0; off < chunks.length; off += SCAN_BATCH_SIZE) {
      if (off > 0 && (sliceExpired() || chatAppOpen())) {
        stoppedEarly = true;
        const why = chatAppOpen() ? 'chat app open' : '--max-seconds deadline';
        console.log(`[reclassify] pass ${passNum}: ${why} — stopping mid-topic at a scan-batch boundary (scanned ${off} of ${chunks.length} chunks for "${fromTopic}")`);
        return true;
      }
      const moves = [];
      for (const chunk of chunks.slice(off, off + SCAN_BATCH_SIZE)) {
        const id = chunk.id;
        considered++;
        const vec = fetchVectorForChunk(id, fromTopic);
        if (!vec) continue;
        const target = chooseReclassifyTarget(vec, candidates, fromTopic, currentVec)
          || chooseReclassifyFallbackTarget({ currentSlug: fromTopic, sourceType: chunk.source_type });
        if (!target) continue;
        moves.push({ id, fromTopic, toTopic: target.slug, vec });
      }
      if (foldBatch(moves)) return true;
    }
    return false;
  };

  if (scopeT1 || scopeT2) {
    // ── Scoped / edit-driven (AC4): a topic was added or edited. Pull matching
    // chunks INTO it from ANY current topic — not just its parent T1 — so a
    // chunk wrongly parked in `personal` migrates into a newly-added work topic.
    // allT2Candidates is already narrowed to the edited T2 by the scopeT2 filter
    // above; hysteresis (chooseReclassifyTarget) keeps well-placed chunks put. ──
    if (allT2Candidates.length) {
      const topicVec = (slug) => {
        const row = topics.all.get(slug);
        return row?.description_embedding ? deserializeEmbedding(row.description_embedding) : null;
      };
      const targetSlugs = new Set(allT2Candidates.map((c) => c.slug));
      const sourceTopics = db
        .prepare("SELECT DISTINCT topic FROM chunks WHERE topic IS NOT NULL AND embedded = 1")
        .all()
        .map((r) => r.topic);
      for (const fromTopic of sourceTopics) {
        if (targetSlugs.has(fromTopic)) continue; // already in the edited topic
        const currentVec = topicVec(fromTopic);
        if (processTopicChunks(fromTopic, allT2Candidates, currentVec)) break;
      }
    }
  } else if (allT2Candidates.length) {
    // ── Full corpus (AC3): re-derive T1. Every embedded chunk — in ANY topic,
    // T1 or T2 — is compared against ALL T2s globally and re-homed to the best
    // match if it beats THRESHOLD and its current topic by REDERIVE_MARGIN. ──
    const candVecBySlug = new Map(allT2Candidates.map((c) => [c.slug, c.vec]));
    const sourceTopics = db
      .prepare("SELECT DISTINCT topic FROM chunks WHERE topic IS NOT NULL AND embedded = 1")
      .all()
      .map((r) => r.topic);
    for (const fromTopic of sourceTopics) {
      // st_2cd1af73 — bounded-slice cut point at a source-topic boundary (durable,
      // no partial transaction). st_fd14cdd4 AC9 — ALSO cut here the instant the chat
      // app opens, so a fresh topic scan never begins while a human is in chat. The
      // intra-topic cut (the foldBatch sub-batch boundary below) handles a topic that
      // is ALREADY mid-flush; this handles the boundary BEFORE the next topic.
      if (sliceExpired() || chatAppOpen()) {
        stoppedEarly = true;
        const why = chatAppOpen() ? 'chat app open' : '--max-seconds deadline reached';
        console.log(`[reclassify] pass ${passNum}: ${why}, stopping at source-topic boundary`);
        break;
      }
      const currentVec = candVecBySlug.get(fromTopic) || null;
      if (processTopicChunks(fromTopic, allT2Candidates, currentVec)) break;
    }
  }

  console.log(`[reclassify] pass ${passNum}: considered=${considered} moved=${moved} deduped=${deduped} threshold=${THRESHOLD}`);
  if (movedByTarget.size) {
    const top = [...movedByTarget.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 10);
    for (const [slug, n] of top) console.log(`    → ${slug}: +${n}`);
  }
  return { moved, deduped, considered, movedByTarget, affectedSources, stoppedEarly };
}

function classifyLlmExportSource(sourceId, topics) {
  const conv = db.prepare(`
    SELECT title, topic_slug, topic_set_method
      FROM conversations
     WHERE id = ?
  `).get(sourceId) || {};
  if (conv.topic_set_method === 'user'
    && conv.topic_slug
    && topicSlugIsClassifiable(conv.topic_slug)
    && topics.all.has(conv.topic_slug)) {
    return { slug: conv.topic_slug, method: 'user' };
  }
  const userMessages = db.prepare(`
    SELECT content
      FROM messages
     WHERE conversation_id = ?
       AND role = 'user'
     ORDER BY seq
     LIMIT 40
  `).all(sourceId);
  const firstChunk = db.prepare(`
    SELECT content
      FROM chunks
     WHERE topic = ?
       AND source_type = 'llm_export'
       AND source_id = ?
     ORDER BY chunk_index
     LIMIT 1
  `).get(NEEDS_ROUTING_TOPIC, sourceId);
  const combined = `${conv.title || ''}\n${userMessages.map((m) => m.content || '').join('\n')}\n${firstChunk?.content || ''}`.slice(0, 4000);
  const inferred = combined.trim() ? inferTopicFromContent(combined, db) : null;
  if (!inferred?.slug || !topicSlugIsClassifiable(inferred.slug) || !topics.all.has(inferred.slug)) {
    return null;
  }
  return { slug: inferred.slug, method: 'keyword-source-backfill' };
}

function syncLlmExportConversationTopic(sourceId, targetSlug, method) {
  if (isDryRun) return;
  db.prepare(`
    UPDATE conversations
       SET topic_slug = ?,
           topic_set_method = ?,
           updated_at = datetime('now')
     WHERE id = ?
       AND (topic_set_method IS NULL OR topic_set_method != 'user')
  `).run(targetSlug, method, sourceId);
  db.prepare(`
    INSERT OR REPLACE INTO conversation_topics
      (conversation_id, topic_slug, is_primary, set_method)
    VALUES (?, ?, 1, ?)
  `).run(sourceId, targetSlug, method);
}

function reclassifyLlmExportSources(topics) {
  const sourceRows = db.prepare(`
    SELECT source_id, COUNT(*) AS chunks
      FROM chunks
     WHERE topic = ?
       AND source_type = 'llm_export'
     GROUP BY source_id
     ORDER BY chunks DESC, source_id
  `).all(NEEDS_ROUTING_TOPIC);

  let moved = 0;
  let deduped = 0;
  let classifiedSources = 0;
  let skippedSources = 0;
  let stoppedEarly = false;
  const affectedTargets = new Set();
  const movedByTarget = new Map();

  const embeddedChunksForSource = db.prepare(`
    SELECT id
      FROM chunks
     WHERE topic = ?
       AND source_type = 'llm_export'
       AND source_id = ?
       AND embedded = 1
     ORDER BY id
  `);
  const unembeddedChunksForSource = db.prepare(`
    UPDATE chunks
       SET topic = ?
     WHERE topic = ?
       AND source_type = 'llm_export'
       AND source_id = ?
       AND embedded = 0
  `);

  for (const source of sourceRows) {
    if ((moved > 0 || classifiedSources > 0) && (sliceExpired() || chatAppOpen())) {
      stoppedEarly = true;
      break;
    }
    const target = classifyLlmExportSource(source.source_id, topics);
    if (!target || target.slug === NEEDS_ROUTING_TOPIC) {
      skippedSources++;
      continue;
    }
    const rows = embeddedChunksForSource.all(NEEDS_ROUTING_TOPIC, source.source_id);
    const moves = [];
    for (const row of rows) {
      const vec = fetchVectorForChunk(row.id, NEEDS_ROUTING_TOPIC);
      if (!vec) continue;
      moves.push({ id: row.id, fromTopic: NEEDS_ROUTING_TOPIC, toTopic: target.slug, vec });
    }
    if (!moves.length) {
      skippedSources++;
      continue;
    }

    classifiedSources++;
    affectedTargets.add(target.slug);
    syncLlmExportConversationTopic(source.source_id, target.slug, target.method);
    if (isDryRun) {
      moved += moves.length;
      movedByTarget.set(target.slug, (movedByTarget.get(target.slug) || 0) + moves.length);
      continue;
    }

    for (let off = 0; off < moves.length; off += MOVE_BATCH_SIZE) {
      if (off > 0 && (sliceExpired() || chatAppOpen())) {
        stoppedEarly = true;
        break;
      }
      const res = applyMovesBatch(moves.slice(off, off + MOVE_BATCH_SIZE));
      moved += res.moved;
      deduped += res.deduped;
      for (const [slug, n] of res.movedByTarget) {
        movedByTarget.set(slug, (movedByTarget.get(slug) || 0) + n);
      }
    }
    const unembedded = unembeddedChunksForSource.run(target.slug, NEEDS_ROUTING_TOPIC, source.source_id).changes || 0;
    if (unembedded > 0) {
      moved += unembedded;
      movedByTarget.set(target.slug, (movedByTarget.get(target.slug) || 0) + unembedded);
    }
    if (stoppedEarly) break;
  }

  if (classifiedSources || skippedSources) {
    console.log(`[reclassify] llm_export source backfill: sources=${classifiedSources} skipped=${skippedSources} moved=${moved} deduped=${deduped}`);
  }
  return { moved, deduped, classifiedSources, skippedSources, movedByTarget, affectedTargets, stoppedEarly };
}

// st_56bd10d1 — deterministic source-account/domain routing backfill. Runs at
// the SAME position as reclassifyLlmExportSources (before the cosine-similarity
// pass below): a sender or owning-mailbox domain match is a HIGH-CONFIDENCE
// signal and always wins over content-embedding similarity for the chunks it
// can resolve. Scoped to the residual pile (NEEDS_ROUTING_TOPIC) only — a chunk
// a human topic edit or a prior cosine pass already placed elsewhere is left
// alone; this drains the "not yet cleanly matched" queue chunkEmails() feeds
// (lib/chunk-worker.js applies the same deterministic routing at INSERT time
// going forward, so this backfill only ever has to cover the historical
// backlog placed before that wiring landed).
export function reclassifyEmailSourcesByDomain(topics) {
  const sourceRows = db.prepare(`
    SELECT DISTINCT source_id
      FROM chunks
     WHERE topic = ?
       AND source_type = 'email'
  `).all(NEEDS_ROUTING_TOPIC);

  let moved = 0;
  let deduped = 0;
  let classifiedSources = 0;
  let skippedSources = 0;
  let stoppedEarly = false;
  const affectedTargets = new Set();
  const movedByTarget = new Map();

  const emailLookup = db.prepare(`
    SELECT e.sender_email AS senderEmail, a.email AS accountEmail, a.topic_slug AS accountTopic
      FROM emails e
      LEFT JOIN accounts a ON a.id = e.account_id
     WHERE e.id = ?
  `);
  const embeddedChunksForSource = db.prepare(`
    SELECT id
      FROM chunks
     WHERE topic = ?
       AND source_type = 'email'
       AND source_id = ?
       AND embedded = 1
     ORDER BY id
  `);
  const countUnembeddedForSource = db.prepare(`
    SELECT COUNT(*) AS n
      FROM chunks
     WHERE topic = ?
       AND source_type = 'email'
       AND source_id = ?
       AND embedded = 0
  `);
  const moveUnembeddedForSource = db.prepare(`
    UPDATE chunks
       SET topic = ?
     WHERE topic = ?
       AND source_type = 'email'
       AND source_id = ?
       AND embedded = 0
  `);

  for (const source of sourceRows) {
    if ((moved > 0 || classifiedSources > 0) && (sliceExpired() || chatAppOpen())) {
      stoppedEarly = true;
      break;
    }

    const emailId = String(source.source_id || '').replace(/^email:/, '');
    const row = emailLookup.get(emailId);
    const targetSlug = row
      ? topicForSourceAccount({ senderEmail: row.senderEmail, accountEmail: row.accountEmail, accountTopic: row.accountTopic })
      : null;
    // Same safety net as classifyLlmExportSource: never move a chunk onto a
    // slug this install's taxonomy doesn't actually have (topic is free-text,
    // no FK — an unmapped slug would silently orphan the chunk).
    if (!targetSlug || !topicSlugIsClassifiable(targetSlug) || !topics.all.has(targetSlug)) {
      skippedSources++;
      continue;
    }

    let sourceTouched = false;

    // Embedded chunks move through the shared batch mover (handles the
    // UNIQUE-collision dedupe the same way every other move path does).
    const rows = embeddedChunksForSource.all(NEEDS_ROUTING_TOPIC, source.source_id);
    const moves = [];
    for (const r of rows) {
      const vec = fetchVectorForChunk(r.id, NEEDS_ROUTING_TOPIC);
      if (!vec) continue;
      moves.push({ id: r.id, fromTopic: NEEDS_ROUTING_TOPIC, toTopic: targetSlug, vec });
    }
    if (moves.length) {
      if (isDryRun) {
        moved += moves.length;
        movedByTarget.set(targetSlug, (movedByTarget.get(targetSlug) || 0) + moves.length);
      } else {
        for (let off = 0; off < moves.length; off += MOVE_BATCH_SIZE) {
          if (off > 0 && (sliceExpired() || chatAppOpen())) { stoppedEarly = true; break; }
          const res = applyMovesBatch(moves.slice(off, off + MOVE_BATCH_SIZE));
          moved += res.moved;
          deduped += res.deduped;
          for (const [slug, n] of res.movedByTarget) movedByTarget.set(slug, (movedByTarget.get(slug) || 0) + n);
        }
      }
      sourceTouched = true;
    }

    // Un-embedded chunks carry no vector yet — a direct UPDATE moves them
    // (mirrors reclassifyLlmExportSources' unembeddedChunksForSource), decided
    // INDEPENDENTLY of the embedded-chunk branch above so a source whose
    // chunks haven't reached the embed daemon yet still gets routed now,
    // rather than waiting.
    if (isDryRun) {
      const wouldMove = countUnembeddedForSource.get(NEEDS_ROUTING_TOPIC, source.source_id).n || 0;
      if (wouldMove > 0) {
        moved += wouldMove;
        movedByTarget.set(targetSlug, (movedByTarget.get(targetSlug) || 0) + wouldMove);
        sourceTouched = true;
      }
    } else {
      const unembedded = moveUnembeddedForSource.run(targetSlug, NEEDS_ROUTING_TOPIC, source.source_id).changes || 0;
      if (unembedded > 0) {
        moved += unembedded;
        movedByTarget.set(targetSlug, (movedByTarget.get(targetSlug) || 0) + unembedded);
        sourceTouched = true;
      }
    }

    if (sourceTouched) {
      classifiedSources++;
      affectedTargets.add(targetSlug);
    } else {
      skippedSources++;
    }
    if (stoppedEarly) break;
  }

  if (classifiedSources || skippedSources) {
    console.log(`[reclassify] email domain backfill: sources=${classifiedSources} skipped=${skippedSources} moved=${moved} deduped=${deduped}`);
  }
  return { moved, deduped, classifiedSources, skippedSources, movedByTarget, affectedTargets, stoppedEarly };
}

// Pass 2+ refresh: blend each affected T2's description_embedding with the
// centroid of newly-assigned chunks. Stored back to user_topics. The blend
// (50/50 here) keeps the user's curated description signal alive while
// letting the topic drift toward what its content actually is.
function recomputeTopicEmbedding(slug, originalVec) {
  const store = vectorStoreForTopic(slug, { database: db, embeddingsDb, requireWritable: true });
  if (!store.database || !tableExists(store.database, store.tableName)) return;
  // st_2cd1af73 BUGFIX: these vec0 tables are declared
  // `vec0(chunk_id TEXT PRIMARY KEY, embedding float[1024])`. A vec0 table with a
  // TEXT primary key is ROWID-LESS — `ORDER BY rowid` throws "no such column:
  // rowid" and aborted every full-corpus run the moment pass 1 moved enough to
  // trigger this pass-2 refresh. chunk_id is the only orderable column; we just
  // need a deterministic sample of up to 200 assigned vectors to form the
  // centroid, so ordering by chunk_id (the PRIMARY KEY) is both valid and stable.
  const sample = store.database.prepare(
    `SELECT embedding FROM ${store.tableName} ORDER BY chunk_id DESC LIMIT 200`
  ).all();
  if (!sample.length) return;
  const dim = EMBED_DIM;
  const centroid = new Float32Array(dim);
  let n = 0;
  for (const r of sample) {
    const v = deserializeEmbedding(r.embedding);
    if (!v || v.length !== dim) continue;
    for (let i = 0; i < dim; i++) centroid[i] += v[i];
    n++;
  }
  if (!n) return;
  for (let i = 0; i < dim; i++) centroid[i] /= n;
  // 50/50 blend with original description embedding (if any)
  if (originalVec && originalVec.length === dim) {
    for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] + originalVec[i]) * 0.5;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += centroid[i] * centroid[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) centroid[i] /= norm;
  db.prepare('UPDATE user_topics SET description_embedding = ? WHERE slug = ?')
    .run(Buffer.from(centroid.buffer), slug);
}

function markAffectedTopicsForContextRegen(slugs, reason) {
  if (isDryRun || !slugs?.size) return 0;
  const mark = db.prepare(`
    UPDATE user_topics
       SET needs_regen = 1,
           updated_at = datetime('now')
     WHERE slug = ?
  `);
  let changed = 0;
  for (const slug of slugs) changed += mark.run(slug).changes || 0;
  if (changed > 0) {
    console.log(`[reclassify] marked ${changed} affected topic(s) needs_regen (${reason})`);
  }
  return changed;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[reclassify] start (dry-run=${isDryRun}, skip-regen=${skipRegen}, threshold=${THRESHOLD}, max-passes=${MAX_PASSES})`);

  const topics = loadTopics();
  console.log(`[reclassify] T1=${topics.t1.size} T2=${topics.t2.size}`);

  await ensureTopicEmbeddings(topics);

  const affectedTargets = new Set();
  const passSummaries = [];
  let lastT1Count = null;
  let deadlineHit = false; // st_2cd1af73 — true when a --max-seconds slice cut the run short
  const sourceBackfill = reclassifyLlmExportSources(topics);
  for (const slug of sourceBackfill.affectedTargets) affectedTargets.add(slug);
  if (sourceBackfill.stoppedEarly) deadlineHit = true;

  // st_56bd10d1 — deterministic domain routing, BEFORE the cosine passes below.
  const emailDomainBackfill = reclassifyEmailSourcesByDomain(topics);
  for (const slug of emailDomainBackfill.affectedTargets) affectedTargets.add(slug);
  if (emailDomainBackfill.stoppedEarly) deadlineHit = true;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    // st_2cd1af73 — between-pass deadline check. A pass already stops itself at a
    // source-topic boundary; this guard avoids even starting another pass once the
    // slice budget is spent.
    if (sliceExpired()) { deadlineHit = true; break; }

    // How many T1 chunks remain before this pass?
    const beforeRow = db.prepare(
      `SELECT COUNT(*) AS n FROM chunks WHERE embedded=1 AND topic IN (${
        [...topics.t1.keys()].concat(['general']).map(() => '?').join(',')
      })`
    ).get(...[...topics.t1.keys(), 'general']);
    const beforeT1 = beforeRow?.n || 0;

    const { moved, deduped, movedByTarget, affectedSources, stoppedEarly } = reclassifyPass(topics, pass);
    passSummaries.push({
      pass,
      moved,
      deduped,
      affected_sources: affectedSources.size,
      affected_targets: movedByTarget.size,
      stopped_early: stoppedEarly,
    });
    for (const slug of movedByTarget.keys()) affectedTargets.add(slug);
    // AC5: topics that LOST chunks also need their context.md refreshed.
    for (const slug of affectedSources) affectedTargets.add(slug);

    // st_2cd1af73 — if the pass stopped on the wall clock, do not start another
    // pass or run the (paid) regen leg on a half-reclassified corpus.
    if (stoppedEarly) { deadlineHit = true; break; }

    // Convergence: stop once a pass changes < CONVERGE_FRACTION of remaining T1
    // chunks. Both a real move AND a dedupe REMOVE a chunk from the source T1, so
    // both are progress — a corpus full of duplicates must still drain to
    // convergence rather than loop re-finding the same collisions every pass.
    const changed = moved + (deduped || 0);
    const fraction = beforeT1 > 0 ? changed / beforeT1 : 0;
    console.log(`[reclassify] pass ${pass} changed ${(fraction * 100).toFixed(2)}% of remaining T1 (moved=${moved} deduped=${deduped || 0})`);
    if (changed === 0 || fraction < CONVERGE_FRACTION) {
      console.log('[reclassify] converged');
      break;
    }

    // Pass 2+ — refresh affected T2 description_embeddings from their
    // (now richer) corpus. Next pass uses the updated centroid.
    if (!isDryRun) {
      for (const slug of movedByTarget.keys()) {
        const original = topics.t2.get(slug)?.description_embedding;
        recomputeTopicEmbedding(slug, deserializeEmbedding(original));
      }
    }
  }

  console.log(`[reclassify] affected targets: ${affectedTargets.size}`);

  // st_2cd1af73 — skip the paid Sonnet regen leg when a --max-seconds slice cut
  // the reclassify short: the corpus is only partially re-homed, so regenerating
  // context now would synthesize from a half-sorted state and be redone next
  // slice. Regen runs only on a run that converged within its budget.
  if (deadlineHit) {
    markAffectedTopicsForContextRegen(affectedTargets, 'partial-slice');
    writeReclassifyResult({
      partial: true,
      status: 'partial_slice',
      source_backfill: {
        moved: sourceBackfill.moved,
        deduped: sourceBackfill.deduped,
        classified_sources: sourceBackfill.classifiedSources,
        skipped_sources: sourceBackfill.skippedSources,
        affected_targets: sourceBackfill.affectedTargets.size,
        stopped_early: sourceBackfill.stoppedEarly,
      },
      email_domain_backfill: {
        moved: emailDomainBackfill.moved,
        deduped: emailDomainBackfill.deduped,
        classified_sources: emailDomainBackfill.classifiedSources,
        skipped_sources: emailDomainBackfill.skippedSources,
        affected_targets: emailDomainBackfill.affectedTargets.size,
        moved_by_target: Object.fromEntries(emailDomainBackfill.movedByTarget),
        stopped_early: emailDomainBackfill.stoppedEarly,
      },
      passes: passSummaries,
      affected_targets: affectedTargets.size,
    });
    console.log('[reclassify] slice deadline hit — skipping context regen (resumes next run)');
    console.log('[reclassify] done (partial slice)');
    process.exit(0);
  }

  if (!skipRegen && !isDryRun && affectedTargets.size) {
    markAffectedTopicsForContextRegen(affectedTargets, 'full-regeneration');
    console.log('[reclassify] regenerating context_md for affected topics…');
    const regenFailures = [];
    for (const slug of affectedTargets) {
      try {
        await generateTopicContext(slug, db);
        await generateTopicEmbedding(slug, db);
        db.prepare('UPDATE user_topics SET needs_regen = 0 WHERE slug = ?').run(slug);
        console.log(`  context regen: ${slug}`);
      } catch (e) {
        regenFailures.push({ slug, message: e.message });
        console.warn(`  context regen failed: ${slug} — ${e.message}`);
      }
    }
    if (regenFailures.length) {
      console.error(`[reclassify] fatal: ${regenFailures.length} context regen failure(s)`);
      process.exit(1);
    }
  } else if (skipRegen && !isDryRun && affectedTargets.size) {
    markAffectedTopicsForContextRegen(affectedTargets, 'deferred-regeneration');
  }

  writeReclassifyResult({
    partial: false,
    status: 'complete',
    source_backfill: {
      moved: sourceBackfill.moved,
      deduped: sourceBackfill.deduped,
      classified_sources: sourceBackfill.classifiedSources,
      skipped_sources: sourceBackfill.skippedSources,
      affected_targets: sourceBackfill.affectedTargets.size,
      stopped_early: sourceBackfill.stoppedEarly,
    },
    email_domain_backfill: {
      moved: emailDomainBackfill.moved,
      deduped: emailDomainBackfill.deduped,
      classified_sources: emailDomainBackfill.classifiedSources,
      skipped_sources: emailDomainBackfill.skippedSources,
      affected_targets: emailDomainBackfill.affectedTargets.size,
      moved_by_target: Object.fromEntries(emailDomainBackfill.movedByTarget),
      stopped_early: emailDomainBackfill.stoppedEarly,
    },
    passes: passSummaries,
    affected_targets: affectedTargets.size,
  });
  console.log('[reclassify] done');
  process.exit(0);
}

// Run only when invoked as a script — importing for tests must not execute.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    writeReclassifyResult({
      ok: false,
      partial: null,
      status: 'failed',
      error: err?.message || String(err),
    });
    console.error('[reclassify] fatal:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
