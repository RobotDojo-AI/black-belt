/**
 * /api/account/* — account preferences, beta opt-ins, telemetry,
 * feature requests, and deletion (four levels).
 *
 * Every endpoint is session-authed via requireAuth(). The current user's
 * account_id is ALWAYS resolved from the session cookie server-side — we
 * never trust a client-supplied account_id.
 *
 * Mounted at /api/account by index.js.
 *
 * See lib/account-prefs.js (data layer) and lib/account-deletion.js
 * (cascade helpers).
 */

import { Hono } from 'hono';
import { join } from 'node:path';
import { requireAuth } from '../lib/middleware-auth.js';
import {
  VALID_BETA_APPS,
  VALID_RELEASE_CHANNELS,
  getPreferences,
  updatePreferences,
  validateAgentName,
  setBetaOptIn,
  listBetaOptIns,
  submitFeatureRequest,
  listFeatureRequests,
  logAudit,
} from '../lib/account-prefs.js';
import {
  deleteUserData,
  deleteUserModel,
  cancelUserSubscription,
  deleteUserFull,
} from '../lib/account-deletion.js';
import { addColumn } from '../lib/db.js';
import db from '../lib/db.js';
import { getReceiptEmail, upsertReceiptEmail, updateDisplayName, updateAccountName, updateBeltStatus } from '../lib/account-prefs-queries.js';
import { REPO_ROOT, USER_PROFILE_PATH } from '../lib/robotdojo-paths.js';

// Ensure receipt_email column exists in account_preferences (idempotent addColumn).
// This avoids a new SQL migration file while keeping storage co-located with
// the other per-user account preferences.
addColumn('account_preferences', 'receipt_email', 'TEXT');

const account = new Hono();

// Every /api/account/* endpoint requires a valid session.
account.use('*', requireAuth());

// --- Helpers ---------------------------------------------------------------

async function readJson(c) {
  try { return await c.req.json(); }
  catch { return null; }
}

function nowIso() { return new Date().toISOString(); }

function requireDeleteConfirm(body) {
  return body && body.confirm === 'DELETE';
}

// --- General preferences (agent_name + future scalars) ---------------------

account.get('/preferences', (c) => {
  const user = c.get('user');
  const prefs = getPreferences(user.id);
  return c.json({ agent_name: prefs.agent_name });
});

