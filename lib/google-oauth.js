/**
 * Google OAuth token management — Keychain-backed, single-machine model.
 *
 * Tokens live in macOS Keychain under:
 *   robotdojo-oauth-google-access-{email}
 *   robotdojo-oauth-google-refresh-{email}
 *   robotdojo-oauth-google-expiry-{email}
 *
 * Why Keychain only (no DB): tokens are credentials, not data. The DB is
 * encrypted but still a file that could be copied; Keychain ACLs are
 * process-scoped on macOS, providing a second security boundary.
 */

import { secret } from './config.js';
import db from './db.js';
import { deleteKeychainSecret, readKeychainSecret, writeKeychainSecret } from './keychain.js';
import { recordLiveVerification } from './integration-status.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REFRESH_WINDOW_MS = 5 * 60_000;
// st_bf4978b0 AC4 — proactive refresh window, wider than the reactive 5-min
// window so our side never lets a token we could have refreshed lapse.
// Env-overridable.
const PROACTIVE_REFRESH_MS = Number(process.env.ROBOTDOJO_PROACTIVE_REFRESH_MS) > 0
  ? Number(process.env.ROBOTDOJO_PROACTIVE_REFRESH_MS)
  : 30 * 60_000;
const memoryTokens = new Map();

function useMemoryTokenStore() {
  return process.env.ROBOTDOJO_OAUTH_TEST_MEMORY_STORE === '1';
}

function keychainRead(service) {
  return readKeychainSecret(service);
}

function keychainWrite(service, value) {
  if (!writeKeychainSecret(service, value)) throw new Error(`Keychain write failed: ${service}`);
}

export function getGoogleTokens(email) {
  if (useMemoryTokenStore()) return memoryTokens.get(email) || null;
  const access  = keychainRead(`oauth-google-access-${email}`);
  const refresh = keychainRead(`oauth-google-refresh-${email}`);
  const expiry  = keychainRead(`oauth-google-expiry-${email}`);
  if (!refresh) return null;
  return { access, refresh, expiry };
}

export function storeGoogleTokens(email, { access, refresh, expiry }) {
  if (useMemoryTokenStore()) {
    memoryTokens.set(email, { access, refresh, expiry });
    return;
  }
  if (access)  keychainWrite(`oauth-google-access-${email}`,  access);
  if (refresh) keychainWrite(`oauth-google-refresh-${email}`, refresh);
  if (expiry)  keychainWrite(`oauth-google-expiry-${email}`,  expiry);
}

