/**
 * Data queries for routes/account-prefs.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */

/**
 * Returns the receipt_email for a user's account preferences row.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} accountId
 * @returns {{ receipt_email: string|null } | undefined}
 */
export function getReceiptEmail(db, accountId) {
  return db.prepare(
    `SELECT receipt_email FROM account_preferences WHERE account_id = ? LIMIT 1`
  ).get(accountId);
}

/**
 * Upserts the receipt_email in account_preferences.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} accountId
 * @param {string} email
 */
export function upsertReceiptEmail(db, accountId, email) {
  return db.prepare(`
    INSERT INTO account_preferences (account_id, receipt_email, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET
      receipt_email = excluded.receipt_email,
      updated_at    = datetime('now')
  `).run(accountId, email);
}

/**
 * Updates the display_name for a user.
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} displayName
 * @param {string|number} userId
 */
export function updateDisplayName(db, displayName, userId) {
  return db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(displayName, userId);
}

/**
 * Updates the user-facing account name for a user. This is deliberately
 * separate from users.user_slug, which is the server/login name.
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 * @param {string|number} userId
 */
export function updateAccountName(db, name, userId) {
  return db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(name, userId);
}

/**
 * Updates the user's belt status.
 * @param {import('better-sqlite3').Database} db
 * @param {'white'|'black'} belt
 * @param {string|number} userId
 */
export function updateBeltStatus(db, belt, userId) {
  return db.prepare(`UPDATE users SET belt = ? WHERE id = ?`).run(belt, userId);
}
