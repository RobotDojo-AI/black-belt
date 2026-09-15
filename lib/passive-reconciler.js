/**
 * lib/passive-reconciler.js
 *
 * st_b50005df Phase 2 — the truth-reconciler that makes the embed/chunk queue
 * impossible to permanently break.
 *
 * The principle (external research §4 — transactional-outbox / lease pattern):
 * the queue (`passive_jobs`) is a DERIVED index, not the source of truth. The
 * real backlog lives in `chunks WHERE embedded=0` (embed work) and in the raw
 * source tables that have no chunk yet (chunk-scan work). If the queue is wiped,
 * frozen, or a launch-critical job is quarantined, the reconciler re-derives the
 * outstanding work from truth and re-animates it. Every failure resolves to
 * "reclaim or re-derive" — never "stuck".
 *
 * Two responsibilities, both idempotent:
 *   1. RE-DERIVE — enqueue a chunk_source_scan job when un-chunked source rows
 *      exist, and embedding_topic jobs for every topic with un-embedded chunks.
 *      Re-enqueue uses requeueDone/requeueQuarantined so a done-or-quarantined
 *      row whose backlog still exists is brought back to 'queued'.
 *   2. UN-QUARANTINE — bring any quarantined launch-critical embed/chunk job
 *      back to life WHILE its backlog still exists in truth. Quarantine stops
 *      being terminal for these job types (it remains terminal for genuine
 *      poison records of OTHER types — drop-folder imports, session logs).
 *
 * This is the production counterpart to the drop-folder watcher's
 * requeueQuarantined (lib/drop-folder/watcher.js:428), which only un-quarantines
 * drop_folder_import jobs on file-replace. The reconciler covers the
 * launch-critical embed/chunk types that previously had NO un-quarantine path
 * (research D3).
 *
 * Pure-ish by construction: every function takes the db as its first argument
 * so the unit tests can drive it against an in-memory fixture with no live data.
 */

import db from './db.js';
import {
  enqueuePassiveJob,
  getPassiveJob,
} from './passive-jobs.js';
import {
  hasPendingChunkSources,
  pendingEmbedCount,
  embedPriorityForTopic,
  daemonOwnsEmbedding,
} from './chunk-worker.js';
import { enrichmentBacklogCount, promoteHighValueCardlessToBacklog } from './entity-enrich.js';

// The launch-critical embed/chunk job types whose backlog lives in truth and
// must never permanently dead-end. Quarantine recovery is scoped to exactly
// these — other types (drop_folder_import, session_log_*, maint_*) keep their
// own recovery owners and terminal-quarantine semantics.
//
// st_b50005df Phase 4 — entity_enrich joins this set: its backlog lives in
// people.needs_regen (truth), so it gets the same re-derive + un-quarantine
// guarantees as embedding. A stalled or quarantined enrichment job recovers
// exactly like a stalled embedding job — no terminal dead-end.
export const LAUNCH_CRITICAL_EMBED_TYPES = Object.freeze([
  'embedding_topic', 'chunk_source_scan', 'entity_enrich',
]);

