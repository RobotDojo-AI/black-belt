import crypto from 'node:crypto';
import db from './db.js';
import config from './config.js';

const TOKEN_BYTES = 32;
const SLUG_HASH_BYTES = 4;

const selectUserByEmailHash = db.prepare(`SELECT * FROM users WHERE email_hash = ?`);
const selectUserBySlug = db.prepare(`SELECT * FROM users WHERE user_slug = ?`);
const selectUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users (email, email_hash, user_slug, tunnel_token, subscription_status, is_admin)
  VALUES (?, ?, ?, ?, 'none', ?)
`);
const countUsers = db.prepare(`SELECT COUNT(*) AS n FROM users`);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function randomUrlSafe(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Names that already exist (or may exist) as infrastructure records directly
// under robotdojo.ai — a per-user dojo hostname is `${slug}.robotdojo.ai`, so a
// slug equal to one of these would collide with the site/email/relay plumbing.
// Reserved (owner decision: users don't get to name their server these).
const RESERVED_SLUGS = new Set([
  'www', 'api', 'app', 'mail', 'send', 'smtp', 'imap', 'pop', 'mx', 'ns', 'ns1', 'ns2',
  'dojo', 'relay', 'connect', 'admin', 'root', 'ftp', 'cdn', 'static', 'assets',
  'blog', 'docs', 'status', 'dashboard', 'login', 'auth', 'account', 'accounts',
  'staging', 'dev', 'test', 'vercel', 'cloudflare', '_dmarc', 'autoconfig', 'autodiscover',
]);

/**
 * Validate an owner-proposed relay subdomain label (`${slug}.robotdojo.ai`).
 *
 * Pure string check — NO email, NO DB, NO network. Global uniqueness for the
 * hostname is enforced by CLOUDFLARE at provision time (the DNS record is global
 * in the shared zone), NEVER by a cross-user lookup here: a dojo only ever holds
 * its own single local user, so there is nothing to look up. This guard only
 * rejects malformed or infrastructure-reserved labels before we spend a
 * Cloudflare round-trip; a name that is well-formed but already taken elsewhere
 * comes back from Cloudflare as a 409.
 *
 * Rules: lowercase a–z / 0–9 / hyphen, 3–32 chars, no leading, trailing, or
 * double hyphen, and not one of RESERVED_SLUGS (site/email/relay infra names).
 *
 * @param {string} slug
 * @returns {{ ok: boolean, error?: string, slug?: string }} normalized slug when ok
 */
export function validateRelaySlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return { ok: false, error: 'Subdomain is required.' };
  if (s.length < 3 || s.length > 32) {
    return { ok: false, error: 'Use 3 to 32 characters.' };
  }
  if (!/^[a-z0-9-]+$/.test(s)) {
    return { ok: false, error: 'Use only lowercase letters, digits, and hyphens.' };
  }
  if (s.startsWith('-') || s.endsWith('-')) {
    return { ok: false, error: 'Cannot start or end with a hyphen.' };
  }
  if (s.includes('--')) {
    return { ok: false, error: 'No double hyphens.' };
  }
  if (RESERVED_SLUGS.has(s)) {
    return { ok: false, error: `"${s}" is reserved. Pick another.` };
  }
  return { ok: true, slug: s };
}

function baseSlugFromEmail(email) {
  const local = email.split('@')[0];
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'dojo';
  // Never hand out an infra name as a dojo hostname.
  return RESERVED_SLUGS.has(base) ? `${base}-dojo` : base;
}

export function hashEmail(email) {
  const s = config.sessionSecret;
  if (!s || Buffer.from(s).length < 32) {
    throw new Error('SESSION_SECRET must be ≥32 bytes to hash email addresses');
  }
  return crypto.createHmac('sha256', s)
    .update(normalizeEmail(email))
    .digest('hex');
}

export function generateUserSlug(email) {
  const base = baseSlugFromEmail(email);
  for (let i = 0; i < 8; i++) {
    const suffix = crypto.randomBytes(SLUG_HASH_BYTES).toString('hex');
    const slug = `${base}-${suffix}`;
    if (!selectUserBySlug.get(slug)) return slug;
  }
  throw new Error('Could not generate unique user_slug');
}

export function generateTunnelToken() {
  return randomUrlSafe(TOKEN_BYTES);
}

export function findOrCreateUser(email) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    throw new Error('Invalid email');
  }
  const emailHash = hashEmail(normalized);
  const existing = selectUserByEmailHash.get(emailHash);
  if (existing) return existing;

  const slug = generateUserSlug(normalized);
  const tunnelToken = generateTunnelToken();
  const isAdmin = countUsers.get().n === 0 ? 1 : 0;
  insertUser.run(emailHash, emailHash, slug, tunnelToken, isAdmin);
  return selectUserByEmailHash.get(emailHash);
}

export function createUserFromEmailHash(emailHash, slugSeed = 'user') {
  const normalizedHash = String(emailHash || '').trim();
  const existing = selectUserByEmailHash.get(normalizedHash);
  if (existing) return existing;
  const slug = generateUserSlug(slugSeed);
  const tunnelToken = generateTunnelToken();
  const isAdmin = countUsers.get().n === 0 ? 1 : 0;
  insertUser.run(normalizedHash, normalizedHash, slug, tunnelToken, isAdmin);
  return selectUserByEmailHash.get(normalizedHash);
}

export function getUserById(id) {
  return id != null ? selectUserById.get(id) : null;
}

export function getUserByEmailHash(emailHash) {
  return selectUserByEmailHash.get(emailHash);
}

export function getUserByEmail(email) {
  return selectUserByEmailHash.get(hashEmail(normalizeEmail(email)));
}
