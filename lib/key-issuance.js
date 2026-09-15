/**
 * Black Belt key issuance — called when an issued/prepaid entitlement is
 * activated. Private-beta checkout routes are disabled, but the lower-level
 * issuance helper remains for admin and future billing paths.
 *
 * Flow
 *   Entitlement confirmed
 *     → issueKey(userEmail)
 *       1. Generate 32 random bytes (base64) — the user's Black Belt key
 *       2. Store SHA-256 hash of the key in users.encryption_key_hash
 *       3. POST the raw key to the tunnel gateway's /internal/push-key
 *          which forwards it over the user's live tunnel agent connection.
 *
 *   On cancellation / non-payment:
 *     → revokeKey(userEmail)
 *       POSTs to /internal/revoke-key. The agent discards the key in-memory.
 *
 * Gateway contract (see robotdojo-gateway/routes/control.js):
 *   POST /internal/push-key    { email, key } → { delivered }
 *   POST /internal/revoke-key  { email }                   → { delivered }
 *   Auth: `Authorization: Bearer <GATEWAY_INTERNAL_SECRET>`
 *
 * Design notes
 *   - The raw key is never written to our disk. The hash lets us rotate and
 *     verify "this is the same user's key" without ever holding the secret.
 *   - If the agent is offline, gateway returns {delivered:false} — the agent
 *     will reconcile on next reconnect via a separate path (not implemented
 *     here; agent-side concern).
 *   - Idempotent: calling issueKey twice produces two independent keys; the
 *     latest replaces the prior hash. Future billing webhook callers must
 *     dedupe their own event IDs before calling issueKey.
 */

import crypto from 'node:crypto';
import db from './db.js';
import config from './config.js';

// BB source lives in lib/bb/ and lib/chat-tools/black/. The runtime gate is
// `isBBActive()` (cohort-key JWT). This helper delivers bearer credentials,
// not executable code.

const KEY_BYTES = 32;

const updateKeyHash = db.prepare(`
  UPDATE users SET encryption_key_hash = ? WHERE email = ?
`);

const clearKeyHash = db.prepare(`
  UPDATE users SET encryption_key_hash = NULL WHERE email = ?
`);

