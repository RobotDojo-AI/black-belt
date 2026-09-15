# Stripe setup

One-time configuration Owner must complete in the Stripe dashboard so the
billing code works. Everything here is account-level state that can't be
provisioned from code without a pre-existing API key.

## 1. Secret key + webhook secret

Place the following in the macOS Keychain under service `miyagi-<NAME>`:

- `STRIPE_SECRET_KEY` — live secret key (`sk_live_...`).
- `STRIPE_WEBHOOK_SECRET` — endpoint signing secret (`whsec_...`) for the
  webhook endpoint pointed at `https://robotdojo.ai/api/billing/stripe/webhook`.
- `STRIPE_PRICE_ID` — recurring price id for Black Belt ($199/mo, USD, monthly).

## 2. RAMP_FREE_MONTH coupon

Corporate-card users (Ramp) get the first month free. Create the coupon once
in the Stripe dashboard:

- Coupon code: `RAMP_FREE_MONTH`
- Discount: `100% off`
- Duration: `once` (the coupon applies to the first invoice only)
- Max redemptions: leave unset, or cap if desired for fraud prevention

When `lib/stripe.js` `isRampCard(pm)` returns true, the subscription is
created with `discounts: [{coupon: 'RAMP_FREE_MONTH'}]`. No code change is
required when the coupon is renamed — update the constant `RAMP_COUPON` at
the top of `routes/billing-stripe.js` if you do.

## 3. Customer Portal configuration

`POST /api/billing/stripe/portal` creates a Billing Portal session. Enable
the features you want exposed to users in the dashboard:

Settings → Billing → Customer portal:
- Subscription: allow cancel at period end, allow payment method updates.
- Invoices: allow download.
- Business info / login link: on.

Default return URL is `${APP_BASE_URL}/account` (configured per request).

## 4. Webhook endpoint

Settings → Developers → Webhooks → Add endpoint:

- URL: `https://robotdojo.ai/api/billing/stripe/webhook`
- Events:
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`
- Version: latest

Copy the signing secret into `miyagi-STRIPE_WEBHOOK_SECRET`.

## 5. Ramp BIN updates

Ramp occasionally issues new card ranges. When a corporate card is missed
by Ramp detection, add the new BIN prefix to `RAMP_BIN_PREFIXES` in
`lib/stripe.js` and redeploy. The Stripe dashboard's Payment details page
shows the issuer + BIN; that's the canonical source.
