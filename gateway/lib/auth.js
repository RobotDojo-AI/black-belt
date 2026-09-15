/**
 * Tunnel-agent authentication.
 *
 * Each paying user is issued a short-lived HS256 JWT by the robotdojo.ai
 * backend. The agent presents it on WebSocket handshake (?token=xxx). We
 * verify signature + expiry here — no DB lookup on the hot path.
 *
 * Token payload: { email, slug, belt, exp }  (exp is unix seconds)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = {
  decode(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); },
};

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest();
}

/**
 * Verify a tunnel JWT. Returns the payload on success, throws on any failure.
 * Never leaks why verification failed — callers log "auth failed" and move on.
 */
export function verifyTunnelToken(token, secret) {
  if (!token || typeof token !== 'string') throw new Error('auth');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('auth');

  const [h, p, s] = parts;

  // Pin alg — reject 'none', HS384, RS256, etc. Only HS256 allowed.
  let head;
  try { head = JSON.parse(b64url.decode(h).toString('utf8')); } catch { throw new Error('auth'); }
  if (head.alg !== 'HS256') throw new Error('auth');

  const expected = sign(`${h}.${p}`, secret);
  const actual = b64url.decode(s);
  if (actual.length !== expected.length) throw new Error('auth');
  if (!timingSafeEqual(actual, expected)) throw new Error('auth');

  const payload = JSON.parse(b64url.decode(p).toString('utf8'));
  // Accept new format (handle+uuid) or old format (slug) — backward compat.
  if (!payload.email) throw new Error('auth');
  if (!payload.handle && !payload.slug) throw new Error('auth');
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('auth');
  return payload;
}

/**
 * Verify the shared secret on internal control-plane REST calls.
 * Constant-time compare. Header: `authorization: Bearer <secret>`.
 */
export function verifyInternalSecret(header, expected) {
  if (!header || !expected) return false;
  const provided = header.replace(/^Bearer\s+/i, '');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
