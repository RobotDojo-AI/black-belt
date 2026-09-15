// lib/mint-tunnel-token.js — mint an HS256 JWT for the tunnel agent to
// present to relay.robotdojo.ai on WebSocket handshake.
//
// Why mint locally and not call out to robotdojo.ai: for the single-user
// owner install, the main app on localhost:4338 and the agent live on the
// same machine, both under the same user. The JWT secret is already in
// Keychain (TUNNEL_JWT_SECRET). There's no value in round-tripping to the
// cloud to mint a token that's then used on the same machine — it only
// adds a bootstrap dependency. For multi-user deployments the backend
// (robotdojo.ai on Vercel) mints tokens via a separate path; this helper
// is owner-only.
//
// JWT shape is fixed by the gateway (see robotdojo-gateway/lib/auth.js):
//   header:  { alg: 'HS256', typ: 'JWT' }
//   payload: { email, slug, belt, exp }     exp is unix seconds
//
// Default TTL is 7 days. The tunnel agent reconnects on disconnect, so a
// short TTL would cause periodic re-minting; 7 days is the sweet spot
// between rotation hygiene and reliability. Re-mint on each app restart.

import { createHmac } from 'node:crypto';
import db from './db.js';
import config from './config.js';

const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;

function b64url(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
  return buf.toString('base64url');
}

/**
 * Look up the owner row. In single-owner installs there's exactly one user
 * with is_admin=1 (created at first magic-link login or by the admin-issue
 * flow in lib/key-issuance.js). Returns null before that user exists —
 * startup callers must handle this, because the agent can't run yet.
 */
export function loadOwnerClaims() {
  const row = db.prepare(
    'SELECT email, user_slug, user_handle, uuid, subscription_status FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1',
  ).get();
  if (!row) return null;
  return {
    email: row.email,
    slug: row.user_slug,
    handle: row.user_handle || row.user_slug,
    uuid: row.uuid || null,
    belt: row.subscription_status || 'white',
  };
}

/**
 * Mint a tunnel JWT for the given claim set. Throws if the HMAC secret
 * isn't configured — callers should check config.tunnelJwtSecret first
 * and skip agent startup when absent (free users, pre-onboarding users).
 *
 * Payload emits `handle` (+ `uuid` when present) instead of `slug`.
 * `slug` is accepted as a backward-compat alias for `handle`.
 */
export function mintTunnelToken({ email, handle, slug, uuid, belt, ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const secret = config.tunnelJwtSecret;
  if (!secret) throw new Error('TUNNEL_JWT_SECRET not configured in Keychain');
  if (!email) throw new Error('mintTunnelToken: email required');
  const h = handle || slug;
  if (!h) throw new Error('mintTunnelToken: handle required');
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payloadObj = {
    email,
    handle: h,
    ...(uuid ? { uuid } : {}),
    belt: belt || 'white',
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payload = b64url(payloadObj);
  const signingInput = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

/**
 * Convenience: mint a token from the DB's owner row. Returns null if the
 * owner user hasn't been created yet OR the secret isn't set.
 */
export function mintOwnerTunnelToken(ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!config.tunnelJwtSecret) return null;
  const claims = loadOwnerClaims();
  if (!claims) return null;
  return mintTunnelToken({ ...claims, ttlSeconds });
}
