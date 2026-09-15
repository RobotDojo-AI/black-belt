/**
 * Google OAuth route handler.
 *
 *   GET  /auth/google           → redirect to Google consent URL
 *   GET  /auth/google/callback  → exchange code, store tokens, upsert accounts row, redirect Account → Integrations
 *
 * State param: random 32-byte hex stored in session cookie on request, verified
 * on callback to prevent CSRF.
 *
 * After tokens are stored: marks Gmail/Calendar sync as queued in
 * integration_health. The scheduled sync worker performs the heavy work behind
 * idle and writer guards.
 */

import crypto from 'node:crypto';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import db from '../lib/db.js';
import { secret } from '../lib/config.js';
import config from '../lib/config.js';
import { storeGoogleTokens } from '../lib/google-oauth.js';
import { upsertGoogleAccounts } from '../lib/oauth-queries.js';
import { queueOAuthSync } from '../lib/oauth-sync-queue.js';
// st_96bb626f AC 12 — accelerate first-connection intelligence. The same
// data-arrival accelerator the passive sync worker and drop-folder watcher
// use, so a freshly connected account's ingest → entity → enrich chain starts
// on connect instead of waiting for the next scheduled sync-worker cycle.
import { enqueuePipelinesOnDataArrival } from '../lib/data-arrival-pipelines.js';
// st_5a63545d AC 9 — single source of truth for OAuth scopes + descriptions.
// Both this file (consent URL) and account/integration UI import from
// lib/google-scopes.js so displayed text never drifts from the actual grant.
import { SCOPES as SCOPES_ARRAY } from '../lib/google-scopes.js';
// st_5a63545d AC 7 — signed `state` param carries wizard stage across the
// OAuth roundtrip; callback advances onboarding_stage server-side instead
// of relying on frontend polling.
import { encode as encodeState, decode as decodeState } from '../lib/oauth-state.js';
import { writeSetting } from './setup/helpers.js';
// Thin-facade extraction (AC 22) — no db.prepare in routes/.
import { getOnboardingStageFromSettings, setAdminOnboardingStage } from '../lib/setup-queries.js';

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT   = 'https://oauth2.googleapis.com/token';
const USERINFO_URL     = 'https://www.googleapis.com/oauth2/v2/userinfo';
const OAUTH_STATE_COOKIE = 'rdojo_oauth_state';
const OAUTH_FROM_COOKIE  = 'rdojo_oauth_from';
const ACCOUNT_INTEGRATIONS = '/account/integrations';

function accountRedirect(params = {}) {
  const qs = new URLSearchParams(params);
  const query = qs.toString();
  return query ? `/account/integrations?${query}` : ACCOUNT_INTEGRATIONS;
}

// Space-delimited scope string for the Google authorize URL. The SCOPES
// array is the canonical list; this is a derived view, never edited directly.
const SCOPES = SCOPES_ARRAY.join(' ');

const oauth = new Hono();

function redirectUri(originUrl) {
  // Use the configured canonical URL so the redirect_uri always matches what's
  // registered in Google Cloud Console, regardless of which subdomain the
  // Vercel middleware proxied the request from.
  // Falls back to request origin for local dev (localhost).
  const canonical = secret('GOOGLE_REDIRECT_BASE') || process.env.GOOGLE_REDIRECT_BASE;
  const base = canonical || (originUrl.includes('localhost') ? originUrl : 'https://robotdojo.ai');
  return new URL('/auth/google/callback', base).toString();
}

/**
 * GET /auth/google/guidance — pre-redirect guidance interstitial.
 *
 * Google shows a "proceed with caution" screen for OAuth apps that are not
 * yet Google-certified. Strangers installing Robot Dojo see this and think
 * something is wrong with the app. This endpoint renders a one-page HTML
 * interstitial explaining the caution screen is normal and that data is
 * not at risk; the user clicks "I understand, continue" to start the real
 * OAuth flow at /auth/google. st_42799dbe AC 13.
 *
 * Returns text/html, no auth required — this is a static guidance page.
 */