// The single unique_key for the always-on enrichment job. One job drains the
// whole backlog in bounded slices (each fire enriches the next highest-value
// slice and shrinks needs_regen), so one keyed row is correct — re-enqueue
// collapses onto it rather than fanning out per-entity. The base priority sits
// just under chunk_source_scan (60) so chunking/embedding the user's data wins
// when both are pending, but above the embedding floor so enrichment is not
// starved. Env-overridable per the no-hardcoded-tunables rule.
export const ENTITY_ENRICH_UNIQUE_KEY = 'entity-enrich-backlog';
const ENTITY_ENRICH_PRIORITY = (() => {
  const n = Number.parseInt(String(process.env.ROBOTDOJO_ENRICH_JOB_PRIORITY ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
})();

/**
 * Topics that still have un-embedded chunks — the embed backlog, straight from
 * the source of truth. Returns the same shape enqueuePendingEmbeddingJobs uses.
 *
 * @param {object} database
 * @returns {string[]} topic slugs with embedded=0 chunks
 */
export function pendingEmbedTopics(database = db) {
  return database.prepare(`
    SELECT DISTINCT topic FROM chunks WHERE embedded = 0 AND skip_embed = 0
  `).all().map((r) => r.topic);
}

/**
 * Re-derive the chunk-scan need from truth. Enqueues (or re-queues a
 * done/quarantined) chunk_source_scan job when un-chunked source rows exist.
 *
 * @param {object} database
 * @returns {{enqueued: boolean, reason: string|null}}
 */
export function reconcileChunkScan(database = db) {
  const sources = hasPendingChunkSources(database);
  if (!sources.pending) return { enqueued: false, reason: null };
  enqueuePassiveJob({
    database,
    jobType: 'chunk_source_scan',
    uniqueKey: 'chunk-source-scan',
    targetType: 'system',
    targetId: 'chunks',
    payload: { reason: sources.reason },
    priority: 60,
    timeoutMs: 120_000,
    metadata: { source: 'reconciler' },
    // The two flags below are what make quarantine non-terminal: a chunk-scan
    // job that was quarantined or marked done is brought back to 'queued' as
    // long as its backlog (un-chunked source rows) still exists in truth.
    requeueDone: true,
    requeueQuarantined: true,
  });
  return { enqueued: true, reason: sources.reason };
}

/**
 * Re-derive the embed need from truth. Enqueues (or re-queues a
 * done/quarantined) embedding_topic job for every topic with un-embedded
 * chunks, priced by the same cross-topic value score the worker uses.
 *
 * @param {object} database
 * @returns {{topics: string[]}}
 */
export function reconcileEmbedTopics(database = db) {
  // st_2cd1af73 — no-op when the long-lived chunk-embed-daemon owns embedding.
  // The daemon drains `chunks WHERE embedded=0` directly with no passive job, so
  // re-deriving embedding_topic jobs here would only enqueue work the worker no
  // longer drains (and risk a second embedder racing the daemon's WAL writer).
  if (daemonOwnsEmbedding()) return { topics: [] };
  const topics = pendingEmbedTopics(database);
  for (const topic of topics) {
    enqueuePassiveJob({
      database,
      jobType: 'embedding_topic',
      uniqueKey: `embedding-topic:${topic}`,
      targetType: 'topic',
      targetId: topic,
      payload: { topic },
      priority: embedPriorityForTopic(database, topic),
      timeoutMs: 300_000,
      metadata: { source: 'reconciler' },
      requeueDone: true,
      requeueQuarantined: true,
    });
  }
  return { topics };
}

/**
 * Re-derive the enrichment need from truth. Enqueues (or re-queues a
 * done/quarantined) entity_enrich job whenever eligible entities still carry
 * needs_regen=1. The eligibility gate is the SAME one the selector uses
 * (lib/entity-enrich.js ENRICHMENT_ELIGIBILITY_WHERE), so backlog and selection
 * never drift. One keyed job drains the backlog in bounded slices.
 *
 * st_b50005df Phase 4 (AC-3a) — this is the enrichment counterpart to
 * reconcileEmbedTopics: people.needs_regen is the source of truth, passive_jobs
 * is a derived index. Wipe or quarantine the enrichment job and this re-derives
 * it as long as the backlog persists — no terminal dead-end.
 *
 * @param {object} database
 * @returns {{ enqueued: boolean, backlog: number }}
 */
export function reconcileEntityEnrich(database = db, options = {}) {
  // First-session depth: cardless Family/Core/Partners get a skeleton + needs_regen
  // so the enrich worker can fill them. Best-effort; never blocks reconcile.
  try { promoteHighValueCardlessToBacklog(database, { limit: 40 }); }
  catch { /* optional on partial imports in tests */ }
  const backlog = enrichmentBacklogCount(database);
  if (backlog === 0) return { enqueued: false, backlog: 0 };
  enqueuePassiveJob({
    database,
    jobType: 'entity_enrich',
    uniqueKey: ENTITY_ENRICH_UNIQUE_KEY,
    targetType: 'system',
    targetId: 'people',
    payload: { reason: options.reason || 'needs_regen backlog' },
    priority: ENTITY_ENRICH_PRIORITY,
    timeoutMs: 300_000,
    metadata: { source: options.source || 'reconciler' },
    // Quarantine is non-terminal for enrichment: a done/quarantined job whose
    // needs_regen backlog still exists is brought back to 'queued'.
    requeueDone: true,
    requeueQuarantined: true,
  });
  return { enqueued: true, backlog };
}

/**
 * Un-quarantine launch-critical embed/chunk/enrich jobs whose backlog still
 * exists in truth. A chunk_source_scan is revived only while un-chunked source
 * rows remain; an embedding_topic is revived only while its topic has un-embedded
 * chunks; an entity_enrich is revived only while eligible needs_regen entities
 * remain. A quarantined job whose backlog is genuinely empty stays quarantined
 * (nothing to do), so this is safe to run every cycle.
 *
 * Returns the ids it revived so the caller can log/assert recovery.
 *
 * @param {object} database
 * @param {object} [opts]
 * @param {string[]} [opts.excludeTypes] launch-critical types to skip this pass
 *   (the worker passes ['entity_enrich'] when enrichment is paused on this box).
 * @returns {{revived: string[]}}
 */
export function unquarantineEmbedChunkJobs(database = db, { excludeTypes = [] } = {}) {
  const types = LAUNCH_CRITICAL_EMBED_TYPES.filter((t) => !excludeTypes.includes(t));
  if (types.length === 0) return { revived: [] };
  const quarantined = database.prepare(`
    SELECT id, job_type, target_id, payload
      FROM passive_jobs
     WHERE status = 'quarantined'
       AND job_type IN (${types.map(() => '?').join(', ')})
  `).all(...types);

  const revived = [];
  for (const row of quarantined) {
    let backlogExists = false;
    if (row.job_type === 'chunk_source_scan') {
      backlogExists = hasPendingChunkSources(database).pending;
    } else if (row.job_type === 'entity_enrich') {
      backlogExists = enrichmentBacklogCount(database) > 0;
    } else if (row.job_type === 'embedding_topic') {
      // Topic is on payload.topic (preferred) or target_id (fallback).
      let topic = row.target_id;
      try { topic = JSON.parse(row.payload || '{}').topic || topic; } catch { /* keep target_id */ }
      const n = database.prepare(`
        SELECT 1 FROM chunks
         WHERE topic = ? AND embedded = 0 AND skip_embed = 0
         LIMIT 1
      `).get(topic);
      backlogExists = !!n;
    }
    if (!backlogExists) continue;

    // Re-animate from quarantine. Reset the real-failure counter so the revived
    // job gets a fresh budget of max_attempts before it could quarantine again —
    // a transient cause recovers; a permanent poison re-quarantines on its own
    // after max_attempts genuine failures.
    const now = new Date().toISOString();
    database.prepare(`
      UPDATE passive_jobs
         SET status = 'queued',
             attempts = 0,
             reclaims = reclaims + 1,
             run_after = ?,
             lease_owner = NULL,
             lease_expires_at = NULL,
             quarantine_reason = NULL,
             last_error = 'un-quarantined by reconciler (backlog still in truth)',
             updated_at = ?
       WHERE id = ?
    `).run(now, now, row.id);
    revived.push(row.id);
  }
  return { revived: revived.map((id) => getPassiveJob(database, id)?.id || id) };
}

/**
 * Full reconcile pass: un-quarantine first (so a revived row participates in
 * the same cycle's re-derive), then re-derive chunk-scan + embed needs from
 * truth. Safe and idempotent to run every worker fire.
 *
 * st_b50005df Phase 4 — enrichment is re-derived ONLY when the caller says
 * enrichment is enabled (BB active + no explicit owner-box opt-out). Passing
 * `enrichEnabled=false` un-quarantines nothing for enrichment AND enqueues no
 * enrichment job, so a box with enrichment paused never accrues enrichment work
 * (and never spends). The worker passes the entity-enrich-policy decision in;
 * the reconciler stays a pure function of (database, enrichEnabled).
 *
 * @param {object} [opts]
 * @param {object} [opts.database]
 * @param {boolean} [opts.enrichEnabled] re-derive/revive entity_enrich when true
 * @returns {{revived: string[], chunkScan: object, embed: object, entityEnrich: object|null}}
 */
export function reconcilePassiveBacklog({ database = db, enrichEnabled = false } = {}) {
  // Un-quarantine embed/chunk always; enrichment only when enabled — otherwise a
  // paused box would revive an enrichment job it must not drain.
  const unquarantined = enrichEnabled
    ? unquarantineEmbedChunkJobs(database)
    : unquarantineEmbedChunkJobs(database, { excludeTypes: ['entity_enrich'] });
  const chunkScan = reconcileChunkScan(database);
  const embed = reconcileEmbedTopics(database);
  const entityEnrich = enrichEnabled ? reconcileEntityEnrich(database) : null;
  return {
    revived: unquarantined.revived,
    chunkScan,
    embed,
    entityEnrich,
    pending_embed: pendingEmbedCount(database),
  };
}
