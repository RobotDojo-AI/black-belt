/**
 * Data queries for routes/compiled.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */

const VIEW_TYPE = 'profile';

/**
 * Returns the cached compiled view for a person (if fresh).
 * @param {import('better-sqlite3').Database} db
 * @param {string} personId
 * @returns {{ content: string, compiled_at: string, stale: number } | null}
 */
export function getCachedView(db, personId) {
  return db.prepare(`
    SELECT content, compiled_at, stale FROM compiled_views
    WHERE entity_type = 'person' AND entity_id = ? AND view_type = ?
      AND stale = 0
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(personId, VIEW_TYPE) || null;
}

/**
 * Upserts a compiled view for a person.
 * @param {import('better-sqlite3').Database} db
 * @param {string} personId
 * @param {string} content
 * @param {string} model
 * @param {number} cacheTtlHours
 */
export function setCachedView(db, personId, content, model, cacheTtlHours = 24) {
  const expires = new Date(Date.now() + cacheTtlHours * 3_600_000).toISOString();
  return db.prepare(`
    INSERT INTO compiled_views (entity_type, entity_id, view_type, content, evidence_ids, compiled_at, stale, expires_at, model)
    VALUES ('person', ?, ?, ?, '[]', datetime('now'), 0, ?, ?)
    ON CONFLICT(entity_type, entity_id, view_type)
    DO UPDATE SET content=excluded.content, compiled_at=excluded.compiled_at,
                  stale=0, expires_at=excluded.expires_at, model=excluded.model
  `).run(personId, VIEW_TYPE, content, expires, model);
}

/**
 * Returns person data for signal gathering.
 * @param {import('better-sqlite3').Database} db
 * @param {string} personId
 */
export function getPersonWithCompany(db, personId) {
  return db.prepare(`
    SELECT p.*,
      (SELECT name FROM companies WHERE id = p.company_id LIMIT 1) as company_name
    FROM people p WHERE p.id = ?
  `).get(personId);
}

/**
 * Returns recent emails involving a given email address.
 * @param {import('better-sqlite3').Database} db
 * @param {string} emailPattern - LIKE pattern
 * @param {number} limit
 */
export function getRecentEmailsForPerson(db, emailPattern, limit = 8) {
  return db.prepare(`
    SELECT subject, from_name, to_names, date, snippet
    FROM emails
    WHERE from_email LIKE ? OR to_emails LIKE ?
    ORDER BY date DESC LIMIT ?
  `).all(emailPattern, emailPattern, limit);
}

/**
 * Returns recent iMessages for a person by their identifiers.
 * @param {import('better-sqlite3').Database} db
 * @param {string} personId
 * @param {number} limit
 */
export function getRecentMessagesForPerson(db, personId, limit = 10) {
  return db.prepare(`
    SELECT text, date, is_from_me
    FROM imessage_messages
    WHERE handle_id IN (
      SELECT handle_id FROM imessage_handles WHERE id IN (
        SELECT imessage_handle_id FROM person_identifiers WHERE person_id = ?
      )
    )
    ORDER BY date DESC LIMIT ?
  `).all(personId, limit);
}

/**
 * Returns recent calendar events involving a given email address.
 * @param {import('better-sqlite3').Database} db
 * @param {string} emailPattern - LIKE pattern
 * @param {number} limit
 */
export function getCalendarEventsForPerson(db, emailPattern, limit = 5) {
  return db.prepare(`
    SELECT title, start_date, end_date, attendees
    FROM calendar_events
    WHERE attendees LIKE ?
    ORDER BY start_date DESC LIMIT ?
  `).all(emailPattern, limit);
}

/**
 * Marks a person's compiled view as stale.
 * @param {import('better-sqlite3').Database} db
 * @param {string} personId
 */
export function invalidatePersonView(db, personId) {
  return db.prepare(`
    UPDATE compiled_views SET stale = 1
    WHERE entity_type = 'person' AND entity_id = ? AND view_type = ?
  `).run(personId, VIEW_TYPE);
}

/**
 * Returns count of non-stale compiled views and marks all as stale.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ count: number }}
 */
export function countAndInvalidateAllViews(db) {
  const { count } = db.prepare(`SELECT COUNT(*) as count FROM compiled_views WHERE stale = 0`).get();
  db.prepare(`UPDATE compiled_views SET stale = 1`).run();
  return { count };
}
