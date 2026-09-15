/**
 * macOS permission detection — read-only probes for the onboarding UI.
 *
 * Strategy:
 *   Use file-descriptor readability probes against the local resources each
 *   permission gates. Never open protected Apple databases through SQLite from
 *   the server process. On macOS, a TCC-denied SQLite open can block inside
 *   the native driver and freeze the app.
 *
 * Hard rules:
 *   - Probes must NEVER throw. The polling endpoint calls these every 2s; one stray throw
 *     would 500 the page and freeze the wizard.
 *   - Cache results for 1 second to absorb burst calls during stage transitions.
 *
 * Bundle identifier: TCC tracks permissions per-binary by signing identity.
 * The stable Robot Dojo LaunchAgent runs through Node; the installer also
 * creates a named Robot Dojo helper so the setup UI can guide users toward a
 * friendlier permission target when macOS accepts it.
 */

import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();

const PERMISSIONS = ['full_disk', 'contacts', 'calendar', 'photos', 'reminders'];
const PROBE_TIMEOUT_MS = Number(process.env.ROBOTDOJO_MACOS_PERMISSION_PROBE_TIMEOUT_MS || 750);
const PROBE_SCRIPT = `
const fs = require('fs');
const mode = process.argv[1];
const path = process.argv[2];
try {
  if (mode === 'dir') {
    const s = fs.statSync(path);
    process.exit(s.isDirectory() ? 0 : 1);
  }
  const fd = fs.openSync(path, 'r');
  fs.closeSync(fd);
  process.exit(0);
} catch {
  process.exit(1);
}
`;

// 1-second result cache to throttle polling load.
let cache = { at: 0, value: null };
const CACHE_TTL_MS = 1000;

function canOpen(path) {
  try {
    if (!existsSync(path)) return false;
    const result = spawnSync(process.execPath, ['-e', PROBE_SCRIPT, 'file', path], {
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function canStatDirectory(path) {
  try {
    if (!existsSync(path)) return false;
    const result = spawnSync(process.execPath, ['-e', PROBE_SCRIPT, 'dir', path], {
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * For each permission we know one canonical resource the OS gates on it:
 *   - full_disk  → open iMessage chat.db (Library/Messages/chat.db) — only Full Disk grants it
 *   - contacts   → read AddressBook SQLite under Library/Application Support/AddressBook/
 *   - calendar   → read Calendar SQLite under Library/Calendars/
 *   - photos     → check existence of Photos.sqlite in the system Photo Library
 *   - reminders  → there's no clean read-only probe for Reminders without the EventKit API,
 *                  so we stat the EventKit container directory and treat existence + readability
 *                  as a positive signal. False positives are possible but the TCC path covers
 *                  the truthful answer when available; the probe is just a best-effort fallback.
 */
function probeFullDisk() {
  const path = resolve(HOME, 'Library/Messages/chat.db');
  return canOpen(path);
}

function probeContacts() {
  const sourcesDir = resolve(HOME, 'Library/Application Support/AddressBook/Sources');
  let dbPath = null;
  try {
    if (existsSync(sourcesDir)) {
      const sources = readdirSync(sourcesDir);
      for (const src of sources) {
        const candidate = resolve(sourcesDir, src, 'AddressBook-v22.abcddb');
        if (existsSync(candidate)) { dbPath = candidate; break; }
      }
    }
    if (!dbPath) {
      const direct = resolve(HOME, 'Library/Application Support/AddressBook/AddressBook-v22.abcddb');
      if (existsSync(direct)) dbPath = direct;
    }
  } catch {
    return false;
  }
  if (!dbPath) return false;
  return canOpen(dbPath);
}

function probeCalendar() {
  // Modern macOS (verified on Darwin 25): the CalendarAgent store lives in a
  // group container, NOT ~/Library/Calendars (which no longer exists). Check it
  // first so the permission probe actually detects Full Disk Access. st_fcdbe84f AC10.
  const groupStore = resolve(HOME, 'Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb');
  if (canOpen(groupStore)) return true;
  // Legacy layout: per-calendar *.calendar/Events.db or a Calendar Cache.
  const calDir = resolve(HOME, 'Library/Calendars');
  try {
    if (!existsSync(calDir)) return false;
    for (const entry of readdirSync(calDir)) {
      if (entry.endsWith('.calendar') && canOpen(resolve(calDir, entry, 'Events.db'))) return true;
    }
    if (canOpen(resolve(calDir, 'Calendar Cache'))) return true;
    if (canOpen(resolve(calDir, 'Calendar.sqlitedb'))) return true;
  } catch {
    return false;
  }
  return false;
}

function probePhotos() {
  // Default Photo Library location. Users can move it but ~99% leave it here.
  const photosDb = resolve(HOME, 'Pictures/Photos Library.photoslibrary/database/Photos.sqlite');
  return canOpen(photosDb);
}

function probeReminders() {
  // EventKit's local store. No clean SQL probe (encrypted SQLite + plist hybrid),
  // so we settle for "container exists and is statable".
  const dir = resolve(HOME, 'Library/Reminders');
  return canStatDirectory(dir);
}

const PROBES = {
  full_disk: probeFullDisk,
  contacts:  probeContacts,
  calendar:  probeCalendar,
  photos:    probePhotos,
  reminders: probeReminders,
};

/**
 * Public API. Returns `{ full_disk, contacts, calendar, photos, reminders }`
 * with boolean values. Cached for 1s to absorb polling bursts. Never throws.
 */
export function detectPermissions() {
  const now = Date.now();
  if (cache.value && now - cache.at < CACHE_TTL_MS) return cache.value;

  const result = {};
  for (const [key, fn] of Object.entries(PROBES)) {
    try { result[key] = !!fn(); }
    catch { result[key] = false; }
  }

  cache = { at: now, value: result };
  return result;
}

export function getCachedPermissions() {
  return cache.value || null;
}

/**
 * Permission watcher compatibility API. Unknown permission names are denied,
 * not thrown, because first-run onboarding should never fail closed from a UI
 * typo or a future permission key.
 */
export function checkPermission(name) {
  try {
    if (!PERMISSIONS.includes(name)) return false;
    return !!detectPermissions()[name];
  } catch {
    return false;
  }
}

/** Force-clear the 1s cache. Used by tests, never by hot paths. */
export function _resetPermissionCache() {
  cache = { at: 0, value: null };
}
