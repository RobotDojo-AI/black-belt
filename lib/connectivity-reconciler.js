/**
 * lib/connectivity-reconciler.js
 *
 * st_bf4978b0 AC6 — the connectivity mirror of lib/passive-reconciler.js. Where
 * that reconciler keeps the embed/chunk plane self-healing, this one keeps the
 * CONNECTIVITY plane (oauth_sync / local_sync) self-healing:
 *
 *   - a RECOVERABLE stall (starvation, crash-mid-job, transient provider/network
 *     failure) is auto-restarted — re-animated with reclaims bumped and
 *     run_after advanced, which IS the recorded heal attempt the guard checks.
 *   - a USER-ACTION stall (revoked grant, FDA re-grant) is surfaced as Issue +
 *     reconnect and NEVER falsely auto-restarted.
 *   - a PERMANENTLY-DEAD scope (403 PERMISSION_DENIED, e.g. photoslibrary.readonly
 *     removed by Google) is classified non-recoverable and never re-enqueued, so
 *     it settles as a stable Issue instead of thrashing every cadence.
 *
 * INTELLIGENCE_TIER: extraction — deterministic, no LLM. Reads passive_jobs and
 * writes structured state (job rows + integration_health); no model call.
 *
 * Pure-ish by construction: every function takes the db as its first argument so
 * the unit tests drive it against an in-memory fixture with no live data. The
 * stall predicate and heal-attempt predicate are exported so the anti-regression
 * guard (scripts/check-integration-truth.js) shares EXACTLY this logic and can
 * never diverge from what the reconciler actually does.
 */

import db from './db.js';
import { classifyPassiveJobDegradation } from './passive-jobs.js';
import { permanentCredentialError } from './passive-sync-orchestrator.js';
import { recordIntegrationJobHealth } from './oauth-sync-queue.js';

export const INTELLIGENCE_TIER = 'extraction';

// The connectivity job types this reconciler owns. oauth_sync covers
// email/calendar/drive; local_sync covers Mac-local iMessage/Photos.
export const CONNECTIVITY_STALL_TYPES = Object.freeze(['oauth_sync', 'local_sync']);

