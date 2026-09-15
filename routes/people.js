/**
 * routes/people.js — Miyagi manual-override surface for person attributes.
 *
 * Story: st_87a0d072 (network-ranking-quality-investigation), Phase 7.
 *
 * Endpoints (relative paths — mounted at /api/people from index.js):
 *   PATCH /:id/relation-tag
 *     Body: { relation_tag: '<tag in FAMILY_TAGS>' }
 *     Returns: 200 with full person row, or 400/401/404.
 *
 * Mounting:
 *   index.js: app.route('/api/people', peopleRoutes);
 *   tests/specs/st_87a0d072.test.js does the same. The Hono sub-app's
 *   internal paths are written as if rooted at /api/people — Hono prepends
 *   the mount prefix at request time.
 *
 * Auth: cookie OR Bearer (mirror lib/server.js global middleware pattern per
 * CLAUDE.md "Route auth — cookie-or-Bearer"). The route is browser-reachable
 * (the Miyagi chat surface emits the PATCH via fetch with session cookie),
 * so Bearer-only would 401 the browser.
 *
 * Thin-facade: no direct DB statements in this file. All DAL lives in
 * lib/people-write.js; routes do HTTP plumbing only.
 */

import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { optionalAuth } from '../lib/middleware-auth.js';
import db from '../lib/db.js';
import { setRelationTag, getPersonById } from '../lib/people-write.js';

const routes = new Hono();

// Cookie-OR-Bearer auth gate on every route in this sub-app.
// Mirrors lib/server.js global middleware: try session cookie first, fall
// back to Bearer. WHY duplicated here: the behavioral spec at
// tests/specs/st_87a0d072.test.js mounts this sub-app directly via
// app.route() without the parent app's global /api/* middleware, so the
// route needs its own auth check.
routes.use('*', async (c, next) => {
  await optionalAuth()(c, async () => {});
  if (c.get('user')) return next();
  return requireAuth()(c, next);
});

/**
 * PATCH /:id/relation-tag  (mounted at /api/people)
 *
 * Body: { relation_tag: '<one of FAMILY_TAGS>' }
 *
 * Status codes:
 *   200 — written successfully, returns the updated row
 *   400 — body missing or relation_tag not in FAMILY_TAGS
 *   401 — not authenticated (handled by middleware above)
 *   404 — person not found
 */
routes.patch('/:id/relation-tag', async (c) => {
  const personId = c.req.param('id');

  // Guard against unparseable JSON — every route handler must wrap c.req.json()
  // per CLAUDE.md security baseline ("Unguarded JSON body reads are a 500
  // exploit surface").
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const tag = body?.relation_tag;
  if (!tag) {
    return c.json({ error: 'missing relation_tag in request body' }, 400);
  }

  try {
    const updated = setRelationTag(db, personId, tag);
    if (!updated) {
      return c.json({ error: `person not found: ${personId}` }, 404);
    }
    return c.json(updated, 200);
  } catch (err) {
    // setRelationTag throws on invalid tag. Any other error is a 500 — but
    // we surface the validation error message at 400 since it's the only
    // path that throws under normal use.
    return c.json({ error: err.message }, 400);
  }
});

export default routes;
