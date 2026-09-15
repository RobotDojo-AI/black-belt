import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import db from './db.js';

export const PASSIVE_JOB_STATUSES = Object.freeze([
  'queued',
  'running',
  'paused',
  'done',
  'failed',
  'quarantined',
]);

export const PASSIVE_DEGRADATION_OWNERS = Object.freeze({
  PRODUCT: 'product_pipeline',
  EXTERNAL_CONNECTOR: 'external_connector',
  OWNER_ACTION: 'owner_action_required',
  UNKNOWN: 'unknown',
});
const DEG = PASSIVE_DEGRADATION_OWNERS;

// st_27561b77 P6/P7/AC10 — passive job inventory.
//
// SHAPE: an Array of {id, label, owner} for `.map(row => row.id)` consumers
// (tests/passive-jobs.test.js, scripts/qa/passive-launch-chaos.js), AND
// keyed by `id` as named properties on the same Array so AC10's
// `Object.keys(PASSIVE_DATA_PLANE_PATHS).includes('email_history_backfill')`
// criterion sees the registry as a keyed map. Named properties are added
// via defineProperty BEFORE freeze so they survive Object.freeze.
//
// Adding a new entry: append to the array literal AND the named property
// loop will pick it up.
const PASSIVE_DATA_PLANE_LIST = [
  { id: 'drop_folder_import', label: 'Drop-folder watcher/imports', owner: 'lib/drop-folder/watcher.js', degradation_owner: DEG.PRODUCT },
  { id: 'session_log_turn', label: 'Chat transcript/session-log turns', owner: 'routes/session-log.js', degradation_owner: DEG.PRODUCT },
  { id: 'session_log_bookmark', label: 'Chat transcript/session-log bookmarks', owner: 'routes/session-log.js', degradation_owner: DEG.PRODUCT },
  { id: 'session_log_batch', label: 'Session-log batch materialization', owner: 'routes/session-log.js', degradation_owner: DEG.PRODUCT },
  { id: 'llm_export_import', label: 'LLM export import', owner: 'lib/drop-folder/route-llm-export.js', degradation_owner: DEG.PRODUCT },
  { id: 'oauth_sync', label: 'Email/calendar/drive OAuth sync', owner: 'lib/oauth-sync-queue.js', degradation_owner: DEG.EXTERNAL_CONNECTOR },
  { id: 'granola_sync', label: 'Granola transcript snapshots', owner: 'lib/granola-sync.js', degradation_owner: DEG.EXTERNAL_CONNECTOR },
  { id: 'granola_call_asana', label: 'Granola call summary Asana tasks', owner: 'lib/granola-call-asana.js', degradation_owner: DEG.EXTERNAL_CONNECTOR },
  { id: 'local_sync', label: 'Mac-local iMessage/Apple Photos sync', owner: 'scripts/sync.js', degradation_owner: DEG.PRODUCT },
  { id: 'chunk_source_scan', label: 'Chunking source scan', owner: 'lib/chunk-worker.js', degradation_owner: DEG.PRODUCT },
  { id: 'embedding_topic', label: 'Embedding topic batches', owner: 'lib/rag/embed.js', degradation_owner: DEG.PRODUCT },
  // st_b50005df Phase 4 — entity enrichment as a passive job type so it rides
  // the same lease + reconciler discipline as embedding (self-healing, never a
  // terminal dead-end). Drained by the always-on chunk-worker; re-derived from
  // people.needs_regen truth by lib/passive-reconciler.js.
  { id: 'entity_enrich', label: 'Entity context enrichment batches', owner: 'lib/entity-enrich.js', degradation_owner: DEG.PRODUCT },
  { id: 'integration_health_refresh', label: 'Integration health refresh', owner: 'lib/integration-health.js', degradation_owner: DEG.PRODUCT },
  { id: 'asana_sync', label: 'Asana task context', owner: 'lib/asana-context-sync.js', degradation_owner: DEG.EXTERNAL_CONNECTOR },
  { id: 'notion_sync', label: 'Notion context', owner: 'lib/notion-sync.js', degradation_owner: DEG.EXTERNAL_CONNECTOR },
  { id: 'oura_sync', label: 'Oura health sync', owner: 'lib/oura-sync.js', degradation_owner: DEG.EXTERNAL_CONNECTOR },
  { id: 'eight_sleep_sync', label: 'Eight Sleep health sync', owner: 'lib/eight-sleep-sync.js', degradation_owner: DEG.EXTERNAL_CONNECTOR },
  { id: 'health_import', label: 'Apple Health/FHIR/lab imports', owner: 'lib/drop-folder/route-health.js', degradation_owner: DEG.PRODUCT },
  { id: 'imports_snapshot', label: 'Import snapshot refresh', owner: 'lib/imports-snapshot.js', degradation_owner: DEG.PRODUCT },
  { id: 'maintenance', label: 'Always-on maintenance routines', owner: 'lib/maintenance-routines.js', degradation_owner: DEG.PRODUCT },
  // st_27561b77 P7 — email history backfill as a passive job type. The
  // handler lives in scripts/backfill-email-history.js (runBackfillPass());
  // seeding derives from lib/integration-registry.js historyBackfill specs.
  { id: 'email_history_backfill', label: 'Email history full backfill (walk backward)', owner: 'scripts/backfill-email-history.js', degradation_owner: DEG.EXTERNAL_CONNECTOR },
  // st_fd14cdd4 AC8 — one passive job type per maintenance routine so the
  // worker drains each independently with its own priority and the fairness
  // counter applies across types. The supervisor's freshness probe seeds
  // them (lib/maintenance-routines.js declares windows + priorities); the
  // former nightly_* overnight types are retired (one-time cleanup:
  // scripts/migrate-overnight-to-routines.js).
  { id: 'maint_clean', label: 'CLEAN phase (hygiene + dedup)', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_rescore', label: 'RESCORE phase (scores + vault)', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'pipeline_ingest', label: 'Entity pipeline INGEST (continuous)', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'pipeline_entities', label: 'Entity pipeline ENTITIES (follows ingest)', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_topics', label: 'TOPICS context regen', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_reclassify', label: 'RECLASSIFY conversations', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_reclassify_chunks', label: 'RECLASSIFY_CHUNKS full-corpus re-home', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_style', label: 'STYLE communication analysis', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_enrich', label: 'ENRICH entity contexts (BB-gated)', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_brief', label: 'BRIEF daily cheat-sheet synthesis', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_memory_ingest', label: 'MEMORY_INGEST flat-note fold', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_memory_recalc', label: 'MEMORY_RECALC workbench/context projections', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_memory_verify', label: 'MEMORY_VERIFY chain integrity', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_timeline_recalc', label: 'TIMELINE_RECALC life timeline projection', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_audit', label: 'AUDIT counts + history + anomaly alarm', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_monitor', label: 'MONITOR gateway error digest', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_dmarc', label: 'DMARC report parse', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_tls_rpt', label: 'TLS-RPT report parse', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_gsc', label: 'GSC poll + auto-heal', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_indexnow', label: 'INDEXNOW sitemap push', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
  { id: 'maint_models_refresh', label: 'models.json provider refresh', owner: 'scripts/update-models.js', degradation_owner: DEG.EXTERNAL_CONNECTOR },
  { id: 'participants_backfill', label: 'Retroactive participants backfill', owner: 'scripts/backfill-participants.js', degradation_owner: DEG.PRODUCT },
  // st_2d941f89 gap 1 — ambient chunk_vec_general shard build, bounded/gated.
  { id: 'maint_ambient_shard', label: 'AMBIENT_SHARD ambient vector shard build', owner: 'scripts/maintenance-phases.js', degradation_owner: DEG.PRODUCT },
];
for (const entry of PASSIVE_DATA_PLANE_LIST) {
  Object.defineProperty(PASSIVE_DATA_PLANE_LIST, entry.id, {
    value: entry,
    enumerable: true,
    writable: false,
    configurable: false,
  });
}
export const PASSIVE_DATA_PLANE_PATHS = Object.freeze(PASSIVE_DATA_PLANE_LIST);

export function passiveDataPlanePathFor(jobType) {
  return PASSIVE_DATA_PLANE_LIST[String(jobType || '')] || null;
}

function baseDegradationOwner(jobType) {
  return passiveDataPlanePathFor(jobType)?.degradation_owner || PASSIVE_DEGRADATION_OWNERS.UNKNOWN;
}

function ownerActionRequired(row = {}) {
  const text = [
    row.last_error,
    row.quarantine_reason,
    row.sample_error,
    row.reason,
  ].filter(Boolean).join(' ');
  return /reauth|re-auth|scope not granted|needs_permission|permission required|invalid_grant|unauthorized|forbidden/i.test(text);
}

export function classifyPassiveJobDegradation(row = {}) {
  const jobType = String(row.job_type || row.jobType || row.id || '');
  const entry = passiveDataPlanePathFor(jobType);
  const baseOwner = baseDegradationOwner(jobType);
  const owner = baseOwner === PASSIVE_DEGRADATION_OWNERS.EXTERNAL_CONNECTOR && ownerActionRequired(row)
    ? PASSIVE_DEGRADATION_OWNERS.OWNER_ACTION
    : baseOwner;
  return {
    owner,
    build_owned: owner === PASSIVE_DEGRADATION_OWNERS.PRODUCT || owner === PASSIVE_DEGRADATION_OWNERS.UNKNOWN,
    action: owner === PASSIVE_DEGRADATION_OWNERS.OWNER_ACTION
      ? 'reconnect_or_grant_scope'
      : owner === PASSIVE_DEGRADATION_OWNERS.EXTERNAL_CONNECTOR
        ? 'provider_or_network_degraded'
        : 'fix_product_pipeline',
    label: entry?.label || jobType || 'Unknown passive job',
    owner_file: entry?.owner || null,
  };
}

const DEFAULT_QUEUE = 'default';
const DEFAULT_MAX_ATTEMPTS = 5;
// st_27561b77 AC7 — lease window reduced from 60s to 30s. A killed-mid-run
// passive job is recovered to status='queued' within 30s instead of 60s.
// Long-running handlers must call renewPassiveJobLease every ~20s.
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BACKOFF_BASE_MS = 10_000;
const DEFAULT_BACKOFF_MAX_MS = 60 * 60_000;
const DEFAULT_PRESSURE_DELAY_MS = 60_000;
const DEFAULT_PARTIAL_DELAY_MS = 30_000;
// st_27561b77 AC5 — when the idle check fires while a job is running, pause
// it with run_after = now + 60s. The drain loop breaks; the next idle
// window resumes the same job from its persisted cursor.
const IDLE_PAUSE_DELAY_MS = 60_000;
// st_27561b77 AC9 — fairness counter. After 8 consecutive jobs of the same
// job_type, the drain loop excludes that type for the next acquire so other
// types make progress under a large same-type backlog. 8 lets a tight
// supervisor tick (limit=10) trigger the rebalance.
export const MAX_CONSECUTIVE_SAME_TYPE = 8;
// df_02d633dc — round-robin fairness (fairnessMode: 'round_robin_by_type').
// All four are read at call time via positiveInt(process.env.X, DEFAULT) so an
// ops override takes effect on the next launchd sync fire without a restart —
// same convention backoffDelayMs uses for its base/max. The env-var names are
// the tunables; these are their defaults.
//
// Per-row STALL guard: a row is excluded from round-robin contention once its
// consecutive non-progressing turns (busy-classified retry, lease-expiry
// reclaim, or benign requeue) exceed STALL_TURNS, then re-admitted for one
// probe turn once its stall_probe_at ages past STALL_PROBE_COOLDOWN_MS (or is
// NULL). A row genuinely marching toward quarantine never increments
// stall_streak (failPassiveJob increments it on the busy branch only), so the
// guard never interferes with the real-failure path.
const DEFAULT_STALL_TURNS = 3;
const DEFAULT_STALL_PROBE_COOLDOWN_MS = 60 * 60_000;
// Per-type MONOPOLY cap: a job_type is excluded from type_rank once it has won
// the rotation slot more than TYPE_MONOPOLY_CAP_TICKS consecutive times without
// a real success (35 → excluded on the 36th win = 36 × 5-minute ticks = exactly
// 3 hours), then re-admitted for one probe turn once last_monopoly_win_at ages
// past TYPE_MONOPOLY_COOLDOWN_MS. Flat, row-count-independent — it counts turns
// won, not rows cleared, so the bound does not grow as accounts are connected.
const DEFAULT_TYPE_MONOPOLY_CAP_TICKS = 35;
const DEFAULT_TYPE_MONOPOLY_COOLDOWN_MS = 60 * 60_000;
// st_27561b77 AC3 — in-process summary cache TTL. Back-to-back
// /api/server-health calls within 2s reuse the cached summary instead of
// re-running four full-table aggregates on a 6.1 GB DB.
// st_27561b77 AC3 — summary cache TTL. The four full-table aggregates cost
// 250–300ms on the live 6.1 GB DB even with the (queue, job_type, status)
// composite index. The supervisor's drain tick (every 15s) refreshes the
// cache pre-emptively so foreground /api/server-health calls never pay
// the scan cost — they always hit cache. The TTL must comfortably exceed
// the tick interval; 30s gives the supervisor 2x headroom before any
// foreground request would see a cold miss.
const SUMMARY_CACHE_TTL_MS = Number(process.env.ROBOTDOJO_PASSIVE_SUMMARY_CACHE_MS || 30_000);

function iso(date = new Date()) {
  return date.toISOString();
}

function datePlus(ms) {
  return iso(new Date(Date.now() + ms));
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function safeJson(value, fallback = {}) {
  if (value === undefined || value === null) return JSON.stringify(fallback);
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ value });
    }
  }
  return JSON.stringify(value);
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || '{}'); } catch { return fallback; }
}

