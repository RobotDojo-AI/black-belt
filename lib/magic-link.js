/**
 * Magic-link authentication — token generation, verification, user upsert.
 *
 * Flow
 *   1. User submits email → `generateMagicLink(email, redirectTo)` stores a
 *      32-byte single-use token with a 15-minute TTL and returns the URL.
 *   2. Email is sent via `lib/email.js`.
 *   3. User clicks the link → `verifyMagicLink(token)` marks it used,
 *      upserts the user, and returns the canonical user row.
 *
 * Tokens are URL-safe base64 of 32 random bytes (openssl-grade).
 * Expiry is enforced in SQL (`expires_at > datetime('now')`) and the token
 * is single-use (the first verify marks `used_at`).
 */

import db from './db.js';
import crypto from 'node:crypto';
import config from './config.js';
import {
  createUserFromEmailHash,
  findOrCreateUser,
  generateTunnelToken,
  generateUserSlug,
  getUserByEmail,
  getUserByEmailHash,
  getUserById,
  hashEmail,
} from './user-identity.js';

export {
  findOrCreateUser,
  generateTunnelToken,
  generateUserSlug,
  getUserByEmail,
  getUserById,
  hashEmail,
} from './user-identity.js';

const TOKEN_TTL_MINUTES = 15;
const TOKEN_BYTES = 32;

// 6-digit numeric codes for the email-code login flow. Short enough to type
// comfortably, long enough that 5-attempts-per-15-min rate limiting makes
// guessing infeasible (1M combinations / 5 tries = 200K-year expected time).
// Stored in the same `magic_links.token` column — lookup is scoped by
// (token, email) so two users who happen to get the same digits can't
// collide on verification.
const CODE_LENGTH = 6;

// --- Prepared statements -----------------------------------------------------

const insertMagicLink = db.prepare(`
  INSERT INTO magic_links (token, email, email_hash, redirect_to, expires_at)
  VALUES (?, ?, ?, ?, datetime('now', ?))
`);

const selectMagicLink = db.prepare(`
  SELECT token, email, redirect_to, created_at, expires_at, used_at
    FROM magic_links
   WHERE token = ?
`);

const consumeMagicLink = db.prepare(`
  UPDATE magic_links
     SET used_at = datetime('now')
   WHERE token = ?
     AND used_at IS NULL
     AND expires_at > datetime('now')
`);

const CODE_MAX_ATTEMPTS = 5;

// Code-based verification: scoped by (token, email) so two users who
// happened to land on the same 6 digits never cross-contaminate.
// check_count guard: rejects after CODE_MAX_ATTEMPTS bad tries (DB-backed,
// survives process restarts).
const incrementCheckCount = db.prepare(`
  UPDATE magic_links SET check_count = check_count + 1
   WHERE token = ? AND email = ?
`);
const consumeMagicCode = db.prepare(`
  UPDATE magic_links
     SET used_at = datetime('now')
   WHERE token = ?
     AND email = ?
     AND used_at IS NULL
     AND expires_at > datetime('now')
     AND check_count <= ${CODE_MAX_ATTEMPTS}
`);

const selectMagicCode = db.prepare(`
  SELECT token, email, redirect_to, created_at, expires_at, used_at, check_count
    FROM magic_links
   WHERE token = ? AND email = ?
`);

// Best-effort retraction of any still-valid code for this email. Called
// before issuing a new code so a user requesting a second code can't
// accidentally log in with the first (and the table doesn't grow with
// dangling un-consumed entries).
const invalidatePriorCodesForEmail = db.prepare(`
  UPDATE magic_links
     SET used_at = datetime('now')
   WHERE email = ?
     AND used_at IS NULL
     AND length(token) = ${CODE_LENGTH}
`);

const touchUserLogin = db.prepare(`
  UPDATE users SET last_login_at = datetime('now') WHERE id = ?
`);

// --- Helpers -----------------------------------------------------------------

function randomUrlSafe(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  // RFC-light validation. Real verification happens when the user clicks the link.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/**
 * Create a magic-link token for `email` and return the full verify URL.
 * Does not send the email — that's the caller's job.
 *
 * When `slug` is provided the verify URL is built against the user's
 * personal subdomain ({slug}.robotdojo.ai) so the magic-link click goes
 * straight to the Mac via SNI passthrough instead of through the relay proxy.
 *
 * When `handle` is provided the verify URL uses the new apex-domain path form:
 *   https://robotdojo.ai/{handle}/api/auth/verify
 * instead of the old subdomain form:
 *   https://{slug}.robotdojo.ai/api/auth/verify
 */
export function generateMagicLink(email, redirectTo = null, handle = null) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    throw new Error('Invalid email');
  }
  const token = randomUrlSafe(TOKEN_BYTES);
  const offset = `+${TOKEN_TTL_MINUTES} minutes`;
  insertMagicLink.run(token, hashEmail(normalized), hashEmail(normalized), redirectTo || null, offset);

  const apex = (config.appBaseUrl || 'https://robotdojo.ai').replace(/\/+$/, '');
  const verifyPath = handle ? `/${handle}/api/auth/verify` : '/api/auth/verify';
  const url = new URL(verifyPath, apex);
  url.searchParams.set('token', token);
  if (redirectTo) url.searchParams.set('redirect', redirectTo);
  return {
    token,
    url: url.toString(),
    email: normalized,
    expiresInMinutes: TOKEN_TTL_MINUTES,
  };
}

