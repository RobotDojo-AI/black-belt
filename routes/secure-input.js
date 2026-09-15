/**
 * secure-input routes.
 *
 *   POST /api/secure-input/request   — internal: create a pending request
 *   POST /api/secure-input/submit    — browser: submit value (never echoed)
 *   POST /api/secure-input/cancel    — browser: cancel a pending request
 *
 * Auth: all three endpoints require an authenticated session
 * (`c.get('user')`). A value submitted by one logged-in user cannot target
 * another user's request — `session_id` on the request row is compared to
 * the caller's session id and must match.
 */

import { Hono } from 'hono';
import {
  createRequest, submitValue, cancelRequest, getRequest,
} from '../lib/secure-input.js';

const routes = new Hono();

function requireUserSession(c) {
  const user = c.get('user');
  const session = c.get('session');
  if (!user || !session?.id) return null;
  return { user, sessionId: session.id };
}

// --- Internal: create ------------------------------------------------------

routes.post('/api/secure-input/request', async (c) => {
  const auth = requireUserSession(c);
  if (!auth) return c.json({ error: 'unauthenticated' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const { service, label, purpose } = body || {};
  if (!service || !label) return c.json({ error: 'validation_error' }, 400);

  try {
    const out = createRequest({
      sessionId: auth.sessionId,
      service,
      label,
      purpose: purpose || null,
    });
    return c.json(out);
  } catch (err) {
    const code = err.code === 'invalid_service' ? 400 : 500;
    return c.json({ error: err.code || 'request_failed', message: err.message }, code);
  }
});

// --- Browser: submit -------------------------------------------------------

routes.post('/api/secure-input/submit', async (c) => {
  const auth = requireUserSession(c);
  if (!auth) return c.json({ error: 'unauthenticated' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const { requestId, value } = body || {};
  if (!requestId || !value) return c.json({ error: 'validation_error' }, 400);

  try {
    await submitValue({ requestId, value, sessionId: auth.sessionId });
    return c.json({ success: true });
  } catch (err) {
    const status = err.code === 'forbidden'        ? 403
                 : err.code === 'not_found'        ? 404
                 : err.code === 'expired'          ? 410
                 : err.code === 'cancelled'        ? 410
                 : err.code === 'already_consumed' ? 409
                 : err.code === 'invalid_value'    ? 400
                 : err.code === 'invalid_service'  ? 400
                 : err.code === 'submitted'        ? 409
                 : err.code === 'unsupported_platform' ? 501
                 : 500;
    return c.json({ error: err.code || 'submit_failed' }, status);
  }
});

// --- Browser: cancel -------------------------------------------------------

routes.post('/api/secure-input/cancel', async (c) => {
  const auth = requireUserSession(c);
  if (!auth) return c.json({ error: 'unauthenticated' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const { requestId } = body || {};
  if (!requestId) return c.json({ error: 'validation_error' }, 400);

  const out = cancelRequest({ requestId, sessionId: auth.sessionId });
  return c.json(out);
});

// --- Introspection (status only) -------------------------------------------
// Browsers can poll this to tell if the modal should dismiss after submit/cancel.
routes.get('/api/secure-input/:id/status', (c) => {
  const auth = requireUserSession(c);
  if (!auth) return c.json({ error: 'unauthenticated' }, 401);
  const row = getRequest(c.req.param('id'));
  if (!row || row.session_id !== auth.sessionId) return c.json({ error: 'not_found' }, 404);
  return c.json({
    id: row.id,
    service: row.service,
    label: row.label,
    status: row.status,
    expires_at: row.expires_at,
  });
});
export default routes;