function stableId(seed) {
  return `pj_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

function normalizeError(err) {
  if (!err) return 'job failed';
  return String(err.message || err.code || err.name || err).slice(0, 1000);
}

function isBusyError(err) {
  const message = normalizeError(err);
  return err?.code === 'SQLITE_BUSY' || err?.code === 'SQLITE_LOCKED' || /SQLITE_(BUSY|LOCKED)|database is locked|database locked/i.test(message);
}

function backoffDelayMs(attempts, opts = {}) {
  const base = positiveInt(opts.baseMs ?? process.env.ROBOTDOJO_PASSIVE_JOB_BACKOFF_BASE_MS, DEFAULT_BACKOFF_BASE_MS);
  const max = positiveInt(opts.maxMs ?? process.env.ROBOTDOJO_PASSIVE_JOB_BACKOFF_MAX_MS, DEFAULT_BACKOFF_MAX_MS);
  const exponent = Math.max(0, Math.min(10, Number(attempts || 1) - 1));
  return Math.min(max, base * (2 ** exponent));
}

function buildTypeFilter(jobTypes, params) {
  if (!jobTypes || jobTypes.length === 0) return '';
  const placeholders = jobTypes.map((type) => {
    params.push(type);
    return '?';
  }).join(', ');
  return ` AND job_type IN (${placeholders})`;
}

function buildUniqueKeyFilter(uniqueKeys, params) {
  if (!uniqueKeys || uniqueKeys.length === 0) return '';
  const placeholders = uniqueKeys.map((key) => {
    params.push(key);
    return '?';
  }).join(', ');
  return ` AND unique_key IN (${placeholders})`;
}

export function passiveJobUniqueKey({ jobType, targetType = 'system', targetId = '', payload = null } = {}) {
  const target = `${jobType || 'job'}:${targetType}:${targetId}`;
  if (!payload) return target;
  const payloadHash = crypto.createHash('sha256').update(safeJson(payload)).digest('hex').slice(0, 16);
  return `${target}:${payloadHash}`;
}

export function enqueuePassiveJob({
  database = db,
  id = null,
  queue = DEFAULT_QUEUE,
  jobType,
  uniqueKey = null,
  targetType = 'system',
  targetId = '',
  payload = {},
  priority = 50,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runAfter = null,
  metadata = {},
  requeueDone = false,
  requeueQuarantined = false,
} = {}) {
  if (!jobType) throw new Error('enqueuePassiveJob: jobType required');
  const normalizedTargetId = String(targetId ?? '');
  const normalizedUniqueKey = uniqueKey || passiveJobUniqueKey({ jobType, targetType, targetId: normalizedTargetId });
  const normalizedId = id || stableId(normalizedUniqueKey);
  const now = iso();
  const nextRun = runAfter || now;

  database.prepare(`
    INSERT INTO passive_jobs (
      id, queue, job_type, unique_key, target_type, target_id, payload, status,
      priority, max_attempts, run_after, timeout_ms, metadata, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(unique_key) DO UPDATE SET
      payload = excluded.payload,
      priority = MAX(passive_jobs.priority, excluded.priority),
      max_attempts = excluded.max_attempts,
      timeout_ms = excluded.timeout_ms,
      metadata = excluded.metadata,
      attempts = CASE
        WHEN passive_jobs.status = 'quarantined' AND ? = 1 THEN 0
        ELSE passive_jobs.attempts
      END,
      retry_count = CASE
        WHEN passive_jobs.status = 'quarantined' AND ? = 1 THEN 0
        ELSE passive_jobs.retry_count
      END,
      run_after = CASE
        WHEN passive_jobs.status = 'done' AND ? = 0 THEN passive_jobs.run_after
        WHEN passive_jobs.status = 'quarantined' AND ? = 0 THEN passive_jobs.run_after
        WHEN passive_jobs.status = 'running' THEN passive_jobs.run_after
        ELSE excluded.run_after
      END,
      status = CASE
        WHEN passive_jobs.status = 'done' AND ? = 0 THEN passive_jobs.status
        WHEN passive_jobs.status = 'quarantined' AND ? = 0 THEN passive_jobs.status
        WHEN passive_jobs.status = 'running' THEN passive_jobs.status
        ELSE 'queued'
      END,
      lease_owner = CASE WHEN passive_jobs.status = 'running' THEN passive_jobs.lease_owner ELSE NULL END,
      lease_expires_at = CASE WHEN passive_jobs.status = 'running' THEN passive_jobs.lease_expires_at ELSE NULL END,
      last_error = CASE
        WHEN passive_jobs.status = 'quarantined' AND ? = 1 THEN NULL
        WHEN passive_jobs.status IN ('done', 'quarantined') THEN passive_jobs.last_error
        ELSE NULL
      END,
      last_failure_at = CASE
        WHEN passive_jobs.status = 'quarantined' AND ? = 1 THEN NULL
        ELSE passive_jobs.last_failure_at
      END,
      quarantine_reason = CASE
        WHEN passive_jobs.status = 'quarantined' AND ? = 0 THEN passive_jobs.quarantine_reason
        ELSE NULL
      END,
      updated_at = excluded.updated_at
  `).run(
    normalizedId,
    queue,
    jobType,
    normalizedUniqueKey,
    targetType,
    normalizedTargetId,
    safeJson(payload),
    priority,
    maxAttempts,
    nextRun,
    timeoutMs,
    safeJson(metadata),
    now,
    now,
    requeueQuarantined ? 1 : 0,
    requeueQuarantined ? 1 : 0,
    requeueDone ? 1 : 0,
    requeueQuarantined ? 1 : 0,
    requeueDone ? 1 : 0,
    requeueQuarantined ? 1 : 0,
    requeueQuarantined ? 1 : 0,
    requeueQuarantined ? 1 : 0,
    requeueQuarantined ? 1 : 0,
  );

  const row = database.prepare('SELECT * FROM passive_jobs WHERE unique_key = ?').get(normalizedUniqueKey);
  return hydrateJob(row);
}

export function getPassiveJob(database = db, id) {
  const row = database.prepare('SELECT * FROM passive_jobs WHERE id = ? OR unique_key = ?').get(id, id);
  return hydrateJob(row);
}

function recoverClaimableJobs(database, now) {
  // st_b50005df Phase 2 — lease-expiry recovery is a BENIGN reclaim, not a
  // failure. A crash, jetsam -9, idle-abort, or a slice that ran past its
  // lease is indistinguishable from a slow worker (the SQS visibility-timeout
  // property): the lease simply expires and the row becomes claimable again.
  // We bump `reclaims` (bookkeeping) and leave `attempts` (real-failure count)
  // untouched, so an unbreakable job can be reclaimed without ever marching
  // toward the max_attempts -> quarantine dead-end. This is the fix for the
  // live churn where one embedding_topic job reached attempts=246 without
  // ever failing.
  // df_02d633dc — a lease-expiry reclaim is a non-progressing turn: bump
  // stall_streak + stamp stall_probe_at unconditionally on this path (every
  // reclaim here is non-progressing by definition). The second statement below
  // (paused → queued resume) is NOT a stall signal and must not touch either.
  database.prepare(`
    UPDATE passive_jobs
       SET status = 'queued',
           reclaims = reclaims + 1,
           stall_streak = stall_streak + 1,
           stall_probe_at = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           started_at = NULL,
           last_error = COALESCE(last_error, 'stale lease recovered'),
           updated_at = ?
     WHERE status = 'running'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= ?
  `).run(now, now, now);

  database.prepare(`
    UPDATE passive_jobs
       SET status = 'queued',
           updated_at = ?
     WHERE status = 'paused'
       AND run_after <= ?
  `).run(now, now);
}

export function acquireNextPassiveJob({
  database = db,
  queue = DEFAULT_QUEUE,
  worker = `worker:${process.pid}`,
  jobTypes = null,
  uniqueKeys = null,
  leaseMs = DEFAULT_LEASE_MS,
  // df_02d633dc — opt-in fairness ordering. Default null selects the legacy,
  // byte-for-byte unmodified `ORDER BY priority DESC` query for every existing
  // caller. 'round_robin_by_type' selects type-level round-robin by staleness,
  // with a per-row stall guard and a per-type monopoly cap (Piece 1). Only
  // scripts/sync.js sets this — every other caller resolves it to null.
  fairnessMode = null,
} = {}) {
  const now = iso();
  const leaseUntil = datePlus(positiveInt(leaseMs, DEFAULT_LEASE_MS));

  return database.transaction(() => {
    recoverClaimableJobs(database, now);

    const params = [queue, now];
    const typeFilter = buildTypeFilter(jobTypes, params);
    const uniqueKeyFilter = buildUniqueKeyFilter(uniqueKeys, params);

    let row;
    if (fairnessMode === 'round_robin_by_type') {
      const stallTurns = positiveInt(process.env.ROBOTDOJO_PASSIVE_ROTATION_STALL_TURNS, DEFAULT_STALL_TURNS);
      const probeCooldownMs = positiveInt(process.env.ROBOTDOJO_PASSIVE_ROTATION_STALL_PROBE_COOLDOWN_MS, DEFAULT_STALL_PROBE_COOLDOWN_MS);
      const capTicks = positiveInt(process.env.ROBOTDOJO_PASSIVE_ROTATION_TYPE_MONOPOLY_CAP_TICKS, DEFAULT_TYPE_MONOPOLY_CAP_TICKS);
      const typeCooldownMs = positiveInt(process.env.ROBOTDOJO_PASSIVE_ROTATION_TYPE_MONOPOLY_COOLDOWN_MS, DEFAULT_TYPE_MONOPOLY_COOLDOWN_MS);
      const nowMs = Date.parse(now);
      const probeCutoff = iso(new Date(nowMs - probeCooldownMs));
      const typeCooldownCutoff = iso(new Date(nowMs - typeCooldownMs));

      // Fully-protected query. `rotation_eligible` drops per-row stall-guarded
      // rows BEFORE the type_rank aggregate (so an excluded row's stale anchor
      // can't poison its type's MAX); `type_capped` drops per-type monopoly-
      // capped types by grouping key. Ranking is by staleness between types
      // (MAX-per-type, not MIN — one broken row can't drag a healthy type
      // stale), priority only as the within-type row tiebreak.
      row = database.prepare(`
        WITH due AS (
          SELECT * FROM passive_jobs
           WHERE queue = ?
             AND status = 'queued'
             AND run_after <= ?
             ${typeFilter}
             ${uniqueKeyFilter}
        ),
        rotation_eligible AS (
          SELECT * FROM due
           WHERE stall_streak <= ?
              OR stall_probe_at IS NULL
              OR stall_probe_at <= ?
        ),
        type_capped AS (
          SELECT job_type FROM passive_job_type_rotation
           WHERE queue = ?
             AND monopoly_streak > ?
             AND last_monopoly_win_at IS NOT NULL
             AND last_monopoly_win_at > ?
        ),
        type_rank AS (
          SELECT job_type,
                 MAX(COALESCE(last_success_at, created_at)) AS type_anchor,
                 MAX(priority)                              AS type_priority
            FROM rotation_eligible
           WHERE job_type NOT IN (SELECT job_type FROM type_capped)
           GROUP BY job_type
           ORDER BY type_anchor ASC, type_priority DESC, job_type ASC
           LIMIT 1
        )
        SELECT rotation_eligible.*
          FROM rotation_eligible JOIN type_rank ON rotation_eligible.job_type = type_rank.job_type
         ORDER BY priority DESC, run_after ASC, created_at ASC
         LIMIT 1
      `).get(...params, stallTurns, probeCutoff, queue, capTicks, typeCooldownCutoff);

      if (!row) {
        // Total collapse — every due row stall-guarded and/or every due type
        // monopoly-capped, all still inside cooldown. Never return null while
        // real due work exists: fall back to the unfiltered round-robin query
        // directly against `due`. Returns null iff `due` is genuinely empty.
        row = database.prepare(`
          WITH due AS (
            SELECT * FROM passive_jobs
             WHERE queue = ?
               AND status = 'queued'
               AND run_after <= ?
               ${typeFilter}
               ${uniqueKeyFilter}
          ),
          type_rank AS (
            SELECT job_type,
                   MAX(COALESCE(last_success_at, created_at)) AS type_anchor,
                   MAX(priority)                              AS type_priority
              FROM due
             GROUP BY job_type
             ORDER BY type_anchor ASC, type_priority DESC, job_type ASC
             LIMIT 1
          )
          SELECT due.*
            FROM due JOIN type_rank ON due.job_type = type_rank.job_type
           ORDER BY priority DESC, run_after ASC, created_at ASC
           LIMIT 1
        `).get(...params);
      }
    } else {
      row = database.prepare(`
        SELECT *
          FROM passive_jobs
         WHERE queue = ?
           AND status = 'queued'
           AND run_after <= ?
           ${typeFilter}
           ${uniqueKeyFilter}
         ORDER BY priority DESC, run_after ASC, created_at ASC
         LIMIT 1
      `).get(...params);
    }
    if (!row) return null;

    // st_b50005df Phase 2 — claiming a job is NOT a failure attempt. The old
    // code incremented `attempts` on every claim, so a job reclaimed after a
    // benign lease expiry (slow slice, idle-abort, crash) marched toward
    // max_attempts even though nothing failed. `attempts` is now incremented
    // ONLY by failPassiveJob on a real handler error; the claim path leaves it
    // untouched. Benign reclaim bookkeeping lives in `reclaims`
    // (recoverClaimableJobs).
    const updated = database.prepare(`
      UPDATE passive_jobs
         SET status = 'running',
             lease_owner = ?,
             lease_expires_at = ?,
             started_at = COALESCE(started_at, ?),
             finished_at = NULL,
             updated_at = ?
       WHERE id = ?
         AND status = 'queued'
    `).run(worker, leaseUntil, now, now, row.id);
    if (updated.changes !== 1) return null;

    // df_02d633dc — type-level monopoly cap: count this type's consecutive
    // rotation-slot wins. Scoped to round_robin_by_type only, so every other
    // caller (which never sets fairnessMode) never writes this table at all.
    // Reset to 0 by completePassiveJob on a real success.
    if (fairnessMode === 'round_robin_by_type') {
      database.prepare(`
        INSERT INTO passive_job_type_rotation (queue, job_type, monopoly_streak, last_monopoly_win_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(queue, job_type) DO UPDATE SET
          monopoly_streak = monopoly_streak + 1,
          last_monopoly_win_at = excluded.last_monopoly_win_at
      `).run(queue, row.job_type, now);
    }

    return hydrateJob(database.prepare('SELECT * FROM passive_jobs WHERE id = ?').get(row.id));
  })();
}

export function completePassiveJob(database = db, id, result = {}) {
  const now = iso();
  // df_02d633dc — read (queue, job_type) before the update so the type-level
  // monopoly-streak reset can key on them. One indexed primary-key lookup.
  const owner = database.prepare('SELECT queue, job_type FROM passive_jobs WHERE id = ?').get(id);
  // df_02d633dc — a real success resets stall_streak to 0 (the one place a
  // row's success is recorded). This is the load-bearing reset: it lets a
  // recovered row leave the stall guard's exclusion instead of being frozen
  // out forever by its own long-resolved history.
  database.prepare(`
    UPDATE passive_jobs
       SET status = 'done',
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_success_at = ?,
           finished_at = ?,
           last_error = NULL,
           quarantine_reason = NULL,
           stall_streak = 0,
           metadata = ?,
           updated_at = ?
     WHERE id = ?
  `).run(now, now, safeJson(result), now, id);
  // df_02d633dc — reset the type-level monopoly streak on real success. No
  // fairnessMode gate needed: for any job_type that never won under
  // round_robin_by_type, passive_job_type_rotation has no matching row, so this
  // UPDATE affects zero rows and is a silent no-op (scoped by construction, not
  // by conditional). Never creates a row as a side effect.
  if (owner) {
    database.prepare(`
      UPDATE passive_job_type_rotation
         SET monopoly_streak = 0
       WHERE queue = ? AND job_type = ?
    `).run(owner.queue, owner.job_type);
  }
  return getPassiveJob(database, id);
}

export function failPassiveJob(database = db, id, err, opts = {}) {
  const row = database.prepare('SELECT * FROM passive_jobs WHERE id = ?').get(id);
  if (!row) return null;
  const now = iso();
  const message = normalizeError(err);
  const poison = opts.quarantine || err?.quarantine || err?.poison;
  const retryableBusy = isBusyError(err);
  // st_b50005df Phase 2 — `attempts` is now the REAL-failure counter, and it
  // is incremented HERE (the only place a genuine handler error is recorded),
  // not on claim. A transient DB-busy error does not consume an attempt
  // (retryableBusy short-circuits before the increment) so lock contention
  // never marches a healthy job to quarantine. The exhaustion check compares
  // the POST-increment count against max_attempts: a job is quarantined only
  // once it has genuinely failed max_attempts times for a non-busy reason —
  // exactly the poison-pill case quarantine exists to contain.
  const nextAttempts = retryableBusy ? row.attempts : row.attempts + 1;
  const exhausted = nextAttempts >= row.max_attempts;
  if (poison || (exhausted && !retryableBusy)) {
    // Record the failed attempt before quarantining so the attempts count
    // reflects the real-failure total that tripped the dead-letter.
    if (!retryableBusy) {
      database.prepare('UPDATE passive_jobs SET attempts = ? WHERE id = ?').run(nextAttempts, id);
    }
    return quarantinePassiveJob(database, id, opts.reason || message);
  }

  const delayMs = opts.delayMs ?? backoffDelayMs(nextAttempts, opts);
  const runAfter = datePlus(delayMs);
  // df_02d633dc — stall guard write-site. stall_probe_at (the escape-hatch
  // cooldown clock) is stamped unconditionally on every retry — it is just a
  // "last non-progressing event" timestamp with no arithmetic role. stall_streak
  // increments ONLY when the failure is busy-classified (retryableBusy): a
  // busy/lock retry never consumes an attempt and never quarantines, so it is
  // the never-progresses case the guard is for. A genuine, non-busy failure
  // marching toward quarantine must NOT increment stall_streak, or the guard
  // would start interfering with the quarantine path.
  database.prepare(`
    UPDATE passive_jobs
       SET status = 'queued',
           attempts = ?,
           retry_count = retry_count + 1,
           run_after = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_failure_at = ?,
           last_error = ?,
           finished_at = ?,
           stall_probe_at = ?,
           stall_streak = stall_streak + ?,
           updated_at = ?
     WHERE id = ?
  `).run(nextAttempts, runAfter, now, message, now, now, retryableBusy ? 1 : 0, now, id);
  return getPassiveJob(database, id);
}

/**
 * st_b50005df Phase 2 — benign re-queue of an interrupted-but-not-failed job.
 *
 * The handler signals "I was aborted by idle/signal, or stopped cleanly with
 * work remaining" — NOT "I errored." This is the success-but-interrupted path:
 * the job re-queues immediately (or after an optional small delay) with
 * `attempts` UNCHANGED, bumping only `reclaims`. It is the explicit, named
 * counterpart to failPassiveJob: failure consumes an attempt and can quarantine;
 * a benign reclaim never does. Idempotent content-keyed writes (embed.js's
 * DELETE+INSERT) make re-running the reclaimed job safe.
 *
 * @param {object} database
 * @param {string} id
 * @param {object} [opts]
 * @param {string} [opts.reason]  bookkeeping note stored in last_error
 * @param {number} [opts.delayMs] optional delay before the row is claimable
 */
export function requeuePassiveJob(database = db, id, opts = {}) {
  const row = database.prepare('SELECT * FROM passive_jobs WHERE id = ?').get(id);
  if (!row) return null;
  const now = iso();
  const delayMs = positiveInt(opts.delayMs, 0);
  const runAfter = delayMs > 0 ? datePlus(delayMs) : now;
  const reason = opts.reason ? String(opts.reason).slice(0, 1000) : 'interrupted — benign reclaim';
  // df_02d633dc — every call to this function is a benign, non-progressing
  // reclaim, so bump stall_streak + stamp stall_probe_at unconditionally,
  // mirroring the reclaims bump. (A row that keeps getting benignly requeued
  // without ever succeeding is exactly the never-progresses case the guard
  // bounds.)
  database.prepare(`
    UPDATE passive_jobs
       SET status = 'queued',
           reclaims = reclaims + 1,
           stall_streak = stall_streak + 1,
           stall_probe_at = ?,
           run_after = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = ?,
           finished_at = ?,
           started_at = NULL,
           updated_at = ?
     WHERE id = ?
  `).run(now, runAfter, reason, now, now, id);
  return getPassiveJob(database, id);
}

/**
 * st_27561b77 AC7 — extend the lease window of a running job.
 *
 * Long-running handlers (the pipeline INGEST phase, the email backfill
 * pass) call this every ~20s. Without it, a handler that runs longer than
 * DEFAULT_LEASE_MS (30s) will get its lease marked stale by
 * recoverClaimableJobs() in the next acquire, causing duplicate execution.
 *
 * The function only renews — it does not validate ownership. Callers that
 * need ownership semantics should compare lease_owner before calling. The
 * separation is intentional: this is a primitive, not a guard.
 */
export function renewPassiveJobLease(database = db, id, leaseMs = DEFAULT_LEASE_MS) {
  const ms = positiveInt(leaseMs, DEFAULT_LEASE_MS);
  const now = iso();
  const leaseUntil = datePlus(ms);
  database.prepare(`
    UPDATE passive_jobs
       SET lease_expires_at = ?,
           updated_at = ?
     WHERE id = ?
       AND status = 'running'
  `).run(leaseUntil, now, id);
  return getPassiveJob(database, id);
}

export function pausePassiveJob(database = db, id, reason = 'background pressure', delayMs = DEFAULT_PRESSURE_DELAY_MS) {
  const now = iso();
  const runAfter = datePlus(positiveInt(delayMs, DEFAULT_PRESSURE_DELAY_MS));
  database.prepare(`
    UPDATE passive_jobs
       SET status = 'paused',
           run_after = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = ?,
           finished_at = ?,
           updated_at = ?
     WHERE id = ?
  `).run(runAfter, reason, now, now, id);
  return getPassiveJob(database, id);
}

export function quarantinePassiveJob(database = db, id, reason = 'poison record') {
  const now = iso();
  database.prepare(`
    UPDATE passive_jobs
       SET status = 'quarantined',
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_failure_at = ?,
           last_error = ?,
           quarantine_reason = ?,
           finished_at = ?,
           updated_at = ?
     WHERE id = ?
  `).run(now, reason, reason, now, now, id);
  return getPassiveJob(database, id);
}

export function mirrorPassiveJobStatus(database = db, {
  jobType,
  uniqueKey,
  targetType = 'integration',
  targetId = '',
  payload = {},
  status = 'queued',
  error = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  metadata = {},
} = {}) {
  if (!jobType || !uniqueKey) return null;
  const job = enqueuePassiveJob({
    database,
    jobType,
    uniqueKey,
    targetType,
    targetId,
    payload,
    maxAttempts,
    timeoutMs,
    metadata,
    requeueDone: status === 'queued' || status === 'running',
  });
  const normalized = String(status || '').toLowerCase();
  if (job.status === 'quarantined' && !['ok', 'done', 'connected', 'partial'].includes(normalized)) {
    return job;
  }
  const now = iso();
  if (normalized === 'running' || normalized === 'in_progress') {
    // st_b50005df Phase 2 — entering 'running' is a claim, not a failure, so
    // it no longer touches `attempts` (the real-failure counter). The external
    // mirror's failure accounting flows through failPassiveJob below, which is
    // the single writer of `attempts`.
    database.prepare(`
      UPDATE passive_jobs
         SET status = 'running',
             lease_owner = COALESCE(lease_owner, 'external'),
             lease_expires_at = ?,
             started_at = COALESCE(started_at, ?),
             updated_at = ?
       WHERE id = ?
    `).run(datePlus(DEFAULT_LEASE_MS), now, now, job.id);
  } else if (['ok', 'done', 'connected', 'partial'].includes(normalized)) {
    completePassiveJob(database, job.id, { mirrored_status: normalized, ...metadata });
  } else if (['error', 'failed', 'needs_permission'].includes(normalized)) {
    failPassiveJob(database, job.id, error || normalized, { delayMs: backoffDelayMs(job.attempts || 1) });
  }
  return getPassiveJob(database, job.id);
}

export function resourcePressureDecision({
  worker = 'passive-worker',
  loadAverage = os.loadavg()[0],
  cpuCount = os.cpus()?.length || 1,
  freeMem = os.freemem(),
  totalMem = os.totalmem(),
  platform = os.platform(),
  memoryFreeRatio = null,
  env = process.env,
} = {}) {
  if (env.ROBOTDOJO_FORCE_BACKGROUND_PRESSURE === '1') {
    return { ok: false, reason: 'forced-pressure', delayMs: DEFAULT_PRESSURE_DELAY_MS, worker };
  }
  if (env.ROBOTDOJO_DISABLE_BACKGROUND_PRESSURE_GUARD === '1') {
    return { ok: true, worker };
  }
  const loadRatio = cpuCount > 0 ? loadAverage / cpuCount : loadAverage;
  const loadLimit = Number(env.ROBOTDOJO_BACKGROUND_LOAD_LIMIT || 2.5);
  if (Number.isFinite(loadLimit) && loadRatio > loadLimit) {
    return {
      ok: false,
      reason: 'cpu-pressure',
      loadAverage,
      cpuCount,
      loadRatio: Number(loadRatio.toFixed(2)),
      delayMs: DEFAULT_PRESSURE_DELAY_MS,
      worker,
    };
  }
  const freeRatio = memoryFreeRatio !== null && memoryFreeRatio !== undefined && Number.isFinite(Number(memoryFreeRatio))
    ? Number(memoryFreeRatio)
    : effectiveMemoryFreeRatio({ platform, freeMem, totalMem, env });
  const minFree = Number(env.ROBOTDOJO_BACKGROUND_MIN_FREE_MEM_RATIO || 0.05);
  if (Number.isFinite(minFree) && freeRatio < minFree) {
    return {
      ok: false,
      reason: 'memory-pressure',
      freeRatio: Number(freeRatio.toFixed(3)),
      delayMs: DEFAULT_PRESSURE_DELAY_MS,
      worker,
    };
  }
  return { ok: true, worker, loadAverage, cpuCount, freeRatio };
}

export function darwinMemoryFreeRatioFromPressureOutput(output) {
  const match = String(output || '').match(/System-wide memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/i);
  if (!match) return null;
  const pct = Number(match[1]);
  return Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : null;
}

function readDarwinMemoryPressureFreeRatio({ env = process.env } = {}) {
  if (env.ROBOTDOJO_DISABLE_DARWIN_MEMORY_PRESSURE === '1') return null;
  try {
    const result = spawnSync('/usr/bin/memory_pressure', [], {
      encoding: 'utf8',
      timeout: Number(env.ROBOTDOJO_DARWIN_MEMORY_PRESSURE_TIMEOUT_MS || 1000),
      maxBuffer: 128 * 1024,
    });
    if (result.status !== 0 && !result.stdout) return null;
    return darwinMemoryFreeRatioFromPressureOutput(`${result.stdout || ''}\n${result.stderr || ''}`);
  } catch {
    return null;
  }
}

export function effectiveMemoryFreeRatio({
  platform = os.platform(),
  freeMem = os.freemem(),
  totalMem = os.totalmem(),
  env = process.env,
} = {}) {
  if (platform === 'darwin') {
    const darwinRatio = readDarwinMemoryPressureFreeRatio({ env });
    if (Number.isFinite(darwinRatio)) return darwinRatio;
  }
  return totalMem > 0 ? freeMem / totalMem : 1;
}

function timeoutPromise(ms, label) {
  return new Promise((_, reject) => {
    const t = setTimeout(() => {
      const err = new Error(`${label || 'passive job'} timed out`);
      err.code = 'PASSIVE_JOB_TIMEOUT';
      reject(err);
    }, ms);
    t.unref?.();
  });
}

export async function runPassiveJob(job, handler, {
  database = db,
  worker = 'passive-worker',
  pressureCheck = resourcePressureDecision,
} = {}) {
  const pressure = pressureCheck({ worker });
  if (!pressure.ok) {
    try {
      return {
        skipped: true,
        job: pausePassiveJob(database, job.id, pressure.reason, pressure.delayMs),
        reason: pressure.reason,
      };
    } catch (err) {
      if (isBusyError(err)) {
        return {
          skipped: true,
          job,
          reason: 'database_locked',
          error: normalizeError(err),
          transient_db_lock: true,
        };
      }
      throw err;
    }
  }

  try {
    const result = await Promise.race([
      Promise.resolve(handler(job)),
      timeoutPromise(job.timeout_ms || DEFAULT_TIMEOUT_MS, job.job_type),
    ]);
    // st_b50005df Phase 2 — a handler that returns `{ aborted: true }` was
    // interrupted by idle/signal with work still remaining. This is NOT a
    // completion and NOT a failure: re-queue benignly so `attempts` is
    // unchanged and the job never marches to quarantine for being paused.
    if (result && result.aborted === true) {
      return {
        aborted: true,
        job: requeuePassiveJob(database, job.id, { reason: result.reason || 'aborted by idle/signal' }),
        reason: result.reason || 'aborted by idle/signal',
      };
    }
    if (result && result.partial === true) {
      const reason = result.lockSkipped
        ? 'partial slice — writer lock unavailable'
        : (result.reason || 'partial slice — residual work remains');
      return {
        partial: true,
        job: requeuePassiveJob(database, job.id, {
          reason,
          delayMs: positiveInt(result.requeueDelayMs, DEFAULT_PARTIAL_DELAY_MS),
        }),
        reason,
      };
    }
    return { ok: true, job: completePassiveJob(database, job.id, result || {}) };
  } catch (err) {
    // st_b50005df Phase 2 — an AbortError thrown by the handler (idle-abort or
    // SIGTERM mid-batch) is a benign interruption, not a real failure. Route it
    // to a benign reclaim so the real-failure counter is untouched. Any other
    // thrown error is a genuine failure and flows through failPassiveJob.
    if (err?.name === 'AbortError') {
      try {
        return {
          aborted: true,
          job: requeuePassiveJob(database, job.id, { reason: normalizeError(err) }),
          reason: normalizeError(err),
        };
      } catch (statusErr) {
        if (isBusyError(statusErr)) {
          return { aborted: true, skipped: true, job, transient_db_lock: true };
        }
        throw statusErr;
      }
    }
    const error = normalizeError(err);
    try {
      return {
        ok: false,
        job: failPassiveJob(database, job.id, err),
        error,
      };
    } catch (statusErr) {
      if (isBusyError(statusErr)) {
        return {
          ok: false,
          skipped: true,
          job,
          error: normalizeError(statusErr),
          original_error: error,
          transient_db_lock: true,
        };
      }
      throw statusErr;
    }
  }
}

/**
 * st_27561b77 P4 — drain N passive jobs with idle re-check, fairness
 * counter, and per-slice setImmediate yield.
 *
 * Parameters added by st_27561b77:
 *   - `queue` (already present) — scope the drain to a single queue. The
 *     AC2/AC4/AC9 harnesses use isolated queues (ac2-load-test,
 *     ac4-load-test, ac9-fairness-test) so test enqueues never touch the
 *     real `default` queue.
 *   - `idleCheck` — optional callback invoked at each iteration *before*
 *     acquireNextPassiveJob. If it returns `{ok:false}`, any currently
 *     running job is paused (run_after = now + IDLE_PAUSE_DELAY_MS) and
 *     the drain breaks. Lets the in-process supervisor yield the moment
 *     the user becomes active.
 *   - `onJobComplete` — optional callback invoked after each job result
 *     with (job, index). The AC9 fairness harness uses it to record the
 *     index at which the first different-type job transitions.
 *   - `dryRun` — accepted for API symmetry with the AC9 harness; passed
 *     through but does not change drain behavior.
 *
 * Fairness counter (AC9): tracks the type of the last job processed. After
 * MAX_CONSECUTIVE_SAME_TYPE (2) consecutive same-type jobs, the NEXT
 * acquire excludes that type so a different type can be picked up. The
 * counter is local to this call — the supervisor uses limit ≥ 10 so the
 * counter has room to trigger before the call returns (failure mode F7).
 */
export async function drainPassiveJobs(arg1 = {}, arg2 = {}) {
  // st_27561b77 AC2/AC9 harness compatibility — the criteria invoke
  // `drainPassiveJobs(db, {queue, limit, onJobComplete})` (positional).
  // Detect: if arg1 has the better-sqlite3 `prepare` method, it's a db.
  // Else assume options-object form.
  const isDb = arg1 && typeof arg1 === 'object' && typeof arg1.prepare === 'function';
  const opts = isDb ? { database: arg1, ...arg2 } : arg1;
  const {
    database = db,
    worker = 'passive-worker',
    queue = DEFAULT_QUEUE,
    jobTypes = null,
    uniqueKeys = null,
    handlers = {},
    limit = 10,
    leaseMs = DEFAULT_LEASE_MS,
    pressureCheck = resourcePressureDecision,
    idleCheck = null,
    onJobComplete = null,
    // df_02d633dc — forwarded unchanged into acquireNextPassiveJob below.
    // Default null keeps every existing caller on the legacy ordering; only
    // scripts/sync.js (via drainPassiveSyncJobs) sets 'round_robin_by_type'.
    fairnessMode = null,
    // eslint-disable-next-line no-unused-vars
    dryRun = false,
  } = opts || {};
  const max = positiveInt(limit, 10);
  const results = [];
  let lastType = null;
  let sameTypeCount = 0;
  // Track the current running job so the idle-pause path can pause it.
  // The supervisor wires idleCheck so this is exercised in production.
  for (let i = 0; i < max; i += 1) {
    if (typeof idleCheck === 'function') {
      try {
        const decision = idleCheck();
        if (decision && decision.ok === false) {
          results.push({ skipped: true, reason: 'user-active', idle_check: decision });
          break;
        }
      } catch (err) {
        // An idleCheck that throws is a programming error — surface it,
        // but do not crash the drainer. Treat as "idle ok" (safe-fail in
        // the direction of letting work continue).
        results.push({ skipped: false, reason: 'idle-check-error', error: normalizeError(err) });
      }
    }
    // st_27561b77 AC9 — if we have hit the same-type ceiling, exclude that
    // type from the next acquire so a different type can run. The counter
    // does NOT reset until the next acquire returns a different type (or
    // null).
    let acquireTypes = jobTypes;
    if (lastType && sameTypeCount >= MAX_CONSECUTIVE_SAME_TYPE) {
      // Build an exclusion list. If jobTypes was specified, intersect:
      // include every requested type except the saturated one. If not,
      // we cannot enumerate "all types not equal to X" without a schema
      // query — but the in-process supervisor passes limit=10 so the
      // exclusion only needs to last one acquire round.
      if (Array.isArray(jobTypes)) {
        acquireTypes = jobTypes.filter((t) => t !== lastType);
        if (acquireTypes.length === 0) acquireTypes = jobTypes; // nothing else to pick — accept the saturation
      } else {
        // Read distinct types from the queue minus the saturated one.
        try {
          const distinct = database.prepare(`
            SELECT DISTINCT job_type
              FROM passive_jobs
             WHERE queue = ?
               AND status = 'queued'
               AND job_type != ?
          `).all(queue, lastType).map((row) => row.job_type);
          if (distinct.length > 0) acquireTypes = distinct;
        } catch {
          // ignore — fall back to no filter
        }
      }
    }
    let job;
    try {
      job = acquireNextPassiveJob({ database, queue, worker, jobTypes: acquireTypes, uniqueKeys, leaseMs, fairnessMode });
    } catch (err) {
      if (isBusyError(err)) {
        results.push({
          skipped: true,
          reason: 'database_locked',
          error: normalizeError(err),
          transient_db_lock: true,
        });
        break;
      }
      throw err;
    }
    if (!job) break;
    // Update fairness counter BEFORE running so the next iteration's
    // exclusion decision uses the post-acquire state.
    if (job.job_type === lastType) sameTypeCount += 1;
    else { lastType = job.job_type; sameTypeCount = 1; }

    const handler = handlers[job.job_type];
    let outcome;
    if (!handler) {
      outcome = { ok: false, job: quarantinePassiveJob(database, job.id, `no handler for ${job.job_type}`) };
      results.push(outcome);
    } else {
      outcome = await runPassiveJob(job, handler, { database, worker, pressureCheck });
      results.push(outcome);
    }
    if (typeof onJobComplete === 'function') {
      try { onJobComplete(outcome.job || job, i, outcome); }
      catch { /* harness errors must not stop the drain */ }
    }
    // st_b50005df Phase 3 — stop the drain immediately on a self-imposed RSS
    // ceiling breach. Continuing to the next topic in THIS process keeps the
    // accumulated resident set; the only thing that resets RSS is a fresh
    // process, so we stop here and let the launchd respawn (next 120s fire) pick
    // up the benignly-requeued backlog with RSS back at baseline. This is the
    // proactive "restart the embed subprocess before jetsam" backstop.
    if (outcome && outcome.reason === 'embed rss-ceiling restart') {
      results.push({ skipped: true, reason: 'rss-ceiling-stop' });
      break;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  // Attach a processed-count + count of distinct types touched so the
  // supervisor + AC2 under-load harness can assert work actually happened.
  Object.defineProperty(results, 'processed', {
    value: results.filter((r) => r && (r.ok || r.skipped === undefined)).length,
    enumerable: false,
  });
  return results;
}

// st_27561b77 AC3 — in-process summary cache.
//
// Keyed by (queue, jobTypes JSON, limit). The four full-table aggregates
// cost 250–370ms on a 6.1 GB SQLCipher DB even with the new (queue,
// job_type, status) composite index — primarily because each aggregate
// still walks the matched index pages and decrypts each one. A 2s TTL
// amortizes that cost across back-to-back probes (server-health p95 with
// no cache: 2.5s; with 2s cache + index: <300ms).
//
// The cache is intentionally process-local — no cross-process invalidation
// is needed because every write to passive_jobs goes through this
// process (the in-process drainer is the only writer in steady state;
// launchd agents enqueue and exit). A stale 2s read on the summary
// reports counts that may lag the true state by <2s, which is well within
// the AC3 fidelity bar.
const summaryCache = new Map();
function summaryCacheKey({ queue, jobTypes, limit }) {
  return `${queue}|${jobTypes ? JSON.stringify(jobTypes) : ''}|${limit}`;
}

// Build the final summary object — shared between sync and async paths.
function enrichSummaryItem(item) {
  const entry = passiveDataPlanePathFor(item.job_type);
  const classification = classifyPassiveJobDegradation(item);
  return {
    ...item,
    label: entry?.label || item.job_type,
    owner_file: entry?.owner || null,
    degradation_owner: classification.owner,
    build_owned_degradation: classification.build_owned,
    degradation_action: classification.action,
  };
}

function degradedRowRecord(row = {}, classification = classifyPassiveJobDegradation(row)) {
  return {
    job_type: row.job_type,
    target_id: row.target_id || null,
    label: classification.label,
    owner_file: classification.owner_file,
    status: row.status || null,
    count: Number(row.count || 0),
    failed: row.status === 'failed' ? Number(row.count || 0) : Number(row.failed || 0),
    quarantined: row.status === 'quarantined' ? Number(row.count || 0) : Number(row.quarantined || 0),
    sample_error: row.sample_error || row.last_error || null,
    action: classification.action,
  };
}

function summarizeDegradedRows(rows) {
  const counts = {
    product_pipeline: 0,
    external_connector: 0,
    owner_action_required: 0,
    unknown: 0,
  };
  const buildOwned = [];
  const visibleExternal = [];
  for (const row of rows || []) {
    const degradedRows = Number(row.count || 0) || (Number(row.failed || 0) + Number(row.quarantined || 0));
    if (degradedRows <= 0) continue;
    const classification = classifyPassiveJobDegradation(row);
    counts[classification.owner] = (counts[classification.owner] || 0) + degradedRows;
    const record = degradedRowRecord(row, classification);
    if (classification.build_owned) buildOwned.push(record);
    else visibleExternal.push(record);
  }
  const buildOwnedRows = buildOwned.reduce((sum, item) => sum + item.failed + item.quarantined, 0);
  const externalRows = visibleExternal.reduce((sum, item) => sum + item.failed + item.quarantined, 0);
  return {
    ok: buildOwnedRows === 0,
    reason: buildOwnedRows > 0
      ? 'build_owned_degradation_present'
      : externalRows > 0
        ? 'external_or_owner_action_degradation_only'
        : 'no_degradation',
    counts,
    build_owned_failed_or_quarantined: buildOwnedRows,
    visible_external_failed_or_quarantined: externalRows,
    build_owned: buildOwned,
    visible_external: visibleExternal,
  };
}

function degradedRowsForSummary({ database, queue, jobTypes, limit }) {
  const params = [queue];
  const typeFilter = buildTypeFilter(jobTypes, params);
  return database.prepare(`
    SELECT job_type, target_id, status, COUNT(*) AS count,
           MAX(updated_at) AS latest_updated_at,
           MAX(last_failure_at) AS latest_failure_at,
           MAX(last_error) AS sample_error,
           MAX(quarantine_reason) AS quarantine_reason
      FROM passive_jobs
     WHERE queue = ?
       AND status IN ('failed', 'quarantined')
       ${typeFilter}
     GROUP BY job_type, target_id, status
     ORDER BY latest_updated_at DESC
     LIMIT ${positiveInt(limit, 100)}
  `).all(...params);
}

// Build the final summary object — shared between sync and async paths.
function _finalizeSummary(summary, degradedRows = []) {
  const queues = [...summary.values()]
    .map(enrichSummaryItem)
    .sort((a, b) => a.job_type.localeCompare(b.job_type));
  const totals = PASSIVE_JOB_STATUSES.reduce((acc, status) => ({ ...acc, [status]: 0 }), { depth: 0 });
  for (const item of queues) {
    totals.depth += item.depth;
    for (const status of PASSIVE_JOB_STATUSES) totals[status] += item[status] || 0;
  }
  return {
    ok: true,
    checked_at: iso(),
    totals,
    queues,
    degradations: summarizeDegradedRows(degradedRows),
  };
}

/**
 * st_27561b77 AC2/AC3 — async variant of getPassiveJobSummary that yields
 * the event loop between each of the four aggregate scans.
 *
 * WHY this exists: each individual aggregate is ~70ms on the live 6.1 GB
 * SQLCipher DB. Run sequentially in one synchronous function (the sync
 * version above) the total is ~280ms, exceeding the AC2 200ms event-loop
 * ceiling. With `await new Promise(r => setImmediate(r))` between scans,
 * no single sync chunk exceeds ~80ms — well under the ceiling.
 *
 * The supervisor's pre-warm path uses this async version. The foreground
 * request path can use the sync version because it now always hits the
 * cache (supervisor pre-warms every SUMMARY_REFRESH_MS).
 *
 * Result is identical to getPassiveJobSummary({noCache:true}). Writes to
 * the same in-process cache so subsequent sync reads see the fresh value.
 */
export async function getPassiveJobSummaryAsync({
  database = db,
  jobTypes = null,
  queue = DEFAULT_QUEUE,
  limit = 100,
  noCache = false,
} = {}) {
  // st_27561b77 AC2/AC3 — cache short-circuit. Without this, every async
  // call re-runs the four aggregate scans even when the sync cache is
  // warm — defeating the cache when both sync and async readers coexist
  // (server-health body builder calls async on every request).
  if (!noCache && SUMMARY_CACHE_TTL_MS > 0) {
    const key = summaryCacheKey({ queue, jobTypes, limit });
    const cached = summaryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }
  const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

  // Scan 1: GROUP BY job_type, status
  const params1 = [queue];
  const typeFilter1 = buildTypeFilter(jobTypes, params1);
  const rows = database.prepare(`
    SELECT job_type, status, COUNT(*) AS count
      FROM passive_jobs
     WHERE queue = ?
       ${typeFilter1}
     GROUP BY job_type, status
     ORDER BY job_type, status
     LIMIT ${positiveInt(limit, 100)}
  `).all(...params1);
  await yieldLoop();

  const summary = new Map();
  for (const row of rows) {
    if (!summary.has(row.job_type)) {
      summary.set(row.job_type, {
        job_type: row.job_type,
        depth: 0,
        queued: 0,
        running: 0,
        paused: 0,
        done: 0,
        failed: 0,
        quarantined: 0,
        retry_count: 0,
        last_success_at: null,
        last_failure_at: null,
        last_error: null,
        next_retry_at: null,
        active_job: null,
      });
    }
    const item = summary.get(row.job_type);
    item[row.status] = row.count;
    if (['queued', 'running', 'paused'].includes(row.status)) item.depth += row.count;
  }

  // Scan 2: detail aggregates (SUM, MAX, MIN)
  const params2 = [queue];
  const typeFilter2 = buildTypeFilter(jobTypes, params2);
  const details = database.prepare(`
    SELECT job_type,
           SUM(retry_count) AS retry_count,
           MAX(last_success_at) AS last_success_at,
           MAX(last_failure_at) AS last_failure_at,
           MIN(CASE WHEN status IN ('queued', 'paused') THEN run_after ELSE NULL END) AS next_retry_at
      FROM passive_jobs
     WHERE queue = ?
       ${typeFilter2}
     GROUP BY job_type
  `).all(...params2);
  for (const row of details) {
    const item = summary.get(row.job_type);
    if (!item) continue;
    item.retry_count = row.retry_count || 0;
    item.last_success_at = row.last_success_at || null;
    item.last_failure_at = row.last_failure_at || null;
    item.next_retry_at = row.next_retry_at || null;
  }
  await yieldLoop();

  // Scan 3: running jobs (active_job)
  const params3 = [queue];
  const typeFilter3 = buildTypeFilter(jobTypes, params3);
  const active = database.prepare(`
    SELECT job_type, id, target_type, target_id, lease_owner, lease_expires_at, started_at
      FROM passive_jobs
     WHERE queue = ?
       AND status = 'running'
       ${typeFilter3}
     ORDER BY started_at DESC
  `).all(...params3);
  for (const row of active) {
    const item = summary.get(row.job_type);
    if (!item || item.active_job) continue;
    item.active_job = {
      id: row.id,
      target_type: row.target_type,
      target_id: row.target_id,
      lease_owner: row.lease_owner,
      lease_expires_at: row.lease_expires_at,
      started_at: row.started_at,
    };
  }
  await yieldLoop();

  // Scan 4: last_error per job_type
  const params4 = [queue];
  const typeFilter4 = buildTypeFilter(jobTypes, params4);
  const errors = database.prepare(`
    SELECT job_type, last_error
      FROM passive_jobs
     WHERE queue = ?
       AND last_error IS NOT NULL
       ${typeFilter4}
     ORDER BY updated_at DESC
  `).all(...params4);
  for (const row of errors) {
    const item = summary.get(row.job_type);
    if (item && !item.last_error) item.last_error = row.last_error;
  }

  await yieldLoop();
  const degradedRows = degradedRowsForSummary({ database, queue, jobTypes, limit });

  const summaryResult = _finalizeSummary(summary, degradedRows);
  if (SUMMARY_CACHE_TTL_MS > 0) {
    const key = summaryCacheKey({ queue, jobTypes, limit });
    summaryCache.set(key, { value: summaryResult, expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS });
    if (summaryCache.size > 64) {
      const oldestKey = summaryCache.keys().next().value;
      summaryCache.delete(oldestKey);
    }
  }
  return summaryResult;
}

export function getPassiveJobSummary({
  database = db,
  jobTypes = null,
  queue = DEFAULT_QUEUE,
  limit = 100,
  noCache = false,
} = {}) {
  if (!noCache && SUMMARY_CACHE_TTL_MS > 0) {
    const key = summaryCacheKey({ queue, jobTypes, limit });
    const cached = summaryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }
  const params = [queue];
  const typeFilter = buildTypeFilter(jobTypes, params);
  const rows = database.prepare(`
    SELECT job_type, status, COUNT(*) AS count
      FROM passive_jobs
     WHERE queue = ?
       ${typeFilter}
     GROUP BY job_type, status
     ORDER BY job_type, status
     LIMIT ${positiveInt(limit, 100)}
  `).all(...params);

  const summary = new Map();
  for (const row of rows) {
    if (!summary.has(row.job_type)) {
      summary.set(row.job_type, {
        job_type: row.job_type,
        depth: 0,
        queued: 0,
        running: 0,
        paused: 0,
        done: 0,
        failed: 0,
        quarantined: 0,
        retry_count: 0,
        last_success_at: null,
        last_failure_at: null,
        last_error: null,
        next_retry_at: null,
        active_job: null,
      });
    }
    const item = summary.get(row.job_type);
    item[row.status] = row.count;
    if (['queued', 'running', 'paused'].includes(row.status)) item.depth += row.count;
  }

  const detailParams = [queue];
  const detailTypeFilter = buildTypeFilter(jobTypes, detailParams);
  const details = database.prepare(`
    SELECT job_type,
           SUM(retry_count) AS retry_count,
           MAX(last_success_at) AS last_success_at,
           MAX(last_failure_at) AS last_failure_at,
           MIN(CASE WHEN status IN ('queued', 'paused') THEN run_after ELSE NULL END) AS next_retry_at
      FROM passive_jobs
     WHERE queue = ?
       ${detailTypeFilter}
     GROUP BY job_type
  `).all(...detailParams);
  for (const row of details) {
    const item = summary.get(row.job_type);
    if (!item) continue;
    item.retry_count = row.retry_count || 0;
    item.last_success_at = row.last_success_at || null;
    item.last_failure_at = row.last_failure_at || null;
    item.next_retry_at = row.next_retry_at || null;
  }

  const activeParams = [queue];
  const activeTypeFilter = buildTypeFilter(jobTypes, activeParams);
  const active = database.prepare(`
    SELECT job_type, id, target_type, target_id, lease_owner, lease_expires_at, started_at
      FROM passive_jobs
     WHERE queue = ?
       AND status = 'running'
       ${activeTypeFilter}
     ORDER BY started_at DESC
  `).all(...activeParams);
  for (const row of active) {
    const item = summary.get(row.job_type);
    if (!item || item.active_job) continue;
    item.active_job = {
      id: row.id,
      target_type: row.target_type,
      target_id: row.target_id,
      lease_owner: row.lease_owner,
      lease_expires_at: row.lease_expires_at,
      started_at: row.started_at,
    };
  }

  const errorParams = [queue];
  const errorTypeFilter = buildTypeFilter(jobTypes, errorParams);
  const errors = database.prepare(`
    SELECT job_type, last_error
      FROM passive_jobs
     WHERE queue = ?
       AND last_error IS NOT NULL
       ${errorTypeFilter}
     ORDER BY updated_at DESC
  `).all(...errorParams);
  for (const row of errors) {
    const item = summary.get(row.job_type);
    if (item && !item.last_error) item.last_error = row.last_error;
  }

  const degradedRows = degradedRowsForSummary({ database, queue, jobTypes, limit });
  const summaryResult = _finalizeSummary(summary, degradedRows);
  if (SUMMARY_CACHE_TTL_MS > 0) {
    const key = summaryCacheKey({ queue, jobTypes, limit });
    summaryCache.set(key, { value: summaryResult, expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS });
    // Bound the cache size so a query with many distinct jobTypes filters
    // doesn't leak memory. 64 entries is plenty for the few callers.
    if (summaryCache.size > 64) {
      const oldestKey = summaryCache.keys().next().value;
      summaryCache.delete(oldestKey);
    }
  }
  return summaryResult;
}

export function hydrateJob(row) {
  if (!row) return null;
  return {
    ...row,
    payload: parseJson(row.payload),
    metadata: parseJson(row.metadata),
  };
}

export function _isBusyErrorForTest(err) {
  return isBusyError(err);
}
