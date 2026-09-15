/**
 * Data queries for routes/billing-history.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */

/**
 * Returns all payment intents for a user, newest first.
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} userId
 */
export function listPaymentIntentsForUser(db, userId) {
  return db.prepare(`
    SELECT id,
           rail,
           amount_cents,
           status,
           stripe_payment_intent_id,
           usdc_sender_wallet,
           usdc_tx_hash,
           created_at,
           confirmed_at,
           expires_at
      FROM payment_intents
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 200
  `).all(userId);
}

/**
 * Returns all subscriptions for a user, newest first.
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} userId
 */
export function listSubscriptionsForUser(db, userId) {
  return db.prepare(`
    SELECT id,
           belt,
           status,
           rail,
           started_at,
           current_period_end,
           stripe_subscription_id,
           usdc_sender_wallet,
           last_payment_tx_hash,
           last_payment_at,
           cancelled_at
      FROM subscriptions
     WHERE user_id = ?
     ORDER BY started_at DESC
  `).all(userId);
}
