/**
 * Subscriptions + payment-intents data layer.
 * Shared by Stripe (lib/stripe.js / routes/billing-stripe.js) and
 * USDC (lib/usdc-watcher.js / routes/billing-usdc.js) rails.
 *
 * Schema: lib/migrations/003_subscriptions.sql
 *
 * Design
 *   - Stripe and USDC write to the same `subscriptions` and `payment_intents`
 *     tables, keyed by `rail`. The schema is rail-agnostic; the consumers
 *     disambiguate by `rail` column.
 *   - `subscription_status` on the parent users row is synced to the active
 *     subscription row so middleware can gate without a join.
 */

import crypto from 'node:crypto';
import db from './db.js';
import config from './config.js';

// --- Prepared statements ---------------------------------------------------

const stmts = {
  insertSub: db.prepare(`
    INSERT INTO subscriptions
      (user_id, belt, status, rail, started_at, current_period_end,
       stripe_customer_id, stripe_subscription_id, usdc_sender_wallet,
       billing_channel)
    VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)
  `),

  // Upsert by stripe_subscription_id (unique per Stripe object).
  findSubByStripeId: db.prepare(`
    SELECT * FROM subscriptions WHERE stripe_subscription_id = ?
  `),
  updateSubByStripeId: db.prepare(`
    UPDATE subscriptions SET
      status = ?,
      current_period_end = ?,
      last_payment_at = COALESCE(?, last_payment_at),
      cancelled_at = CASE WHEN ? = 'cancelled' THEN datetime('now') ELSE cancelled_at END,
      billing_channel = COALESCE(?, billing_channel)
    WHERE stripe_subscription_id = ?
  `),

  findActiveSubByUser: db.prepare(`
    SELECT * FROM subscriptions
     WHERE user_id = ? AND status IN ('active','past_due','incomplete')
     ORDER BY started_at DESC LIMIT 1
  `),
  findAnySubByUser: db.prepare(`
    SELECT * FROM subscriptions WHERE user_id = ? ORDER BY started_at DESC LIMIT 1
  `),

  // Payment intents
  insertIntent: db.prepare(`
    INSERT INTO payment_intents
      (id, user_id, rail, amount_cents, status, stripe_payment_intent_id,
       usdc_sender_wallet, expires_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
  `),
  getIntent: db.prepare(`SELECT * FROM payment_intents WHERE id = ?`),
  getPendingByWallet: db.prepare(`
    SELECT * FROM payment_intents
     WHERE rail = 'usdc' AND status = 'pending' AND lower(usdc_sender_wallet) = ?
       AND (expires_at IS NULL OR expires_at > datetime('now'))
     ORDER BY created_at ASC
  `),
  confirmIntentUsdc: db.prepare(`
    UPDATE payment_intents
       SET status = 'confirmed',
           usdc_tx_hash = ?,
           confirmed_at = datetime('now')
     WHERE id = ? AND status = 'pending'
  `),
  confirmIntentStripe: db.prepare(`
    UPDATE payment_intents
       SET status = 'confirmed',
           confirmed_at = datetime('now')
     WHERE stripe_payment_intent_id = ? AND status = 'pending'
  `),
  expireStale: db.prepare(`
    UPDATE payment_intents
       SET status = 'expired'
     WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')
  `),

  // User-level subscription status mirror
  updateUserStatus: db.prepare(`
    UPDATE users SET subscription_status = ? WHERE id = ?
  `),

  // Stripe webhook dedup
  insertWebhookEvent: db.prepare(`
    INSERT OR IGNORE INTO stripe_webhook_events (event_id, type) VALUES (?, ?)
  `),
  markWebhookProcessed: db.prepare(`
    UPDATE stripe_webhook_events SET processed_at = datetime('now') WHERE event_id = ?
  `),
  isWebhookProcessed: db.prepare(`
    SELECT processed_at FROM stripe_webhook_events WHERE event_id = ? AND processed_at IS NOT NULL
  `),

  // USDC log dedup
  insertProcessedLog: db.prepare(`
    INSERT OR IGNORE INTO usdc_processed_logs
      (tx_hash, log_index, block_number, from_wallet, amount_raw)
    VALUES (?, ?, ?, ?, ?)
  `),
  hasProcessedLog: db.prepare(`
    SELECT 1 FROM usdc_processed_logs WHERE tx_hash = ? AND log_index = ?
  `),
};

// --- Public API -------------------------------------------------------------

export function generateIntentId() {
  return 'pi_rd_' + crypto.randomBytes(12).toString('hex');
}

// --- Stripe-rail helpers ----------------------------------------------------

/**
 * Upsert (insert-or-update) a subscription row from a Stripe Subscription
 * object. Called by the webhook handler.
 *
 *   stripeSub.status: 'incomplete' | 'active' | 'past_due' | 'canceled' | ...
 *     We map 'canceled' → 'cancelled' (double-l) internally.
 */
