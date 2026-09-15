/**
 * lib/session-registry.js — st_8745309c.
 *
 * Coordination surface for parallel Claude Code sessions sharing one repo.
 * Pure: no LLM, no DB, no network. File I/O only.
 *
 * Schema (one JSON object — NOT an append log):
 *
 *   {
 *     "sessions": {
 *       "<session_id>": {
 *         "session_id":    "<string — stable Claude Code session_id>",
 *         "label":         "<string — human label, e.g. 'A'>",
 *         "story_id":      "<string | null>",
 *         "worktree_path": "<string | null — absolute path or null for main checkout>",
 *         "pid":           <number — process PID for liveness check>,
 *         "started_at":    "<ISO string>",
 *         "last_heartbeat":"<ISO string>",
 *         "files":         ["<path>", ...]
 *       }
 *     },
 *     "updated_at": "<ISO string>"
 *   }
 *
 * Design invariants:
 *
 *   1. File size tracks LIVE-session count, never write history. JSON object
 *      keyed by session_id; 10k heartbeats from one session produce exactly
 *      one entry, not 10k log rows.
 *
 *   2. Atomic write: temp file + rename. POSIX rename() is atomic on local
 *      filesystems — readers see either the old object or the new one, never
 *      a half-written file.
 *
 *   3. Two-factor staleness on every write: an entry is pruned when its PID
 *      no longer responds to kill(0) AND when its last_heartbeat is older
 *      than STALE_HEARTBEAT_MS. The PID liveness check alone is unsafe (PID
 *      reuse); the heartbeat alone is unsafe (a paused process); both
 *      together are the documented defense.
 *
 *   4. Corrupt or missing file → empty registry. readRegistry() returns
 *      { sessions: {} } on JSON parse error or ENOENT so consumers never
 *      crash on a half-written file or a fresh install.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PIPELINE_SESSIONS_PATH } from './robotdojo-paths.js';

// 60-second window. A session that momentarily fails a heartbeat has one
// minute to recover before another session prunes it. Tuned to match the
// AC3 "within 60 seconds" requirement and to forgive transient hook
// failures (the session-log hook has an 800ms timeout — a single dropped
// post must not orphan the entry).
export const STALE_HEARTBEAT_MS = 60_000;

function registryPath() {
  // Resolve on every call so tests can change ROBOTDOJO_SESSIONS_PATH at
  // runtime via process.env. The module-level import is just the default.
  return process.env.ROBOTDOJO_SESSIONS_PATH
    ? resolve(process.env.ROBOTDOJO_SESSIONS_PATH)
    : PIPELINE_SESSIONS_PATH;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Liveness probe — kill(pid, 0) returns true iff the kernel reports a live
 * process with that PID owned by a signalable user. process.kill() raises on
 * ESRCH (no such process) and EPERM (process exists but not signalable by
 * us). The latter still counts as "live" — a sibling process owned by us
 * never produces EPERM, but a Claude Code session that re-execed as another
 * user is sufficiently unusual that treating EPERM as live is safer than
 * pruning a real session.
 */
export function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function heartbeatStale(iso, now = Date.now()) {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return true;
  return (now - t) > STALE_HEARTBEAT_MS;
}

/**
 * Prune entries by heartbeat staleness. Returns a new sessions object with
 * only live entries retained. Liveness is authoritative on the heartbeat:
 * the session-log hook re-upserts last_heartbeat on every prompt, so an
 * active session stays fresh and a crashed/exited one goes stale within
 * STALE_HEARTBEAT_MS (AC3: "pruned within 60s of liveness-signal loss").
 *
 * WHY NOT the PID: the hook that writes the registry runs as an ephemeral
 * subprocess (node ~/.claude/hooks/robotdojo-session-log.mjs) whose pid
 * exits the instant the hook returns. So entry.pid is the dead hook pid,
 * isPidAlive(entry.pid) is ~always false, and an OR-on-dead predicate would
 * prune EVERY entry immediately — which is exactly the bug this replaces
 * (activeSessions() was permanently empty). The hook cannot supply a stable
 * long-lived pid, so the heartbeat is the only sound liveness signal. pid is
 * retained on entries for display/diagnostics only. Clean exits are removed
 * directly via removeSession() on the Stop hook, so the 60s stale window
 * only governs crashes, not graceful quits.
 */
