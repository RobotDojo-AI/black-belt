/**
 * Session management — HMAC-signed, HTTP-only cookies backed by SQLite.
 *
 * Cookie format: `base64url(JSON.stringify({sessionId,userId,slug,belt,expiresAt})).hmac`
 *   - The JSON payload is base64url-encoded (no padding).
 *   - The HMAC is SHA-256(payloadB64, SESSION_SECRET) in base64url.
 *
 * This format matches what Vercel middleware's verifyCookieSignature() expects.
 * The middleware validates the HMAC and reads slug+expiresAt from the payload
 * without hitting the DB — the SQLite lookup happens only on the Mac server.
 *
 * Expiry: 30 days. Rows older than that are deleted lazily during verify.
 * IPs are stored as SHA-256 hashes only.
 */

import crypto from 'node:crypto';
import db from './db.js';
import config from './config.js';
import { getUserById } from './magic-link.js';

export const COOKIE_NAME = 'rdj_session';
export const SESSION_TTL_DAYS = 30;
export const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 86400;
const SESSION_ID_BYTES = 32;
const DEFAULT_SESSION_BUSY_RETRY_MS = [50, 150, 400, 1000, 2000];
const DEFAULT_SESSION_CREATE_BUSY_RETRY_MS = [25, 75, 150, 300];
const PENDING_SESSION_FLUSH_RETRY_MS = [250, 1000, 2500, 5000, 10000, 30000, 60000];
const DEFAULT_SESSION_VERIFY_CACHE_TTL_MS = 30 * 86400 * 1000;

// --- Prepared statements -----------------------------------------------------

const insertSessionAt = db.prepare(`
  INSERT OR IGNORE INTO sessions (id, user_id, expires_at, user_agent, ip_hash)
  VALUES (?, ?, ?, ?, ?)
`);

const selectSession = db.prepare(`
  SELECT id, user_id, created_at, expires_at, belt_override
    FROM sessions
   WHERE id = ?
     AND expires_at > datetime('now')
`);

const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);
const deleteSessionsByUser = db.prepare(`DELETE FROM sessions WHERE user_id = ?`);

function configuredSessionBusyRetryMs() {
  return configuredRetryMs(process.env.ROBOTDOJO_SESSION_BUSY_RETRY_MS, DEFAULT_SESSION_BUSY_RETRY_MS);
}

function configuredSessionCreateBusyRetryMs() {
  return configuredRetryMs(process.env.ROBOTDOJO_SESSION_CREATE_BUSY_RETRY_MS, DEFAULT_SESSION_CREATE_BUSY_RETRY_MS);
}

function configuredRetryMs(raw, fallback) {
  if (!raw) return fallback;
  const parsed = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length ? parsed : fallback;
}

const SESSION_BUSY_RETRY_MS = configuredSessionBusyRetryMs();
const SESSION_CREATE_BUSY_RETRY_MS = configuredSessionCreateBusyRetryMs();

function configuredSessionVerifyCacheTtlMs() {
  const raw = Number(process.env.ROBOTDOJO_SESSION_VERIFY_CACHE_TTL_MS || '');
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SESSION_VERIFY_CACHE_TTL_MS;
}

const SESSION_VERIFY_CACHE_TTL_MS = configuredSessionVerifyCacheTtlMs();
const verifiedSessionCache = new Map();
const pendingSessions = new Map();

