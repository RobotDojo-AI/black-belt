/**
 * Vercel log drain receiver.
 *
 * Vercel POSTs JSON/NDJSON log events here. We filter for errors (4xx/5xx or
 * level=error), store in a capped in-memory ring buffer, and expose
 * /internal/errors for the monitoring agent.
 *
 * Auth: Vercel signs the request body with HMAC-SHA256 using the optional
 * "Signature Verification Secret" from the dashboard. The signature is sent
 * in x-vercel-signature. Verification is optional — if no drainSecret is
 * configured we accept all POSTs (the obscure path is defence enough for v1).
 *
 * Persistence: intentionally none. Restart-loss is acceptable at ≤99 users.
 */
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifyInternalSecret } from '../lib/auth.js';

function verifyHmac(body, signature, secret) {
  if (!secret || !signature) return true; // optional — skip if not configured
  try {
    const expected = createHmac('sha1', secret).update(body).digest('hex');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch { return false; }
}

const BUFFER_CAP = 500;

// { id, ts, level, status, message, requestId, host, source }
const errorBuffer = [];

function push(event) {
  errorBuffer.push(event);
  if (errorBuffer.length > BUFFER_CAP) errorBuffer.shift();
}

export function logDrainRoutes({ drainSecret, verifyToken, secret }) {
  const app = new Hono();

  // GET /internal/events — Vercel endpoint verification probe.
  // Vercel GETs this URL; we respond with x-vercel-verify set to the token.
  // Some Vercel versions pass the expected token in a request header or
  // query param — we echo those back first, then fall through to the env var.
  app.get('/internal/events', (c) => {
    // Log everything so we can see exactly what Vercel sends.
    const incomingHeaders = Object.fromEntries(
      ['host','user-agent','x-vercel-verify-token','x-forwarded-for'].map(h => [h, c.req.header(h) ?? null])
    );
    const qs = Object.fromEntries(new URL(c.req.url, 'http://x').searchParams);
    console.info('[log-drain] verify GET headers:', JSON.stringify(incomingHeaders), 'qs:', JSON.stringify(qs));

    // Vercel may pass the expected value as a query param or request header.
    const token = c.req.query('token')
      || c.req.header('x-vercel-verify-token')
      || verifyToken;
    if (!token) return c.json({ error: 'not configured' }, 404);
    c.header('x-vercel-verify', token);
    return c.text('ok');
  });

  // POST /internal/events — Vercel → gateway
  app.post('/internal/events', async (c) => {
    let body;
    try { body = await c.req.text(); }
    catch { return c.json({ error: 'bad body' }, 400); }

    // Verify HMAC signature if a secret is configured. Vercel signs with SHA-1.
    const sig = c.req.header('x-vercel-signature') ?? '';
    if (!verifyHmac(body, sig, drainSecret)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Support both JSON (single object) and NDJSON (one object per line).
    const raw = body.trim();
    const lines = raw.startsWith('{') && !raw.includes('\n')
      ? [raw]
      : raw.split('\n').filter(Boolean);
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }

      const isError = event.level === 'error'
        || (typeof event.statusCode === 'number' && event.statusCode >= 400);
      if (!isError) continue;

      push({
        id:        event.id        ?? null,
        ts:        event.timestamp ?? Date.now(),
        level:     event.level     ?? 'unknown',
        status:    event.statusCode ?? null,
        message:   event.message   ?? '',
        requestId: event.requestId ?? null,
        host:      event.host      ?? null,
        source:    event.source    ?? null,
        path:      event.path      ?? null,
      });
    }

    return c.json({ ok: true });
  });

  // GET /internal/errors — monitoring agent → gateway
  // Optional ?since=<unix_ms> to get only events after a timestamp.
  app.get('/internal/errors', (c) => {
    if (!verifyInternalSecret(c.req.header('authorization') ?? '', secret)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const since = parseInt(c.req.query('since') ?? '0', 10) || 0;
    const events = since
      ? errorBuffer.filter(e => e.ts > since)
      : [...errorBuffer];
    return c.json({ count: events.length, errors: events });
  });

  return app;
}
