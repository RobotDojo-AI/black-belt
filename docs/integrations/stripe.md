# Stripe Integration Spec

**Source docs:**
- https://docs.stripe.com/api/authentication
- https://docs.stripe.com/api/customers/create
- https://docs.stripe.com/api/subscriptions/create
- https://docs.stripe.com/billing/subscriptions/build-subscriptions
- https://docs.stripe.com/billing/subscriptions/webhooks
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/api/idempotent_requests
- https://docs.stripe.com/api/events/types
- https://docs.stripe.com/error-codes
- https://docs.stripe.com/rate-limits
- https://docs.stripe.com/payments/elements

**Fetched:** 2026-04-16
**For:** Robot Dojo — $199/mo Black Belt subscription. Card collection via Payment Element embedded in chat. Webhook triggers encryption-key issuance over the tunnel gateway.

---

## Authentication

**HTTP Basic Auth** (recommended by Stripe): secret key as username, empty password.

```
-u sk_test_xxxxxxxx:
```

Equivalent `Authorization` header (for non-curl clients):
```
Authorization: Basic <base64(sk_test_xxxxxxxx:)>
```

Also supported: `Authorization: Bearer sk_test_xxxxxxxx` (for cross-origin contexts).

**Key prefixes:**
| Key type | Test prefix | Live prefix | Where it lives |
|---|---|---|---|
| Secret | `sk_test_` | `sk_live_` | server only, Keychain `STRIPE_SECRET_KEY` |
| Publishable | `pk_test_` | `pk_live_` | client (chat app), safe to expose |
| Restricted | `rk_test_` | `rk_live_` | scoped permissions (we don't need for v0) |
| Webhook signing | `whsec_` (same prefix test + live) | — | per-endpoint, Keychain `STRIPE_WEBHOOK_SECRET` |

All requests MUST use HTTPS. HTTP returns 403.

---

## Endpoints we use

### POST /v1/customers

**URL:** `https://api.stripe.com/v1/customers`

**Purpose:** Create a Stripe customer object for Owner's user the first time they hit the paywall.

**Headers:**
- `Authorization: Basic <base64(sk_live_...:)>`
- `Content-Type: application/x-www-form-urlencoded`
- `Idempotency-Key: <uuid v4>` (strongly recommended)

**Request body** (form-urlencoded, not JSON):
- `email` (string, max 512 chars)
- `name` (string, max 256 chars)
- `description` (string)
- `metadata[robotdojo_user_id]` (string) — our internal user ID
- `metadata[wallet_address]` (string, optional) — Base wallet if they preferred crypto first

**Success response (201):** Customer object, top-level fields:
```json
{
  "id": "cus_Na6dX7aXxi11N4",
  "object": "customer",
  "email": "user@example.com",
  "name": "Owner Example",
  "balance": 0,
  "created": 1679609767,
  "metadata": { "robotdojo_user_id": "u_abc123" },
  "invoice_settings": { "default_payment_method": null },
  "tax_exempt": "none"
}
```

**Example curl:**
```bash
curl https://api.stripe.com/v1/customers \
  -u sk_live_xxxxx: \
  -H "Idempotency-Key: cust-u_abc123-v1" \
  -d "email=user@example.com" \
  -d "name=Owner Example" \
  -d "metadata[robotdojo_user_id]=u_abc123"
```

---

### POST /v1/subscriptions

**URL:** `https://api.stripe.com/v1/subscriptions`

**Purpose:** Start the $199/mo Black Belt subscription for a customer.

**Headers:** same auth + idempotency key (e.g. `sub-u_abc123-v1`).

**Required params:**
- `customer` — `cus_...` from step 1
- `items[0][price]` — our $199/mo price ID (e.g. `price_1Abc...`; provisioned in Stripe dashboard, stored in config)

**Recommended params for our flow (Payment Element, collect-at-create):**
- `payment_behavior=default_incomplete` — creates subscription in `incomplete` state with a PaymentIntent attached
- `payment_settings[save_default_payment_method]=on_subscription` — auto-attach the confirmed PM
- `expand[0]=latest_invoice.payment_intent` — returns the `client_secret` we hand to Payment Element

**Optional params we might use:**
- `metadata[robotdojo_user_id]` — mirror our user ID onto subscription
- `trial_period_days` — not planned for v0
- `collection_method=charge_automatically` (default)

**Success response (201):** Subscription object. Critical fields for us:
```json
{
  "id": "sub_1MowQVLkdIwHu7ixeRlqHVzs",
  "object": "subscription",
  "status": "incomplete",
  "customer": "cus_Na6dX7aXxi11N4",
  "current_period_start": 1679609767,
  "current_period_end": 1682288167,
  "cancel_at_period_end": false,
  "items": { "data": [{ "id": "si_...", "price": { "id": "price_...", "unit_amount": 19900, "recurring": { "interval": "month" } } }] },
  "latest_invoice": {
    "id": "in_...",
    "payment_intent": {
      "id": "pi_...",
      "client_secret": "pi_..._secret_...",
      "status": "requires_payment_method"
    }
  },
  "metadata": { "robotdojo_user_id": "u_abc123" },
  "livemode": true
}
```

We hand `latest_invoice.payment_intent.client_secret` to the Payment Element on the client.

**Example curl:**
```bash
curl https://api.stripe.com/v1/subscriptions \
  -u sk_live_xxxxx: \
  -H "Idempotency-Key: sub-u_abc123-v1" \
  -d customer=cus_Na6dX7aXxi11N4 \
  -d "items[0][price]=price_1Abc..." \
  -d payment_behavior=default_incomplete \
  -d "payment_settings[save_default_payment_method]=on_subscription" \
  -d "expand[0]=latest_invoice.payment_intent" \
  -d "metadata[robotdojo_user_id]=u_abc123"
```

Status transitions: `incomplete` → (user confirms PaymentIntent) → `active` via webhook.

---

### POST /v1/subscriptions/:id (update)
### DELETE /v1/subscriptions/:id (cancel)

Not used in launch flow. Cancellation will be implemented in v0.2 via dashboard or `cancel_at_period_end=true`.

---

## Payment Element (client-side)

**Source doc:** https://docs.stripe.com/payments/elements

**Script:**
```html
<script src="https://js.stripe.com/v3/"></script>
```

**Minimum client flow:**
```js
const stripe = Stripe('pk_live_xxxxx');
const elements = stripe.elements({ clientSecret: '<pi_..._secret_...>' });
const paymentElement = elements.create('payment');
paymentElement.mount('#payment-element');

// on submit:
const { error } = await stripe.confirmPayment({
  elements,
  confirmParams: { return_url: 'https://robotdojo.ai/chat?pay=done' },
  redirect: 'if_required'
});
```

**Key points:**
- Uses a **PaymentIntent client_secret** (not SetupIntent) because we want to charge the first invoice immediately.
- `redirect: 'if_required'` keeps the user in-chat unless the card requires 3DS.
- On success the PI transitions to `succeeded`, Stripe marks the invoice paid, subscription flips to `active`, and webhooks fire.

**Never trust client-side success.** Rely on the `customer.subscription.updated` or `invoice.payment_succeeded` webhook before issuing the encryption key.

---

## Webhooks

**Endpoint we expose:** `POST https://api.robotdojo.ai/webhooks/stripe`

Must return 2xx within **a few seconds** — do heavy work async (e.g. push to a job queue before responding). Stripe retries on non-2xx for **up to 3 days** (live) with exponential backoff.

### Events we subscribe to

| Event | When it fires | Our action |
|---|---|---|
| `customer.subscription.created` | Subscription row written (status may be `incomplete`) | Mark user as `pending_payment`. No access yet. |
| `customer.subscription.updated` | Any change; most importantly `status: incomplete → active` | If `status=active`: issue encryption key via tunnel gateway, grant Black Belt role. If `past_due`/`unpaid`: downgrade. |
| `customer.subscription.deleted` | Subscription ended (cancel or non-payment) | Revoke Black Belt role at `current_period_end`. |
| `invoice.payment_succeeded` | Any recurring payment clears | Renew access through next `current_period_end`. Log payment. |
| `invoice.payment_failed` | Card declined, etc. | Notify user, retain access until Stripe's retry schedule gives up, then `customer.subscription.updated` → `past_due`. |

We deliberately ignore: `customer.subscription.trial_will_end` (no trial), `customer.subscription.paused/resumed` (no pausing), `invoice.finalized`, `invoice.paid` (duplicate of `payment_succeeded`).

### Webhook payload structure (top-level)

```json
{
  "id": "evt_1Abc...",
  "object": "event",
  "type": "customer.subscription.updated",
  "created": 1234567890,
  "livemode": true,
  "api_version": "2024-11-20.acacia",
  "request": { "id": "req_...", "idempotency_key": "..." },
  "data": {
    "object": { /* Subscription | Invoice | Customer — matches `type` */ },
    "previous_attributes": { /* diff from prior state, only on *.updated events */ }
  }
}
```

### Signature verification (MANDATORY before trusting payload)

**Header:** `Stripe-Signature`

Format:
```
Stripe-Signature: t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```
(Ignore `v0=` — it is a dummy value Stripe uses for testing only.)

**Verification algorithm:**
1. Split header on `,`, then each element on `=` to get `t` and `v1`.
2. Build signed payload: `<t>.<raw request body>` (must be the raw bytes, not a re-serialized JSON).
3. Compute HMAC-SHA256 over the signed payload using the endpoint signing secret (`whsec_...`) as the key.
4. Hex-encode the HMAC and compare to `v1` using constant-time comparison.
5. Verify `abs(now - t) <= 300` seconds (default tolerance). Reject older payloads to prevent replay.

**Minimal Node implementation (no Stripe SDK):**
```js
import crypto from 'node:crypto';

function verifyStripe(rawBody, sigHeader, secret, tolerance = 300) {
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > tolerance) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

**Critical:** the `rawBody` must be the unparsed request body. If any middleware (JSON parser, pretty-printer, charset normalizer) touches the bytes, the HMAC will not match. Grab `req.rawBody` before parsing.

### Retry policy

- Live mode: retries for **3 days** with exponential backoff.
- Sandbox: 3 retries over hours.
- Manual retries: up to 15 days via dashboard, 30 days via CLI.
- Idempotency on our side: dedupe by `event.id` in a table; Stripe may redeliver.

---

## Idempotency keys

- Header: `Idempotency-Key`
- Supported on **every POST**. Ignored on GET/DELETE (already idempotent).
- Key length: up to 255 chars.
- Recommended: UUID v4 or a deterministic value like `sub-u_abc123-v1` (safe because we bump the suffix on retry).
- Server stores result for **at least 24h**. Same key → same response (including 5xx).
- **Do NOT** use sensitive data (email, PII) as the key.
- If parameters fail validation before the endpoint executes, the key is not stored and is reusable.

---

## Rate limits

- **Live mode:** 100 requests/sec global.
- **Sandbox/test:** 25 requests/sec.
- Per-endpoint default: 25 rps.
- Subscriptions specifically: 10 new invoices/min, 20/day per customer, 200 quantity updates/hour.

429 response carries `Stripe-Rate-Limited-Reason` header (`global-rate`, `endpoint-rate`, `resource-rate`).

**Handling:** exponential backoff with jitter. Start 1s, double, cap at 30s, max 5 retries. For 99 users we will never come close to rate limits.

---

## Error codes

HTTP status mapping:
- `400` — validation (`invalid_request_error`)
- `401` — auth (`api_key_expired`, missing key)
- `402` — card declined (`card_error`)
- `403` — forbidden
- `404` — resource not found
- `409` — idempotency conflict (`idempotency_key_in_use`)
- `429` — rate limited (`rate_limit_error`)
- `5xx` — Stripe-side; retry

Error body:
```json
{
  "error": {
    "type": "card_error",
    "code": "card_declined",
    "decline_code": "insufficient_funds",
    "message": "The card has been declined",
    "doc_url": "https://docs.stripe.com/error-handling",
    "param": "source",
    "request_log_url": "<Stripe dashboard request log URL>"
  }
}
```

Always log `error.request_log_url` — lets us jump straight to the Stripe log for that request.

---

## Pricing at our scale

- Stripe fee: **2.9% + $0.30** per successful card charge (US, domestic).
- $199 × (0.029) + $0.30 = **$6.07 per subscription per month**.
- 99 users × $199 gross = $19,701/mo. Stripe fees ≈ $601/mo.
- No platform fee, no monthly fee on standard Stripe.
- International cards add 1.5% (not modeled for launch).

---

## Test vs live

- Use `sk_test_*` + `pk_test_*` keys + test webhook endpoint for dev.
- Card for end-to-end test: `4242 4242 4242 4242`, any future expiry, any CVC.
- 3DS test card: `4000 0027 6000 3184`.
- Webhook endpoints are per-mode: create one for test, one for live, each with its own `whsec_...`.

---

## Gotchas / footguns

1. **Form-encoded bodies, not JSON.** `/v1/customers` and `/v1/subscriptions` reject `application/json`. Nested params use bracket notation: `metadata[key]=value`, `items[0][price]=...`.
2. **Raw body for webhook signature.** JSON-parse middleware will silently break verification.
3. **`payment_behavior=default_incomplete`** is mandatory for in-app Payment Element flow. Without it, subscription goes straight to `active` without a PaymentIntent — there's nothing to mount.
4. **Subscription status `trialing` without trial** can happen if `trial_period_days` is set anywhere. Audit before launch.
5. **Currency is implicit** via the Price object. Make sure our Price is USD; crypto checkout uses USDC on Base separately.
6. **Webhook timeouts:** Stripe treats >5s as a failure. Push to queue, return 200 immediately.
7. **`event.type` strings include the dot** (e.g. `customer.subscription.updated`). Beware camelCase constants in some SDKs — the wire value is always dotted.
8. **Test mode events can be redelivered for 30 days**. Make sure your event-dedupe table has a TTL aligned with the mode.
9. **`expand[]` is an array param** even when you expand one field. Use `expand[0]=...`.
10. **API version pinning:** Set a fixed version in the dashboard (e.g. `2024-11-20.acacia`). Otherwise Stripe upgrades your webhook payloads and fields shift.

---

## What we DON'T use

- `POST /v1/checkout/sessions` — no hosted Checkout; we use Payment Element for in-chat UX.
- `POST /v1/setup_intents` — we charge immediately, not setup-first.
- `POST /v1/invoices` — invoicing is auto-generated by subscriptions.
- `POST /v1/prices` and `POST /v1/products` — one-time dashboard setup, not runtime.
- `POST /v1/payment_links` — no shareable pay links.
- Stripe Tax, Stripe Connect, Stripe Identity, Terminal, Radar custom rules — all out of scope.
- Stripe Node SDK — we use native `fetch` + HMAC verification. SDK acceptable if a future agent prefers, but raw HTTP stays canonical.