oauth.get('/google/guidance', (c) => {
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Robot Dojo — Connect Google</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif;
         max-width: 540px; margin: 0 auto; padding: 48px 24px; color: #1a1a1a; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 24px; }
  .callout { background: #fff8e6; border: 1px solid #f0d56b; border-radius: 8px;
             padding: 16px 18px; margin: 16px 0 24px; font-size: 14px; }
  .callout strong { color: #8a6500; }
  p { font-size: 15px; margin: 12px 0; }
  ul { padding-left: 22px; }
  li { margin: 6px 0; font-size: 14px; }
  .actions { margin-top: 32px; display: flex; gap: 12px; }
  .btn { display: inline-block; padding: 10px 18px; border-radius: 6px;
         text-decoration: none; font-weight: 500; font-size: 14px; }
  .btn-primary { background: #1a73e8; color: #fff; }
  .btn-primary:hover { background: #1664c8; }
  .btn-secondary { background: #f1f3f4; color: #1a1a1a; }
  .btn-secondary:hover { background: #e6e9eb; }
</style></head>
<body>
  <h1>Connecting your Google account</h1>

  <div class="callout">
    <strong>You may see a "proceed with caution" screen</strong> from Google.
    That's because Robot Dojo is currently awaiting Google certification — not
    because anything is unsafe. Robot Dojo runs entirely on your Mac and never
    sends your data to a third-party server.
  </div>

  <p>When the caution screen appears:</p>
  <ul>
    <li>Click <strong>Advanced</strong> at the bottom of the screen.</li>
    <li>Click <strong>Go to robotdojo.ai (unsafe)</strong> — Google's certification
        review is in progress; this label disappears once approved.</li>
    <li>Review the requested permissions and click <strong>Allow</strong>.</li>
  </ul>

  <p>Robot Dojo asks for the Google scopes listed on the next screen. All data
  syncs to a local SQLite file on your Mac; Robot Dojo only writes back when
  you explicitly ask it to (e.g. send an email, schedule a meeting).</p>

  <div class="actions">
    <a class="btn btn-primary" href="/auth/google">I understand — continue to Google</a>
    <a class="btn btn-secondary" href="/account/integrations">Cancel</a>
  </div>
</body></html>`;
  return c.html(html);
});

/**
 * GET /api/auth/google/start?account=<personal|branded|family|work>
 *
 * Per-account Google OAuth entry point — used by the Accounts redesign
 * Google connect cards (Story st_d9fc573b — AC 16). The query `account`
 * parameter is mapped to a Google login_hint via the configured email
 * addresses (active-integrations memory). Falls back to a plain consent
 * URL with no hint if the account label is unknown.
 *
 * Mounted at /api/auth in index.js — so this resolves at
 * /api/auth/google/start, which the global PUBLIC_PREFIXES allows
 * unauthenticated (the OAuth flow is itself the auth surface).
 *
 * WHY a separate start endpoint instead of reusing /auth/google with a
 * query param: the AC asserts the path `/api/auth/google/start` returns
 * 302 to accounts.google.com. Co-locating with the rest of the OAuth
 * logic in this file keeps the consent + callback dance discoverable.
 */
oauth.get('/google/start', (c) => {
  const clientId = secret('GOOGLE_CLIENT_ID');
  if (!clientId) return c.json({ error: 'service_unavailable' }, 503);

  // Map account label → login_hint. Keep the list short; unknown labels
  // pass through to a plain consent URL (Google will surface its account
  // chooser). Real email addresses are user-personal data and stay out of
  // source — set ROBOTDOJO_GOOGLE_HINT_<LABEL> env vars if a deployment
  // wants pre-fill hints.
  const account = (c.req.query('account') || '').toLowerCase();
  let loginHint = c.req.query('login_hint') || null;
  if (!loginHint && account) {
    if (account.includes('@')) {
      loginHint = account;
    } else {
      const envKey = `ROBOTDOJO_GOOGLE_HINT_${account.toUpperCase()}`;
      if (process.env[envKey]) loginHint = process.env[envKey];
    }
  }

  const state = crypto.randomBytes(32).toString('hex');
  const origin = new URL(c.req.url).origin;

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri(origin),
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  // Carry the account label through the state cookie so the callback can
  // attribute the resulting tokens (future enhancement; non-blocking).
  if (account) params.set('hd', '*'); // hint domain wildcard — always allow

  const secure = origin.startsWith('https');
  setCookie(c, OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 600, secure });
  setCookie(c, OAUTH_FROM_COOKIE, 'account', { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 600, secure });

  return c.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302);
});

oauth.get('/google', (c) => {
  const clientId = secret('GOOGLE_CLIENT_ID');
  if (!clientId) return c.json({ error: 'service_unavailable' }, 503);

  const origin = new URL(c.req.url).origin;
  const isSetup = c.req.query('setup') === '1';

  // st_5a63545d AC 7 — when from setup, use signed-state encoding
  // `{stage, nonce}` HMAC'd with SESSION_SECRET. Callback decodes, advances
  // onboarding_stage to (stage+1) in the same handler. The legacy random
  // 32-byte state is preserved as a fallback for the account-page flow
  // (which doesn't need stage advance).
  let state;
  if (isSetup) {
    const sessionSecret = config.sessionSecret;
    if (!sessionSecret) {
      console.warn('[oauth] setup flow requires SESSION_SECRET — falling back to random state');
      state = crypto.randomBytes(32).toString('hex');
    } else {
      // Read the user's current stage from settings; default 3 (the OAuth stage).
      // The callback advances to (stage+1) so the wizard lands on the next page.
      const currentStage = getOnboardingStageFromSettings(db) ?? 3;
      state = encodeState({ stage: currentStage, nonce: crypto.randomBytes(16).toString('hex') }, sessionSecret);
    }
  } else {
    state = crypto.randomBytes(32).toString('hex');
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri(origin),
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',
    state,
  });

  const loginHint = c.req.query('login_hint');
  if (loginHint) params.set('login_hint', loginHint);

  const secure = origin.startsWith('https');
  // For signed state (setup flow) the cookie carries the same signed value so
  // the callback can both verify the HMAC AND confirm the state came from
  // a flow this server initiated (defense-in-depth). For the legacy random
  // state, the cookie is the only CSRF check.
  setCookie(c, OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 600, secure });
  setCookie(c, OAUTH_FROM_COOKIE, isSetup ? 'setup' : 'account', { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 600, secure });

  return c.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302);
});

oauth.get('/google/callback', async (c) => {
  const code       = c.req.query('code');
  const stateParam = c.req.query('state');
  const error      = c.req.query('error');
  const stateCookie = getCookie(c, OAUTH_STATE_COOKIE);

  setCookie(c, OAUTH_STATE_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });

  if (error) {
    console.warn('[oauth] Google denied:', error);
    return c.redirect(accountRedirect({ error: 'oauth_denied', provider: 'google' }), 302);
  }

  if (!code) return c.redirect(accountRedirect({ error: 'oauth_no_code', provider: 'google' }), 302);

  // st_5a63545d AC 7 — verify the state param. Two acceptable shapes:
  //   (a) Signed state from a setup flow: `b64.hmac` — decode against
  //       SESSION_SECRET; on success, extract the stage so we can advance it
  //       server-side after token exchange.
  //   (b) Legacy random hex state from the account flow: match against the
  //       cookie (existing CSRF check).
  // Tampering (mismatched HMAC) on (a) MUST be rejected — st_5a63545d spec
  // asserts the stage is NOT advanced on tampered state.
  let decodedStagePayload = null;
  if (stateParam && stateParam.includes('.')) {
    const sessionSecret = config.sessionSecret;
    if (sessionSecret) {
      try {
        decodedStagePayload = decodeState(stateParam, sessionSecret);
      } catch (err) {
        console.warn('[oauth] signed state verification failed:', err.message);
        return c.json({ error: 'state_invalid' }, 400);
      }
    }
  }
  // If not a signed state, fall back to the cookie-matched random-state CSRF check.
  if (!decodedStagePayload) {
    if (!stateParam || !stateCookie || stateParam !== stateCookie) {
      console.warn('[oauth] state mismatch — possible CSRF');
      return c.redirect(accountRedirect({ error: 'oauth_state_mismatch', provider: 'google' }), 302);
    }
  }

  const clientId     = secret('GOOGLE_CLIENT_ID');
  const clientSecret = secret('GOOGLE_CLIENT_SECRET');
  const origin = new URL(c.req.url).origin;

  // Test-only token exchange hook — when ROBOTDOJO_OAUTH_MOCK is set, skip
  // the network call and use the injected response. Production never sets
  // this. The mock unblocks AC 7 spec testing without standing up an
  // outbound HTTP mock.
  let tokenData;
  const mockEnv = process.env.ROBOTDOJO_OAUTH_MOCK;
  if (mockEnv) {
    try { tokenData = JSON.parse(mockEnv); }
    catch { return c.redirect(accountRedirect({ error: 'oauth_mock_bad_json', provider: 'google' }), 302); }
  } else {
    if (!clientId || !clientSecret) {
      return c.redirect(accountRedirect({ error: 'oauth_not_configured', provider: 'google' }), 302);
    }
    try {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id:     clientId,
          client_secret: clientSecret,
          redirect_uri:  redirectUri(origin),
          grant_type:    'authorization_code',
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Token exchange: ${res.status} ${body}`);
      }
      tokenData = await res.json();
    } catch (err) {
      console.error('[oauth] token exchange failed:', err.message);
      return c.redirect(accountRedirect({ error: 'oauth_token_failed', provider: 'google' }), 302);
    }
  }

  let email = null;
  let displayName = null;
  // Mock path supplies id_token_email directly so test doesn't need to mock
  // the userinfo endpoint too.
  if (mockEnv && tokenData?.id_token_email) {
    email = tokenData.id_token_email;
    displayName = tokenData.id_token_name || null;
  } else {
    try {
      const infoRes = await fetch(USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (infoRes.ok) {
        const info = await infoRes.json();
        email = info.email || null;
        displayName = info.name || null;
      }
    } catch (err) {
      console.warn('[oauth] userinfo failed:', err.message);
    }
  }

  if (!email) {
    console.error('[oauth] could not determine Google account email');
    return c.redirect(accountRedirect({ error: 'oauth_no_email', provider: 'google' }), 302);
  }

  const expiry = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();
  try {
    storeGoogleTokens(email, {
      access:  tokenData.access_token,
      refresh: tokenData.refresh_token || null,
      expiry,
    });
  } catch (err) {
    console.error('[oauth] storeGoogleTokens failed:', err.message);
    return c.redirect(accountRedirect({ error: 'oauth_store_failed', provider: 'google' }), 302);
  }

  try {
    const grantedScopes = String(tokenData.scope || '')
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
    upsertAccount(email, displayName || `Google (${email})`, grantedScopes.length ? grantedScopes : SCOPES_ARRAY);
  } catch (err) {
    console.error('[oauth] upsertAccount failed:', err.message);
    // Non-fatal — tokens are stored, account sync will fix DB state
  }

  queueOAuthSync(db, 'google', email);

  // st_96bb626f AC 12 — kick the extraction/ingest pipeline on connect.
  // queueOAuthSync only marks the provider sync queued in integration_health;
  // the ingest → entity → enrich chain would otherwise wait for the next
  // scheduled sync-worker cycle, pushing entity-aware chat past the 5-minute
  // launch target. Enqueue the debounced data-arrival pipelines now (same call
  // the sync orchestrator and drop-folder watcher use). Best-effort: tokens are
  // already stored, so a trigger failure must never break the OAuth redirect.
  try {
    enqueuePipelinesOnDataArrival(db, { source: 'oauth-google-connected' });
  } catch (err) {
    console.warn('[oauth] data-arrival pipeline enqueue failed:', err.message);
  }

  setCookie(c, OAUTH_FROM_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });

  // st_5a63545d AC 7 — when signed state decoded a stage, advance
  // onboarding_stage to (stage + 1) server-side. The frontend no longer
  // polls for stage changes around OAuth; the callback IS the advance.
  // Redirect target lands on Account → Integrations; setup is not a user
  // surface. The API state still advances server-side for compatibility.
  // Writes BOTH users.onboarding_stage (canonical column per spec) AND
  // user_settings.onboarding_stage (legacy key consumed by existing GETs)
  // so /api/setup/onboarding handlers using readSetting() keep working.
  if (decodedStagePayload && Number.isFinite(decodedStagePayload.stage)) {
    try {
      const nextStage = decodedStagePayload.stage + 1;
      setAdminOnboardingStage(db, nextStage);
      writeSetting('onboarding_stage', String(nextStage));
    } catch (err) {
      console.error('[oauth] onboarding_stage advance failed:', err.message);
    }
    return c.redirect(accountRedirect({ connected: 'google', refresh: '1' }), 302);
  }
  return c.redirect(accountRedirect({ connected: 'google', refresh: '1' }), 302);
});

function upsertAccount(email, displayName, scopes = SCOPES_ARRAY) {
  upsertGoogleAccounts(db, email, displayName, {
    metadata: {
      google_oauth_scopes: scopes,
      google_oauth_scopes_recorded_at: new Date().toISOString(),
      google_oauth_scope_contract: 'full-google-history-v1',
    },
  });
}

// WHY: when stored-accounts.json refresh fails, user must re-open Granola app.
// This route attempts a refresh first; on success redirects to integrations page.
oauth.get('/granola', async (c) => {
  const { existsSync } = await import('node:fs');
  const { STORED_ACCOUNTS_FILE, getGranolaToken } = await import('../lib/granola-client.js');
  const installed = existsSync(STORED_ACCOUNTS_FILE);

  if (installed) {
    try {
      const token = await getGranolaToken();
      if (token) return c.redirect('/account/integrations?connected=granola&refresh=1');
    } catch { /* fall through to instruction page */ }
  }

  const title = installed ? 'Reconnect Granola' : 'Connect Granola';
  const body = installed
    ? `<h1>Reconnect Granola</h1>
<p>Your Granola session has expired. Open the <strong>Granola app</strong> on your Mac, make sure you're signed in, then <a href="/auth/granola">try again</a>.</p>`
    : `<h1>Connect Granola</h1>
<p>Granola is a free Mac app that transcribes your meetings. Robot Dojo reads transcripts directly from your Mac — no API key needed.</p>
<p><strong>Step 1:</strong> <a href="https://granola.ai" target="_blank">Download Granola ↗</a></p>
<p><strong>Step 2:</strong> Open the app and sign in.</p>
<p><strong>Step 3:</strong> <a href="/auth/granola">Return here</a> — your transcripts will sync automatically.</p>`;

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#333}
h1{font-size:20px;margin-bottom:8px}p{color:#555;line-height:1.5}a{color:#1a73e8}</style>
</head>
<body>${body}
<p style="margin-top:24px"><a href="/account/integrations">← Back to integrations</a></p>
</body>
</html>`);
});

export default oauth;

// Test-only exports
export { redirectUri as _redirectUri };
