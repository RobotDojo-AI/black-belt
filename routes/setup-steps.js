/**
 * /api/setup-steps — onboarding task tile lifecycle (st_42799dbe).
 *
 * Thin HTTP facade. All DB work happens in lib/setup-steps.js so the
 * route stays testable without a live server and contains zero direct
 * SQL statement calls (thin-facade gate).
 *
 * Endpoints:
 *   GET    /api/setup-steps          — list non-dismissed tiles in display order
 *   DELETE /api/setup-steps/:step    — mark a tile dismissed (404 if unknown)
 *
 * Auth: every endpoint validates the Bearer token via lib/auth.js requireAuth().
 * In production the global /api/* middleware in lib/server.js handles auth before
 * this handler runs; in tests the route is mounted directly so the route-local
 * guard is the only thing standing between a fetch() and the data layer.
 */

import { Hono } from 'hono';
import db from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { optionalAuth } from '../lib/middleware-auth.js';
import { getAll, markDismissed } from '../lib/setup-steps.js';

const routes = new Hono();

// Accept either a cookie-based session OR a Bearer token. The cookie flow
// is how the browser app (apps/account) reaches this; Bearer is used by
// localhost scripts and verification criteria. Mirrors the same pattern
// the global /api/* middleware in lib/server.js applies — in production
// the global middleware handles this first, so this route-level guard
// is only load-bearing when the route is mounted in isolation (e.g. the
// behavioral spec at tests/specs/st_42799dbe.test.js).
routes.use('*', async (c, next) => {
  await optionalAuth()(c, async () => {});
  if (c.get('user')) return next();
  return requireAuth()(c, next);
});

// GET /api/setup-steps — non-dismissed tiles in display order (AC 6 sequence).
// WHY no query-param toggle for "include dismissed": the frontend never needs
// dismissed rows; if it ever does, add ?include_dismissed=1 then.
routes.get('/', (c) => {
  const steps = getAll(db);
  return c.json({ steps });
});

// DELETE /api/setup-steps/:step — mark a tile dismissed (sets dismissed_at).
// Idempotent: re-deleting an already-dismissed step still returns 200 because
// the row exists. Unknown step returns 404 — this is the contract checked by
// VC-error-2 and by the spec ("returns 404 for unknown step").
routes.delete('/:step', (c) => {
  const step = c.req.param('step');
  const ok = markDismissed(db, step);
  if (!ok) return c.json({ error: 'unknown_step', step }, 404);
  return c.json({ ok: true, step });
});

export default routes;
