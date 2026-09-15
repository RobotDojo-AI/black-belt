/**
 * Stripe billing routes (mounted at /api/billing/stripe).
 *
 * Spec: docs/integrations/stripe.md (fetched 2026-04-16)
 *
 * Endpoints
 *   POST /api/billing/stripe/create-subscription   (auth required)
 *   POST /api/billing/stripe/webhook               (public; HMAC verified)
 *
 * Webhook event handling (spec "Events we subscribe to"):
 *   customer.subscription.created  → upsert, status likely 'incomplete'
 *   customer.subscription.updated  → sync status + period end; on active → issue key
 *   customer.subscription.deleted  → cancelled; revoke key
 *   invoice.payment_succeeded      → upsert sub as active; issue key
 *   invoice.payment_failed         → mark past_due
 *
 * Webhook handler design
 *   - Raw body required for signature verification (spec gotcha #2).
 *   - Uses Hono's c.req.text() which gives us the body bytes unchanged,
 *     before any JSON parsing touches them.
 *   - Dedup on event.id (spec: "Stripe may redeliver").
 *   - Return 200 quickly (spec: <5s). We do the DB work inline since it's
 *     single-digit ms; key-issuance is awaited (HTTP call to gateway).
 */

import { Hono } from 'hono';
import {
  createCustomer,
  createSubscription,
  createSubscriptionWithCoupon,
  createPortalSession,
  getPaymentMethod,
  isRampCard,
  verifyWebhookSignature,
} from '../lib/stripe.js';
import {
  upsertStripeSubscription,
  recordStripeWebhookEvent,
  markStripeWebhookProcessed,
  confirmStripePaymentIntent,
  setUserSubscriptionStatus,
  findSubscriptionByStripeId,
} from '../lib/subscriptions.js';
import { issueKey, revokeKey } from '../lib/key-issuance.js';
import { getUserByEmail } from '../lib/magic-link.js';
import config from '../lib/config.js';
import db from '../lib/db.js';
import {
  getStripeCustomerId,
  getUserEmailHash,
  getUserIdByStripeCustomer,
  activateSubscriptionPeriod,
  markSubscriptionPastDue,
} from '../lib/billing-stripe-queries.js';

// Stripe coupon code for first-month-free on corporate (Ramp) cards.
// Created manually in Stripe dashboard — see docs/stripe-setup.md.
const RAMP_COUPON = 'RAMP_FREE_MONTH';

const billingStripe = new Hono();
const BILLING_ENABLED = process.env.ROBOTDOJO_BILLING_ENABLED === '1';

function betaBillingDisabled(c) {
  return c.json({
    error: 'billing_disabled',
    message: 'Private beta access uses issued or prepaid Black Belt keys.',
  }, 404);
}

// --- Public endpoint: Stripe publishable key for the frontend ---------------

/**
 * GET /api/billing/stripe/key
 *
 * Returns the Stripe publishable key so the frontend can initialise Stripe.js
 * without embedding the key in HTML. Returns null when Stripe is not
 * configured so the UI can show a graceful fallback.
 */
billingStripe.get('/key', (c) => {
  if (!BILLING_ENABLED) return c.json({ publishableKey: null, disabled: true });

  const publishableKey = config.stripePublishableKey || null;
  return c.json({ publishableKey });
});

// --- Authenticated endpoint: start a subscription --------------------------

/**
 * POST /api/billing/stripe/create-subscription
 *
 * Uses the session-cookie auth middleware (c.var.user set by requireAuth).
 * Idempotent per user — if we already have a Stripe customer row we reuse it.
 *
 * Response: { clientSecret, subscriptionId } — clientSecret is handed to
 * the Payment Element on the client (spec "Payment Element").
 */
billingStripe.post('/create-subscription', async (c) => {
  if (!BILLING_ENABLED) return betaBillingDisabled(c);

  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  // Optional: a PaymentMethod the client pre-collected so we can detect Ramp
  // (corporate card) *before* creating the subscription and apply the
  // first-month-free coupon on the first invoice. Without this, Ramp
  // detection falls back to the post-hoc path in handleSubscriptionEvent().
  let paymentMethodId = null;
  try {
    const body = await c.req.json().catch(() => null);
    paymentMethodId = body?.paymentMethodId || null;
  } catch { /* no body, no PM — plain path */ }

  try {
    // Find any prior subscription row for this user to reuse Stripe customer.
    const prior = getStripeCustomerId(db, user.id);

    let customerId = prior?.stripe_customer_id || null;
    if (!customerId) {
      const customer = await createCustomer(user.email, {
        userId: user.id,
        name: null,
      });
      customerId = customer.id;
    }

    // Ramp detection — if the client pre-attached a PM, inspect it.
    let isRamp = false;
    if (paymentMethodId) {
      try {
        const pm = await getPaymentMethod(paymentMethodId);
        isRamp = isRampCard(pm);
      } catch (err) {
        // Non-fatal — continue with standard sub creation.
        console.warn('[billing-stripe] PM lookup failed:', err.message);
      }
    }

    const sub = isRamp
      ? await createSubscriptionWithCoupon(customerId, {
          userId: user.id,
          coupon: RAMP_COUPON,
        })
      : await createSubscription(customerId, { userId: user.id });

    // Persist row immediately so the webhook can find it on its first event.
    upsertStripeSubscription(user.id, sub, {
      billingChannel: isRamp ? 'corporate_card' : 'personal',
    });

    // Spec: latest_invoice.payment_intent.client_secret is the Payment
    // Element client_secret. It's only present because we expanded it.
    const clientSecret =
      sub?.latest_invoice?.payment_intent?.client_secret || null;

    if (!clientSecret) {
      return c.json({ error: 'no_client_secret', subscriptionId: sub.id }, 500);
    }

    return c.json({
      clientSecret,
      subscriptionId: sub.id,
      customerId,
      billingChannel: isRamp ? 'corporate_card' : 'personal',
      couponApplied: isRamp ? RAMP_COUPON : null,
    });
  } catch (err) {
    console.error('[billing-stripe] create-subscription failed:', err.message);
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return c.json({ error: err.stripeError?.code || 'stripe_error', message: err.message }, status);
  }
});

