/**
 * Local macOS Calendar reader — st_fcdbe84f WS7 / AC10.
 *
 * Reads the on-device Calendar store (no network, no Google account) and upserts
 * events into calendar_events with source='apple-local'. This is the Apple-Suite
 * companion to the iMessage/Contacts readers: once a user grants Full Disk Access,
 * their local calendars (incl. subscribed and work calendars) flow in.
 *
 * Store location: modern macOS keeps the CalendarAgent store in a group
 * container; older layouts used ~/Library/Calendars. Dates are CFAbsoluteTime
 * (seconds since 2001-01-01 UTC), converted to ISO here. The full table is read
 * — no recent-window filter — so historical events back-populate.
 */
import Database from 'better-sqlite3';
import db from './db.js';
import { insertTimelineEventForDb } from './timeline-schema.js';

// CFAbsoluteTime epoch (2001-01-01) → Unix epoch (1970-01-01), in seconds.
const MAC_EPOCH_OFFSET = 978307200;

// EKEventStatus → calendar_events.status
const STATUS_MAP = { 0: 'confirmed', 1: 'confirmed', 2: 'tentative', 3: 'cancelled' };

// Store path resolution lives in lib/apple-store-paths.js (st_fd14cdd4 — the
// integration registry needs it without importing this module's db side).
// Re-exported for existing callers.
export { appleCalendarStorePath } from './apple-store-paths.js';
import { appleCalendarStorePath } from './apple-store-paths.js';

/** CFAbsoluteTime (seconds) → ISO 8601 string, or '' when missing/invalid. */
export function macAbsoluteToIso(macSeconds) {
  if (macSeconds == null || !Number.isFinite(macSeconds)) return '';
  const d = new Date((macSeconds + MAC_EPOCH_OFFSET) * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

const upsertEvent = db.prepare(`
  INSERT INTO calendar_events
    (id, calendar_id, summary, description, location, start_time, end_time,
     all_day, attendees, organizer, status, html_link, account_id, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '', ?, '', NULL, 'apple-local')
  ON CONFLICT(id) DO UPDATE SET
    summary     = excluded.summary,
    description = excluded.description,
    location    = excluded.location,
    start_time  = excluded.start_time,
    end_time    = excluded.end_time,
    all_day     = excluded.all_day,
    status      = excluded.status,
    calendar_id = excluded.calendar_id,
    source      = 'apple-local',
    synced_at   = datetime('now')
`);

/**
 * Read the local Calendar store and upsert events into calendar_events.
 * Read-only on the macOS store. Returns { synced, skipped, store, error? }.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.storePath]  override the store path (tests)
 * @param {import('better-sqlite3').Database} [opts.targetDb]  override write target (tests)
 */
export function syncAppleCalendar({ storePath = appleCalendarStorePath(), targetDb = db } = {}) {
  const stats = { synced: 0, skipped: 0, store: storePath };
  if (!storePath) {
    stats.error = 'no_local_calendar_store';
    return stats;
  }

  let src;
  try {
    src = new Database(storePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    stats.error = `open_failed: ${err.message}`;
    return stats;
  }

  const upsert = targetDb === db ? upsertEvent : targetDb.prepare(upsertEvent.source);

  try {
    // Calendar events have a start_date and a summary; skip hidden rows. We do
    // not filter on entity_type — its value varies by macOS version (observed 2
    // for events on Darwin 25) and reminders live in a separate Reminders store.
    const rows = src.prepare(`
      SELECT ci.ROWID AS rowid, ci.UUID AS uuid, ci.summary, ci.description,
             ci.start_date, ci.end_date, ci.all_day, ci.status,
             ci.calendar_id, c.title AS calendar_title
      FROM CalendarItem ci
      LEFT JOIN Calendar c ON ci.calendar_id = c.ROWID
      WHERE ci.summary IS NOT NULL
        AND ci.start_date IS NOT NULL
        AND (ci.hidden IS NULL OR ci.hidden = 0)
    `).all();

    const tx = targetDb.transaction(() => {
      for (const r of rows) {
        const start = macAbsoluteToIso(r.start_date);
        if (!start) { stats.skipped++; continue; }
        upsert.run(
          `apple:${r.uuid || r.rowid}`,
          r.calendar_title || String(r.calendar_id ?? 'local'),
          r.summary || '',
          r.description || '',
          '',
          start,
          macAbsoluteToIso(r.end_date),
          r.all_day ? 1 : 0,
          STATUS_MAP[r.status] ?? 'confirmed',
        );
        insertTimelineEventForDb(targetDb, {
          sourceType: 'calendar',
          sourceId: `apple:${r.uuid || r.rowid}`,
          eventDate: start,
          eventType: 'calendar',
          summary: r.summary || 'Calendar event',
          content: `${r.summary || ''}\n${r.calendar_title || ''}`,
          metadata: { source: 'apple-local', calendar_id: r.calendar_title || String(r.calendar_id ?? 'local') },
        });
        stats.synced++;
      }
    });
    tx();
  } catch (err) {
    stats.error = `read_failed: ${err.message}`;
  } finally {
    src.close();
  }

  return stats;
}
