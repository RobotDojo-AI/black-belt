/**
 * Microsoft Graph auth.
 *
 * Launch path: tenant-admin application credentials stored in Keychain,
 * then mailbox rows are added locally. Legacy delegated OAuth remains for
 * installs that already have robotdojo-oauth-microsoft-* tokens.
 *
 * Scopes: Mail.Read Calendars.Read User.Read offline_access
 * Token URL: https://login.microsoftonline.com/common/oauth2/v2.0/token
 */
import { secret } from './config.js';
import db from './db.js';
import { deleteKeychainSecret, readKeychainSecret, writeKeychainSecret } from './keychain.js';
import { recordLiveVerification } from './integration-status.js';

// st_bf4978b0 AC4 — proactive refresh window (env-overridable), wider than the
// reactive 5-min window in getValidMicrosoftAccessToken.
const MS_PROACTIVE_REFRESH_MS = Number(process.env.ROBOTDOJO_PROACTIVE_REFRESH_MS) > 0
  ? Number(process.env.ROBOTDOJO_PROACTIVE_REFRESH_MS)
  : 30 * 60_000;

function microsoftTenant() {
  return secret('MICROSOFT_TENANT_ID') || 'common';
}

function tokenUrl() {
  return `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/token`;
}

export const AUTH_URL = `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/authorize`;
export const SCOPES = 'Mail.Read Calendars.Read User.Read offline_access';

const memoryTokens = new Map();
const memoryRegistry = new Set();

function useMemoryTokenStore() {
  return process.env.ROBOTDOJO_OAUTH_TEST_MEMORY_STORE === '1';
}

// ── Keychain helpers ──────────────────────────────────────────────────────────

function keychainWrite(service, value) {
  if (!writeKeychainSecret(service, value)) throw new Error(`Keychain write failed: ${service}`);
}

function keychainRead(service) {
  return readKeychainSecret(service);
}

function keychainDelete(service) {
  deleteKeychainSecret(service);
}

function svcAccess(email) { return `robotdojo-oauth-microsoft-access-${email}`; }
function svcRefresh(email) { return `robotdojo-oauth-microsoft-refresh-${email}`; }
function svcExpiry(email) { return `robotdojo-oauth-microsoft-expiry-${email}`; }

// ── Registry — which accounts are connected ───────────────────────────────────
// Stored as a JSON array of email strings under a single Keychain entry.

const REGISTRY_SVC = 'robotdojo-oauth-microsoft-accounts';

