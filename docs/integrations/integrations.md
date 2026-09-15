# Robot Dojo Integration Specs

**Purpose:** single source of truth for every 3rd-party API Robot Dojo touches. These specs exist so no agent ever writes integration code from memory.

**Canonical rule:**

> Agents MUST reference these specs before writing integration code.
> No vendor API call may be written from memory.
> If a spec is missing, stale, or contradicted by vendor docs, update this directory BEFORE writing the call.

---

## Specs

| Spec | Vendor / Protocol | What it covers |
|---|---|---|
| [`resend.md`](./resend.md) | Resend | Transactional email API (`POST /emails`), domain verification, rate limits, webhooks. Magic-link auth. |
| [`stripe.md`](./stripe.md) | Stripe | Customers + Subscriptions API, Payment Element, webhook signature verification, event types, idempotency, error codes. $199/mo Black Belt. |
| [`aws-fargate.md`](./aws-fargate.md) | AWS Fargate + ALB + Route 53 + ACM | Tunnel gateway deployment: task sizing, `awsvpc` networking, ALB WebSocket + stickiness, TLS, DNS. |
| [`alchemy-base.md`](./alchemy-base.md) | Alchemy (Base mainnet RPC) | `eth_getLogs`, `eth_subscribe`, authentication, rate limits, confirmation depth. USDC transfer watcher. |
| [`usdc-base.md`](./usdc-base.md) | USDC (ERC-20 on Base) | Canonical contract address, decimals, Transfer event structure, native vs bridged, matching logic. |

---

## Dependency map — Robot Dojo feature → vendor

| Feature | Vendors involved | Relevant specs |
|---|---|---|
| **Magic-link sign-in** | Resend | `resend.md` |
| **Black Belt purchase (card)** | Stripe | `stripe.md` |
| **Black Belt purchase (USDC)** | Alchemy, USDC/Base, (no Stripe) | `alchemy-base.md`, `usdc-base.md` |
| **Payment confirmation → key issuance** | Stripe webhook OR USDC watcher → Tunnel gateway | `stripe.md`, `alchemy-base.md`, `usdc-base.md`, `aws-fargate.md` |
| **Tunnel gateway hosting** | AWS Fargate + ALB + Route 53 + ACM | `aws-fargate.md` |
| **Marketing site** | Vercel (not in this directory — standard Vercel project) | — |

Graph view:

```
 user (browser)
   │
   ├── email ─────────────→ Resend ───→ inbox
   │                          (resend.md)
   │
   ├── card ──────────────→ Stripe Elements
   │                             │
   │                             └── webhook ──→ api.robotdojo.ai ──┐
   │                                (stripe.md)                     │
   │                                                                ▼
   └── USDC ──→ Base chain ──→ Alchemy (eth_subscribe) ──→ watcher ─→ tunnel gateway
                (usdc-base.md)   (alchemy-base.md)                   (aws-fargate.md)
                                                                     │
                                                                     ▼
                                                              encryption key
                                                              issued to user
```

---

## Maintenance

- **Fetched date** at the top of each spec says when the doc was last pulled from the vendor. If a spec is older than 90 days at the time of change, re-fetch before editing.
- **Every URL in "Source docs"** must resolve. When a vendor reorganizes their docs (Alchemy did this 2026-04), fix the URLs in the affected spec.
- **If a vendor adds a breaking change**, add a dated note at the top of the affected spec:
  ```
  ## Breaking change 2026-MM-DD
  Stripe deprecated X on date Y. We now use Z. See section [...] below.
  ```
- **Specs are not implementation docs.** They describe vendor APIs, not our code. Keep implementation notes in `~/robotdojo/CLAUDE.md` or inline with the code.

---

## Adding a new integration

1. Create `docs/integrations/<vendor>.md` using the structure in the existing files.
2. WebFetch every doc URL. Do not paraphrase — quote exact schemas.
3. Note the fetch date at the top.
4. Add a row to the Specs table and Dependency map above.
5. Reference the spec from the implementation code (in the PR description or a code comment).
