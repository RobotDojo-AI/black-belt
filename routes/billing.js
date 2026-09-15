/**
 * Billing surface routes — belt toggle, value-prop card, Stripe portal redirect.
 * Story st_d9fc573b — AC 18, 19, 20.
 *
 * WHY a separate file from routes/billing-stripe.js: the Stripe routes file
 * concentrates on Stripe API plumbing (create-subscription, webhook). The
 * routes here are higher-level billing UX (belt write, copy assembly, portal
 * redirect) and benefit from a clear boundary so the spec test can mount
 * them with a minimal route surface.
 *
 * Mounted at root in index.js — declares full /api/billing/* paths internally.
 * Auth: relies on the global /api/* cookie-or-Bearer middleware
 * (lib/server.js). c.get('user') is populated upstream; we only fall back to
 * user_id=1 when only the Bearer admin token is in use (single-user local
 * install pattern).
 *
 * Thin facade: every DB read/write goes through lib/billing-queries.js.
 * No direct DB-statement calls in this file. Verified by scripts/check-thin-facade.js.
 */

import { Hono } from 'hono';
import db from '../lib/db.js';
import config from '../lib/config.js';
import {
  getBeltValueProp,
  setUserBelt,
  getStripeCustomerForUser,
  upsertStripeCustomerForUser,
} from '../lib/billing-queries.js';
import { createPortalSession, createCustomer } from '../lib/stripe.js';

const billing = new Hono();
const BILLING_ENABLED = process.env.ROBOTDOJO_BILLING_ENABLED === '1';
const ADMIN_BELT_TOGGLE_ENABLED = process.env.ROBOTDOJO_ADMIN_BELT_TOGGLE === '1';

function betaBillingDisabled(c) {
  return c.json({
    error: 'billing_disabled',
    message: 'Private beta access uses issued or prepaid Black Belt keys.',
  }, 404);
}

/**
 * GET /api/billing/value-prop — return the canonical belt value-prop body
 * sourced from coreFaq (faq-bundle.js). Same source as the public-chat FAQ
 * assistant, so the billing card and the FAQ cannot drift.
 *
 * Anonymous reads are fine (the FAQ is public) — no auth check at the
 * route level; the global middleware will 401 unauthenticated traffic
 * from production.
 */
billing.get('/api/billing/value-prop', (c) => {
  const { body, version } = getBeltValueProp();
  return c.json({ body, version });
});

/**
 * POST /api/billing/belt — set the user's belt tier on users.belt.
 * Body: { belt: 'white' | 'black' }
 *
 * WHY users.belt instead of writing to subscriptions: belt is read on
 * virtually every authenticated request. Stripe subscription state continues
 * to live in `subscriptions.belt`; this endpoint updates the denormalized
 * fast-read column on `users` only. Stripe sync (issue-key, subscription
 * lifecycle) remains in routes/billing-stripe.js — unchanged.
 */
billing.post('/api/billing/belt', async (c) => {
  if (!ADMIN_BELT_TOGGLE_ENABLED) return betaBillingDisabled(c);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const belt = body?.belt;
  if (belt !== 'white' && belt !== 'black') {
    return c.json({ error: 'invalid_belt' }, 400);
  }

  const user = c.get('user');
  const userId = user?.id ?? null;
  try {
    const persisted = setUserBelt(db, userId, belt);
    return c.json({ ok: true, belt: persisted });
  } catch (err) {
    if (err.message === 'invalid_belt') {
      return c.json({ error: 'invalid_belt' }, 400);
    }
    return c.json({ error: 'storage_failed', message: err.message }, 500);
  }
});

/**
 * POST /api/billing/portal — create a Stripe Customer Portal session and
 * 302-redirect to the hosted URL. Story st_d9fc573b — AC 20.
 *
 * WHY redirect-only (no JSON return): the AC explicitly verifies a 302
 * Location header on billing.stripe.com. Returning JSON with a URL would
 * force a second client-side hop. Stripe Portal cannot be iframed, so a
 * top-level navigation is the only sane option anyway.
 *
 * Pre-conditions: the user must have a Stripe customer ID (either from a
 * prior subscription attempt or from create-subscription's customer call).
 * No Stripe customer → 400 no_stripe_customer; the frontend surfaces that
 * as a hint to start a subscription first.
 */
billing.post('/api/billing/portal', async (c) => {
  if (!BILLING_ENABLED) return betaBillingDisabled(c);

  const user = c.get('user');
  // st_d9fc573b — fall back to user_id=1 for the single-user local install
  // pattern (Bearer-only admin token has no user context). This mirrors the
  // pattern in routes/billing-usdc.js#POST /api/billing-usdc/wallet.
  const userId = user?.id ?? 1;

  let customerId;
  try {
    customerId = getStripeCustomerForUser(db, userId);
  } catch (err) {
    return c.json({ error: 'storage_failed', message: err.message }, 500);
  }

  // st_d9fc573b AC 20 — "Manage payment & invoices" must work from any state.
  // If the user has no Stripe customer yet, create one on the fly using their
  // user metadata. This is idempotent at Stripe (idempotency key = `cust-u{id}-v1`),
  // so a re-run hits the same Customer. The placeholder subscription row is
  // marked status='unprovisioned' so billing-history/reporting don't surface it
  // as an active sub.
  if (!customerId) {
    try {
      const customer = await createCustomer(null, { userId, name: user?.display_name });
      customerId = customer?.id;
      if (customerId) upsertStripeCustomerForUser(db, userId, customerId);
    } catch (err) {
      return c.json({ error: 'stripe_customer_create_failed', message: err.message }, 500);
    }
  }
  if (!customerId) {
    return c.json({ error: 'no_stripe_customer' }, 400);
  }

  const returnUrl = `https://localhost:${config.ports.app}/account`;
  let session;
  try {
    session = await createPortalSession(customerId, returnUrl);
  } catch (err) {
    return c.json({ error: 'stripe_error', message: err.message }, 500);
  }

  if (!session?.url) {
    return c.json({ error: 'stripe_error', message: 'no_session_url' }, 500);
  }

  // 302 with Location header — matches AC 20's assertion.
  return c.redirect(session.url, 302);
});

export default billing;
