# Resend Integration Spec

**Source docs:**
- https://resend.com/docs/api-reference/emails/send-email
- https://resend.com/docs/dashboard/domains/introduction
- https://resend.com/docs/api-reference/errors (referenced, not directly fetched)

**Fetched:** 2026-04-16
**For:** Robot Dojo — transactional email (magic link auth) from `hello@robotdojo.ai`

---

## Authentication

Bearer token in `Authorization` header. Keys are provisioned per environment from the Resend dashboard.

```
Authorization: Bearer re_xxxxxxxxx
Content-Type: application/json
```

- Test/sandbox keys and live keys share the `re_` prefix (no `re_test_`/`re_live_` split like Stripe — rely on the dashboard project to partition).
- Store in macOS Keychain: `RESEND_API_KEY`.

---

## Endpoints we use

### POST /emails

**URL:** `https://api.resend.com/emails`

**Purpose:** Send a single transactional email (magic link).

**Headers:**
- `Authorization: Bearer re_xxxxxxxxx` (required)
- `Content-Type: application/json` (required)
- `Idempotency-Key: <string>` (optional, max 256 chars, deduplicates for 24h)

**Request body schema (exact fields):**

Required:
- `from` (string) — sender, format `"Display Name <sender@domain>"` or bare email
- `to` (string | string[]) — recipient(s), max 50 addresses
- `subject` (string) — subject line

Optional:
- `html` (string) — HTML body
- `text` (string) — plain-text body
- `cc` (string | string[])
- `bcc` (string | string[])
- `reply_to` (string | string[])
- `headers` (object) — custom SMTP headers (e.g. `List-Unsubscribe`)
- `scheduled_at` (string) — ISO 8601 or natural language (e.g. `"in 1 hour"`)
- `tags` (array of `{name, value}`) — ASCII only, max 256 chars per field
- `attachments` (array of `{content, filename, path, content_type, content_id}`)
- `template` (object `{id, variables}`) — template-based sends
- `topic_id` (string) — for opt-in/opt-out routing
- `react` (ReactNode) — Node SDK only, do not use from native `fetch`

**Success response (200):**
```json
{
  "id": "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"
}
```

The `id` is the Resend email ID. Store it alongside the magic-link token if we ever need to debug bounces.

**Error codes:**
- `400` — validation (missing `from`/`to`/`subject`, invalid email)
- `401` — invalid/missing API key
- `403` — domain not verified (when sending from an unverified domain)
- `422` — rejected by provider (bad sender, spam patterns)
- `429` — rate-limit exceeded
- `5xx` — Resend-side error; retry with exponential backoff

Error body shape (observed, confirm per call):
```json
{
  "statusCode": 400,
  "name": "validation_error",
  "message": "The `from` field is missing."
}
```

**Example curl:**
```bash
curl -X POST 'https://api.resend.com/emails' \
  -H 'Authorization: Bearer re_xxxxxxxxx' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 01JABCDEF...' \
  -d '{
    "from": "Robot Dojo <hello@robotdojo.ai>",
    "to": ["user@example.com"],
    "subject": "Your Robot Dojo magic link",
    "text": "Click to sign in: https://robotdojo.ai/auth/verify?token=...",
    "html": "<p>Click to sign in: <a href=\"https://robotdojo.ai/auth/verify?token=...\">Sign in</a></p>"
  }'
```

**Idempotency:**
- Pass a UUID v4 per magic-link send (e.g. `mlink:<token-id>`). Resend dedupes for 24 hours.
- Same key → same response ID; safe to retry on network error.

---

## Domain verification

**DNS records required on `robotdojo.ai`** (added in the Resend dashboard, records generated per domain):

1. **SPF** — TXT record, plus an MX record for bounce/complaint feedback.
2. **DKIM** — TXT record containing Resend's public key.
3. **DMARC** — optional but recommended; improves mailbox provider trust.

**Verification timeline:**
- Resend polls DNS after you add records.
- States: `not_started` → `pending` → `verified` (intermediate: `partially_verified`, `partially_failed`, `temporary_failure`).
- If records aren't detected in **72 hours**, status becomes `failed` and the domain must be re-created or re-verified.

**Sender subdomain recommendation:**
Resend recommends a subdomain (e.g. `mail.robotdojo.ai` → `hello@mail.robotdojo.ai`) to isolate reputation. For launch we can use the apex `hello@robotdojo.ai`; revisit if deliverability drops.

**Unverified domain behavior:**
Sends from an unverified domain are rejected. Only `onboarding@resend.dev` works out of the box (for smoke tests, never production).

---

## Rate limits

Resend's public rate-limit documentation lists **2 requests per second** on the default plan, burst tolerated. For 99 users at ~300 magic-link sends per month (~10/day peak), we are 4+ orders of magnitude under the limit.

Handle `429` by respecting `Retry-After` header when present, else exponential backoff: 1s, 2s, 4s, cap at 30s.

---

## Pricing at our scale

- Free tier: 100 emails/day, 3,000/month, single verified domain.
- Pro: $20/month, 50,000 emails/month.

At 99 users × ~3 magic links/month average ≈ 300 emails/month. **Free tier covers us with 10× headroom.** Upgrade to Pro only if we add broadcast/marketing sends.

---

## Gotchas / footguns

1. **Subject line must be present.** Omitting returns 400 with a generic validation error — easy to miss.
2. **`from` must match a verified domain.** The display name is free-form; the address is strict.
3. **`reply_to` is singular-or-array**, not `replyTo`. Camel-case in the HTTP API will silently drop.
4. **Idempotency window is 24h**, not 7 days. Magic links that retry beyond 24h will resend (fine for our flow).
5. **Tags are ASCII only**, max 256 chars per `name`/`value`. Unicode display names in tags → 400.
6. **Scheduled sends can be canceled** via `DELETE /emails/:id` only before send time.
7. **Attachments count toward payload limit** (~40 MB total). Irrelevant for magic links.
8. **React rendering is SDK-only.** If we skip the SDK, render to HTML string server-side first.

---

## What we DON'T use

- `POST /emails/batch` — we send one email per auth event; not needed.
- `POST /broadcasts` — no marketing sends from Robot Dojo.
- `POST /audiences` / `POST /contacts` — no list management.
- `GET /emails/:id` — we don't poll delivery status; we rely on webhooks if/when we add bounce handling.
- React email templates — we hand-roll a minimal HTML string for magic links.
- Resend Node SDK — we use native `fetch` to keep deps minimal.

---

## Future: webhooks (not launched)

Resend supports webhooks for `email.sent`, `email.delivered`, `email.bounced`, `email.complained`. We'll wire these post-launch for a deliverability dashboard. Signing: HMAC-SHA256 with a per-webhook secret, header `svix-signature`. Not in scope for v0.