// --- Authenticated endpoint: Stripe Customer Portal ------------------------

/**
 * POST /api/billing/stripe/portal
 *
 * Creates a one-time Billing Portal session and returns the URL. The client
 * redirects the browser to `url`; Stripe handles cancellation, payment-method
 * updates, and invoice downloads. On exit the portal sends the user back to
 * `${APP_BASE_URL}/account`.
 *
 * Requires a Stripe customer row; if none exists we 404 so the UI can
 * prompt the user to subscribe first.
 */
billingStripe.post('/portal', async (c) => {
  if (!BILLING_ENABLED) return betaBillingDisabled(c);

  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  const row = getStripeCustomerId(db, user.id);
  if (!row?.stripe_customer_id) {
    return c.json({
      error: 'no_customer',
      message: 'No billing record found for this account. If you believe this is an error, contact hello@robotdojo.ai.',
    }, 404);
  }

  const returnUrl = `${config.appBaseUrl}/account`;
  try {
    const session = await createPortalSession(row.stripe_customer_id, returnUrl);
    return c.json({ url: session.url });
  } catch (err) {
    console.error('[billing-stripe] portal session failed:', err.message);
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return c.json({
      error: 'portal_failed',
      message: 'Could not open the billing portal. Please try again or contact hello@robotdojo.ai if the problem persists.',
    }, status);
  }
});

// --- Public webhook: Stripe event receiver ---------------------------------

/**
 * POST /api/billing/stripe/webhook
 *
 * Must be PUBLIC (no auth middleware). Spec requires signature verification
 * against raw body.
 *
 * Important mounting note
 *   The webhook path `/api/billing/stripe/webhook` is in the PUBLIC_ROUTES
 *   allowlist in lib/server.js so requireAuth() does NOT block it.
 */
billingStripe.post('/webhook', async (c) => {
  if (!BILLING_ENABLED) return betaBillingDisabled(c);

  const sigHeader = c.req.header('stripe-signature');
  const webhookSecret = config.stripeWebhookSecret;
  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured');
    return c.json({ error: 'not_configured' }, 500);
  }
  if (!sigHeader) return c.json({ error: 'missing_signature' }, 400);

  // Raw body — Hono's text() returns the undecoded body. We must NOT parse
  // as JSON before verification, per spec gotcha #2.
  const rawBody = await c.req.text();
  if (!verifyWebhookSignature(rawBody, sigHeader, webhookSecret)) {
    return c.json({ error: 'invalid_signature' }, 400);
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  // Dedup by event.id — Stripe may redeliver for up to 3 days.
  const fresh = recordStripeWebhookEvent(event.id, event.type);
  if (!fresh) {
    return c.json({ received: true, deduped: true });
  }

  try {
    await handleEvent(event);
    markStripeWebhookProcessed(event.id);
  } catch (err) {
    // Return 500 so Stripe retries. processed_at stays NULL so the retry reprocesses.
    console.error(`[stripe-webhook] handler failed (${event.type} ${event.id}):`, err.message);
    return c.json({ error: 'handler_failed' }, 500);
  }

  return c.json({ received: true });
});

// --- Event handlers --------------------------------------------------------

async function handleEvent(event) {
  switch (event.type) {
    case 'customer.subscription.created':
      return handleSubscriptionEvent(event, /* activate */ false);

    case 'customer.subscription.updated':
      return handleSubscriptionEvent(event, /* activate */ true);

    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(event);

    case 'invoice.payment_succeeded':
      return handleInvoicePaymentSucceeded(event);

    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(event);

    default:
      // Per spec we deliberately ignore some event types; just no-op.
      console.info(`[stripe-webhook] ignored event type: ${event.type}`);
      return;
  }
}

/**
 * Resolve the robotdojo user_id for a Stripe event payload.
 *   1. metadata.robotdojo_user_id (we set this at create-subscription time)
 *   2. existing subscription row by stripe_subscription_id
 *   3. customer email lookup
 */
