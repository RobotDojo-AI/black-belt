/**
 * GET /auth/local-start?token=X — installer-to-browser token handoff.
 *
 * The installer opens this relay plumbing URL once. The handler validates the
 * token from Keychain/config, creates a local Mac session, sets the apex
 * routing cookie, strips the token from the browser URL, and lands on the
 * clean robotdojo.ai surface.
 */

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import config from '../../lib/config.js';
import db from '../../lib/db.js';
import { findOrCreateUser } from '../../lib/user-identity.js';
import {
  createSession,
  cookieOptions,
  COOKIE_NAME,
} from '../../lib/session.js';
import { safeEqual } from '../../lib/auth.js';
import {
  readInstalledDeviceName,
  repairGeneratedDeviceSlug,
  resolveLoginServerName,
} from '../../lib/device-name.js';

const CONSUMED_TOKENS = new Set();
const RELAY_ROUTING_TTL_SECONDS = 60 * 60 * 24 * 365;

const start = new Hono();

start.get('/', async (c) => {
  const token = c.req.query('token');
  const expected = config.authToken;

  if (!token || !expected || !safeEqual(token, expected)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  if (CONSUMED_TOKENS.has(token)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  CONSUMED_TOKENS.add(token);

  let user;
  try {
    user = findOrCreateUser('owner@robotdojo.local');
    repairGeneratedDeviceSlug(db, user, readInstalledDeviceName());
  } catch (err) {
    console.error('[auth/local-start] findOrCreateUser failed:', err.message);
    return c.json({ error: 'server_error' }, 500);
  }

  let session;
  try {
    session = await createSession(user.id, c);
  } catch (err) {
    console.error('[auth/local-start] createSession failed:', err.message);
    return c.json({ error: 'server_error' }, 500);
  }

  setCookie(c, COOKIE_NAME, session.cookieValue, cookieOptions(session.maxAgeSeconds, c));
  const loginServer = resolveLoginServerName(user.user_slug);
  if (loginServer) {
    setCookie(c, 'rd_server', loginServer, {
      domain: '.robotdojo.ai',
      path: '/',
      maxAge: RELAY_ROUTING_TTL_SECONDS,
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
    });
  }
  c.header('Referrer-Policy', 'no-referrer');

  const redirect = typeof c.req.query('redirect') === 'string' ? c.req.query('redirect') : '/account/integrations';
  const safeRedirect = redirect.startsWith('/') && !redirect.startsWith('//') && !redirect.includes('://')
    ? redirect
    : '/account/integrations';
  return c.redirect(`https://robotdojo.ai${safeRedirect}`, 302);
});

export default start;
export { CONSUMED_TOKENS as _CONSUMED_TOKENS };
