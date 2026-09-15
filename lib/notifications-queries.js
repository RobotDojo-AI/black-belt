/**
 * Data queries for routes/notifications.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */

/**
 * Returns all unresolved file import errors, newest first.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{original_name, error_message, processed_at, path}>}
 */
export function listPendingErrors(db) {
  return db.prepare(
    `SELECT original_name, error_message, processed_at, path
       FROM drop_folder_files
      WHERE status = 'needs_user'
      ORDER BY processed_at DESC
      LIMIT 50`
  ).all();
}
