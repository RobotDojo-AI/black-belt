/**
 * Stripe HTTP client — native fetch, no SDK.
 *
 * Spec: docs/integrations/stripe.md (fetched 2026-04-16).
 * Every API call below maps to a line in that spec; do not invent endpoints.
 *
 * Surface:
 *   createCustomer(email, opts)         → POST /v1/customers
 *   createSubscription(customerId, opts)→ POST /v1/subscriptions (default_incomplete)
 *   getSubscription(id)                 → GET  /v1/subscriptions/:id
 *   cancelSubscription(id)              → DELETE /v1/subscriptions/:id
 *   verifyWebhookSignature(rawBody, sigHeader, secret) → boolean
 *   newIdempotencyKey(prefix)           → uuid-v4
 *
 * Form-encoded bodies only — Stripe rejects application/json for these
 * endpoints (spec gotcha #1). Nested params use bracket notation.
 */

import crypto from 'node:crypto';
import config from './config.js';

const API_BASE = 'https://api.stripe.com';
const WEBHOOK_TOLERANCE_SECONDS = 300; // spec: 5-minute replay window

// --- Helpers ----------------------------------------------------------------

function requireKey() {
  const key = config.stripeSecretKey;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  return key;
}

function basicAuthHeader(secretKey) {
  // Spec: HTTP Basic with secret key as username, empty password.
  return 'Basic ' + Buffer.from(`${secretKey}:`).toString('base64');
}

/**
 * Flatten a nested JS object into Stripe's bracket-style form encoding.
 *   { items: [{ price: 'p1' }], metadata: { k: 'v' } }
 *   → items[0][price]=p1&metadata[k]=v
 */