const updatePeriodStart = db.prepare(`
  UPDATE subscriptions
     SET current_period_start = ?
   WHERE user_id = (SELECT id FROM users WHERE email = ?)
     AND status = 'active'
     AND perpetual = 0
`);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// st_96bb626f AC16: issued Black Belt keys carry the same `rdj-` access-token
// prefix as the pasted bearer token. Exported so the prefix is unit-testable.
// The prefix is hash-transparent — hashKey() digests the already-prefixed raw
// key, so verification stays self-consistent (no length/parse assumption on
// the hashed value).
export function generateKey() {
  return `rdj-${crypto.randomBytes(KEY_BYTES).toString('base64')}`;
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function callGateway(path, body) {
  const url = `${config.gatewayUrl.replace(/\/+$/, '')}${path}`;
  const secret = config.gatewayInternalSecret;
  if (!secret) throw new Error('GATEWAY_INTERNAL_SECRET not configured');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`[gateway] ${res.status} ${json?.error || 'error'} (${path})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Generate a new Black Belt subscription credential, store its hash,
 * push to the user's agent.
 *
 * billingPeriodStart (ISO date, e.g. '2026-04-01') is recorded on the
 * subscription row so /api/bb/session can derive HKDF-keyed credentials
 * if any subsystem needs them. Falls back to today if omitted (USDC path
 * where no Stripe period is available).
 *
 * Returns { delivered, keyHash } — raw key is never returned to callers.
 */
export async function issueKey(userEmail, { billingPeriodStart } = {}) {
  const email = normalizeEmail(userEmail);
  if (!email) throw new Error('email required');

  // Fall back to today (date-only) for USDC and any caller that omits it.
  const periodStart = billingPeriodStart || new Date().toISOString().slice(0, 10);

  const rawKey = generateKey();
  const keyHash = hashKey(rawKey);

  // Store hash first so we can rotate & track, even if gateway call fails.
  updateKeyHash.run(keyHash, email);

  // Persist period start so /api/bb/session can re-derive the session key.
  updatePeriodStart.run(periodStart, email);

  // st_bc949e7c Phase 3: bundle field dropped — BB source is now ungated
  // in the repo, gated only by isBBActive() at the call sites. The rawKey
  // is a subscription credential; the gateway pushes it to the agent.
  const result = await callGateway('/internal/push-key', {
    email,
    key: rawKey,
  });

  // st_d142f701 AC17: log without PII. Email omitted from the audit line so
  // log shipments / shared screen recordings never carry plaintext addresses.
  // keyHash is in-memory only; we don't log it either (avoids hash-bucket
  // attacks if the log is exposed).
  console.info(`[key-issuance] issued key, period=${periodStart}, delivered=${result?.delivered === true}`);
  return { delivered: result?.delivered === true, keyHash };
}

/**
 * Admin-only: issue an unbilled perpetual key to an arbitrary email.
 *
 * Creates the user row if it doesn't exist, stores the key hash, and
 * inserts a `subscriptions` row marked perpetual=1 (no Stripe/USDC IDs)
 * so downstream billing code treats it as "paid forever".
 *
 * Unlike issueKey() this returns the RAW key because the admin flow
 * hands the plaintext back to the admin once — the user then installs
 * the agent with that key. This is only callable from an admin-gated
 * route and the raw key is never stored.
 */
export async function issuePerpetualKey(userEmail, { name = null, belt = 'black' } = {}) {
  const email = normalizeEmail(userEmail);
  if (!email) throw new Error('email required');
  if (belt !== 'black') {
    throw new Error(`belt must be 'black' (got ${belt})`);
  }

  // Find-or-create the user via the same path as magic-link auth so the
  // slug / defaults stay consistent. Dynamic import dodges a cycle with
  // magic-link.js (which itself imports nothing from key-issuance).
  const { findOrCreateUser } = await import('./magic-link.js');
  const user = findOrCreateUser(email);
  if (name) {
    // st_d142f701 AC17: redact email + name from the perpetual-key log.
    // Users table has no name column today — historically the line carried
    // both fields for ops audit. Both are PII.
    console.info(`[key-issuance] perpetual key (named user)`);
  }

  const rawKey = generateKey();
  const keyHash = hashKey(rawKey);
  updateKeyHash.run(keyHash, email);

  // Flip the user's subscription_status so middleware gates pass.
  db.prepare(`UPDATE users SET subscription_status = ? WHERE id = ?`).run(belt, user.id);

  // Record the perpetual subscription row.
  db.prepare(`
    INSERT INTO subscriptions
      (user_id, belt, status, rail, started_at, current_period_end,
       stripe_customer_id, stripe_subscription_id, usdc_sender_wallet,
       billing_channel, perpetual)
    VALUES (?, ?, 'active', 'admin', datetime('now'), NULL, NULL, NULL, NULL, 'admin', 1)
  `).run(user.id, belt);

  // Best-effort push to the gateway. If the agent isn't connected yet
  // (common for admin-issued keys — they arrive before the user installs)
  // the agent will read the key from the install flow instead. We log
  // delivery state but never throw.
  // st_bc949e7c Phase 3: bundle field dropped — BB source is now ungated.
  let delivered = false;
  try {
    const result = await callGateway('/internal/push-key', {
      email,
      key: rawKey,
    });
    delivered = result?.delivered === true;
  } catch (err) {
    // st_d142f701 AC17: log gateway failure without the email.
    console.warn(`[key-issuance] gateway push failed (perpetual): ${err.message}`);
  }

  // st_d142f701 AC17: log without PII. The return value still carries the
  // email so the admin caller can render it in the response; the log file
  // does not.
  console.info(`[key-issuance] perpetual ${belt} key issued, delivered=${delivered}`);
  return { apiKey: rawKey, keyHash, belt, email, userId: user.id, delivered };
}

/**
 * Tell the gateway to invalidate the user's in-memory key. Clear our hash.
 */
export async function revokeKey(userEmail) {
  const email = normalizeEmail(userEmail);
  if (!email) throw new Error('email required');

  clearKeyHash.run(email);

  const result = await callGateway('/internal/revoke-key', { email });
  // st_d142f701 AC17: log without PII.
  console.info(`[key-issuance] revoked key, delivered=${result?.delivered === true}`);
  return { delivered: result?.delivered === true };
}