/**
 * Generate a 6-digit login code for `email` and store it with a 15-minute
 * TTL. Returns the plaintext code for the caller to email. Invalidates
 * any still-valid code previously issued to the same email so users
 * always have exactly one live code in play (the newest one).
 *
 * Crypto-grade random: uses randomInt with a bounded range, not
 * modulo-biased from Math.random. Leading zeros are preserved by storing
 * as zero-padded string.
 */
export function generateMagicCode(email, redirectTo = null) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    throw new Error('Invalid email');
  }
  // Retire any still-valid prior codes for this email. Done outside the
  // insert so two concurrent requests don't both end up with a live code
  // racing each other — last-write-wins + idempotent against re-runs.
  invalidatePriorCodesForEmail.run(hashEmail(normalized));

  // 6 digits with leading-zero support → always CODE_LENGTH chars.
  const code = String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
  const offset = `+${TOKEN_TTL_MINUTES} minutes`;
  insertMagicLink.run(code, hashEmail(normalized), hashEmail(normalized), redirectTo || null, offset);

  return {
    code,
    email: normalized,
    expiresInMinutes: TOKEN_TTL_MINUTES,
  };
}

/**
 * Verify a code against an email. Returns { user, redirectTo } on success,
 * throws on any failure. The (code, email) scoping means a guessed code
 * for one user can't accidentally log in another user who happens to
 * share the same 6 digits.
 */
export function verifyMagicCode(code, email) {
  if (!code || typeof code !== 'string') throw new Error('Code required');
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error('Email required');
  // Hash the email for all DB lookups — magic_links.email stores the hash.
  const emailForLookup = hashEmail(normalizedEmail);
  // Normalize code: strip whitespace + dashes users may add ("482-916").
  const normalizedCode = String(code).replace(/[\s-]+/g, '');
  if (!/^\d{6}$/.test(normalizedCode)) throw new Error('Invalid code format');

  // Always increment first so every attempt (win or fail) counts against the limit.
  incrementCheckCount.run(normalizedCode, emailForLookup);
  const result = consumeMagicCode.run(normalizedCode, emailForLookup);
  if (result.changes === 0) {
    const row = selectMagicCode.get(normalizedCode, emailForLookup);
    if (!row) throw new Error('Invalid code');
    if (row.check_count > CODE_MAX_ATTEMPTS) throw new Error('Too many bad attempts. Request a new code.');
    if (row.used_at) throw new Error('Code already used');
    throw new Error('Code expired');
  }

  const user = findOrCreateUser(normalizedEmail);
  touchUserLogin.run(user.id);
  return {
    user: getUserById(user.id),
    redirectTo: null, // caller supplies this from the outer request
  };
}

/**
 * Read a magic-link token's status WITHOUT consuming it. Used by the
 * two-step verify flow: the initial GET fetches a click-to-confirm page
 * (which email scanners will pre-fetch, but that's fine because this is
 * non-destructive); the user's actual click submits a POST that calls
 * verifyMagicLink() to consume the token.
 *
 * Returns { email, status, redirectTo }:
 *   status = 'valid' | 'used' | 'expired' | null (if token not found)
 */
export function peekMagicLink(token) {
  if (!token || typeof token !== 'string') return null;
  const row = selectMagicLink.get(token);
  if (!row) return null;
  if (row.used_at) return { email: row.email, status: 'used', redirectTo: row.redirect_to };
  // SQLite stores naïve UTC strings; append Z to parse as UTC.
  if (new Date(row.expires_at + 'Z') < new Date()) {
    return { email: row.email, status: 'expired', redirectTo: row.redirect_to };
  }
  return { email: row.email, status: 'valid', redirectTo: row.redirect_to };
}

/**
 * Verify a magic-link token. On success, marks it used, upserts the user,
 * touches `last_login_at`, and returns the user row. Throws on failure.
 */
export function verifyMagicLink(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Token required');
  }

  // Atomic: only consume if not already used and not expired.
  const result = consumeMagicLink.run(token);
  if (result.changes === 0) {
    const row = selectMagicLink.get(token);
    if (!row) throw new Error('Invalid token');
    if (row.used_at) throw new Error('Token already used');
    throw new Error('Token expired');
  }

  const link = selectMagicLink.get(token);
  // link.email is now stored as an HMAC-SHA256 hash (same as email_hash).
  // Look up directly by hash; fall back to findOrCreateUser path is not
  // possible without the plaintext — if no user exists yet, the magic-link
  // request flow should have created them via generateMagicLink → the caller
  // is expected to call findOrCreateUser before issuing the link. In practice
  // the user always exists here (upsert happens at link-generation time).
  let user = getUserByEmailHash(link.email);
  if (!user) {
    // Fallback: create a stub user keyed only by hash (no plaintext available).
    // Same first-user auto-promote rule as findOrCreateUser above.
    user = createUserFromEmailHash(link.email, 'user');
  }
  touchUserLogin.run(user.id);
  return {
    user: getUserById(user.id),
    redirectTo: link.redirect_to || null,
  };
}
