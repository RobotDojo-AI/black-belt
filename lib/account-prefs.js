/**
 * Account preferences + lifecycle data layer.
 *
 * Backs the /account UI: release channel, telemetry opt-ins, per-app beta
 * opt-ins, feature requests, deletion actions, admin audit trail.
 *
 * Every function takes `accountId` (= users.id) as the owning key — the
 * route layer resolves the current user from the session cookie and
 * never trusts a client-supplied id.
 *
 * Schema: lib/migrations/013_account_prefs.sql
 */

import db from './db.js';

// --- Shared constants ------------------------------------------------------

export const VALID_BETA_APPS = new Set(['health']);
export const VALID_RELEASE_CHANNELS = new Set(['stable', 'beta']);

const DEFAULT_PREFS = Object.freeze({
  auto_update: true,
  channel: 'stable',
  telemetry_usage: false,
  telemetry_error_reporting: false,
  telemetry_include_screenshots: false,
  telemetry_include_chat_sessions: false,
  agent_name: 'miyagi',
});

// Validate agent_name: 1-32 chars, lowercase alphanumeric + hyphens only.
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function validateAgentName(name) {
  if (typeof name !== 'string' || !AGENT_NAME_RE.test(name)) {
    throw new Error('agent_name must be 1-32 chars, lowercase alphanumeric and hyphens only');
  }
}

// --- Prepared statements ---------------------------------------------------

const stmts = {
  getPrefs: db.prepare(`SELECT * FROM account_preferences WHERE account_id = ?`),
  upsertPrefs: db.prepare(`
    INSERT INTO account_preferences
      (account_id, auto_update, release_channel,
       telemetry_usage, telemetry_error_reporting,
       telemetry_include_screenshots, telemetry_include_chat_sessions,
       agent_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET
      auto_update                     = excluded.auto_update,
      release_channel                 = excluded.release_channel,
      telemetry_usage                 = excluded.telemetry_usage,
      telemetry_error_reporting       = excluded.telemetry_error_reporting,
      telemetry_include_screenshots   = excluded.telemetry_include_screenshots,
      telemetry_include_chat_sessions = excluded.telemetry_include_chat_sessions,
      agent_name                      = excluded.agent_name,
      updated_at                      = datetime('now')
  `),

  getOptIn: db.prepare(`SELECT * FROM beta_opt_ins WHERE account_id = ? AND app = ?`),
  listOptIns: db.prepare(`
    SELECT app, opted_in, updated_at
      FROM beta_opt_ins
     WHERE account_id = ? AND opted_in = 1
     ORDER BY app ASC
  `),
  upsertOptIn: db.prepare(`
    INSERT INTO beta_opt_ins (account_id, app, opted_in, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(account_id, app) DO UPDATE SET
      opted_in = excluded.opted_in,
      updated_at = datetime('now')
  `),

  insertFeatureRequest: db.prepare(`
    INSERT INTO feature_requests (account_id, title, body)
    VALUES (?, ?, ?)
  `),
  listFeatureRequests: db.prepare(`
    SELECT id, title, body, submitted_at
      FROM feature_requests
     WHERE account_id = ?
     ORDER BY submitted_at DESC, id DESC
  `),

  insertAudit: db.prepare(`
    INSERT INTO account_audit_log (account_id, action, metadata)
    VALUES (?, ?, ?)
  `),
};

// --- Preferences -----------------------------------------------------------

/**
 * Return the user's prefs as a clean JSON shape (with sane defaults when no
 * row exists yet). Booleans are real booleans, not SQLite 0/1.
 */
export function getPreferences(accountId) {
  const row = stmts.getPrefs.get(accountId);
  if (!row) return { ...DEFAULT_PREFS };
  return {
    auto_update:                     !!row.auto_update,
    channel:                         row.release_channel || 'stable',
    telemetry_usage:                 !!row.telemetry_usage,
    telemetry_error_reporting:       !!row.telemetry_error_reporting,
    telemetry_include_screenshots:   !!row.telemetry_include_screenshots,
    telemetry_include_chat_sessions: !!row.telemetry_include_chat_sessions,
    agent_name:                      row.agent_name || 'miyagi',
  };
}

/**
 * Merge-update the user's preferences. Only keys present in `patch` are
 * touched; anything omitted keeps its current value (or the default on
 * first write).
 *
 * `patch` mirrors the shape returned by getPreferences() — callers map
 * their UI keys (e.g. "include_screenshots") to the full column name
 * (e.g. "telemetry_include_screenshots") before calling.
 */
export function updatePreferences(accountId, patch = {}) {
  const current = getPreferences(accountId);
  const next = { ...current, ...pickDefined(patch) };

  // Normalize types — SQLite INTEGER column for booleans, TEXT for channel.
  if (!VALID_RELEASE_CHANNELS.has(next.channel)) {
    throw new Error(`invalid channel: ${next.channel}`);
  }

  // Validate agent_name if present in patch.
  if (patch.agent_name !== undefined) {
    validateAgentName(next.agent_name);
  }

  stmts.upsertPrefs.run(
    accountId,
    next.auto_update ? 1 : 0,
    next.channel,
    next.telemetry_usage ? 1 : 0,
    next.telemetry_error_reporting ? 1 : 0,
    next.telemetry_include_screenshots ? 1 : 0,
    next.telemetry_include_chat_sessions ? 1 : 0,
    next.agent_name || 'miyagi',
  );
  return getPreferences(accountId);
}

function pickDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// --- Beta opt-ins ----------------------------------------------------------

export function setBetaOptIn(accountId, app, optIn) {
  if (!VALID_BETA_APPS.has(app)) throw new Error(`invalid app: ${app}`);
  stmts.upsertOptIn.run(accountId, app, optIn ? 1 : 0);
  const row = stmts.getOptIn.get(accountId, app);
  return {
    app,
    opt_in: !!row?.opted_in,
    updated_at: row?.updated_at || null,
  };
}

export function listBetaOptIns(accountId) {
  const rows = stmts.listOptIns.all(accountId);
  return rows.map((r) => ({
    app: r.app,
    opt_in: !!r.opted_in,
    updated_at: r.updated_at,
  }));
}

// --- Feature requests ------------------------------------------------------

/** Validate, persist, return the new row id + timestamp. */
export function submitFeatureRequest(accountId, { title, body }) {
  const t = typeof title === 'string' ? title.trim() : '';
  const b = typeof body  === 'string' ? body.trim()  : '';
  if (t.length < 1 || t.length > 120) {
    throw new Error('title must be 1-120 characters');
  }
  if (b.length < 10 || b.length > 4000) {
    throw new Error('body must be 10-4000 characters');
  }
  const r = stmts.insertFeatureRequest.run(accountId, t, b);
  const id = r.lastInsertRowid;
  const row = db.prepare(`SELECT submitted_at FROM feature_requests WHERE id = ?`).get(id);
  return { id, submitted_at: row?.submitted_at };
}

export function listFeatureRequests(accountId) {
  return stmts.listFeatureRequests.all(accountId);
}

// --- Audit log -------------------------------------------------------------

/** Log a deletion / admin action. `metadata` may be any JSON-serialisable value. */
export function logAudit(accountId, action, metadata = {}) {
  let json;
  try { json = JSON.stringify(metadata ?? {}); }
  catch { json = '{}'; }
  stmts.insertAudit.run(accountId, action, json);
}
