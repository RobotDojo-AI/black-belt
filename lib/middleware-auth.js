/**
 * Session-cookie auth middleware for Hono.
 *
 * Two flavors:
 *   requireAuth()  — 401 if no valid session, else attaches c.var.user
 *   optionalAuth() — attaches c.var.user if present, never blocks
 *
 * Both are distinct from `lib/auth.js` (Bearer token for the local app port).
 * This middleware is for the public robotdojo.ai session cookie.
 */

import { timingSafeEqual } from 'node:crypto';
import { getCookie } from 'hono/cookie';
import { COOKIE_NAME, verifySession } from './session.js';
import config from './config.js';

function loadUser(c) {
  const cookie = getCookie(c, COOKIE_NAME);
  if (!cookie) return null;
  return verifySession(cookie);
}

function safeTokenEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Blocks the request with 401 unless a valid session cookie OR Bearer token
 * (ROBOTDOJO_AUTH_TOKEN) is present.
 * On success, attaches `user` and `session` to the Hono context vars when
 * a session is active; Bearer-only requests run without a user context.
 */
export function requireAuth() {
  return async (c, next) => {
    // Accept the static Bearer token (local app key) as a valid auth path.
    // Mirrors the pattern used by requireAdmin() above.
    const bearerHeader = c.req.header('Authorization') || '';
    const bearerToken = bearerHeader.startsWith('Bearer ') ? bearerHeader.slice(7) : null;
    const adminToken = config.authToken;
    if (bearerToken && adminToken && safeTokenEqual(bearerToken, adminToken)) {
      // Bearer token auth: look up the admin user so route handlers have a user context.
      c.set('session', { id: 'bearer', belt_override: null });
      const { default: db } = await import('./db.js');
      const adminUser = db.prepare('SELECT * FROM users WHERE is_admin = 1 LIMIT 1').get();
      if (adminUser) {
        c.set('user', adminUser);
      }
      await next();
      return;
    }

    const auth = loadUser(c);
    if (!auth) {
      return c.json({ error: 'authentication required' }, 401);
    }
    c.set('user', auth.user);
    c.set('session', auth.session);
    await next();
  };
}

/**
 * Attaches `user` / `session` to the context if a valid session cookie is
 * present. Never blocks. Use for pages that render differently for logged-in
 * vs anonymous visitors.
 */
export function optionalAuth() {
  return async (c, next) => {
    const auth = loadUser(c);
    if (auth) {
      c.set('user', auth.user);
      c.set('session', auth.session);
    }
    await next();
  };
}

/**
 * Blocks the request with 403 unless the authenticated user's `is_admin`
 * flag is true. Chain after `requireAuth()` or rely on the presence of
 * `c.var.user`.
 */
export function requireAdmin() {
  return async (c, next) => {
    // Accept either a valid admin session cookie OR the static Bearer token.
    const bearerHeader = c.req.header('Authorization') || '';
    const bearerToken = bearerHeader.startsWith('Bearer ') ? bearerHeader.slice(7) : null;
    const adminToken = config.authToken;
    if (bearerToken && adminToken && safeTokenEqual(bearerToken, adminToken)) {
      c.set('session', { id: 'bearer', belt_override: null });
      const { default: db } = await import('./db.js');
      const adminUser = db.prepare('SELECT * FROM users WHERE is_admin = 1 LIMIT 1').get();
      if (adminUser) {
        c.set('user', adminUser);
      }
      await next();
      return;
    }

    const auth = loadUser(c);
    if (!auth) return c.json({ error: 'authentication required' }, 401);
    if (!auth.user?.is_admin) return c.json({ error: 'forbidden' }, 403);
    c.set('user', auth.user);
    c.set('session', auth.session);
    await next();
  };
}