function isSessionBusyError(err) {
  const message = String(err?.message || err?.code || err || '');
  return err?.code === 'SQLITE_BUSY'
    || err?.code === 'SQLITE_LOCKED'
    || /SQLITE_(BUSY|LOCKED)|database is locked|database locked/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cachedSession(sessionId) {
  if (!SESSION_VERIFY_CACHE_TTL_MS || !sessionId) return null;
  const cached = verifiedSessionCache.get(sessionId);
  if (!cached) return null;
  const now = Date.now();
  if (cached.cacheExpiresAtMs <= now || cached.payloadExpiresAtMs <= now) {
    verifiedSessionCache.delete(sessionId);
    return null;
  }
  return { session: cached.session, user: cached.user };
}

function cacheSession(sessionId, payloadExpiresAtMs, session, user) {
  if (!SESSION_VERIFY_CACHE_TTL_MS || !sessionId || !session || !user) return;
  const now = Date.now();
  verifiedSessionCache.set(sessionId, {
    session,
    user,
    payloadExpiresAtMs,
    cacheExpiresAtMs: Math.min(now + SESSION_VERIFY_CACHE_TTL_MS, payloadExpiresAtMs),
  });
}

function clearCachedSession(sessionId) {
  if (sessionId) verifiedSessionCache.delete(sessionId);
}

function clearCachedSessionsForUser(userId) {
  for (const [sessionId, cached] of verifiedSessionCache.entries()) {
    if (String(cached?.user?.id) === String(userId)) verifiedSessionCache.delete(sessionId);
  }
}

async function runSessionWriteWithBusyRetry(fn, label, retryMs = SESSION_BUSY_RETRY_MS) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      if (!isSessionBusyError(err) || attempt >= retryMs.length) throw err;
      const waitMs = retryMs[attempt];
      console.warn(`[session] SQLITE_BUSY on ${label}; retry ${attempt + 1}/${retryMs.length} after ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}

function sqliteDateTime(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function pendingSession(sessionId, payloadExpiresAtMs) {
  const pending = pendingSessions.get(sessionId);
  if (!pending) return null;
  const now = Date.now();
  if (pending.payloadExpiresAtMs <= now || pending.payloadExpiresAtMs !== payloadExpiresAtMs) {
    pendingSessions.delete(sessionId);
    return null;
  }
  return { session: pending.session, user: pending.user };
}

function rememberPendingSession({ session, user, userAgent, ipHash, payloadExpiresAtMs }) {
  if (!session?.id || !user) return;
  pendingSessions.set(session.id, {
    session,
    user,
    userAgent,
    ipHash,
    payloadExpiresAtMs,
    flushAttempt: 0,
    flushTimer: null,
  });
  schedulePendingSessionFlush(session.id);
}

function schedulePendingSessionFlush(sessionId, delayMs = PENDING_SESSION_FLUSH_RETRY_MS[0]) {
  const pending = pendingSessions.get(sessionId);
  if (!pending || pending.flushTimer) return;
  pending.flushTimer = setTimeout(() => {
    pending.flushTimer = null;
    flushPendingSession(sessionId).catch((err) => {
      console.warn(`[session] pending session flush failed for ${sessionId}: ${err?.message || String(err)}`);
    });
  }, delayMs);
  pending.flushTimer.unref?.();
}

async function flushPendingSession(sessionId) {
  const pending = pendingSessions.get(sessionId);
  if (!pending) return false;
  if (pending.payloadExpiresAtMs <= Date.now()) {
    pendingSessions.delete(sessionId);
    return false;
  }
  try {
    await runSessionWriteWithBusyRetry(() => {
      insertSessionAt.run(
        pending.session.id,
        pending.session.user_id,
        pending.session.expires_at,
        pending.userAgent,
        pending.ipHash,
      );
    }, 'flushPendingSession');
    cacheSession(pending.session.id, pending.payloadExpiresAtMs, pending.session, pending.user);
    pendingSessions.delete(sessionId);
    return true;
  } catch (err) {
    if (!isSessionBusyError(err)) throw err;
    pending.flushAttempt += 1;
    const retryDelay = PENDING_SESSION_FLUSH_RETRY_MS[Math.min(pending.flushAttempt, PENDING_SESSION_FLUSH_RETRY_MS.length - 1)];
    schedulePendingSessionFlush(sessionId, retryDelay);
    return false;
  }
}

// --- HMAC signing ------------------------------------------------------------

function secretOrThrow() {
  const s = config.sessionSecret;
  if (!s) throw new Error('SESSION_SECRET not configured');
  return s;
}

function timingSafeEqual(a, b) {
  // st_d142f701 AC16 (adjacent pattern audit): same pad-to-equal-length
  // pattern as lib/auth.js#safeEqual. The earlier `if (ab.length !==
  // bb.length) return false` revealed length via the fast-return.
  const ab = Buffer.from(a || '', 'utf8');
  const bb = Buffer.from(b || '', 'utf8');
  const max = Math.max(ab.length, bb.length, 1);
  const ap = Buffer.alloc(max);
  const bp = Buffer.alloc(max);
  ab.copy(ap);
  bb.copy(bp);
  return crypto.timingSafeEqual(ap, bp) && ab.length === bb.length;
}

/**
 * Encode a session payload into the cookie format expected by Vercel middleware.
 * Pure function — no DB, no config reads. Secret is passed explicitly so tests
 * can call it without config wiring.
 */
export function encodeSessionCookieSync(payload, secret) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${hmac}`;
}

// --- IP hashing --------------------------------------------------------------

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip)).digest('hex');
}

import { ipFromHonoContext as ipFromRequest } from './ip.js';
import { resolveLoginServerName } from './device-name.js';

// --- Public API --------------------------------------------------------------

/**
 * Create a new session for `userId`. Returns `{ sessionId, cookieValue, expiresAt }`.
 * Callers typically hand `cookieValue` to Hono's `setCookie` with Secure + HttpOnly.
 */
export async function createSession(userId, c = null) {
  if (!userId) throw new Error('userId required');

  const sessionId = crypto.randomBytes(SESSION_ID_BYTES).toString('base64url');
  const userAgent = c ? (c.req.header('user-agent') || null) : null;
  const ipHash    = c ? hashIp(ipFromRequest(c))            : null;
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400 * 1000);
  const expiresAtSql = sqliteDateTime(expiresAt);
  const user = getUserById(userId);
  const pendingSessionRow = {
    id: sessionId,
    user_id: userId,
    created_at: sqliteDateTime(new Date()),
    expires_at: expiresAtSql,
    belt_override: null,
  };

  let persisted = true;
  try {
    await runSessionWriteWithBusyRetry(() => {
      insertSessionAt.run(sessionId, userId, expiresAtSql, userAgent, ipHash);
    }, 'createSession', SESSION_CREATE_BUSY_RETRY_MS);
  } catch (err) {
    if (!isSessionBusyError(err)) throw err;
    persisted = false;
    rememberPendingSession({
      session: pendingSessionRow,
      user,
      userAgent,
      ipHash,
      payloadExpiresAtMs: expiresAt.getTime(),
    });
    console.warn(`[session] createSession using pending session after SQLITE_BUSY; session=${sessionId}`);
  }

  // External routing uses the local device slug. User records can have their
  // own historical slug, but Vercel only needs to know which Mac to reach.
  const slug = resolveLoginServerName(user?.user_slug) || String(userId).slice(0, 8);
  const belt = user?.subscription_status || 'white';

  const cookieValue = encodeSessionCookieSync(
    { sessionId, userId, slug, belt, expiresAt: expiresAt.toISOString() },
    secretOrThrow()
  );

  const session = persisted ? selectSession.get(sessionId) : pendingSessionRow;
  if (session && user) cacheSession(sessionId, expiresAt.getTime(), session, user);

  return {
    sessionId,
    cookieValue,
    expiresAt,
    maxAgeSeconds: SESSION_TTL_SECONDS,
  };
}

/**
 * Verify a session cookie. Returns `{ session, user }` or `null`.
 * Rejects on bad signature, expired payload, missing DB row, or missing user.
 */
export function verifySession(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = cookieValue.slice(0, dot);
  const providedHmac = cookieValue.slice(dot + 1);
  if (!payloadB64 || !providedHmac) return null;

  let expectedHmac;
  try { expectedHmac = crypto.createHmac('sha256', secretOrThrow()).update(payloadB64).digest('base64url'); } catch { return null; }
  if (!timingSafeEqual(providedHmac, expectedHmac)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch { return null; }

  const { sessionId, expiresAt } = payload;
  if (!sessionId || !expiresAt) return null;
  const payloadExpiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(payloadExpiresAtMs) || payloadExpiresAtMs <= Date.now()) return null;

  const cached = cachedSession(sessionId);
  if (cached) return cached;

  const pending = pendingSession(sessionId, payloadExpiresAtMs);
  if (pending) return pending;

  const session = selectSession.get(sessionId);
  if (!session) return null;
  const user = getUserById(session.user_id);
  if (!user) return null;
  cacheSession(sessionId, payloadExpiresAtMs, session, user);
  return { session, user };
}

/**
 * Delete a session by ID (called on logout).
 */
export function destroySession(sessionId) {
  if (!sessionId) return 0;
  clearCachedSession(sessionId);
  pendingSessions.delete(sessionId);
  return deleteSession.run(sessionId).changes;
}

/**
 * Delete every session for a user. Used when login credentials rotate.
 */
export function destroySessionsForUser(userId) {
  if (!userId) return 0;
  clearCachedSessionsForUser(userId);
  for (const [sessionId, pending] of pendingSessions.entries()) {
    if (String(pending?.session?.user_id) === String(userId)) pendingSessions.delete(sessionId);
  }
  return deleteSessionsByUser.run(userId).changes;
}

/**
 * Extract the raw sessionId from a signed cookie value (for destroy).
 */
export function sessionIdFromCookie(cookieValue) {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0) return null;
  try {
    return JSON.parse(Buffer.from(cookieValue.slice(0, dot), 'base64url').toString()).sessionId || null;
  } catch { return null; }
}

/**
 * Default cookie options for setCookie. Callers may override.
 */
function cookieDomainFor(request = null) {
  const host = typeof request === 'string'
    ? request
    : request?.req?.header?.('host');
  const hostname = String(host || '').split(':')[0].toLowerCase();
  return hostname === 'robotdojo.ai' || hostname.endsWith('.robotdojo.ai')
    ? '.robotdojo.ai'
    : undefined;
}

export function cookieOptions(maxAgeSeconds = SESSION_TTL_SECONDS, request = null) {
  const domain = cookieDomainFor(request);
  const options = {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
  // Share across all *.robotdojo.ai subdomains only when the current request
  // is actually on that registrable domain. Local production installs run with
  // NODE_ENV=production on localhost; a .robotdojo.ai cookie is rejected there.
  if (domain) options.domain = domain;
  return options;
}

export const _sessionBusyRetryForTest = runSessionWriteWithBusyRetry;
export const _isSessionBusyErrorForTest = isSessionBusyError;
export const _clearSessionVerifyCacheForTest = () => verifiedSessionCache.clear();
export const _rememberPendingSessionForTest = rememberPendingSession;
export const _flushPendingSessionForTest = flushPendingSession;
export const _pendingSessionCountForTest = () => pendingSessions.size;
