/**
 * Ingest Orchestrator — wires permission grants and Google OAuth completion
 * to the 5-phase pipeline in `scripts/onboard.js`.
 *
 * Single in-process FIFO queue; concurrency=1 *per phase* (a phase that is
 * already running is a no-op on re-trigger). Phases are independent — a
 * crash in one does not block the others.
 *
 * Public surface:
 *   triggerOnPermission(permission_name)  — fires when a permission flips
 *     false→true. Routes:
 *       'contacts'   → phase 1 (contacts)
 *       'calendar'   → phase 2 (calendar)
 *       'full_disk'  → phase 3 (iMessage backfill)
 *   triggerOnGoogleAuth()                 — fires when Google OAuth lands.
 *     Routes to phase 4 (email-link). Does NOT trigger Gmail body sync;
 *     that's a separate subsystem (existing Gmail watcher / Ori).
 *   getQueueState()                       — { phase, started_at, processed,
 *     total, msgs_per_sec, status } per phase, for the ETA endpoint.
 *   events                                — EventEmitter; emits 'ingest.*'.
 *
 * Idempotency: every trigger checks whether the phase is `running` or
 * already `completed` for this boot. Re-grant after revoke is a no-op
 * unless we explicitly choose to re-run (we do for `running=false &&
 * status='completed'` only when the caller passes `{force:true}` — out of
 * scope for v1; orchestrator just no-ops the second call).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FAILURE MANIFEST (read before changing this file):
 *
 * 1. Permission revoked mid-ingest.
 *    Contract: the phase keeps running with whatever data was loaded into
 *    memory before revocation. macOS doesn't tear down our in-process
 *    SQLite handle when the user flips the switch — it only blocks NEW
 *    opens. Phase completes (or errors) on its own. Subsequent runs after
 *    re-grant will see the revoked state and either skip (no DB) or no-op
 *    (already completed).
 *
 * 2. Google token expires mid-Gmail-sync.
 *    Out of scope here. Phase 4 only links *header* data already in the
 *    `emails` table — it does NOT call the Gmail API. Token expiry only
 *    affects the upstream Gmail sync job (Ori). If `emails` is empty when
 *    triggerOnGoogleAuth fires, phase 4 logs "0 senders" and exits clean.
 *
 * 3. Phase 1 crashes — does phase 2 still run?
 *    Yes. Each trigger is independent and isolated in its own try/catch
 *    inside an async microtask. A failed phase emits `ingest.failed` and
 *    marks status='error'; later triggers proceed normally.
 *
 * 4. DB locked by another process.
 *    SQLite WAL mode permits concurrent reads. Writes serialize. Our
 *    busyTimeout is 30s (config.timeouts.db.busyTimeout). If a write
 *    fails after 30s we propagate the error → `ingest.failed`. The user
 *    can re-trigger by toggling permission off/on, which the watcher
 *    will pick up.
 *
 * 5. User closes laptop mid-ingest.
 *    Process is suspended; on resume, in-flight DB writes either complete
 *    (better-sqlite3 is synchronous) or were already committed at the
 *    last `COMMIT`. We do NOT persist queue state across reboots in v1.
 *    On next boot, the watcher re-checks permissions and re-triggers any
 *    phase whose `completed_at` is missing. (See `getQueueState` —
 *    callers can persist this themselves if needed.)
 *
 * 6. 0 contacts on Mac (does it complete with no error?).
 *    Yes. `extractContacts()` already returns `[]` gracefully when the
 *    AddressBook DB isn't found. `phaseContacts()` iterates an empty
 *    array and emits `ingest.phase.completed` with stats={total:0}.
 *    Same shape for empty calendar / iMessage.
 *
 * Telemetry contract (consumed by Ori's ETA endpoint via DB polling, NOT
 * via this event bus — these events are for log/observability only):
 *   - ingest.started        { phase, at }
 *   - ingest.phase.completed { phase, at, durationMs, stats }
 *   - ingest.failed         { phase, at, error }
 *
 * ───────────────────────────────────────────────────────────────────────────
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import config from './config.js';
import db from './db.js';
import { anchorDeclaredOwner } from './identity.js';
import {
  phaseContacts,
  phaseCalendar,
  phaseIMessage,
  phaseEmail,
  phaseScore,
} from '../scripts/onboard.js';

// df_cbd30a5a — the server first-run path that actually runs on a fresh
// install. After any ingest phase completes we set owner_person_id from the
// declared block ONCE per boot (idempotent; a no-op after the first success),
// so the owner-anchor guard is fully armed (not just declared-email membership)
// before the next full resolve. Deterministic Tier-0 — no LLM writes a row.
let _ownerAnchoredThisBoot = false;
async function maybeAnchorOwner() {
  if (_ownerAnchoredThisBoot) return;
  try {
    const r = await anchorDeclaredOwner(db);
    if (r.anchored) {
      _ownerAnchoredThisBoot = true;
      console.info(`[ingest] owner anchored: owner_person_id=${r.owner_person_id}${r.created ? ' (created)' : ''}`);
    }
  } catch (err) {
    console.warn(`[ingest] owner anchor skipped: ${err.message}`);
  }
}

// --- Event bus -------------------------------------------------------------

export const events = new EventEmitter();
// Permission-watcher can emit hundreds of poll cycles; keep listener limit sane.
events.setMaxListeners(50);

function emit(type, payload) {
  // Use console.info as the primary telemetry sink until a dedicated bus
  // exists (per spec). The EventEmitter is for in-process subscribers.
  const evt = { type, at: new Date().toISOString(), ...payload };
  console.info(`[ingest] ${type} ${JSON.stringify(payload || {})}`);
  events.emit(type, evt);
  events.emit('event', evt);
}

// --- Phase routing ---------------------------------------------------------

const PERMISSION_TO_PHASE = {
  contacts:   { phase: 1, name: 'contacts',   fn: phaseContacts },
  calendar:   { phase: 2, name: 'calendar',   fn: phaseCalendar },
  full_disk:  { phase: 3, name: 'imessage',   fn: phaseIMessage },
};

const GOOGLE_AUTH_PHASE = { phase: 4, name: 'email', fn: phaseEmail };
const PHASE_MARKER_DIR = join(config.configDir, 'onboarding-phases');

function markerPath(item) {
  return join(PHASE_MARKER_DIR, `phase-${item.phase}-${item.name}.json`);
}

function readPhaseMarker(item) {
  if (process.env.ROBOTDOJO_IGNORE_ONBOARDING_PHASE_MARKERS === '1') return null;
  const path = markerPath(item);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { completed_at: null, unreadable: true };
  }
}

function writePhaseMarker(item, payload) {
  try {
    mkdirSync(PHASE_MARKER_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(markerPath(item), JSON.stringify({
      phase: item.phase,
      name: item.name,
      completed_at: payload.completed_at,
      stats: payload.stats || null,
    }, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    console.warn(`[ingest] failed to persist phase=${item.phase} completion marker: ${err.message}`);
  }
}

// --- State -----------------------------------------------------------------
//
// status: 'idle' | 'queued' | 'running' | 'completed' | 'error'
// One slot per phase. The orchestrator never runs the same phase twice
// concurrently, but different phases run sequentially through a single
// in-process FIFO so SQLite writes don't fan out.

const state = {
  1: { phase: 1, name: 'contacts', status: 'idle', started_at: null, completed_at: null, processed: 0, total: 0, msgs_per_sec: 0, error: null, stats: null },
  2: { phase: 2, name: 'calendar', status: 'idle', started_at: null, completed_at: null, processed: 0, total: 0, msgs_per_sec: 0, error: null, stats: null },
  3: { phase: 3, name: 'imessage', status: 'idle', started_at: null, completed_at: null, processed: 0, total: 0, msgs_per_sec: 0, error: null, stats: null },
  4: { phase: 4, name: 'email',    status: 'idle', started_at: null, completed_at: null, processed: 0, total: 0, msgs_per_sec: 0, error: null, stats: null },
  5: { phase: 5, name: 'score',    status: 'idle', started_at: null, completed_at: null, processed: 0, total: 0, msgs_per_sec: 0, error: null, stats: null },
};

// FIFO queue — array of { phase, fn, name }. Drained by the worker loop.
const queue = [];
let workerActive = false;

// --- Queue worker ----------------------------------------------------------

function enqueue(item) {
  // Idempotency guard: if the phase is currently queued or running, drop.
  // If it has already completed this boot, also drop (re-grant after
  // revoke is a no-op by design — see failure manifest #1).
  const cur = state[item.phase];
  const marker = readPhaseMarker(item);
  if (marker) {
    cur.status = 'completed';
    cur.completed_at = marker.completed_at || cur.completed_at;
    cur.stats = marker.stats || cur.stats;
    console.info(`[ingest] skip enqueue phase=${item.phase} (persisted completion marker)`);
    return false;
  }
  if (cur.status === 'queued' || cur.status === 'running') {
    console.info(`[ingest] skip enqueue phase=${item.phase} (already ${cur.status})`);
    return false;
  }
  if (cur.status === 'completed') {
    console.info(`[ingest] skip enqueue phase=${item.phase} (already completed at ${cur.completed_at})`);
    return false;
  }
  cur.status = 'queued';
  cur.error = null;
  queue.push(item);
  // setImmediate keeps us off the HTTP event loop's hot path.
  if (!workerActive) setImmediate(drain);
  return true;
}

async function drain() {
  if (workerActive) return;
  workerActive = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      await runPhase(item);
    }
  } finally {
    workerActive = false;
  }
}

async function runPhase({ phase, fn, name }) {
  const cur = state[phase];
  cur.status = 'running';
  cur.started_at = new Date().toISOString();
  const t0 = Date.now();
  emit('ingest.started', { phase, name, at: cur.started_at });

  try {
    // Phase functions are synchronous (better-sqlite3). Wrap in a
    // microtask boundary so a long-running phase yields to the event
    // loop on the next tick — though synchronous SQLite work itself
    // doesn't yield. The HTTP server runs on the same loop, so we can't
    // make ingest non-blocking without worker_threads. For v1 we accept
    // that a long phase will pause /api/* responses for its duration —
    // that's the existing behavior of `node scripts/onboard.js` too.
    // The setImmediate at enqueue keeps us off the synchronous path of
    // whatever triggered us (HTTP handler, OAuth callback, watcher tick).
    await Promise.resolve();
    const stats = await Promise.resolve(fn());
    const durationMs = Date.now() - t0;

    cur.status = 'completed';
    cur.completed_at = new Date().toISOString();
    cur.stats = stats || null;
    // Best-effort processed/total derivation from common stat shapes.
    if (stats && typeof stats === 'object') {
      cur.total = stats.total ?? stats.events ?? 0;
      cur.processed = (stats.created ?? 0) + (stats.matched ?? 0) + (stats.linked ?? 0) + (stats.resolved ?? 0);
      cur.msgs_per_sec = durationMs > 0 ? +(cur.processed / (durationMs / 1000)).toFixed(2) : 0;
    }
    writePhaseMarker({ phase, name }, { completed_at: cur.completed_at, stats });
    // Anchor the declared owner after a successful phase (idempotent; once/boot).
    await maybeAnchorOwner();
    emit('ingest.phase.completed', { phase, name, at: cur.completed_at, durationMs, stats });
  } catch (err) {
    cur.status = 'error';
    cur.error = err?.message || String(err);
    emit('ingest.failed', { phase, name, at: new Date().toISOString(), error: cur.error });
  }
}

// --- Public API ------------------------------------------------------------

/**
 * Fire when a macOS permission flips false→true.
 * @param {'contacts'|'calendar'|'full_disk'} permission_name
 * @returns {boolean} true if a phase was enqueued, false on no-op.
 */