export function upsertStripeSubscription(userId, stripeSub, opts = {}) {
  const statusRaw = stripeSub.status || 'incomplete';
  const status = statusRaw === 'canceled' ? 'cancelled' : statusRaw;
  const periodEnd = stripeSub.current_period_end
    ? new Date(stripeSub.current_period_end * 1000).toISOString()
    : null;
  const lastPaymentAt = status === 'active'
    ? new Date().toISOString()
    : null;
  // billingChannel: 'personal' (default) | 'corporate_card' (Ramp). Passed
  // through to both insert and update; undefined leaves existing rows alone.
  const billingChannel = opts.billingChannel ?? null;

  const existing = stmts.findSubByStripeId.get(stripeSub.id);
  if (existing) {
    stmts.updateSubByStripeId.run(status, periodEnd, lastPaymentAt, status, billingChannel, stripeSub.id);
    return stmts.findSubByStripeId.get(stripeSub.id);
  }

  stmts.insertSub.run(
    userId,
    'black',
    status,
    'stripe',
    periodEnd,                  // current_period_end
    stripeSub.customer || null, // stripe_customer_id
    stripeSub.id,               // stripe_subscription_id
    null,                       // usdc_sender_wallet
    billingChannel || 'personal', // billing_channel (default 'personal')
  );
  return stmts.findSubByStripeId.get(stripeSub.id);
}

export function findSubscriptionByStripeId(id) {
  return stmts.findSubByStripeId.get(id);
}

export function confirmStripePaymentIntent(stripePaymentIntentId) {
  const r = stmts.confirmIntentStripe.run(stripePaymentIntentId);
  return r.changes > 0;
}

/**
 * Check+record a Stripe webhook event id. Returns true on FIRST sight,
 * false if already processed (dedup).
 */
export function recordStripeWebhookEvent(eventId, type) {
  stmts.insertWebhookEvent.run(eventId, type);
  return !stmts.isWebhookProcessed.get(eventId);
}

export function markStripeWebhookProcessed(eventId) {
  stmts.markWebhookProcessed.run(eventId);
}

// --- USDC-rail helpers ------------------------------------------------------

/**
 * Create a pending USDC payment intent. 1-hour expiry by default.
 */
export function createUsdcIntent(userId, senderWallet, amountCents, ttlSeconds = 3600) {
  const id = generateIntentId();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const wallet = String(senderWallet || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) throw new Error('invalid wallet address');
  stmts.insertIntent.run(id, userId, 'usdc', amountCents, null, wallet, expiresAt);
  return stmts.getIntent.get(id);
}

/** Look up pending usdc intents that match a sender wallet. */
export function getPendingUsdcIntentsByWallet(wallet) {
  return stmts.getPendingByWallet.all(String(wallet).toLowerCase());
}

export function getIntent(id) {
  return stmts.getIntent.get(id);
}

/** Mark a USDC intent confirmed by tx hash. Returns true if updated. */
export function confirmUsdcIntent(intentId, txHash) {
  const r = stmts.confirmIntentUsdc.run(txHash, intentId);
  return r.changes > 0;
}

/**
 * Create or update the subscription row for a USDC payment. Called once a
 * pending intent confirms via the watcher.
 */
export function activateUsdcSubscription(userId, { senderWallet, txHash, periodEndIso }) {
  const wallet = String(senderWallet).toLowerCase();
  const now = new Date().toISOString();

  // Is there already a USDC subscription for this user?
  const existing = stmts.findAnySubByUser.get(userId);
  if (existing && existing.rail === 'usdc') {
    db.prepare(`
      UPDATE subscriptions
         SET status = 'active',
             current_period_end = ?,
             usdc_sender_wallet = ?,
             last_payment_tx_hash = ?,
             last_payment_at = ?
       WHERE id = ?
    `).run(periodEndIso, wallet, txHash, now, existing.id);
    return { id: existing.id, created: false };
  }

  const r = stmts.insertSub.run(
    userId,
    'black',
    'active',
    'usdc',
    periodEndIso,
    null,        // stripe_customer_id
    null,        // stripe_subscription_id
    wallet,
    'personal',  // billing_channel — USDC is always personal for now
  );
  db.prepare(`
    UPDATE subscriptions
       SET last_payment_tx_hash = ?, last_payment_at = ?
     WHERE id = ?
  `).run(txHash, now, r.lastInsertRowid);

  return { id: r.lastInsertRowid, created: true };
}

/** Dedup a USDC log. Returns true if this is the first time we've seen it. */
export function recordUsdcLog(txHash, logIndex, blockNumber, fromWallet, amountRaw) {
  const r = stmts.insertProcessedLog.run(
    txHash, logIndex, blockNumber,
    String(fromWallet).toLowerCase(),
    String(amountRaw),
  );
  return r.changes > 0;
}

export function hasProcessedUsdcLog(txHash, logIndex) {
  return !!stmts.hasProcessedLog.get(txHash, logIndex);
}

// --- Cross-rail helpers -----------------------------------------------------

export function setUserSubscriptionStatus(userId, status) {
  stmts.updateUserStatus.run(status, userId);
}

export function getActiveSubscriptionForUser(userId) {
  return stmts.findActiveSubByUser.get(userId);
}

/** Background upkeep — called from scheduler or before intent lookups. */
export function expireStalePendingIntents() {
  return stmts.expireStale.run().changes;
}
