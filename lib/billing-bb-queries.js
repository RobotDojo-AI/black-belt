/**
 * Data queries for routes/billing-bb.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */

/**
 * Returns the active (non-perpetual) subscription row for the user
 * identified by their subscription key hash.
 * @param {import('better-sqlite3').Database} db
 * @param {string} keyHash - SHA-256 hex of the bearer token
 * @returns {{ email: string, current_period_start: string } | undefined}
 */
export function getActiveSubscriptionByKeyHash(db, keyHash) {
  return db.prepare(`
    SELECT u.email, s.current_period_start
      FROM users u
      JOIN subscriptions s ON s.user_id = u.id
     WHERE u.encryption_key_hash = ?
       AND s.status = 'active'
       AND s.perpetual = 0
     ORDER BY s.started_at DESC
     LIMIT 1
  `).get(keyHash);
}
