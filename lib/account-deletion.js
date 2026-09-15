/**
 * Account deletion — four levels.
 *
 *   deleteUserData(userId)          — hard-reset imported data (emails, messages,
 *                                     calendar, contacts, chunks, timeline events).
 *                                     Keeps account, sessions, subscriptions, prefs.
 *
 *   deleteUserModel(userId)         — remove future user-owned model artifacts.
 *                                     Stub today; hooks into the model store when
 *                                     that artifact class exists.
 *
 *   cancelUserSubscription(user)    — cancel Black Belt subscription via the
 *                                     existing Stripe/USDC paths; revoke the
 *                                     encryption key.
 *
 *   deleteUserFull(user)            — cascade: cancel subscription → delete
 *                                     model → delete data → tombstone the user.
 *
 * Every helper returns `{ deleted: true, at: <ISO timestamp> }` on success
 * (matching the endpoint contract). Errors throw.
 *
 * Each helper is intended to be called behind a session-authed route that
 * has already validated the { confirm: "DELETE" } payload. Callers log to
 * the audit table (see lib/account-prefs.logAudit) — this module does not
 * write audit rows itself so that a cascade only logs the parent action.
 */

import db from './db.js';
import { cancelSubscription as stripeCancel } from './stripe.js';
import { revokeKey } from './key-issuance.js';
import {
  getActiveSubscriptionForUser,
  setUserSubscriptionStatus,
} from './subscriptions.js';

function nowIso() { return new Date().toISOString(); }

// --- Data deletion ---------------------------------------------------------

// Tables that store imported / extracted data we want to wipe on
// /api/account/delete/data. Order doesn't matter — FKs are tolerant and we
// wrap in a transaction. Tables that do NOT exist in a given install are
// skipped silently (the RAG/timeline schema is modular).
const DATA_TABLES = [
  'emails',
  'email_messages',
  'imessage_messages',
  'calendar_events',
  'contacts',
  'chunks',
  'timeline_events',
  'people',
  'companies',
  'places',
  // person_edges retired by st_87a0d072 Phase 6.
  'person_topics',
  'person_interactions',
  'person_identifiers',
  'chunk_entities',
  'entity_extraction_log',
];

function tableExists(name) {
  const row = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(name);
  return !!row;
}

/**
 * Wipe imported data for a user. NOTE: the current White Belt install is
 * single-tenant — every row in these tables belongs to the one user of the
 * node. We delete ALL rows; no per-user WHERE clause is possible because
 * none of these tables carry a user_id today.
 *
 * This is safe because Robot Dojo is installed per-user (one node per Mac).
 * When multi-tenant lands, every table in DATA_TABLES must gain a user_id
 * column and this function must scope by it.
 */
export function deleteUserData(userId) {
  if (!userId) throw new Error('userId required');

  const wipe = db.transaction(() => {
    for (const t of DATA_TABLES) {
      if (!tableExists(t)) continue;
      db.prepare(`DELETE FROM ${t}`).run();
    }
  });
  wipe();

  return { deleted: true, at: nowIso() };
}

// --- Model deletion --------------------------------------------------------

/**
 * User-owned model artifacts are future work. Today this is a no-op that
 * returns a clean success so the UI can call it safely. When model artifacts
 * land, this function unlinks them and drops any rows from a future
 * user_models table.
 */
export function deleteUserModel(userId) {
  if (!userId) throw new Error('userId required');

  return { deleted: true, at: nowIso() };
}

// --- Subscription cancellation ---------------------------------------------

/**
 * Cancel the user's active subscription (any rail) and revoke their
 * encryption key. Delegates to the existing billing helpers so the same
 * webhook/cleanup paths run as when a user cancels via the Stripe portal.
 *
 * USDC auto-renew is implicitly "off" — USDC subscriptions have no auto-
 * debit today (each period is a manual on-chain transfer). Cancelling the
 * subscription row is sufficient.
 */
export async function cancelUserSubscription(user) {
  if (!user?.id) throw new Error('user required');

  const active = getActiveSubscriptionForUser(user.id);
  if (active) {
    if (active.rail === 'stripe' && active.stripe_subscription_id) {
      try {
        await stripeCancel(active.stripe_subscription_id);
      } catch (err) {
        // If Stripe says it's already cancelled we can proceed. Any other
        // error bubbles so the caller returns 502.
        if (!/resource_missing|already cancel/i.test(err?.message || '')) {
          throw err;
        }
      }
    }
    db.prepare(`
      UPDATE subscriptions
         SET status = 'cancelled',
             cancelled_at = datetime('now')
       WHERE id = ?
    `).run(active.id);
  }

  setUserSubscriptionStatus(user.id, 'cancelled');

  if (user.email) {
    try { await revokeKey(user.email); }
    catch (err) { console.error('[account-deletion] revokeKey failed:', err.message); }
  }

  return { deleted: true, at: nowIso() };
}

// --- Full cascade ----------------------------------------------------------

/**
 * Tombstone a user: cancel → model delete → data delete → mark the users
 * row. We do NOT hard-delete the users row because downstream analytics
 * (audit log, referrals) reference it. The tombstone clears PII-adjacent
 * fields and locks the account out.
 */
export async function deleteUserFull(user) {
  if (!user?.id) throw new Error('user required');

  await cancelUserSubscription(user);
  deleteUserModel(user.id);
  deleteUserData(user.id);

  // Kill all active sessions so any open browser tab logs out.
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(user.id);

  // Tombstone. Email is rewritten to `deleted+<id>@tombstone.robotdojo.ai` so
  // the UNIQUE constraint on users.email still lets the user re-sign-up with
  // the original address later if they want.
  const tombEmail = `deleted+${user.id}@tombstone.robotdojo.ai`;
  db.prepare(`
    UPDATE users
       SET email = ?,
           subscription_status = 'deleted',
           encryption_key_hash = NULL,
           tunnel_token = NULL
     WHERE id = ?
  `).run(tombEmail, user.id);

  return { deleted: true, at: nowIso() };
}
