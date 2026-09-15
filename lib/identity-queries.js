/**
 * Data queries for routes/identity.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */

/**
 * Returns slug, email for the admin user.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ user_slug: string, email: string } | undefined}
 */
export function getAdminDeviceName(db) {
  return db.prepare('SELECT user_slug, email FROM users WHERE is_admin = 1 LIMIT 1').get();
}

/**
 * Returns the admin user's id only.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ id: number|string } | undefined}
 */
export function getAdminId(db) {
  return db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
}

/**
 * Returns the admin user's id, email, and user_slug.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ id: number|string, email: string, user_slug: string } | undefined}
 */
export function getAdminProfile(db) {
  return db.prepare('SELECT id, email, user_slug FROM users WHERE is_admin = 1 LIMIT 1').get();
}

/**
 * Inserts a pending_rename row with a 5-minute TTL.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} userId
 * @param {string} newSlug
 * @param {string} token - UUID
 */
export function insertPendingRename(db, userId, newSlug, token) {
  return db.prepare(`
    INSERT INTO pending_renames (user_id, new_slug, token, expires_at)
    VALUES (?, ?, ?, datetime('now', '+5 minutes'))
  `).run(String(userId), newSlug, token);
}

/**
 * Returns a pending_rename row by token + user_id, if not expired.
 * @param {import('better-sqlite3').Database} db
 * @param {string} token
 * @param {string|number} userId
 * @returns {{ id: number, new_slug: string } | undefined}
 */
export function getPendingRename(db, token, userId) {
  return db.prepare(`
    SELECT id, new_slug FROM pending_renames
    WHERE token = ? AND user_id = ? AND expires_at > datetime('now')
  `).get(token, String(userId));
}

/**
 * Executes the device rename transaction atomically:
 * - updates user_slug on the users row
 * - deletes all sessions for the user
 * - deletes the pending_rename row
 * @param {import('better-sqlite3').Database} db
 * @param {string} newSlug
 * @param {string|number} userId
 * @param {string|number} pendingId
 */
export function executeDeviceRenameTransaction(db, newSlug, userId, pendingId) {
  return db.transaction(() => {
    db.prepare('UPDATE users SET user_slug = ? WHERE id = ?').run(newSlug, userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM pending_renames WHERE id = ?').run(pendingId);
  })();
}
