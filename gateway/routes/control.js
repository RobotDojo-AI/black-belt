/**
 * Internal control-plane REST. Called by robotdojo.ai backend only, never
 * exposed to the public. Protected by a shared secret in the Authorization
 * header. If the user's agent is offline the call returns 200 with
 * `{delivered:false}` — the caller treats this as a queue miss and retries
 * or reconciles on the next reconnect.
 */
import { Hono } from 'hono';
import { verifyInternalSecret } from '../lib/auth.js';
import { pushKey, revokeKey } from '../lib/control.js';

export function controlRoutes({ secret }) {
  const app = new Hono();

  app.use('/internal/*', async (c, next) => {
    if (!verifyInternalSecret(c.req.header('authorization') || '', secret)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  app.post('/internal/push-key', async (c) => {
    const { email, key, modules_url, bundle } = await c.req.json();
    if (!email || !key) return c.json({ error: 'missing_fields' }, 400);
    return c.json(pushKey(email, key, modules_url, bundle));
  });

  app.post('/internal/revoke-key', async (c) => {
    const { email } = await c.req.json();
    if (!email) return c.json({ error: 'missing_fields' }, 400);
    return c.json(revokeKey(email));
  });

  return app;
}
