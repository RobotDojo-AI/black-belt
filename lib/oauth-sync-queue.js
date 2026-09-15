/**
 * OAuth sync queue/status facade.
 *
 * OAuth callbacks should only prove the account is connected, store tokens,
 * and return the user to setup/account. Heavy mail/calendar sync is handled
 * by the scheduled sync worker, which is already idle-gated and writer-guarded.
 *
 * This helper records the pending background work in integration_health so the
 * UI can say "queued" instead of silently doing expensive work inline.
 */
import { enqueuePassiveJob, mirrorPassiveJobStatus } from './passive-jobs.js';
import { recordLiveVerification } from './integration-status.js';
// st_fd14cdd4 AC2: the provider→jobs map and the health-name→job-type routing
// derive from the integration registry instead of hand-edited lists. The
// registry is the single declaration; this module stays the queue mechanics.
import { buildProviderJobs, healthNamePrefixes } from './integration-registry.js';

const PROVIDER_JOBS = Object.freeze(buildProviderJobs());

function queueJobRows(db, provider, jobs, scope = null) {
  if (!db || jobs.length === 0) {
    return { queued: 0, provider, scope, jobs: [], names: [] };
  }

  const now = new Date().toISOString();
  const suffix = scope ? `:${scope}` : '';
  const names = jobs.map((job) => `${job}${suffix}`);
  const upsert = db.prepare(`
    INSERT INTO integration_health
      (name, status, last_check, last_sync, consecutive_failures, last_error, updated_at)
    VALUES (?, 'queued', ?, NULL, 0, NULL, ?)
    ON CONFLICT(name) DO UPDATE SET
      status = 'queued',
      last_check = excluded.last_check,
      consecutive_failures = 0,
      last_error = NULL,
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction(() => {
    for (const name of names) {
      upsert.run(name, now, now);
      try {
        enqueuePassiveJob({
          database: db,
          jobType: jobTypeForHealthName(name),
          uniqueKey: `integration:${name}`,
          targetType: 'integration',
          targetId: name,
          payload: { provider, scope, name },
          metadata: { source: 'oauth-sync-queue' },
          requeueDone: true,
          requeueQuarantined: true,
        });
      } catch {
        // The integration_health row remains the primary foreground contract.
        // Passive ledger mirroring must never break OAuth callbacks.
      }
    }
  });
  tx();

  return { queued: names.length, provider, scope, jobs, names };
}

export function queueIntegrationJobs(db, provider, opts = {}) {
  const jobs = opts.jobs || PROVIDER_JOBS[provider] || [];
  const scope = opts.scope ? String(opts.scope).trim().toLowerCase() : null;
  return queueJobRows(db, provider, jobs, scope);
}

export function queueOAuthSync(db, provider, email, opts = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    return { queued: 0, provider, email: normalizedEmail, jobs: [], names: [] };
  }

  const result = queueIntegrationJobs(db, provider, {
    ...opts,
    scope: normalizedEmail,
  });
  return { ...result, email: normalizedEmail };
}

export function recordIntegrationJobHealth(db, name, status, opts = {}) {
  if (!db || !name) return null;

  const normalizedStatus = String(status || '').toLowerCase() || 'error';
  const isOk = normalizedStatus === 'ok'
    || normalizedStatus === 'done'
    || normalizedStatus === 'connected'
    || normalizedStatus === 'partial';
  const updatesLastSync = isOk;
  const isFailure = ['error', 'failed', 'needs_permission'].includes(normalizedStatus);
  const now = new Date().toISOString();
  const previous = db.prepare('SELECT last_sync, consecutive_failures FROM integration_health WHERE name=?').get(name);
  const lastSync = updatesLastSync
    ? (opts.lastSync || now)
    : (opts.lastSync || previous?.last_sync || null);
  const consecutiveFailures = updatesLastSync ? 0
    : isFailure ? ((previous?.consecutive_failures || 0) + 1)
      : (previous?.consecutive_failures || 0);
  const error = isFailure && opts.error ? String(opts.error).slice(0, 500) : null;

  db.prepare(`
    INSERT INTO integration_health
      (name, status, last_check, last_sync, consecutive_failures, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      status = excluded.status,
      last_check = excluded.last_check,
      last_sync = excluded.last_sync,
      consecutive_failures = excluded.consecutive_failures,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run(name, isOk ? 'ok' : normalizedStatus, now, lastSync, consecutiveFailures, error, now);

  if (isOk) {
    try { recordLiveVerification(db, name); } catch { /* best-effort */ }
  }

  if (opts.mirrorLedger === false) {
    return {
      name,
      status: isOk ? 'ok' : normalizedStatus,
      last_sync: lastSync,
      consecutive_failures: consecutiveFailures,
      error,
    };
  }

  try {
    mirrorPassiveJobStatus(db, {
      jobType: jobTypeForHealthName(name),
      uniqueKey: `integration:${name}`,
      targetType: 'integration',
      targetId: name,
      payload: { name },
      status: isOk ? 'ok' : normalizedStatus,
      error,
      metadata: {
        source: 'integration_health',
        last_sync: lastSync,
        consecutive_failures: consecutiveFailures,
      },
    });
  } catch {
    // Keep the existing health write non-failing and fast; the passive ledger
    // is an observability/retry mirror, not a reason to fail a foreground route.
  }

  return {
    name,
    status: isOk ? 'ok' : normalizedStatus,
    last_sync: lastSync,
    consecutive_failures: consecutiveFailures,
    error,
  };
}

// health-name prefix → passive job type, derived once from the registry's
// declared jobs (covers gmail/calendar/drive/contacts/photos and
// microsoft-mail/microsoft-calendar → oauth_sync, granola/oura/asana/notion/
// imports-snapshot → their dedicated types, and every Apple local kind →
// local_sync). Unknown prefixes are platform/health probes, not durable worker
// types; keep them under the owned integration-health path instead of letting
// passive_jobs mint arbitrary job_type values such as "anthropic".
const JOB_TYPE_BY_PREFIX = (() => {
  const map = new Map();
  for (const [prefix, { jobType }] of healthNamePrefixes()) {
    map.set(prefix, jobType);
  }
  return map;
})();

export function jobTypeForHealthName(name) {
  const raw = String(name || '').split(':')[0].trim().toLowerCase() || 'unknown';
  const fromRegistry = JOB_TYPE_BY_PREFIX.get(raw);
  if (fromRegistry) return fromRegistry;
  return 'integration_health_refresh';
}

export function integrationResultErrorForEmail(result, email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;

  const row = integrationResultForEmail(result, normalizedEmail);
  if (row?.error) return row.error;

  if (Array.isArray(result?.errors)) {
    const hit = result.errors.find((entry) => String(entry).toLowerCase().startsWith(`${normalizedEmail}:`));
    if (hit) return hit;
  }

  return result?.error || null;
}

export function integrationResultForEmail(result, email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;
  const rows = Array.isArray(result) ? result
    : Array.isArray(result?.results) ? result.results
      : [];
  return rows.find((item) => String(item?.email || '').trim().toLowerCase() === normalizedEmail) || null;
}

export function integrationResultStatusForEmail(result, email) {
  const row = integrationResultForEmail(result, email);
  return row?.status || row?.state || row?.coverage_state || null;
}

export function recordAccountIntegrationJobResult(db, job, emails, result) {
  const normalizedJob = String(job || '').trim();
  if (!normalizedJob || !Array.isArray(emails)) return [];

  return emails.map((email) => {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const error = integrationResultErrorForEmail(result, normalizedEmail);
    const status = integrationResultStatusForEmail(result, normalizedEmail);
    return recordIntegrationJobHealth(
      db,
      `${normalizedJob}:${normalizedEmail}`,
      error ? 'error' : (status || 'ok'),
      error ? { error } : {}
    );
  });
}

export function backgroundStateFromHealth(row) {
  const raw = String(row?.status || '').toLowerCase();
  if (raw === 'queued') return 'queued';
  if (raw === 'running' || raw === 'in_progress') return 'running';
  if (raw === 'partial') return 'partial';
  if (raw === 'paused' || raw === 'user-active') return 'paused';
  if (raw === 'needs_permission' || /permission|tcc|full disk/i.test(row?.last_error || '')) return 'needs_permission';
  if (raw === 'failed' || raw === 'error') return 'failed';
  if (raw === 'ok' || raw === 'done' || raw === 'connected') return 'done';
  return null;
}