export function triggerOnPermission(permission_name) {
  const route = PERMISSION_TO_PHASE[permission_name];
  if (!route) {
    console.warn(`[ingest] triggerOnPermission: unknown permission "${permission_name}"`);
    return false;
  }
  return enqueue({ phase: route.phase, fn: route.fn, name: route.name });
}

/**
 * Fire when Google OAuth completes successfully (token persisted).
 * Routes to phase 4 (email-header link). Idempotent.
 */
export function triggerOnGoogleAuth() {
  return enqueue({ phase: GOOGLE_AUTH_PHASE.phase, fn: GOOGLE_AUTH_PHASE.fn, name: GOOGLE_AUTH_PHASE.name });
}

/**
 * Snapshot of queue state for ETA endpoint.
 * Returns an array of phase rows in deterministic order (1..5).
 */
export function getQueueState() {
  return [1, 2, 3, 4, 5].map(p => ({ ...state[p] }));
}

/**
 * Subscribe to a single google.auth.completed emission. Wired by index.js
 * so the auth route doesn't need to import this module directly.
 *
 * Importers can also subscribe to `events` directly:
 *   import { events } from './ingest-orchestrator.js';
 *   events.on('ingest.phase.completed', …)
 */
export function subscribeToGoogleAuthEvents(emitter) {
  emitter.on('google.auth.completed', () => triggerOnGoogleAuth());
}

/**
 * Subscribe to permission.granted events from the permission-watcher.
 */
export function subscribeToPermissionEvents(emitter) {
  emitter.on('permission.granted', ({ permission }) => {
    triggerOnPermission(permission);
  });
}

export default {
  triggerOnPermission,
  triggerOnGoogleAuth,
  getQueueState,
  events,
  subscribeToGoogleAuthEvents,
  subscribeToPermissionEvents,
};