function envMs(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Stall thresholds (cadence × factor). oauth_sync runs hourly → stall at 120m;
// local_sync → stall at 60m. Both env-overridable.
const OAUTH_STALL_MS = envMs('ROBOTDOJO_OAUTH_STALL_MS', 120 * 60_000);
const LOCAL_STALL_MS = envMs('ROBOTDOJO_LOCAL_STALL_MS', 60 * 60_000);

export function stallMsForType(jobType) {
  return jobType === 'local_sync' ? LOCAL_STALL_MS : OAUTH_STALL_MS;
}

function jobName(job) {
  if (job.target_id) return job.target_id;
  try { return JSON.parse(job.payload || '{}').name || job.job_type; } catch { return job.job_type; }
}

/**
 * Is a connectivity job stalled? Stalled iff it is not currently leased/running,
 * is due (not scheduled ahead via a managed backoff), and has made no progress
 * (last_success_at, else created_at) for longer than its stall window.
 * @param {object} job passive_jobs row
 * @param {number} [now] epoch ms
 */
export function isConnectivityJobStalled(job, now = Date.now()) {
  if (!job || job.status === 'running') return false;
  const runAfter = Date.parse(job.run_after || '');
  if (Number.isFinite(runAfter) && runAfter > now) return false; // scheduled ahead = actively managed
  const anchor = Date.parse(job.last_success_at || job.created_at || '') || 0;
  return (now - anchor) > stallMsForType(job.job_type);
}

/**
 * Classify a stalled connectivity job into recoverable / user-action / dead-scope.
 * recoverable = NOT permanentCredentialError AND degradation.action is not a
 * user-action (reconnect_or_grant_scope). FDA/local permission errors and dead
 * scopes are user-action / non-recoverable.
 * @param {object} job passive_jobs row
 */
export function classifyConnectivityStall(job) {
  const err = `${job.last_error || ''} ${job.quarantine_reason || ''} ${job.sample_error || ''}`;
  const deadScope = /permission_denied|removed[_ -]?scope|\b403\b|photoslibrary/i.test(err);
  const fdaOrPermission = /full disk|tcc|sqlite_cantopen|operation not permitted|permission/i.test(err);
  const degradation = classifyPassiveJobDegradation(job);
  const userAction = deadScope
    || fdaOrPermission
    || permanentCredentialError(err)
    || degradation.action === 'reconnect_or_grant_scope';
  const recoverable = !userAction;
  return {
    name: jobName(job),
    deadScope,
    userAction,
    recoverable,
    // FDA/dead-scope want a permission prompt; a revoked grant wants reconnect.
    healthStatus: (deadScope || fdaOrPermission) ? 'needs_permission' : 'needs_reauth',
  };
}

/**
 * Has a heal attempt been recorded for this (stalled) job within its window? A
 * re-animation bumps reclaims, advances run_after, and stamps the marker error;
 * a scheduled retry (run_after ahead) is also a live heal attempt. The guard
 * uses THIS predicate so "unhealed recoverable stall" means exactly what the
 * reconciler leaves behind.
 * @param {object} job passive_jobs row
 * @param {number} [now] epoch ms
 * @param {number|null} [windowMs]
 */
export function healAttemptRecorded(job, now = Date.now(), windowMs = null) {
  const win = windowMs ?? stallMsForType(job.job_type);
  if (/re-animated by connectivity reconciler/i.test(job.last_error || '')) return true;
  const runAfter = Date.parse(job.run_after || '');
  if (Number.isFinite(runAfter) && runAfter > now) return true;
  const updated = Date.parse(job.updated_at || '') || 0;
  if ((now - updated) < win && (job.reclaims || 0) > 0) return true;
  return false;
}

/** All currently-stalled connectivity jobs. */
export function detectStalledConnectivityJobs(database = db, now = Date.now()) {
  const placeholders = CONNECTIVITY_STALL_TYPES.map(() => '?').join(', ');
  const rows = database.prepare(`
    SELECT * FROM passive_jobs
     WHERE job_type IN (${placeholders})
       AND status != 'running'
  `).all(...CONNECTIVITY_STALL_TYPES);
  return rows.filter((job) => isConnectivityJobStalled(job, now));
}

function markUserActionRequired(database, id, deadScope, now) {
  const row = database.prepare('SELECT metadata FROM passive_jobs WHERE id = ?').get(id);
  let meta = {};
  try { meta = row?.metadata ? JSON.parse(row.metadata) : {}; } catch { meta = {}; }
  meta.user_action_required = true;
  if (deadScope) meta.dead_scope = true;
  database.prepare('UPDATE passive_jobs SET metadata = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(meta), new Date(now).toISOString(), id);
}

/**
 * The full connectivity self-heal pass. Idempotent; safe every cadence.
 * @param {{database?: object, now?: number}} [opts]
 * @returns {{scanned:number, restarted:string[], userAction:string[], deadScope:string[]}}
 */
export function reconcileConnectivity({ database = db, now = Date.now() } = {}) {
  const stalled = detectStalledConnectivityJobs(database, now);
  const summary = { scanned: stalled.length, restarted: [], userAction: [], deadScope: [] };

  for (const job of stalled) {
    const cls = classifyConnectivityStall(job);
    if (cls.recoverable) {
      // Auto-restart: re-animate to queued. Bumping reclaims + advancing
      // run_after + the marker error IS the recorded heal attempt the guard
      // asserts. attempts reset so a transient cause gets a fresh budget; a
      // genuine poison re-quarantines on its own after max_attempts failures.
      const ts = new Date(now).toISOString();
      database.prepare(`
        UPDATE passive_jobs
           SET status = 'queued',
               attempts = 0,
               reclaims = reclaims + 1,
               run_after = ?,
               lease_owner = NULL,
               lease_expires_at = NULL,
               quarantine_reason = NULL,
               last_error = 're-animated by connectivity reconciler (recoverable stall)',
               updated_at = ?
         WHERE id = ?
      `).run(ts, ts, job.id);
      summary.restarted.push(job.id);
    } else {
      // User-action / dead-scope: NEVER re-enqueue. Surface Issue + reconnect on
      // the integration_health row and mark the job so the guard knows it was
      // correctly surfaced (not a silently-unhealed recoverable stall).
      try {
        recordIntegrationJobHealth(database, cls.name, cls.healthStatus, {
          error: job.last_error || (cls.deadScope ? 'permission_denied — removed scope' : 'needs_reauth'),
          mirrorLedger: false,
        });
      } catch { /* health write is best-effort; must not stall the sweep */ }
      markUserActionRequired(database, job.id, cls.deadScope, now);
      (cls.deadScope ? summary.deadScope : summary.userAction).push(job.id);
    }
  }

  return summary;
}
