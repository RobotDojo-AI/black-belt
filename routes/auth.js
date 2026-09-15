/**
 * Authentication routes — token-paste login + session lifecycle.
 *
 * Endpoints (mounted at /api/auth from index.js):
 *   POST /api/auth/token         body {token} — token-paste login (new in st_5a63545d)
 *   POST /api/auth/local-session body {redirect} — loopback-only stored-token login
 *   POST /api/auth/request-code  → 410 Gone (st_5a63545d: magic-code flow retired)
 *   POST /api/auth/verify-code   → 410 Gone
 *   POST /api/auth/logout        → 200 + clears cookie
 *   GET  /api/auth/me            → user JSON | 401
 *   GET  /api/auth/probe         → health JSON
 *
 * st_5a63545d AC 16, AC 21:
 *   - lib/email.js no longer imported from this file
 *   - Resend-backed magic-code endpoints return 410 Gone (stale-client compat)
 *   - New /api/auth/token endpoint rate-limited at 10/min per IP
 *
 * The token-paste flow is the ONLY identity surface: anyone with the
 * dojo's ROBOTDOJO_AUTH_TOKEN (visible on the accounts page) IS the owner.
 */

import crypto from 'node:crypto';
import { Hono } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';

import app from '../lib/server.js';
import db from '../lib/db.js';
import {
  getAdminUser,
  pingDb,
  promoteUserToAdmin,
} from '../lib/auth-queries.js';
import { validateToken, safeEqual } from '../lib/auth.js';
import {
  createSession,
  destroySession,
  sessionIdFromCookie,
  verifySession,
  cookieOptions,
  COOKIE_NAME,
} from '../lib/session.js';
import { safeRedirect } from '../lib/utils.js';
import config from '../lib/config.js';
import { findOrCreateUser } from '../lib/user-identity.js';
import {
  readInstalledDeviceName,
  repairGeneratedDeviceSlug,
} from '../lib/device-name.js';
import { readInstallExpiry } from '../lib/cohort/active.js';

// --- IP hashing / rate limiting ---------------------------------------------

import { ipFromHonoContext as ipFromRequest } from '../lib/ip.js';

// In-process per-IP rate limit for /api/auth/token. 10 attempts per minute
// matches the brief; per-IP bucket reset rolls every minute. Storage is a
// bounded Map (one row per active IP); a sweep every 5 minutes prunes
// expired buckets to keep memory bounded.
const TOKEN_RATE_LIMIT = 10;
const TOKEN_RATE_WINDOW_MS = 60_000;
const tokenRateBuckets = new Map();

