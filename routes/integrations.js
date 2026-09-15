/**
 * Integration health routes.
 *
 * GET /api/integrations/health
 *   Returns the latest audit from the integration_health table + live doc counts.
 *   Reads from DB only — no live probes on HTTP request (too slow).
 *   Run scripts/integration-monitor.js to refresh.
 */

import { Hono } from 'hono';
import db from '../lib/db.js';
import { getLatestHealth } from '../lib/integration-health.js';
import { getDocCount } from '../lib/integrations-queries.js';

const routes = new Hono();
const HEALTH_CACHE_TTL_MS = Number(process.env.ROBOTDOJO_INTEGRATION_HEALTH_CACHE_MS || 15_000);
let healthCache = null;

function docCount(integrationName) {
  return getDocCount(db, integrationName);
}

routes.get('/api/integrations/health', (c) => {
  const includeCounts = c.req.query('counts') === '1';
  const cacheKey = includeCounts ? 'with-counts' : 'status-only';
  const now = Date.now();
  if (
    healthCache
    && healthCache.key === cacheKey
    && now - healthCache.createdAt < HEALTH_CACHE_TTL_MS
  ) {
    return c.json(healthCache.payload);
  }

  const rows = getLatestHealth();
  const lastCheck = rows.reduce((max, r) => (!max || r.last_check > max ? r.last_check : max), null);
  const payload = {
    checked_at: lastCheck,
    integrations: rows.map(r => ({
      name: r.name,
      status: r.status,
      last_sync: r.last_sync,
      last_check: r.last_check,
      consecutive_failures: r.consecutive_failures,
      error: r.last_error || null,
      doc_count: includeCounts ? docCount(r.name) : null,
    })),
    counts_included: includeCounts,
  };
  healthCache = { key: cacheKey, createdAt: now, payload };
  return c.json(payload);
});
export default routes;
