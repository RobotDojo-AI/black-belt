/**
 * apple-store-paths.js — pure path resolution for Apple local data stores.
 *
 * WHY a separate module (st_fd14cdd4): lib/integration-registry.js must stay
 * importable with zero heavy dependencies (no db.js, no config.js) so the
 * pre-commit contract check can load it without opening the database. The
 * reader modules (apple-{calendar,mail,calls,notes}-reader.js) import db.js at
 * module level, so the registry cannot import them for store-existence
 * conditions. These helpers are the single source of truth for store
 * locations; the readers re-export them for compatibility.
 *
 * CONTRACT: every helper returns an absolute path string when the store
 * exists on this machine, else null. No side effects, no caching — existence
 * is re-checked on every call because TCC grants and store creation happen
 * while the server is running.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Modern macOS keeps the CalendarAgent store in a group container; older
// layouts used ~/Library/Calendars. First hit wins.
const CALENDAR_STORE_CANDIDATES = [
  'Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb',
  'Library/Calendars/Calendar.sqlitedb',
];

/** Resolve the local Calendar store path, or null if none is present. */
export function appleCalendarStorePath(home = homedir()) {
  for (const rel of CALENDAR_STORE_CANDIDATES) {
    const p = resolve(home, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Locate the newest "Mail/V<n>/MailData/Envelope Index" store, or null. */
export function appleMailEnvelopePath(home = homedir()) {
  const mailRoot = resolve(home, 'Library/Mail');
  if (!existsSync(mailRoot)) return null;
  try {
    for (const v of readdirSync(mailRoot).filter((d) => /^V\d+$/.test(d)).sort().reverse()) {
      const ei = join(mailRoot, v, 'MailData', 'Envelope Index');
      if (existsSync(ei)) return ei;
    }
  } catch { /* unreadable Mail dir — treat as absent */ }
  return null;
}

const CALLS_STORE_REL = 'Library/Application Support/CallHistoryDB/CallHistory.storedata';

/** Resolve the local Call History store path, or null if none is present. */
export function appleCallStorePath(home = homedir()) {
  const p = resolve(home, CALLS_STORE_REL);
  return existsSync(p) ? p : null;
}

const NOTES_STORE_REL = 'Library/Group Containers/group.com.apple.notes/NoteStore.sqlite';

/** Resolve the local Notes store path, or null if none is present. */
export function appleNotesStorePath(home = homedir()) {
  const p = resolve(home, NOTES_STORE_REL);
  return existsSync(p) ? p : null;
}
