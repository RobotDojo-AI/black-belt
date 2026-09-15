/**
 * DB query functions for routes/setup/
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */

/**
 * Returns the admin user's slug.
 * @param {import('better-sqlite3').Database} db
 * @returns {string|null}
 */
export function getAdminUserSlug(db) {
  try {
    const row = db.prepare('SELECT user_slug FROM users WHERE is_admin = 1 LIMIT 1').get();
    return row?.user_slug || null;
  } catch { return null; }
}

/**
 * Returns the admin user's id and handle.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ id: number, user_handle: string|null }|null}
 */
export function getAdminUserHandle(db) {
  try {
    return db.prepare('SELECT id, user_handle FROM users WHERE is_admin = 1 LIMIT 1').get() || null;
  } catch { return null; }
}

/**
 * Updates the user_handle for a user by id.
 * @param {import('better-sqlite3').Database} db
 * @param {string} handle
 * @param {number} userId
 */
export function setUserHandle(db, handle, userId) {
  db.prepare('UPDATE users SET user_handle = ? WHERE id = ?').run(handle, userId);
}

/**
 * Reads a user_setting value by key.
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @returns {string|null}
 */
export function readUserSetting(db, key) {
  try {
    const row = db.prepare('SELECT value FROM user_settings WHERE key = ?').get(key);
    return row?.value || null;
  } catch { return null; }
}

/**
 * Writes or updates a user_setting key/value.
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {string} value
 */
export function writeUserSetting(db, key, value) {
  db.prepare(
    `INSERT INTO user_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, String(value ?? ''));
}

/**
 * Checks if an accounts row exists for a given vendor + type with active status.
 * @param {import('better-sqlite3').Database} db
 * @param {string} vendor
 * @param {string} type
 * @returns {boolean}
 */
export function accountHasVendorType(db, vendor, type) {
  try {
    const row = db.prepare(
      `SELECT id FROM accounts WHERE vendor = ? AND type = ? AND status IN ('active', 'connected') LIMIT 1`
    ).get(vendor, type);
    return !!row;
  } catch { return false; }
}

/**
 * Safe single-value SELECT. Returns null if table/row missing.
 * Generic wrapper for use by setup/helpers.js thin wrapper.
 * @param {import('better-sqlite3').Database} db
 * @param {string} sql
 * @param {...*} params
 * @returns {*}
 */
export function safeGetQuery(db, sql, ...params) {
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

/**
 * Safe multi-value SELECT. Returns [] if table/row missing.
 * Generic wrapper for use by setup/helpers.js thin wrapper.
 * @param {import('better-sqlite3').Database} db
 * @param {string} sql
 * @param {...*} params
 * @returns {Array}
 */
export function safeAllQuery(db, sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

/**
 * Read the legacy user_settings.onboarding_stage value as an integer.
 * Returns null when absent or unparseable. Kept for back-compat during the
 * canonical-column migration (st_5a63545d): users.onboarding_stage is the
 * canonical home, but the helper still dual-writes user_settings so legacy
 * GETs that read from there keep working.
 * @param {import('better-sqlite3').Database} db
 * @returns {number|null}
 */
export function getOnboardingStageFromSettings(db) {
  try {
    const row = db.prepare("SELECT value FROM user_settings WHERE key='onboarding_stage'").get();
    if (!row?.value) return null;
    const n = parseInt(row.value, 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/**
 * Advance users.onboarding_stage for the admin user (single-owner install).
 * Idempotent: re-running with the same stage is a no-op.
 * @param {import('better-sqlite3').Database} db
 * @param {number} stage
 */
export function setAdminOnboardingStage(db, stage) {
  db.prepare("UPDATE users SET onboarding_stage = ? WHERE is_admin = 1").run(stage);
}