function checkTokenRate(ip) {
  const now = Date.now();
  const b = tokenRateBuckets.get(ip);
  if (!b || b.resetAt <= now) {
    tokenRateBuckets.set(ip, { count: 1, resetAt: now + TOKEN_RATE_WINDOW_MS });
    return true;
  }
  if (b.count >= TOKEN_RATE_LIMIT) return false;
  b.count += 1;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenRateBuckets.entries()) {
    if (v.resetAt <= now) tokenRateBuckets.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

// --- Helpers ----------------------------------------------------------------

// safeRedirect is imported from lib/utils.js and re-exported here for
// backward compat (tests import it from routes/auth.js directly).
export { safeRedirect };

function publicUser(u) {
  if (!u) return null;
  return {
    user_slug: u.user_slug,
    user_handle: u.user_handle || null,
    name: u.name || null,
    uuid: u.uuid || null,
    subscription_status: u.subscription_status,
    created_at: u.created_at,
    last_login_at: u.last_login_at,
    email: u.email || null,
    display_name: u.display_name || null,
    belt: u.belt || null,
  };
}

function hostnameFromHostHeader(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(1, end) : raw;
  }
  return raw.split(':')[0];
}

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function isLoopbackOrigin(origin) {
  if (!origin) return true;
  try {
    return isLoopbackHostname(new URL(origin).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

function localAuthReject(c, status, reason) {
  c.header('x-status-reason', reason);
  return c.json({ error: reason }, status);
}

// --- Auth sub-app -----------------------------------------------------------

const auth = new Hono();

/**
 * POST /api/auth/local-session  body: { redirect }
 *
 * Localhost is the installed app, not the relay. If the Mac already has its
 * ROBOTDOJO_AUTH_TOKEN in Keychain/config, the browser should not ask the
 * owner to paste it back into the same machine. This endpoint mints that
 * browser session from the server-side token state, but only on loopback
 * hosts and only from the same-origin login app.
 */
auth.post('/local-session', async (c) => {
  const host = hostnameFromHostHeader(c.req.header('host'));
  if (!isLoopbackHostname(host)) {
    return localAuthReject(c, 403, 'local_only');
  }
  const localAutoHeader = c.req.header('x-rdj-local-auto') || c.req.header('x-robotdojo-local-auto');
  if (localAutoHeader !== '1') {
    return localAuthReject(c, 403, 'local_auto_header_required');
  }
  if (!isLoopbackOrigin(c.req.header('origin'))) {
    return localAuthReject(c, 403, 'origin_not_local');
  }
  if (!config.authToken) {
    return localAuthReject(c, 409, 'not_initialized');
  }

  let body = {};
  try {
    const contentType = c.req.header('content-type') || '';
    if (contentType.includes('application/json')) body = await c.req.json();
  } catch {
    return localAuthReject(c, 400, 'invalid_json');
  }

  let adminUser = getAdminUser(db);
  if (!adminUser) {
    try {
      const user = findOrCreateUser('owner@robotdojo.local');
      promoteUserToAdmin(db, user.id);
      repairGeneratedDeviceSlug(db, user, readInstalledDeviceName());
      adminUser = getAdminUser(db) || user;
    } catch (err) {
      console.error('[auth/local-session] owner bootstrap failed:', err.message);
      return localAuthReject(c, 500, 'server_error');
    }
  }

  let session;
  try {
    session = await createSession(adminUser.id, c);
  } catch (err) {
    console.error('[auth/local-session] createSession failed:', err.message);
    return localAuthReject(c, 500, 'server_error');
  }

  setCookie(c, COOKIE_NAME, session.cookieValue, cookieOptions(session.maxAgeSeconds, c));

  const redirectParam = typeof body?.redirect === 'string' ? body.redirect : null;
  const redirectTo = safeRedirect(redirectParam || '/chat');
  return c.json({ ok: true, redirect: redirectTo, auth: 'stored_local_token' });
});

/**
 * POST /api/auth/token  body: { token }
 *
 * Token-paste login. The dojo's ROBOTDOJO_AUTH_TOKEN is shown on the
 * accounts page so the owner can sign in from a second device by pasting
 * it here. On success: creates a session, sets the cookie, returns the
 * redirect target.
 *
 * Rate-limited at 10/min per IP to slow brute force. The token is 32 bytes
 * of base64-encoded entropy (256 bits) — even unbounded, brute force is
 * computationally infeasible. The rate limit is defense-in-depth and
 * mitigates accidental hammer-paste loops.
 */
auth.post('/token', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const ipHash = crypto.createHash('sha256').update(String(ipFromRequest(c))).digest('hex');
  if (!checkTokenRate(ipHash)) {
    return c.json({ error: 'rate_limit' }, 429);
  }

  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token) return c.json({ error: 'token_required' }, 400);

  const expected = config.authToken;
  if (!expected || !safeEqual(token, expected)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  // Find or bootstrap the admin user. Token-paste login must work even when
  // the installer could not complete the one-time browser handoff.
  let adminUser = getAdminUser(db);
  if (!adminUser) {
    try {
      const user = findOrCreateUser('owner@robotdojo.local');
      promoteUserToAdmin(db, user.id);
      repairGeneratedDeviceSlug(db, user, readInstalledDeviceName());
      adminUser = getAdminUser(db) || user;
    } catch (err) {
      console.error('[auth/token] owner bootstrap failed:', err.message);
      return c.json({ error: 'server_error' }, 500);
    }
  }

  const session = await createSession(adminUser.id, c);
  setCookie(c, COOKIE_NAME, session.cookieValue, cookieOptions(session.maxAgeSeconds, c));

  const redirectParam = typeof body?.redirect === 'string' ? body.redirect : null;
  const redirectTo = safeRedirect(redirectParam || '/chat');
  return c.json({ ok: true, redirect: redirectTo });
});

/**
 * Magic-code endpoints retired in st_5a63545d. Returning 410 Gone instead
 * of removing the route entirely lets stale clients (cached HTML, offline
 * docs) get a clear signal instead of crashing on 404 + console errors.
 */
auth.all('/request-code', (c) => c.json({ error: 'gone', message: 'Magic-code login retired. Use the token-paste login at /login.' }, 410));
auth.all('/verify-code',  (c) => c.json({ error: 'gone', message: 'Magic-code login retired. Use the token-paste login at /login.' }, 410));
// Legacy magic-link endpoints — same retirement treatment.
auth.all('/request-link', (c) => c.json({ error: 'gone', message: 'Magic-link login retired. Use /api/auth/token.' }, 410));
auth.all('/verify',       (c) => c.json({ error: 'gone', message: 'Magic-link login retired. Use /api/auth/token.' }, 410));

/**
 * Health probe — no rate limit, no email, no session required.
 * Tests DB connectivity only (Resend dependency removed).
 */
auth.get('/probe', (c) => {
  try {
    pingDb(db);
  } catch (err) {
    return c.json({ ok: false, db: false, error: err.message }, 503);
  }
  return c.json({
    ok: true,
    db: true,
    ts: new Date().toISOString(),
  });
});

/**
 * Clear the session cookie and destroy the server-side row.
 */
auth.post('/logout', async (c) => {
  const cookie = getCookie(c, COOKIE_NAME);
  const sessionId = sessionIdFromCookie(cookie);
  if (sessionId) destroySession(sessionId);
  setCookie(c, COOKIE_NAME, '', { ...cookieOptions(0, c), maxAge: 0 });
  return c.json({ ok: true });
});

/**
 * Current-user JSON. 401 if not logged in.
 * Accepts session cookie OR Bearer token (ROBOTDOJO_AUTH_TOKEN) for the
 * local app port — mirrors the pattern used elsewhere.
 */
auth.get('/me', async (c) => {
  // Bearer token path: look up the admin user and return their profile.
  const bearerHeader = c.req.header('Authorization') || '';
  if (bearerHeader.startsWith('Bearer ')) {
    const token = bearerHeader.slice(7);
    if (validateToken(token)) {
      const adminUser = getAdminUser(db);
      // st_96bb626f AC-13 — surface the per-install Black Belt expiry as a
      // read-only field for the Admin identity surface. Local install state,
      // never a payment/checkout hook. Computed only on authenticated success.
      if (adminUser) return c.json({ user: publicUser(adminUser), bb_expires_at: readInstallExpiry() });
    }
  }
  const cookie = getCookie(c, COOKIE_NAME);
  const authData = cookie ? verifySession(cookie) : null;
  if (!authData) return c.json({ error: 'not_authenticated' }, 401);
  return c.json({ user: publicUser(authData.user), bb_expires_at: readInstallExpiry() });
});

export default auth;

// --- Legacy bearer-token endpoints ------------------------------------------
// `/auth/validate` predates magic-link auth and remains for the local-app
// bearer flow. `/api/whoami` lives in routes/api.js — the belt is dynamic there.

app.post('/auth/validate', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ valid: false, error: 'invalid_json' }, 400); }
  const token = body?.token;
  if (!token) return c.json({ valid: false, error: 'token_required' }, 400);
  return c.json({ valid: validateToken(token) });
});