function resolveUserId(stripeObject, fallbackSubId = null) {
  const metaId = stripeObject?.metadata?.robotdojo_user_id;
  if (metaId) return Number(metaId);

  const subId = stripeObject?.id || fallbackSubId;
  if (subId) {
    const row = findSubscriptionByStripeId(subId);
    if (row) return row.user_id;
  }

  // Fallback by customer email if we expanded it (rare on webhooks — Stripe
  // usually just sends customer ID). Graceful-degrade to null.
  return null;
}

async function handleSubscriptionEvent(event, mayActivate) {
  const sub = event.data?.object;
  if (!sub || sub.object !== 'subscription') return;

  const userId = resolveUserId(sub);
  if (!userId) {
    console.warn(`[stripe-webhook] cannot resolve user for sub ${sub.id}`);
    return;
  }

  // Post-hoc Ramp detection: if the default PM is now known, inspect it and
  // record the billing channel. (The pre-creation path in /create-subscription
  // is the primary detector; this is the fallback for flows where the PM is
  // only known after confirmation.)
  let billingChannel = null;
  const defaultPmId = typeof sub.default_payment_method === 'string'
    ? sub.default_payment_method
    : sub.default_payment_method?.id || null;
  if (defaultPmId) {
    try {
      const pm = await getPaymentMethod(defaultPmId);
      billingChannel = isRampCard(pm) ? 'corporate_card' : 'personal';
    } catch (err) {
      console.warn('[stripe-webhook] PM lookup failed:', err.message);
    }
  }

  const row = upsertStripeSubscription(userId, sub, { billingChannel });
  if (sub.status === 'active') {
    setUserSubscriptionStatus(userId, 'black');
    if (mayActivate) {
      const u = getUserEmailHash(db, userId);
      if (u?.email_hash) {
        const periodStart = sub.current_period_start
          ? new Date(sub.current_period_start * 1000).toISOString().slice(0, 10)
          : null;
        await issueKey(u.email_hash, { billingPeriodStart: periodStart });
      }
    }
  } else if (sub.status === 'past_due' || sub.status === 'unpaid') {
    setUserSubscriptionStatus(userId, 'none');
  } else if (sub.status === 'canceled') {
    setUserSubscriptionStatus(userId, 'cancelled');
  }
  return row;
}

async function handleSubscriptionDeleted(event) {
  const sub = event.data?.object;
  if (!sub) return;
  const userId = resolveUserId(sub);
  if (!userId) return;

  upsertStripeSubscription(userId, { ...sub, status: 'canceled' });
  setUserSubscriptionStatus(userId, 'cancelled');

  // WHY no revokeKey here: the 30-day key TTL handles natural expiry. The key
  // was issued at the last payment; it expires at that +30 days, which aligns
  // with Stripe sending this event at period end. Immediate force-revoke is
  // available via the admin endpoint for fraud/ToS cases only.
}

async function handleInvoicePaymentSucceeded(event) {
  const invoice = event.data?.object;
  if (!invoice || invoice.object !== 'invoice') return;

  const subId = invoice.subscription;
  const customerId = invoice.customer;
  const paymentIntentId = invoice.payment_intent;

  // Confirm any matching pending payment_intent row (from client-side flow).
  if (paymentIntentId) confirmStripePaymentIntent(paymentIntentId);

  // Resolve user via existing subscription row (it was written on
  // create-subscription).
  const existing = subId ? findSubscriptionByStripeId(subId) : null;
  let userId = existing?.user_id || null;

  if (!userId && customerId) {
    const row = getUserIdByStripeCustomer(db, customerId);
    userId = row?.user_id || null;
  }
  if (!userId) {
    console.warn(`[stripe-webhook] payment_succeeded: cannot resolve user (invoice=${invoice.id})`);
    return;
  }

  // Mark sub active + bump period.
  const lineItem = invoice.lines?.data?.[0];
  const periodStart = lineItem?.period?.start
    ? new Date(lineItem.period.start * 1000).toISOString().slice(0, 10)
    : null;
  if (existing) {
    const periodEnd = lineItem?.period?.end
      ? new Date(lineItem.period.end * 1000).toISOString()
      : existing.current_period_end;
    activateSubscriptionPeriod(db, periodStart, periodEnd, existing.id);
  }
  setUserSubscriptionStatus(userId, 'black');

  const u = getUserEmailHash(db, userId);
  if (u?.email_hash) {
    try { await issueKey(u.email_hash, { billingPeriodStart: periodStart }); }
    catch (err) { console.error(`[stripe-webhook] issueKey failed: ${err.message}`); }
  }
}

async function handleInvoicePaymentFailed(event) {
  const invoice = event.data?.object;
  if (!invoice) return;
  const subId = invoice.subscription;
  if (!subId) return;

  const existing = findSubscriptionByStripeId(subId);
  if (!existing) return;

  markSubscriptionPastDue(db, existing.id);
  setUserSubscriptionStatus(existing.user_id, 'none');
}

export default billingStripe;
