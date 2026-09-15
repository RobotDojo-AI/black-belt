#!/usr/bin/env node
/**
 * Integration health monitor — probes all integrations, self-heals where
 * possible, and notifies on persistent failures.
 *
 * The scheduled path is passive-job owned: a refresh job is enqueued, leased,
 * timed out, retried, or quarantined through passive_jobs. --dry-run remains
 * read-only and probes without writes.
 */

// Integration health must be probed during active use — this is lightweight
// network I/O, not CPU-meaningful local embedding/import work.
export const IDLE_GATED = false;

import { withLaunchDbWriterGuard } from '../lib/db-writer-policy.js';

const DRY_RUN = process.argv.includes('--dry-run');

const ts = () => new Date().toISOString().slice(11, 19);
const log  = (m) => process.stderr.write(`[${ts()}] ${m}\n`);
const warn = (m) => process.stderr.write(`[${ts()}] WARN ${m}\n`);

function summarize(results = []) {
  const ok = results.filter(r => r.status === 'ok');
  const degraded = results.filter(r => r.status === 'degraded');
  const errors = results.filter(r => r.status === 'error');
  const unknown = results.filter(r => r.status === 'unknown');
  return { ok, degraded, errors, unknown };
}

function outputHealth(results, dryRun) {
  const { ok, degraded, errors, unknown } = summarize(results);
  log(`results: ${ok.length} ok, ${degraded.length} degraded, ${errors.length} error, ${unknown.length} unknown`);

  for (const r of [...degraded, ...errors]) {
    const tag = r.consecutive_failures >= 2 ? '[ALERT]' : '[WARN]';
    warn(`${tag} ${r.name}: ${r.error || r.status}${r.lastSync ? ` (last sync: ${r.lastSync})` : ''}`);
  }

  return {
    checked_at: new Date().toISOString(),
    dry_run: dryRun,
    summary: { ok: ok.length, degraded: degraded.length, error: errors.length, unknown: unknown.length },
    integrations: results.map(r => ({
      name: r.name,
      status: r.status,
      last_sync: r.lastSync || null,
      last_check: new Date().toISOString(),
      consecutive_failures: r.consecutive_failures ?? 0,
      error: r.error || null,
    })),
  };
}

async function main() {
  log(`integration-monitor start${DRY_RUN ? ' (dry-run)' : ''}`);

  const { healAndAudit } = await import('../lib/integration-health.js');

  if (DRY_RUN) {
    const results = await healAndAudit({ dryRun: true, mirrorLedger: false });
    process.stdout.write(JSON.stringify(outputHealth(results, true), null, 2) + '\n');
    log('integration-monitor done');
    return;
  }

  const { enqueuePassiveJob, drainPassiveJobs, getPassiveJobSummary } = await import('../lib/passive-jobs.js');
  enqueuePassiveJob({
    jobType: 'integration_health_refresh',
    uniqueKey: 'integration-health:refresh',
    targetType: 'system',
    targetId: 'all',
    payload: { mode: 'all' },
    priority: 35,
    timeoutMs: 90_000,
    metadata: { source: 'integration-monitor' },
    requeueDone: true,
    requeueQuarantined: true,
  });

  const drained = await drainPassiveJobs({
    worker: 'integration-monitor',
    jobTypes: ['integration_health_refresh'],
    limit: 1,
    handlers: {
      integration_health_refresh: async () => {
        // st_fd14cdd4 AC3: reconcile registration before probing so a
        // creds-without-row gap is repaired on the same 15-minute cadence
        // that refreshes health — "within minutes", not at next boot.
        const { reconcileIntegrations } = await import('../lib/integration-reconciler.js');
        const reconcile = reconcileIntegrations();
        if (reconcile.createdAccounts.length || reconcile.microsoft.repaired.length || reconcile.error) {
          log(`reconciler: created=${reconcile.createdAccounts.join(',') || 'none'} microsoft_repaired=${reconcile.microsoft.repaired.join(',') || 'none'}${reconcile.error ? ` error=${reconcile.error}` : ''}`);
        }

        // st_bf4978b0 AC4 — OAuth proactive refresh runs BEFORE the health probe
        // so a token near expiry is renewed and verified_at is fresh when the
        // page reads it. A genuine revocation flips the account to needs_reauth
        // inside the refresher (→ Issue + reconnect).
        try {
          const { refreshExpiringGoogleTokens } = await import('../lib/google-oauth.js');
          const { refreshExpiringMicrosoftTokens } = await import('../lib/microsoft-oauth.js');
          const [g, m] = await Promise.all([
            refreshExpiringGoogleTokens().catch((e) => ({ error: e?.message })),
            refreshExpiringMicrosoftTokens().catch((e) => ({ error: e?.message })),
          ]);
          const gRefreshed = Array.isArray(g) ? g.filter((r) => r.refreshed).length : 0;
          const mRefreshed = Array.isArray(m) ? m.filter((r) => r.refreshed).length : 0;
          if (gRefreshed || mRefreshed) log(`oauth proactive refresh: google=${gRefreshed} microsoft=${mRefreshed}`);
        } catch (e) {
          warn(`oauth proactive refresh failed: ${e?.message || e}`);
        }

        // AC5 — the API-key cadence handshake runs inside healAndAudit (real
        // /v1/models probe → verified_at on 200).
        const results = await healAndAudit({ dryRun: false, mirrorLedger: false });

        // st_bf4978b0 AC6 — the connectivity reconciler runs LAST so its verdict
        // is the final word: a dead-scope (Photos 403) or user-action stall is
        // surfaced as Issue AFTER the token probe would otherwise re-green it,
        // and recoverable stalls are re-animated. Ordering matters — healAndAudit
        // sees a valid OAuth token and would mark a dead-scope product 'ok'; the
        // reconciler corrects that to needs_permission at end-of-pass.
        try {
          const { default: monitorDb } = await import('../lib/db.js');
          const { reconcileConnectivity } = await import('../lib/connectivity-reconciler.js');
          const conn = reconcileConnectivity({ database: monitorDb });
          if (conn.restarted.length || conn.userAction.length || conn.deadScope.length) {
            log(`connectivity reconciler: restarted=${conn.restarted.length} user_action=${conn.userAction.length} dead_scope=${conn.deadScope.length}`);
          }
        } catch (e) {
          warn(`connectivity reconciler failed: ${e?.message || e}`);
        }

        return { ...outputHealth(results, false), reconcile };
      },
    },
  });

  process.stdout.write(JSON.stringify({
    checked_at: new Date().toISOString(),
    dry_run: false,
    drained: drained.length,
    passive_jobs: getPassiveJobSummary({ jobTypes: ['integration_health_refresh'] }),
  }, null, 2) + '\n');

  log('integration-monitor done');
}

withLaunchDbWriterGuard('integration-monitor', () => main(), { dryRun: DRY_RUN, idleGated: IDLE_GATED })
  .then(() => process.exit(0))
  .catch(e => {
    console.error('[integration-monitor] fatal:', e.message);
    process.exit(1);
  });