export async function refreshGoogleToken(email) {
  const tokens = getGoogleTokens(email);
  if (!tokens?.refresh) throw new Error(`no refresh token for ${email}`);

  const clientId     = secret('GOOGLE_CLIENT_ID');
  const clientSecret = secret('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refresh,
      client_id:     clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text();
    // st_d142f701 AC2: surface invalid_grant as needs_reauth.
    // WHY explicit JSON-body parse (not substring match on the raw response):
    // Google's error envelope is `{"error":"invalid_grant", "error_description":...}`.
    // Substring matches on transient 5xx error pages (Akamai/cloudflare) that
    // happen to contain the literal "invalid_grant" anywhere would
    // misclassify a network blip as a permanently-revoked token and force the
    // user to re-consent a working account. Parse + check the `error` field
    // so transient errors re-throw unchanged and only an explicit
    // OAuth-protocol invalid_grant triggers the self-heal.
    let isInvalidGrant = false;
    try {
      const parsed = JSON.parse(body);
      isInvalidGrant = parsed?.error === 'invalid_grant';
    } catch { /* non-JSON body — treat as transient */ }

    if (isInvalidGrant) {
      // Clear the dead tokens from Keychain so a subsequent connection
      // attempt starts fresh. Best-effort — Keychain delete failures are
      // logged but never block the re-throw below.
      try {
        if (!useMemoryTokenStore()) {
          deleteKeychainSecret(`oauth-google-access-${email}`);
          deleteKeychainSecret(`oauth-google-refresh-${email}`);
          deleteKeychainSecret(`oauth-google-expiry-${email}`);
        } else {
          memoryTokens.delete(email);
        }
      } catch (cleanupErr) {
        console.warn(`[google-oauth] keychain cleanup failed for ${email}: ${cleanupErr.message}`);
      }
      // Flag the account row so the accounts surface renders a Reconnect CTA.
      try {
        db.prepare(
          `UPDATE accounts SET status='needs_reauth', last_error=? WHERE vendor='google' AND email=?`
        ).run('invalid_grant', email);
      } catch (dbErr) {
        console.warn(`[google-oauth] needs_reauth flag failed for ${email}: ${dbErr.message}`);
      }
    }
    throw new Error(`Google token refresh failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const newExpiry = new Date(Date.now() + data.expires_in * 1000).toISOString();

  storeGoogleTokens(email, {
    access:  data.access_token,
    refresh: tokens.refresh,
    expiry:  newExpiry,
  });

  try {
    db.prepare(
      `UPDATE accounts
          SET status='active', last_error=NULL, updated_at=datetime('now')
        WHERE vendor='google' AND email=?`
    ).run(email);
  } catch (dbErr) {
    console.warn(`[google-oauth] account revive failed for ${email}: ${dbErr.message}`);
  }

  return data.access_token;
}

export async function getValidAccessToken(email) {
  const tokens = getGoogleTokens(email);
  if (!tokens) return null;

  // No access token at all → must refresh.
  if (!tokens.access) return refreshGoogleToken(email);

  // Expiry unknown → optimistically use existing token; caller sees 401 if expired.
  if (!tokens.expiry) return tokens.access;

  const expiry = new Date(tokens.expiry).getTime();
  if (Date.now() > expiry - REFRESH_WINDOW_MS) return refreshGoogleToken(email);

  return tokens.access;
}

/**
 * st_bf4978b0 AC4 — proactively refresh every Google token near expiry, before
 * it lapses. Called on the 15-minute integration-monitor cadence. A genuine
 * external revocation (invalid_grant / provider-side password reset) is handled
 * inside refreshGoogleToken: it clears the dead tokens and flips the account to
 * needs_reauth (→ Issue + reconnect), so the loop surfaces it rather than
 * silently dying. Never throws — one bad account must not stall the sweep.
 * @param {{ withinMs?: number }} [opts]
 * @returns {Promise<Array<{email:string, refreshed:boolean, error?:string, reason?:string}>>}
 */
export async function refreshExpiringGoogleTokens({ withinMs = PROACTIVE_REFRESH_MS } = {}) {
  const results = [];
  for (const email of listConnectedGoogleAccounts()) {
    const tokens = getGoogleTokens(email);
    if (!tokens?.refresh) { results.push({ email, refreshed: false, reason: 'no_refresh_token' }); continue; }
    const expiryMs = tokens.expiry ? new Date(tokens.expiry).getTime() : NaN;
    const dueForRefresh = !Number.isFinite(expiryMs) || (expiryMs - Date.now()) < withinMs;
    if (!dueForRefresh) { results.push({ email, refreshed: false, reason: 'not_due' }); continue; }
    try {
      await refreshGoogleToken(email);
      // A successful refresh is a live verification of the connection — stamp
      // verified_at on the account's product health rows so the card stays green.
      for (const job of ['gmail', 'calendar', 'drive', 'contacts']) {
        try { recordLiveVerification(db, `${job}:${email}`); } catch { /* best-effort */ }
      }
      results.push({ email, refreshed: true });
    } catch (err) {
      results.push({ email, refreshed: false, error: err?.message || 'refresh failed' });
    }
  }
  return results;
}

export function listConnectedGoogleAccounts() {
  // Accounts table is the canonical list — Keychain has the tokens, but the
  // accounts row created at callback time is the only discoverable index
  // without `security dump-keychain` (which requires interactive unlock on
  // macOS 13+).
  try {
    return db.prepare(
      `SELECT DISTINCT email
         FROM accounts
        WHERE vendor = 'google'
          AND status IN ('active', 'connected')
          AND email IS NOT NULL
        ORDER BY email`
    ).all().map(r => r.email);
  } catch {
    return [];
  }
}
