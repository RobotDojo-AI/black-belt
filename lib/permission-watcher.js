/**
 * Permission Watcher — long-poll style.
 *
 * Polls macOS permission state every 5 s via `lib/macos-permissions.js`
 * (Ori's module). When a permission flips false → true, emits a
 * `permission.granted` event. Subscribers (ingest-orchestrator) decide
 * what to do.
 *
 * Lifecycle:
 *   start()  — begins polling. Idempotent. Self-stops once every tracked
 *              permission has flipped to true (no point polling further).
 *   stop()   — clears the interval. Safe to call from anywhere.
 *
 * Boot rule (enforced in index.js, not here): only start the watcher if
 * the active config dir's `.onboarded` sentinel is absent. Once the user finishes onboarding,
 * we don't need a permission cop running forever.
 *
 * Failure mode: if `lib/macos-permissions.js` doesn't exist yet (Ori's
 * still building it), the watcher logs once and stays idle. It does NOT
 * crash the server. When the module lands, restart the server to pick
 * it up — there's no point in dynamic re-import for a one-time onboarding
 * subsystem.
 *
 * Permissions tracked (must match keys in PERMISSION_TO_PHASE in
 * ingest-orchestrator.js):
 *   - contacts
 *   - calendar
 *   - full_disk     (iMessage SQLite + Contacts SQLite)
 *
 * Photos and Reminders are listed in the onboarding flow but currently
 * have no ingest phase wired, so we don't track them here. Add them when
 * a phase exists.
 */

import { EventEmitter } from 'node:events';

// --- Config ----------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000;
const TRACKED_PERMISSIONS = ['contacts', 'calendar', 'full_disk'];

// --- Event bus -------------------------------------------------------------

export const events = new EventEmitter();
events.setMaxListeners(20);

// --- State -----------------------------------------------------------------

let timer = null;
let started = false;
let permissionsApi = null;     // lazy-loaded; null if module missing
let lastState = Object.fromEntries(TRACKED_PERMISSIONS.map(p => [p, false]));

// --- Lazy import of Ori's module ------------------------------------------

async function loadPermissionsApi() {
  if (permissionsApi !== null) return permissionsApi;
  try {
    const mod = await import('./macos-permissions.js');
    // Expected surface: checkPermission(name) → boolean | Promise<boolean>
    if (typeof mod.checkPermission !== 'function') {
      console.warn('[permission-watcher] macos-permissions.js loaded but missing checkPermission()');
      permissionsApi = false;
      return false;
    }
    permissionsApi = mod;
    return mod;
  } catch (err) {
    // Module not present yet (Ori still building) — log once, stay idle.
    console.info('[permission-watcher] lib/macos-permissions.js not found; watcher idle until it ships');
    permissionsApi = false;
    return false;
  }
}

// --- Polling loop ----------------------------------------------------------

async function tick() {
  const api = await loadPermissionsApi();
  if (!api) return;

  for (const perm of TRACKED_PERMISSIONS) {
    let granted;
    try {
      granted = await Promise.resolve(api.checkPermission(perm));
    } catch (err) {
      console.warn(`[permission-watcher] checkPermission(${perm}) threw: ${err.message}`);
      continue;
    }
    granted = !!granted;

    const prev = lastState[perm];
    if (granted && !prev) {
      lastState[perm] = true;
      console.info(`[permission-watcher] ${perm}: granted`);
      events.emit('permission.granted', { permission: perm, at: new Date().toISOString() });
    } else if (!granted && prev) {
      // Revocation — log only. We don't roll anything back; in-flight
      // ingest keeps its already-loaded data (see orchestrator failure
      // manifest #1). Re-grant after revoke is a no-op (already
      // completed) unless the caller forces it.
      lastState[perm] = false;
      console.info(`[permission-watcher] ${perm}: revoked`);
      events.emit('permission.revoked', { permission: perm, at: new Date().toISOString() });
    }
  }

  // Self-stop once every tracked permission is granted. The user can
  // re-grant after revoke by re-running install.sh, which restarts the
  // server and re-checks the active config dir's `.onboarded` sentinel.
  if (TRACKED_PERMISSIONS.every(p => lastState[p])) {
    console.info('[permission-watcher] all tracked permissions granted; stopping watcher');
    stop();
  }
}

// --- Public API ------------------------------------------------------------

export function start() {
  if (started) return;
  started = true;
  console.info(`[permission-watcher] starting (poll every ${POLL_INTERVAL_MS}ms, tracking: ${TRACKED_PERMISSIONS.join(', ')})`);
  // Kick a first tick immediately (don't make the user wait 5s on a fresh
  // install when they just granted Contacts). Wrap in setImmediate so we
  // don't block whatever called us.
  setImmediate(() => { tick().catch(err => console.warn('[permission-watcher] first tick failed:', err.message)); });
  timer = setInterval(() => {
    tick().catch(err => console.warn('[permission-watcher] tick failed:', err.message));
  }, POLL_INTERVAL_MS);
  // Don't keep the event loop alive just for permission polling.
  if (timer.unref) timer.unref();
}

export function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}

/**
 * For tests / introspection. Returns a snapshot of the last observed
 * permission state.
 */
export function getState() {
  return { ...lastState };
}

export default { start, stop, events, getState };
