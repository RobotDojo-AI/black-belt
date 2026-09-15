/**
 * Data queries for routes/auth.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */

/**
 * Returns the rate limit row for a given key.
 * @param {import('better-sqlite3').Database} db
 * @param {string} key - e.g. "{ipHash}:{hourBucket}"
 * @returns {{ count: number } | undefined}
 */
export function getMagicLinkRate(db, key) {
  return db.prepare('SELECT count FROM magic_link_rate WHERE key = ?').get(key);
}

/**
 * Upserts (inserts or increments) the rate-limit counter for a key.
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {string} ipHash
 * @param {string} bucket
 */
export function upsertMagicLinkRate(db, key, ipHash, bucket) {
  return db.prepare(`
    INSERT INTO magic_link_rate (key, ip_hash, bucket, count, updated_at)
    VALUES (?, ?, ?, 1, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      count = count + 1,
      updated_at = datetime('now')
  `).run(key, ipHash, bucket);
}

/**
 * Returns the admin user's email_hash and user_slug.
 * Used for owner-email gate on magic-link / code requests.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ email_hash: string, user_slug: string } | undefined}
 */
export function getAdminEmailHash(db) {
  return db.prepare('SELECT email_hash, user_slug FROM users WHERE is_admin = 1 LIMIT 1').get();
}

/**
 * Returns the user_slug for the user matching the given email_hash.
 * @param {import('better-sqlite3').Database} db
 * @param {string} emailHash
 * @returns {{ user_slug: string } | undefined}
 */
export function getUserSlugByEmailHash(db, emailHash) {
  return db.prepare('SELECT user_slug FROM users WHERE email_hash = ? LIMIT 1').get(emailHash);
}

/**
 * Lightweight DB liveness check. Returns true if the DB responds.
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean}
 */
export function pingDb(db) {
  db.prepare('SELECT 1').get();
  return true;
}

/**
 * Returns the admin user's full row (for Bearer-token /me response).
 * @param {import('better-sqlite3').Database} db
 * @returns {object | undefined}
 */
export function getAdminUser(db) {
  return db.prepare('SELECT * FROM users WHERE is_admin = 1 LIMIT 1').get();
}

/**
 * Promotes a user row to admin/owner. Used by the owner-bootstrap fallback in
 * both local-session and token-paste login when the installer could not finish
 * the one-time browser handoff, so a freshly created owner still becomes admin.
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} userId
 */
export function promoteUserToAdmin(db, userId) {
  return db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);
}