function formEncode(obj, prefix = '') {
  const parts = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        const arrayKey = `${fullKey}[${i}]`;
        if (item !== null && typeof item === 'object') {
          parts.push(formEncode(item, arrayKey));
        } else {
          parts.push(`${encodeURIComponent(arrayKey)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (typeof val === 'object') {
      parts.push(formEncode(val, fullKey));
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(val))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

export function newIdempotencyKey(prefix = 'op') {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Low-level POST with idempotency + basic-auth.
 * Returns parsed JSON on 2xx, throws with context on error.
 */
async function stripePost(path, params, { idempotencyKey } = {}) {
  const key = requireKey();
  const body = formEncode(params);
  const headers = {
    'Authorization': basicAuthHeader(key),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`[stripe] ${res.status} ${json?.error?.code || json?.error?.type || 'error'}: ${json?.error?.message || 'unknown'}`);
    err.status = res.status;
    err.stripeError = json?.error || null;
    err.path = path;
    throw err;
  }
  return json;
}

async function stripeGet(path) {
  const key = requireKey();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: { 'Authorization': basicAuthHeader(key) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`[stripe] ${res.status} ${json?.error?.code || 'error'}: ${json?.error?.message || 'unknown'}`);
    err.status = res.status;
    err.stripeError = json?.error || null;
    err.path = path;
    throw err;
  }
  return json;
}

async function stripeDelete(path) {
  const key = requireKey();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: { 'Authorization': basicAuthHeader(key) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`[stripe] ${res.status} ${json?.error?.code || 'error'}: ${json?.error?.message || 'unknown'}`);
    err.status = res.status;
    err.stripeError = json?.error || null;
    err.path = path;
    throw err;
  }
  return json;
}

// --- Public API -------------------------------------------------------------

/**
 * POST /v1/customers — spec section "POST /v1/customers".
 * Creates a Customer. Email + internal user-id metadata.
 */
export async function createCustomer(email, { userId, name, walletAddress } = {}) {
  const params = {
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    metadata: {
      ...(userId ? { robotdojo_user_id: String(userId) } : {}),
      ...(walletAddress ? { wallet_address: walletAddress } : {}),
    },
  };
  return stripePost('/v1/customers', params, {
    // Deterministic key per user — safe to retry. Spec: don't use PII as key.
    idempotencyKey: userId ? `cust-u${userId}-v1` : newIdempotencyKey('cust'),
  });
}

/**
 * POST /v1/subscriptions — spec section "POST /v1/subscriptions".
 *
 * Uses payment_behavior=default_incomplete + expand latest_invoice.payment_intent
 * so we receive a client_secret to hand to the Payment Element on the client.
 */
export async function createSubscription(customerId, { priceId, userId } = {}) {
  if (!customerId) throw new Error('customerId required');
  const price = priceId || config.stripePriceId;
  if (!price) throw new Error('priceId (or STRIPE_PRICE_ID config) required');

  const params = {
    customer: customerId,
    items: [{ price }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
    ...(userId ? { metadata: { robotdojo_user_id: String(userId) } } : {}),
  };
  return stripePost('/v1/subscriptions', params, {
    idempotencyKey: userId ? `sub-u${userId}-v1` : newIdempotencyKey('sub'),
  });
}

/** GET /v1/subscriptions/:id */
export async function getSubscription(subscriptionId) {
  if (!subscriptionId) throw new Error('subscriptionId required');
  return stripeGet(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

/** DELETE /v1/subscriptions/:id (spec: cancel) */
export async function cancelSubscription(subscriptionId) {
  if (!subscriptionId) throw new Error('subscriptionId required');
  return stripeDelete(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

// --- Webhook signature verification ----------------------------------------

/**
 * Parse Stripe-Signature header: "t=...,v1=...,v1=...".
 * Returns { t, v1: string[] } or null on malformed input.
 */
function parseSignatureHeader(header) {
  if (!header || typeof header !== 'string') return null;
  const parts = header.split(',').map(p => p.trim());
  let t = null;
  const v1s = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === 't') t = Number(v);
    else if (k === 'v1') v1s.push(v);
  }
  if (!t || v1s.length === 0) return null;
  return { t, v1: v1s };
}

/**
 * Verify a Stripe webhook signature per spec section "Signature verification".
 *
 *   rawBody:       Buffer or string — MUST be the raw request body, not re-serialized JSON
 *   sigHeader:     value of the `Stripe-Signature` request header
 *   secret:        endpoint signing secret (whsec_...)
 *   tolerance:     seconds, default 300 (spec default)
 *
 * Returns true on valid + fresh signature. Constant-time compare.
 */
export function verifyWebhookSignature(rawBody, sigHeader, secret, tolerance = WEBHOOK_TOLERANCE_SECONDS) {
  if (!secret) return false;
  const parsed = parseSignatureHeader(sigHeader);
  if (!parsed) return false;

  // Replay protection
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.t) > tolerance) return false;

  // Build signed payload: "<t>.<rawBody>"
  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const signed = Buffer.concat([
    Buffer.from(`${parsed.t}.`, 'utf8'),
    bodyBuf,
  ]);

  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');

  // Stripe can supply multiple v1 signatures (key rotation). Accept if any match.
  for (const v1 of parsed.v1) {
    const cand = Buffer.from(v1, 'utf8');
    if (cand.length !== expectedBuf.length) continue;
    try {
      if (crypto.timingSafeEqual(cand, expectedBuf)) return true;
    } catch {
      // length mismatch — try next
    }
  }
  return false;
}

// --- Ramp corporate-card detection -----------------------------------------

/**
 * BIN prefixes used by Ramp's Visa business cards. The Stripe PaymentMethod
 * object exposes the card issuer under `card.issuer` when Stripe can identify
 * it — we check issuer first and fall back to BIN prefix matching if issuer
 * is missing.
 *
 * Keep this list updatable: when Ramp issues new BIN ranges, add them here.
 * Last verified: 2026-04 via Stripe BIN lookup tool.
 */
export const RAMP_BIN_PREFIXES = ['440393', '440394', '558158'];

/**
 * Identify whether a Stripe PaymentMethod was issued by Ramp. Used by the
 * subscription flow to attach a first-month-free coupon for corporate card
 * users (see RAMP_FREE_MONTH coupon in docs/stripe-setup.md).
 *
 * We prefer the structured `card.issuer` field when present — Stripe
 * normalises the issuer name (e.g. "Ramp Business Corporation"). When the
 * issuer is blank we check the first six digits of the card (the BIN) against
 * known Ramp ranges.
 */
export function isRampCard(paymentMethod) {
  const issuer = (paymentMethod?.card?.issuer || '').toUpperCase();
  if (issuer.includes('RAMP')) return true;

  const bin = paymentMethod?.card?.iin || paymentMethod?.card?.bin || null;
  if (bin && RAMP_BIN_PREFIXES.some(p => String(bin).startsWith(p))) return true;

  return false;
}

/**
 * POST /v1/subscriptions with a coupon applied. Separate from
 * createSubscription() so the Ramp path is explicit at the call site rather
 * than being a hidden default. The idempotency key includes the coupon so
 * switching from regular → coupon retry does not replay the plain-price row.
 */
export async function createSubscriptionWithCoupon(customerId, { priceId, userId, coupon } = {}) {
  if (!customerId) throw new Error('customerId required');
  if (!coupon) throw new Error('coupon required');
  const price = priceId || config.stripePriceId;
  if (!price) throw new Error('priceId (or STRIPE_PRICE_ID config) required');

  const params = {
    customer: customerId,
    items: [{ price }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    discounts: [{ coupon }],
    expand: ['latest_invoice.payment_intent'],
    ...(userId ? { metadata: { robotdojo_user_id: String(userId) } } : {}),
  };
  return stripePost('/v1/subscriptions', params, {
    idempotencyKey: userId ? `sub-u${userId}-${coupon}-v1` : newIdempotencyKey('sub'),
  });
}

// --- Billing Portal (customer self-service) --------------------------------

/**
 * POST /v1/billing_portal/sessions — create a one-time URL where the customer
 * can manage their subscription (cancel, update payment method, download
 * invoices). Configure the portal's feature set in the Stripe dashboard.
 */
export async function createPortalSession(customerId, returnUrl) {
  if (!customerId) throw new Error('customerId required');
  if (!returnUrl) throw new Error('returnUrl required');
  const params = { customer: customerId, return_url: returnUrl };
  return stripePost('/v1/billing_portal/sessions', params);
}

/** Retrieve a payment method (used to inspect `card.issuer` etc.) */
export async function getPaymentMethod(paymentMethodId) {
  if (!paymentMethodId) throw new Error('paymentMethodId required');
  return stripeGet(`/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`);
}

// --- Exports for test harness ----------------------------------------------
export const _internal = { formEncode, parseSignatureHeader, WEBHOOK_TOLERANCE_SECONDS };
