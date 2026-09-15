/**
 * Data queries for routes/billing-stripe.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */

/**
 * Returns the most recent Stripe customer ID for a user, if any.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} userId
 * @returns {{ stripe_customer_id: string } | undefined}
 */
export function getStripeCustomerId(db, userId) {
  return db.prepare(`
    SELECT stripe_customer_id FROM subscriptions
     WHERE user_id = ? AND stripe_customer_id IS NOT NULL
     ORDER BY started_at DESC LIMIT 1
  `).get(userId);
}

/**
 * Returns the email_hash for a user by ID.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} userId
 * @returns {{ email_hash: string } | undefined}
 */
export function getUserEmailHash(db, userId) {
  return db.prepare('SELECT email_hash FROM users WHERE id = ?').get(userId);
}

/**
 * Returns the user_id for the most recent subscription associated with
 * a Stripe customer ID. Used to resolve user from invoice webhooks.
 * @param {import('better-sqlite3').Database} db
 * @param {string} stripeCustomerId
 * @returns {{ user_id: string|number } | undefined}
 */
export function getUserIdByStripeCustomer(db, stripeCustomerId) {
  return db.prepare(`
    SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?
     ORDER BY started_at DESC LIMIT 1
  `).get(stripeCustomerId);
}

/**
 * Marks an existing subscription as active, updates the billing period, and
 * sets last_payment_at. Used in invoice.payment_succeeded webhook handler.
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} periodStart - ISO date string or null
 * @param {string} periodEnd - ISO datetime string
 * @param {string|number} subscriptionId - internal DB row id
 */
export function activateSubscriptionPeriod(db, periodStart, periodEnd, subscriptionId) {
  return db.prepare(`
    UPDATE subscriptions
       SET status = 'active',
           current_period_start = COALESCE(?, current_period_start),
           current_period_end = ?,
           last_payment_at = datetime('now')
     WHERE id = ?
  `).run(periodStart, periodEnd, subscriptionId);
}

/**
 * Marks a subscription as past_due by internal row ID.
 * Used in invoice.payment_failed webhook handler.
 * @param {import('better-sqlite3').Database} db
 * @param {string|number} subscriptionId - internal DB row id
 */
export function markSubscriptionPastDue(db, subscriptionId) {
  return db.prepare(`
    UPDATE subscriptions SET status = 'past_due' WHERE id = ?
  `).run(subscriptionId);
}
