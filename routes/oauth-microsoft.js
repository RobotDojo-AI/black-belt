/**
 * Microsoft OAuth routes.
 *
 *   GET  /auth/microsoft           → redirect to Microsoft consent
 *   GET  /auth/microsoft/callback  → exchange code, store tokens, queue sync
 *
 * Uses PKCE (S256) — no client secret over the wire at redirect time.
 * State is a random nonce stored in session to prevent CSRF.
 *
 * Heavy Outlook/Calendar sync is handled by the scheduled sync worker, not the
 * browser callback.
 */
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';

const OAUTH_FROM_COOKIE = 'rdojo_oauth_from';
const ACCOUNT_INTEGRATIONS = '/account/integrations';

function accountRedirect(params = {}) {
  const qs = new URLSearchParams(params);
  const query = qs.toString();
  return query ? `/account/integrations?${query}` : ACCOUNT_INTEGRATIONS;
}

import config, { secret } from '../lib/config.js';
import {
  AUTH_URL,
  SCOPES,
  exchangeCodeForTokens,
  storeMicrosoftTokens,
} from '../lib/microsoft-oauth.js';
import db from '../lib/db.js';
import { upsertMicrosoftAccounts } from '../lib/oauth-queries.js';
import { queueOAuthSync } from '../lib/oauth-sync-queue.js';

const router = new Hono();

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function generateVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function deriveChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── State store (in-process, TTL 10 min) ─────────────────────────────────────
// Good enough for a single-user install. A multi-user install would use the DB.

const STATE_STORE = new Map(); // state → { verifier, createdAt }
const STATE_TTL_MS = 10 * 60 * 1000;

function storeState(state, verifier) {
  STATE_STORE.set(state, { verifier, createdAt: Date.now() });
  // Sweep old entries lazily
  for (const [k, v] of STATE_STORE) {
    if (Date.now() - v.createdAt > STATE_TTL_MS) STATE_STORE.delete(k);
  }
}

function consumeState(state) {
  const entry = STATE_STORE.get(state);
  if (!entry) return null;
  STATE_STORE.delete(state);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
  return entry.verifier;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/microsoft', (c) => {
  const clientId = secret('MICROSOFT_CLIENT_ID');
  if (!clientId) {
    return c.json({ error: 'service_unavailable' }, 503);
  }

  const state = crypto.randomBytes(16).toString('hex');
  const verifier = generateVerifier();
  const challenge = deriveChallenge(verifier);

  storeState(state, verifier);

  const origin = new URL(c.req.url).origin;
  const secure = origin.startsWith('https');
  setCookie(c, OAUTH_FROM_COOKIE, c.req.query('setup') === '1' ? 'setup' : 'account', { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 600, secure });
  const redirectUri = `${config.appBaseUrl || origin}/auth/microsoft/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return c.redirect(`${AUTH_URL}?${params}`, 302);
});

router.get('/microsoft/callback', async (c) => {
  const { code, state, error, error_description } = c.req.query();

  if (error) {
    console.error('[oauth/microsoft] consent denied:', error, error_description);
    return c.redirect(accountRedirect({ error }), 302);
  }

  if (!code || !state) {
    return c.redirect(accountRedirect({ error: 'missing_params' }), 302);
  }

  const verifier = consumeState(state);
  if (!verifier) {
    return c.redirect(accountRedirect({ error: 'invalid_state' }), 302);
  }

  const origin = new URL(c.req.url).origin;
  const redirectUri = `${config.appBaseUrl || origin}/auth/microsoft/callback`;

  let tokenData;
  try {
    tokenData = await exchangeCodeForTokens(code, redirectUri, verifier);
  } catch (err) {
    console.error('[oauth/microsoft] token exchange failed:', err.message);
    return c.redirect(accountRedirect({ error: 'token_exchange_failed' }), 302);
  }

  // Fetch the user's email from /me
  let email;
  let displayName;
  if (process.env.ROBOTDOJO_MICROSOFT_OAUTH_MOCK) {
    email = (tokenData.id_token_email || tokenData.email || '').toLowerCase();
    displayName = tokenData.id_token_name || `Microsoft (${email})`;
  } else {
    try {
      const meRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!meRes.ok) throw new Error(`/me returned ${meRes.status}`);
      const me = await meRes.json();
      email = (me.mail || me.userPrincipalName || '').toLowerCase();
      displayName = me.displayName || `Microsoft (${email})`;
    } catch (err) {
      console.error('[oauth/microsoft] /me failed:', err.message);
      return c.redirect(accountRedirect({ error: 'profile_fetch_failed' }), 302);
    }
  }

  if (!email) {
    return c.redirect(accountRedirect({ error: 'no_email' }), 302);
  }

  const expiry = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000).toISOString();
  storeMicrosoftTokens(email, {
    access: tokenData.access_token,
    refresh: tokenData.refresh_token,
    expiry,
  });

  try {
    upsertMicrosoftAccounts(db, email, displayName || `Microsoft (${email})`);
  } catch (err) {
    console.error('[oauth/microsoft] upsert account failed:', err.message);
  }

  console.info(`[oauth/microsoft] connected: ${email}`);

  queueOAuthSync(db, 'microsoft', email);

  setCookie(c, OAUTH_FROM_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return c.redirect(accountRedirect({ connected: 'microsoft', refresh: '1' }), 302);
});

export default router;

// Test-only exports — tree-shaken in production builds, used by tests/oauth.test.js
export { storeState as _storeState, consumeState as _consumeState, generateVerifier, deriveChallenge };
