/**
 * Unified billing history — replaces the legacy single-rail /api/billing/history
 * with a view that unions Stripe + USDC rails from the new subscriptions stack.
 *
 * Data sources: `subscriptions` + `payment_intents` (lib/migrations/003).
 *
 * Endpoint
 *   GET /api/billing/history  (auth required, session cookie)
 *     → [{ id, rail, status, amount_cents, currency, created_at,
 *          confirmed_at, stripe_subscription_id, tx_hash, sender_wallet }]
 *
 * Authorization: session-cookie middleware attaches `user` to the context.
 * We only return rows belonging to the caller.
 */

import { Hono } from 'hono';
import db from '../lib/db.js';
import { listPaymentIntentsForUser, listSubscriptionsForUser } from '../lib/billing-history-queries.js';

const routes = new Hono();

function mapIntent(row) {
  return {
    kind: 'payment',
    id: row.id,
    rail: row.rail,
    status: row.status,
    amount_cents: row.amount_cents,
    currency: row.rail === 'usdc' ? 'USDC' : 'USD',
    created_at: row.created_at,
    confirmed_at: row.confirmed_at,
    expires_at: row.expires_at,
    stripe_payment_intent_id: row.stripe_payment_intent_id,
    tx_hash: row.usdc_tx_hash,
    sender_wallet: row.usdc_sender_wallet,
  };
}

function mapSubscription(row) {
  return {
    kind: 'subscription',
    id: row.id,
    rail: row.rail,
    status: row.status,
    belt: row.belt,
    started_at: row.started_at,
    current_period_end: row.current_period_end,
    cancelled_at: row.cancelled_at,
    last_payment_at: row.last_payment_at,
    tx_hash: row.last_payment_tx_hash,
    stripe_subscription_id: row.stripe_subscription_id,
    sender_wallet: row.usdc_sender_wallet,
  };
}

routes.get('/api/billing/history', (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  const subscriptions = listSubscriptionsForUser(db, user.id).map(mapSubscription);
  const payments = listPaymentIntentsForUser(db, user.id).map(mapIntent);

  return c.json({ subscriptions, payments });
});
export default routes;