function pruneDeadEntries(sessions, now = Date.now()) {
  const out = {};
  for (const [sid, entry] of Object.entries(sessions || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (heartbeatStale(entry.last_heartbeat, now)) continue;
    out[sid] = entry;
  }
  return out;
}

/**
 * Raw read with graceful degradation. Used for display surfaces that want
 * to see every entry (even stale ones) — typically zero callers. The
 * mainline consumer is activeSessions().
 */
export function readRegistry() {
  const path = registryPath();
  if (!existsSync(path)) return { sessions: {}, updated_at: null };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sessions !== 'object') {
      return { sessions: {}, updated_at: null };
    }
    return parsed;
  } catch {
    // Corrupt file → empty. The next upsertSession will overwrite it.
    return { sessions: {}, updated_at: null };
  }
}

/**
 * Pruning read. Returns the array of currently-live session entries. Does
 * NOT write — display, conflict checks, and other read-mostly consumers
 * call this. Every entry passes the two-factor liveness check at call time.
 */
export function activeSessions() {
  const reg = readRegistry();
  const pruned = pruneDeadEntries(reg.sessions || {});
  return Object.values(pruned);
}

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Atomic write: serialize the registry to a temp file under the same
 * parent dir, then rename(2) it over the target. POSIX guarantees rename
 * is atomic when source and target are on the same filesystem; placing the
 * temp file in the same directory satisfies that.
 */
function writeAtomic(path, value) {
  ensureDir(path);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.filter(f => typeof f === 'string' && f.length > 0);
}

/**
 * Upsert a single session entry. Re-reads the file under the lock-free
 * "write the current view" model; concurrent writes resolve as last-rename-
 * wins. The state-loss window is at most one heartbeat — the losing
 * session restores its entry on the next prompt.
 *
 * Contract:
 *   - session_id (required, string) — keyed by Claude Code's stable id.
 *   - label (optional, string) — defaults to the last 6 chars of session_id.
 *   - story_id (optional, string | null) — active story for the session.
 *   - worktree_path (optional, string | null) — absolute path or null.
 *   - pid (optional, number) — defaults to process.pid.
 *   - files (optional, string[]) — list of paths the session is editing.
 *
 * Returns the persisted entry. Throws on missing session_id.
 */
export function upsertSession(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('upsertSession: params required');
  }
  const session_id = String(params.session_id || '').trim();
  if (!session_id) throw new Error('upsertSession: session_id required');

  const reg = readRegistry();
  const sessions = pruneDeadEntries(reg.sessions || {});
  const existing = sessions[session_id] || {};

  const now = nowIso();
  const entry = {
    session_id,
    label: params.label != null ? String(params.label) : (existing.label || session_id.slice(-6)),
    story_id: params.story_id !== undefined ? (params.story_id == null ? null : String(params.story_id)) : (existing.story_id ?? null),
    worktree_path: params.worktree_path !== undefined ? (params.worktree_path == null ? null : String(params.worktree_path)) : (existing.worktree_path ?? null),
    pid: typeof params.pid === 'number' ? params.pid : (existing.pid || process.pid),
    started_at: existing.started_at || now,
    last_heartbeat: now,
    files: params.files !== undefined ? normalizeFiles(params.files) : normalizeFiles(existing.files),
  };

  sessions[session_id] = entry;

  const next = { sessions, updated_at: now };
  writeAtomic(registryPath(), next);
  return entry;
}

/**
 * Remove a single session entry by id. Idempotent — removing a missing id
 * is not an error (the prune may have already removed it). Returns true if
 * the entry was present and removed, false otherwise.
 */
export function removeSession(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('removeSession: params required');
  }
  const session_id = String(params.session_id || '').trim();
  if (!session_id) throw new Error('removeSession: session_id required');

  const reg = readRegistry();
  const sessions = pruneDeadEntries(reg.sessions || {});
  const had = Object.prototype.hasOwnProperty.call(sessions, session_id);
  delete sessions[session_id];

  const next = { sessions, updated_at: nowIso() };
  writeAtomic(registryPath(), next);
  return had;
}
