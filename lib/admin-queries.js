/**
 * Data queries for routes/admin.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */

/**
 * Sets the belt_override for a session.
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} belt
 * @param {string} sessionId
 */
export function setBeltOverride(db, belt, sessionId) {
  return db.prepare(`UPDATE sessions SET belt_override = ? WHERE id = ?`).run(belt, sessionId);
}

/**
 * Returns the current belt_override for a session.
 * @param {import('better-sqlite3').Database} db
 * @param {string} sessionId
 * @returns {{ belt_override: string|null } | undefined}
 */
export function getBeltOverride(db, sessionId) {
  return db.prepare(`SELECT belt_override FROM sessions WHERE id = ?`).get(sessionId);
}
