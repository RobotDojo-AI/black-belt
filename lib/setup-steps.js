/**
 * Setup steps data layer — onboarding task tiles for White Belt distribution.
 *
 * Tracks which onboarding tiles a user has completed or dismissed. The tiles
 * render at the top of the /account integrations page and guide a stranger
 * through API-key + accounts setup. Dismissal persists in the DB (not
 * localStorage) so it survives page reloads, machine reboots, and DB rebuilds
 * inside the user's profile.
 *
 * Three default tiles seeded in lib/db.js (migrate 'seed-setup-steps'):
 *   1. integrate_accounts  — Google OAuth "proceed with caution" guidance
 *   2. installation_faq    — installation FAQ link
 *   3. assistant_intro     — @miyagi prompt
 *
 * Schema: lib/migrations/059_setup_steps.sql
 */

// Documented display order for the tiles. AC 6 in 00-scope.md fixes this order;
// getAll() returns rows in this order so the frontend doesn't need to know about it.
// WHY: the seed transaction insertion order matches but is not guaranteed by SQL.
// Returning ORDER BY a CASE expression on this list is the source of truth.
export const DEFAULT_STEP_ORDER = ['integrate_accounts', 'installation_faq', 'assistant_intro'];

/**
 * Return all setup_steps rows, optionally including dismissed entries.
 * Output is ordered to match DEFAULT_STEP_ORDER so callers can render
 * tiles top-to-bottom without an extra sort.
 *
 * @param {object} db - better-sqlite3 connection (injected, never module-level)
 * @param {object} [opts] - { includeDismissed: false }
 * @returns {Array<{step, completed_at, dismissed_at}>}
 */
export function getAll(db, opts = {}) {
  const includeDismissed = opts.includeDismissed === true;
  // WHY ORDER BY CASE: deterministic order matching the documented AC 6 sequence,
  // independent of insertion order in the migration.
  const sql = includeDismissed
    ? `SELECT step, completed_at, dismissed_at FROM setup_steps
         ORDER BY CASE step
           WHEN 'integrate_accounts' THEN 1
           WHEN 'installation_faq'   THEN 2
           WHEN 'assistant_intro'    THEN 3
           ELSE 5
         END`
    : `SELECT step, completed_at, dismissed_at FROM setup_steps
         WHERE dismissed_at IS NULL
         ORDER BY CASE step
           WHEN 'integrate_accounts' THEN 1
           WHEN 'installation_faq'   THEN 2
           WHEN 'assistant_intro'    THEN 3
           ELSE 5
         END`;
  return db.prepare(sql).all();
}

/**
 * Mark a setup step as dismissed. Idempotent — re-dismissing an already-
 * dismissed step returns truthy (the row was found). Returns null/false
 * when the step doesn't exist in the seed catalog.
 *
 * @param {object} db
 * @param {string} step - one of DEFAULT_STEP_ORDER
 * @returns {boolean} true on success, false on unknown step
 */
export function markDismissed(db, step) {
  // First: confirm the row exists. This separates "unknown step" (404) from
  // "already dismissed" (still 200) at the route layer.
  const existing = db.prepare('SELECT step FROM setup_steps WHERE step = ?').get(step);
  if (!existing) return false;
  db.prepare(
    'UPDATE setup_steps SET dismissed_at = ? WHERE step = ?'
  ).run(Date.now(), step);
  return true;
}

/**
 * Mark a setup step as completed. Idempotent — same shape as markDismissed.
 *
 * @param {object} db
 * @param {string} step
 * @returns {boolean}
 */
export function markComplete(db, step) {
  const existing = db.prepare('SELECT step FROM setup_steps WHERE step = ?').get(step);
  if (!existing) return false;
  db.prepare(
    'UPDATE setup_steps SET completed_at = ? WHERE step = ?'
  ).run(Date.now(), step);
  return true;
}

/**
 * Seed the three default rows. Idempotent via INSERT OR IGNORE — re-running
 * never overwrites a dismissed/completed row. Kept here in addition to the
 * inline db.js migration so call sites (tests, manual rebuilds) can reseed
 * explicitly without re-running every migration.
 *
 * @param {object} db
 */
export function seedDefaults(db) {
  const ins = db.prepare(
    'INSERT OR IGNORE INTO setup_steps (step, completed_at, dismissed_at) VALUES (?, NULL, NULL)'
  );
  const tx = db.transaction((steps) => { for (const s of steps) ins.run(s); });
  tx(DEFAULT_STEP_ORDER);
}