function readRegistry() {
  if (useMemoryTokenStore()) return [...memoryRegistry];
  const raw = keychainRead(REGISTRY_SVC);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function writeRegistry(emails) {
  if (useMemoryTokenStore()) {
    memoryRegistry.clear();
    for (const email of emails) memoryRegistry.add(email);
    return;
  }
  keychainWrite(REGISTRY_SVC, JSON.stringify(emails));
}

function registerAccount(email) {
  const list = readRegistry();
  if (!list.includes(email)) {
    list.push(email);
    writeRegistry(list);
  }
}

function unregisterAccount(email) {
  const list = readRegistry().filter(e => e !== email);
  writeRegistry(list);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getMicrosoftTokens(email) {
  if (useMemoryTokenStore()) return memoryTokens.get(email) || null;
  const access = keychainRead(svcAccess(email));
  const refresh = keychainRead(svcRefresh(email));
  const expiry = keychainRead(svcExpiry(email));
  if (!access && !refresh) return null;
  return { access, refresh, expiry };
}

export function storeMicrosoftTokens(email, { access, refresh, expiry }) {
  if (useMemoryTokenStore()) {
    memoryTokens.set(email, { access, refresh, expiry });
    registerAccount(email);
    return;
  }
  if (access) keychainWrite(svcAccess(email), access);
  if (refresh) keychainWrite(svcRefresh(email), refresh);
  if (expiry) keychainWrite(svcExpiry(email), typeof expiry === 'string' ? expiry : expiry.toISOString());
  registerAccount(email);
}

export function deleteMicrosoftTokens(email) {
  if (useMemoryTokenStore()) {
    memoryTokens.delete(email);
    unregisterAccount(email);
    return;
  }
  keychainDelete(svcAccess(email));
  keychainDelete(svcRefresh(email));
  keychainDelete(svcExpiry(email));
  unregisterAccount(email);
}

export async function refreshMicrosoftToken(email) {
  const tokens = getMicrosoftTokens(email);
  if (!tokens?.refresh) throw new Error(`No refresh token for ${email}`);

  const clientId = secret('MICROSOFT_CLIENT_ID');
  const clientSecret = secret('MICROSOFT_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET not configured');

  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh,
      grant_type: 'refresh_token',
      scope: SCOPES,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text();
    // st_d142f701 AC2: surface invalid_grant as needs_reauth.
    // Microsoft v2.0 token endpoint returns `{"error":"invalid_grant", ...}`
    // when the refresh token has been revoked (sign-in changed, conditional
    // access policy, MFA reset). Same JSON-only check as Google to avoid
    // misclassifying transient 5xx pages as a permanent revocation.
    let isInvalidGrant = false;
    try {
      const parsed = JSON.parse(body);
      isInvalidGrant = parsed?.error === 'invalid_grant';
    } catch { /* non-JSON body — treat as transient */ }

    if (isInvalidGrant) {
      try {
        deleteMicrosoftTokens(email);
      } catch (cleanupErr) {
        console.warn(`[microsoft-oauth] keychain cleanup failed for ${email}: ${cleanupErr.message}`);
      }
      try {
        db.prepare(
          `UPDATE accounts SET status='needs_reauth', last_error=? WHERE vendor='microsoft' AND email=?`
        ).run('invalid_grant', email);
      } catch (dbErr) {
        console.warn(`[microsoft-oauth] needs_reauth flag failed for ${email}: ${dbErr.message}`);
      }
    }
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
  storeMicrosoftTokens(email, {
    access: data.access_token,
    refresh: data.refresh_token ?? tokens.refresh,
    expiry,
  });
  try {
    db.prepare(
      `UPDATE accounts
          SET status='active', last_error=NULL, updated_at=datetime('now')
        WHERE vendor='microsoft' AND email=?`
    ).run(email);
  } catch (dbErr) {
    console.warn(`[microsoft-oauth] account revive failed for ${email}: ${dbErr.message}`);
  }
  return data.access_token;
}

/**
 * st_bf4978b0 AC4 — proactively refresh delegated Microsoft tokens near expiry.
 * App-credential-only mailboxes have no per-user refresh token (getMicrosoftTokens
 * returns null) and are skipped — their liveness rides the client-credentials
 * cache. A genuine invalid_grant flips the account to needs_reauth inside
 * refreshMicrosoftToken (→ Issue + reconnect). Never throws.
 * @param {{ withinMs?: number }} [opts]
 * @returns {Promise<Array<{email:string, refreshed:boolean, error?:string, reason?:string}>>}
 */
export async function refreshExpiringMicrosoftTokens({ withinMs = MS_PROACTIVE_REFRESH_MS } = {}) {
  const results = [];
  const emails = new Set(listConnectedMicrosoftAccounts());
  for (const email of emails) {
    const tokens = getMicrosoftTokens(email);
    if (!tokens?.refresh) { results.push({ email, refreshed: false, reason: 'no_delegated_refresh_token' }); continue; }
    const expiryMs = tokens.expiry ? new Date(tokens.expiry).getTime() : NaN;
    const dueForRefresh = !Number.isFinite(expiryMs) || (expiryMs - Date.now()) < withinMs;
    if (!dueForRefresh) { results.push({ email, refreshed: false, reason: 'not_due' }); continue; }
    try {
      await refreshMicrosoftToken(email);
      for (const job of ['microsoft-mail', 'microsoft-calendar']) {
        try { recordLiveVerification(db, `${job}:${email}`); } catch { /* best-effort */ }
      }
      results.push({ email, refreshed: true });
    } catch (err) {
      results.push({ email, refreshed: false, error: err?.message || 'refresh failed' });
    }
  }
  return results;
}

export async function getValidMicrosoftAccessToken(email) {
  const tokens = getMicrosoftTokens(email);
  if (!tokens) return getClientCredentialsToken();
  if (!tokens.access && tokens.refresh) return refreshMicrosoftToken(email);
  if (!tokens.access) return getClientCredentialsToken();

  if (tokens.expiry) {
    const expiresAt = new Date(tokens.expiry).getTime();
    if (Date.now() >= expiresAt - 5 * 60_000) {
      try {
        return await refreshMicrosoftToken(email);
      } catch (err) {
        if (secret('MICROSOFT_TENANT_ID') && secret('MICROSOFT_CLIENT_ID') && secret('MICROSOFT_CLIENT_SECRET')) {
          return getClientCredentialsToken();
        }
        throw err;
      }
    }
  }

  return tokens.access;
}

// Client credentials cache — keyed by tenant, expires 5 min before token expiry.
// This is the launch path for Microsoft: tenant-admin Graph application
// permissions + manually-added mailbox rows. Delegated OAuth remains only for
// legacy installs that already have refresh tokens.
const _ccCache = {};

export async function getClientCredentialsToken() {
  const tenant       = secret('MICROSOFT_TENANT_ID');
  const clientId     = secret('MICROSOFT_CLIENT_ID');
  const clientSecret = secret('MICROSOFT_CLIENT_SECRET');
  if (!tenant || !clientId || !clientSecret) {
    throw new Error('MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET not configured');
  }

  const cacheKey = `${tenant}:${clientId}`;
  const cached = _ccCache[cacheKey];
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         'https://graph.microsoft.com/.default',
      grant_type:    'client_credentials',
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Client credentials token failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  _ccCache[cacheKey] = {
    token:     data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  };
  return data.access_token;
}

export function decodeMicrosoftTokenRoles(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return [];
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const roles = Array.isArray(decoded.roles) ? decoded.roles : [];
    const scopes = typeof decoded.scp === 'string' ? decoded.scp.split(/\s+/).filter(Boolean) : [];
    return [...new Set([...roles, ...scopes])];
  } catch {
    return [];
  }
}

export async function getMicrosoftAppRoles() {
  const token = await getClientCredentialsToken();
  return decodeMicrosoftTokenRoles(token);
}

export function microsoftRolesSupport(roles = []) {
  const set = new Set(roles);
  return {
    mail: ['Mail.Read', 'Mail.ReadWrite'].some((role) => set.has(role)),
    calendar: ['Calendars.Read', 'Calendars.ReadWrite'].some((role) => set.has(role)),
  };
}

export function listConnectedMicrosoftAccounts(type = null) {
  const emails = new Set();
  try {
    const clause = type ? "AND type=?" : "AND type IN ('email','calendar')";
    const params = type ? [type] : [];
    const rows = db.prepare(
      `SELECT DISTINCT email FROM accounts WHERE vendor='microsoft' AND status IN ('active', 'connected') ${clause}`
    ).all(...params);
    for (const row of rows) {
      const email = String(row.email || '').trim().toLowerCase();
      if (email) emails.add(email);
    }
  } catch {}

  if (!type) {
    for (const email of readRegistry()) {
      const normalized = String(email || '').trim().toLowerCase();
      if (normalized) emails.add(normalized);
    }
  }

  return [...emails];
}

export async function exchangeCodeForTokens(code, redirectUri, codeVerifier) {
  if (process.env.ROBOTDOJO_MICROSOFT_OAUTH_MOCK) {
    return JSON.parse(process.env.ROBOTDOJO_MICROSOFT_OAUTH_MOCK);
  }
  const clientId = secret('MICROSOFT_CLIENT_ID');
  const clientSecret = secret('MICROSOFT_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET not configured');

  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
      scope: SCOPES,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  return res.json();
}
