/**
 * Handle lookup — claim/release/check + email→handle/uuid resolution.
 *
 * This is the email-keyed HANDLE namespace, distinct from the device SLUG that
 * routes the blind relay. The slug's own claim/release now lives on the
 * device-secret-authed /api/register-device and /api/release-device endpoints
 * (st_63b59bda AC-5); the old email-keyed /internal/*-slug endpoints are gone.
 *
 * Called by:
 *   - The Mac's handle-rename flow (claim + release)
 *   - The Mac's install setup card (check availability)
 *   - Vercel Edge (resolve email → handle/uuid)
 *
 * All guarded by GATEWAY_INTERNAL_SECRET.
 */
import { Hono } from 'hono';
import { verifyInternalSecret } from '../lib/auth.js';
import * as handleRegistry from '../lib/handle-registry.js';

const HANDLE_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function handleLookupRoutes({ secret }) {
  const app = new Hono();

  app.use('/internal/*', async (c, next) => {
    if (!verifyInternalSecret(c.req.header('authorization') || '', secret)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  /**
   * GET /internal/check-handle/:handle
   * 200 → { available, takenBy }
   * Read-only — safe to call for UI live feedback.
   */
  app.get('/internal/check-handle/:handle', async (c) => {
    const handle = c.req.param('handle');
    if (!handle || !HANDLE_REGEX.test(handle)) {
      return c.json({ error: 'invalid_handle' }, 400);
    }
    const existing = await handleRegistry.getByHandle(handle);
    return c.json(existing
      ? { available: false, takenBy: existing.email }
      : { available: true, takenBy: null });
  });

  /**
   * POST /internal/claim-handle
   *   body: { handle, email, uuid }
   *   200 → { ok: true }
   *   409 → { ok: false, reason: 'taken', takenBy }
   */
  app.post('/internal/claim-handle', async (c) => {
    let body;
    try { body = await c.req.json(); }
    catch { return c.json({ error: 'invalid_json' }, 400); }

    const handle = typeof body?.handle === 'string' ? body.handle.trim().toLowerCase() : '';
    const email  = typeof body?.email  === 'string' ? body.email.trim().toLowerCase()  : '';
    const uuid   = typeof body?.uuid   === 'string' ? body.uuid.trim()                 : '';

    if (!handle || !HANDLE_REGEX.test(handle)) return c.json({ error: 'invalid_handle' }, 400);
    if (!email) return c.json({ error: 'missing_email' }, 400);
    // uuid is optional — older clients may not send it yet

    const result = await handleRegistry.claim(handle, email, uuid || '');
    if (!result.ok && result.reason === 'taken') return c.json(result, 409);
    if (!result.ok) return c.json(result, 400);
    return c.json(result);
  });

  /**
   * POST /internal/release-handle
   *   body: { handle, email }
   *   Only the claiming email can release.
   */
  app.post('/internal/release-handle', async (c) => {
    let body;
    try { body = await c.req.json(); }
    catch { return c.json({ error: 'invalid_json' }, 400); }

    const handle = typeof body?.handle === 'string' ? body.handle.trim().toLowerCase() : '';
    const email  = typeof body?.email  === 'string' ? body.email.trim().toLowerCase()  : '';

    if (!handle) return c.json({ error: 'missing_handle' }, 400);
    if (!email)  return c.json({ error: 'missing_email' }, 400);

    const result = await handleRegistry.release(handle, email);
    if (!result.ok) return c.json(result, 403);
    return c.json(result);
  });

  /**
   * POST /internal/resolve-email
   *   body: { email }
   *   200 → { handle, uuid } if registered, 404 otherwise.
   */
  app.post('/internal/resolve-email', async (c) => {
    let body;
    try { body = await c.req.json(); }
    catch { return c.json({ error: 'invalid_json' }, 400); }

    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email) return c.json({ error: 'missing_email' }, 400);

    const row = await handleRegistry.resolveEmail(email);
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(row);
  });

  return app;
}