account.patch('/preferences', async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_json' }, 400);

  const patch = {};
  if (body.agent_name !== undefined) {
    try {
      validateAgentName(body.agent_name);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
    patch.agent_name = body.agent_name;
  }

  try {
    const prefs = updatePreferences(user.id, patch);
    return c.json({ agent_name: prefs.agent_name });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

// --- Release channel + updates ---------------------------------------------

account.get('/release-channel', (c) => {
  const user = c.get('user');
  const prefs = getPreferences(user.id);
  return c.json({ auto_update: prefs.auto_update, channel: prefs.channel });
});

account.patch('/release-channel', async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_json' }, 400);

  const patch = {};
  if (body.auto_update !== undefined) {
    if (typeof body.auto_update !== 'boolean') {
      return c.json({ error: 'invalid_value' }, 400);
    }
    patch.auto_update = body.auto_update;
  }
  if (body.channel !== undefined) {
    if (!VALID_RELEASE_CHANNELS.has(body.channel)) {
      return c.json({ error: `channel must be one of: ${[...VALID_RELEASE_CHANNELS].join(', ')}` }, 400);
    }
    patch.channel = body.channel;
  }

  try {
    const prefs = updatePreferences(user.id, patch);
    return c.json({ auto_update: prefs.auto_update, channel: prefs.channel });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

/**
 * POST /api/account/release/pull — kick off scripts/update.js detached.
 * The update script handles git pull + npm ci + launchd restart.
 * Server will restart in ~30s if an update is available.
 */
account.post('/release/pull', async (c) => {
  const user = c.get('user');
  const prefs = getPreferences(user.id);
  logAudit(user.id, 'release_pull_start', { channel: prefs.channel });

  const { spawn } = await import('node:child_process');
  const child = spawn('node', ['scripts/update.js'], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return c.json({ ok: true, message: 'Update started — server will restart in ~30s' });
});

// --- Beta opt-in -----------------------------------------------------------

account.get('/beta-opt-ins', (c) => {
  const user = c.get('user');
  return c.json({ apps: listBetaOptIns(user.id) });
});

account.post('/beta-opt-in', async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_json' }, 400);

  const { app, opt_in } = body;
  if (!VALID_BETA_APPS.has(app)) {
    return c.json({ error: `app must be one of: ${[...VALID_BETA_APPS].join(', ')}` }, 400);
  }
  if (typeof opt_in !== 'boolean') {
    return c.json({ error: 'invalid_value' }, 400);
  }

  try {
    return c.json(setBetaOptIn(user.id, app, opt_in));
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

// --- Telemetry -------------------------------------------------------------

const TELEMETRY_KEYS = [
  'usage',
  'error_reporting',
  'include_screenshots',
  'include_chat_sessions',
];

// Map UI keys ↔ prefs column names. This insulates the client from the
// "telemetry_" prefix used internally for the columns.
function telemetryView(prefs) {
  return {
    usage:                 prefs.telemetry_usage,
    error_reporting:       prefs.telemetry_error_reporting,
    include_screenshots:   prefs.telemetry_include_screenshots,
    include_chat_sessions: prefs.telemetry_include_chat_sessions,
  };
}

account.get('/telemetry', (c) => {
  const user = c.get('user');
  return c.json(telemetryView(getPreferences(user.id)));
});

account.patch('/telemetry', async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_json' }, 400);

  const patch = {};
  for (const key of TELEMETRY_KEYS) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') {
        return c.json({ error: `${key} must be boolean` }, 400);
      }
      patch[`telemetry_${key}`] = body[key];
    }
  }

  try {
    const prefs = updatePreferences(user.id, patch);
    return c.json(telemetryView(prefs));
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

// --- Feature requests ------------------------------------------------------

account.post('/feature-requests', async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_json' }, 400);

  try {
    const row = submitFeatureRequest(user.id, { title: body.title, body: body.body });
    return c.json(row);
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

account.get('/feature-requests', (c) => {
  const user = c.get('user');
  return c.json({ requests: listFeatureRequests(user.id) });
});

// --- Deletion (four levels) ------------------------------------------------

/**
 * Every delete endpoint:
 *   - requires body { confirm: "DELETE" }
 *   - logs the action to account_audit_log
 *   - returns { deleted: true, at: timestamp }
 */

account.post('/delete/data', async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  if (!requireDeleteConfirm(body)) return c.json({ error: 'confirm_required' }, 400);

  try {
    const result = deleteUserData(user.id);
    logAudit(user.id, 'delete_data', { at: result.at });
    return c.json(result);
  } catch (err) {
    console.error('[account] delete/data failed:', err.message);
    return c.json({ error: 'delete_failed', message: err.message }, 500);
  }
});

account.post('/delete/model', async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  if (!requireDeleteConfirm(body)) return c.json({ error: 'confirm_required' }, 400);

  try {
    const result = deleteUserModel(user.id);
    logAudit(user.id, 'delete_model', { at: result.at });
    return c.json(result);
  } catch (err) {
    console.error('[account] delete/model failed:', err.message);
    return c.json({ error: 'delete_failed', message: err.message }, 500);
  }
});

account.post('/delete/subscription', async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  if (!requireDeleteConfirm(body)) return c.json({ error: 'confirm_required' }, 400);

  try {
    const result = await cancelUserSubscription(user);
    logAudit(user.id, 'delete_subscription', { at: result.at });
    return c.json(result);
  } catch (err) {
    console.error('[account] delete/subscription failed:', err.message);
    return c.json({ error: 'cancel_failed', message: err.message }, 502);
  }
});

account.post('/delete/full', async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  if (!requireDeleteConfirm(body)) return c.json({ error: 'confirm_required' }, 400);

  try {
    const result = await deleteUserFull(user);
    // NOTE: audit row is written BEFORE tombstone in deleteUserFull's order
    // if we wanted to preserve account_id — but since we only tombstone the
    // users row (not delete it), the FK is preserved and logging after is safe.
    logAudit(user.id, 'delete_full', { at: result.at });
    return c.json(result);
  } catch (err) {
    console.error('[account] delete/full failed:', err.message);
    return c.json({ error: 'delete_failed', message: err.message }, 500);
  }
});

// --- Receipt email ----------------------------------------------------------
// Stored in the receipt_email column of account_preferences (added above via
// addColumn — idempotent, no new migration file).

account.get('/receipt-email', (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  // Read only the receipt_email column; account_preferences row may not exist yet.
  const row = getReceiptEmail(db, user.id);
  return c.json({ email: row?.receipt_email || null });
});

account.post('/receipt-email', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const body = await readJson(c);
  const email = body?.email;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return c.json({ error: 'invalid_email' }, 400);
  }
  // Upsert the receipt_email into account_preferences. If no preferences row
  // exists yet we create a minimal one with defaults; existing rows are updated.
  upsertReceiptEmail(db, user.id, email.trim().slice(0, 255));
  return c.json({ ok: true });
});

// --- Display name ----------------------------------------------------------
// PATCH /api/account/name  { name: string }
// Sets the user-facing account name shown in Accounts > Admin.

account.patch('/name', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const body = await readJson(c);
  const raw = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!raw) return c.json({ error: 'name_required' }, 400);
  if (raw.length > 64) return c.json({ error: 'name_too_long' }, 400);
  try {
    updateAccountName(db, raw, user.id);
    return c.json({ ok: true, name: raw });
  } catch {
    return c.json({ error: 'storage_failed' }, 500);
  }
});

// PATCH /api/account/belt-status  { belt: "white" | "black" }
// Lets the owner set the account-facing tier label shown in Accounts.

account.patch('/belt-status', async (c) => {
  if (process.env.ROBOTDOJO_ADMIN_BELT_TOGGLE !== '1') {
    return c.json({ error: 'belt_status_readonly' }, 403);
  }

  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const body = await readJson(c);
  const belt = String(body?.belt || '').toLowerCase();
  if (!['white', 'black'].includes(belt)) return c.json({ error: 'invalid_belt' }, 400);
  updateBeltStatus(db, belt, user.id);
  return c.json({ ok: true, belt });
});

// PATCH /api/account/display-name  { display_name: string }
// Sets a friendly display name for the user — shown in greetings and profile.

account.patch('/display-name', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const body = await readJson(c);
  if (!body || body.display_name === undefined) {
    return c.json({ error: 'display_name_required' }, 400);
  }
  const raw = typeof body.display_name === 'string' ? body.display_name.trim() : '';
  if (raw.length > 64) {
    return c.json({ error: 'display_name_too_long' }, 400);
  }
  updateDisplayName(db, raw || null, user.id);

  // Update wk_user/USER.md **Call User:** line and rebuild identity adapters (best-effort).
  // Only touches AI-generated files (hand-edited files lack the marker).
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const userMdPath = USER_PROFILE_PATH;
  try {
    if (existsSync(userMdPath)) {
      let content = readFileSync(userMdPath, 'utf8');
      // Only update AI-generated files (hand-edited files lack the marker).
      if (content.includes('<!-- AI-generated')) {
        const callLine = raw
          ? `- **Call User:** ${raw}`
          : '- **Call User:** (display name cleared)';
        // Match both legacy "Call him:" and current "Call User:" field names
        if (/- \*\*Call (?:User|him):\*\*/.test(content)) {
          content = content.replace(/- \*\*Call (?:User|him):\*\*.*/, callLine);
          writeFileSync(userMdPath, content, 'utf8');
          // Fire-and-forget rebuild of dist adapters.
          const buildScript = join(REPO_ROOT, 'scripts', 'generate-identity.js');
          if (existsSync(buildScript)) {
            spawn(process.execPath, [buildScript], {
              detached: true,
              stdio: 'ignore',
              cwd: REPO_ROOT,
            }).unref();
          }
        }
      }
    }
  } catch (err) {
    console.warn('[display-name] USER.md update failed (non-fatal):', err.message);
  }

  return c.json({ ok: true });
});

export default account;
