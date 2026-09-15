/**
 * Data queries for routes/oauth.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */

import crypto from 'node:crypto';

/**
 * Upserts the three Google account rows (email, calendar, drive) for a user.
 * Updates display_name + status on conflict; inserts on new email.
 * @param {import('better-sqlite3').Database} db
 * @param {string} email
 * @param {string} displayName
 * @param {{metadata?: object}} [opts]
 */
export function upsertGoogleAccounts(db, email, displayName, opts = {}) {
  const hasMetadata = opts && Object.prototype.hasOwnProperty.call(opts, 'metadata');
  const metadataJson = hasMetadata ? JSON.stringify(opts.metadata || {}) : null;
  for (const type of ['email', 'calendar', 'drive']) {
    const existing = db.prepare(
      `SELECT id FROM accounts WHERE provider = 'google' AND type = ? AND email = ? LIMIT 1`
    ).get(type, email);
    if (existing) {
      if (hasMetadata) {
        db.prepare(
          `UPDATE accounts
              SET display_name = ?,
                  status = 'active',
                  last_error = NULL,
                  metadata = ?,
                  synced_at = NULL,
                  updated_at = datetime('now')
            WHERE id = ?`
        ).run(displayName, metadataJson, existing.id);
      } else {
        db.prepare(
          `UPDATE accounts
              SET display_name = ?,
                  status = 'active',
                  last_error = NULL,
                  synced_at = NULL,
                  updated_at = datetime('now')
            WHERE id = ?`
        ).run(displayName, existing.id);
      }
    } else {
      db.prepare(
        `INSERT INTO accounts (id, provider, vendor, type, email, display_name, status, metadata)
         VALUES (?, 'google', 'google', ?, ?, ?, 'active', ?)`
      ).run(crypto.randomUUID(), type, email, displayName, metadataJson || '{}');
    }
  }
}

/**
 * Upserts the Microsoft account rows (email, calendar) for a user.
 * Token storage lives in Keychain; account rows make the connection visible
 * to setup/account without forcing a sync during the OAuth callback.
 * @param {import('better-sqlite3').Database} db
 * @param {string} email
 * @param {string} displayName
 */
export function upsertMicrosoftAccounts(db, email, displayName, types = ['email', 'calendar']) {
  for (const type of types) {
    const existing = db.prepare(
      `SELECT id FROM accounts WHERE provider = 'microsoft' AND type = ? AND email = ? LIMIT 1`
    ).get(type, email);
    if (existing) {
      db.prepare(
        `UPDATE accounts
            SET display_name = ?, status = 'active', last_error = NULL, updated_at = datetime('now')
          WHERE id = ?`
      ).run(displayName, existing.id);
    } else {
      db.prepare(
        `INSERT INTO accounts (id, provider, vendor, type, email, display_name, status)
         VALUES (?, 'microsoft', 'microsoft', ?, ?, ?, 'active')`
      ).run(crypto.randomUUID(), type, email, displayName);
    }
  }
}
