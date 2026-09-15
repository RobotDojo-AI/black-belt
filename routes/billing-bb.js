/**
 * Black Belt session key endpoint.
 *
 * GET /api/bb/session
 *   Auth:    Bearer <subscription_key>
 *   Returns: { session_key: base64(32 bytes), ttl: 300 }
 *
 * The session_key is HKDF(BUNDLE_MASTER_KEY, email|period) — unique per user
 * per billing cycle, re-derivable on demand, never stored server-side.
 *
 * Legacy compatibility endpoint. Post-consolidation, Black Belt source is
 * present in the repo and runtime-gated by cohort entitlement. This endpoint
 * still derives short-lived session material for older callers, but it is not
 * a checkout surface and does not reveal stored subscription keys.
 *
 * Rate limit: 20 requests / hour / user (keyed by SHA-256 of bearer token).
 * Same in-memory pattern as the chat stream limiter.
 */
import crypto from 'node:crypto';
import { Hono } from 'hono';
import db from '../lib/db.js';
import { deriveSessionKey } from '../lib/bb-session.js';
import { getActiveSubscriptionByKeyHash } from '../lib/billing-bb-queries.js';

const routes = new Hono();

// ─── Rate limiting ─────────────────────────────────────────────────────────

const BB_SESSION_RATE_WINDOW_MS = 60 * 60 * 1000;  // 1 hour
const BB_SESSION_RATE_LIMIT = 20;                   // requests per user per hour
const sessionRateBuckets = new Map();               // sha256(bearer) → { count, resetAt }

function checkSessionRate(keyHash) {
  const now = Date.now();
  const bucket = sessionRateBuckets.get(keyHash);
  if (!bucket || bucket.resetAt <= now) {
    sessionRateBuckets.set(keyHash, { count: 1, resetAt: now + BB_SESSION_RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= BB_SESSION_RATE_LIMIT) return false;
  bucket.count += 1;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessionRateBuckets.entries()) {
    if (v.resetAt <= now) sessionRateBuckets.delete(k);
  }
}, 10 * 60 * 1000).unref?.();

// ─── Route ─────────────────────────────────────────────────────────────────

routes.get('/api/bb/session', async (c) => {
  const authHeader = c.req.header('Authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!bearer) return c.json({ error: 'unauthorized' }, 401);

  const keyHash = crypto.createHash('sha256').update(bearer).digest('hex');

  if (!checkSessionRate(keyHash)) {
    return c.json({ error: 'rate_limited', message: 'Too many session requests. Try again later.' }, 429);
  }

  const row = getActiveSubscriptionByKeyHash(db, keyHash);
  if (!row) return c.json({ error: 'unauthorized' }, 401);

  if (!row.current_period_start) {
    return c.json({ error: 'billing_period_unknown' }, 403);
  }

  const sessionKey = deriveSessionKey(row.email, row.current_period_start);
  if (!sessionKey) {
    console.error('[bb-session] master key not configured — cannot serve session key');
    return c.json({ error: 'server_misconfigured' }, 500);
  }

  return c.json({ session_key: sessionKey.toString('base64'), ttl: 300 });
});
export default routes;
