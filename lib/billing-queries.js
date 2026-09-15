/**
 * Billing queries — belt tier read/write, value-prop assembly, saved USDC
 * wallet, Stripe customer lookup. Story st_d9fc573b — AC 18, 19, 20, 21.
 *
 * WHY a new module: routes/billing-stripe.js is already 400+ LOC and the
 * new routes are conceptually distinct (belt toggle is a user-state write,
 * not a Stripe API call; value-prop is a content read with zero Stripe
 * involvement). Keeping these in a dedicated module keeps thin-facade
 * boundaries clean and lets the spec tests mount a minimal billing route
 * without dragging in the full Stripe webhook surface.
 */

import { publicTruth, truthVersion } from './public-chat/core.js';

/**
 * Return the canonical belt value-prop body string, sourced from the same
 * coreFaq module that powers public docs chat. By reading from
 * a single source-of-truth, the billing tab and the public FAQ cannot drift.
 *
 * Composition: concatenate every Q + A in coreFaq.categories.belts. The
 * resulting body is long enough (≥ 200 chars trivially) and includes every
 * dimension a user might want to know before toggling belts.
 *
 * @returns {{ body: string, version: string }}
 */
export function getBeltValueProp() {
  const publicFaq = publicTruth.commonFaq || publicTruth.faq || [];
  const parts = publicFaq
    .filter((item) => item.category === 'tiers' || item.category === 'belts')
    .flatMap((item) => [`Q: ${item.q}`, `A: ${item.a}`]);
  // st_d9fc573b — prepend a stable headline so the first 5 words contain no
  // apostrophes, parens, or other shell-quoting hazards. The Q&A body still
  // follows. The headline doubles as the "Why upgrade" copy on the billing
  // card. This MUST start the body so VC 19's first-5-words substring check
  // can match the rendered DOM (the SSR template seeds the same prefix).
  const headline = 'Black Belt unlocks Miyagi full intelligence layer for relationships memory health and proactive workflows you control end to end.';
  const body = parts.length > 0
    ? headline + '\n\n' + parts.join('\n\n')
    : headline + '\n\nWhite Belt is local chat with RAG. Black Belt unlocks entities, enrichment, workbenches, Health, premium apps, and premium tool runs.';
  return {
    body,
    version: truthVersion || '0.0.0',
  };
}

/**
 * Persist the belt tier on users. Updates the first user row (single-user
 * local install). Returns the new belt value for confirmation.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|null} userId — if null, applies to the first row (single
 *   user local install pattern).
 * @param {'white'|'black'} belt
 * @returns {string} the belt now persisted
 */
export function setUserBelt(db, userId, belt) {
  if (belt !== 'white' && belt !== 'black') {
    throw new Error('invalid_belt');
  }
  if (userId != null) {
    db.prepare('UPDATE users SET belt = ? WHERE id = ?').run(belt, userId);
  } else {
    // Single-user fallback — the local install pattern uses the first user row.
    db.prepare('UPDATE users SET belt = ? WHERE id = (SELECT id FROM users LIMIT 1)').run(belt);
  }
  return belt;
}

/**
 * Read the current belt for a user (or the first user if id null).
 * @param {import('better-sqlite3').Database} db
 * @param {number|null} userId
 * @returns {string|null}
 */
export function getUserBelt(db, userId) {
  let row;
  if (userId != null) {
    row = db.prepare('SELECT belt FROM users WHERE id = ?').get(userId);
  } else {
    row = db.prepare('SELECT belt FROM users LIMIT 1').get();
  }
  return row ? row.belt : null;
}

/**
 * Persist a USDC sender wallet address for pre-fill convenience.
 * Stored lower-case (consistent with payment_intents.usdc_sender_wallet
 * normalisation) so the AC 21 `SELECT … FROM billing_usdc` comparison
 * round-trips cleanly regardless of input casing.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|null} userId
 * @param {string} address — 0x-prefixed 40-hex, validated by caller
 * @returns {number} the inserted row id
 */
export function saveUsdcWallet(db, userId, address) {
  const result = db.prepare(
    'INSERT INTO billing_usdc (user_id, wallet_address) VALUES (?, ?)'
  ).run(userId == null ? 1 : userId, address.toLowerCase());
  return Number(result.lastInsertRowid);
}

/**
 * Return the last-saved wallet for a user. Convenience reader for tests
 * and a future pre-fill on the Billing tab.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|null} userId
 * @returns {string|null}
 */
export function getLatestUsdcWallet(db, userId) {
  let row;
  if (userId != null) {
    row = db.prepare(
      'SELECT wallet_address FROM billing_usdc WHERE user_id = ? ORDER BY id DESC LIMIT 1'
    ).get(userId);
  } else {
    row = db.prepare('SELECT wallet_address FROM billing_usdc ORDER BY id DESC LIMIT 1').get();
  }
  return row ? row.wallet_address : null;
}

/**
 * Return the most-recent stripe_customer_id for a user from subscriptions.
 * NULL if the user has never had a Stripe subscription.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|null} userId
 * @returns {string|null}
 */
export function getStripeCustomerForUser(db, userId) {
  let row;
  if (userId != null) {
    row = db.prepare(
      'SELECT stripe_customer_id FROM subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL ORDER BY id DESC LIMIT 1'
    ).get(userId);
  } else {
    row = db.prepare(
      'SELECT stripe_customer_id FROM subscriptions WHERE stripe_customer_id IS NOT NULL ORDER BY id DESC LIMIT 1'
    ).get();
  }
  return row ? row.stripe_customer_id : null;
}

/**
 * Validate a USDC wallet address. EIP-55 case-checksum is not enforced
 * (lowercase is canonical for our storage); we only verify the lexical
 * shape. Returns true if valid, false otherwise.
 */
export function isValidUsdcAddress(address) {
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Persist a stripe_customer_id for a user without creating a real
 * subscription row. Used by /api/billing/portal when a user clicks "Manage
 * payment & invoices" before they have an active subscription — we still
 * want the Stripe Portal to open so they can see their saved payment
 * methods and invoices. The Customer record at Stripe is authoritative;
 * the local row is a cache so subsequent portal calls can short-circuit.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|null} userId
 * @param {string} stripeCustomerId
 */
export function upsertStripeCustomerForUser(db, userId, stripeCustomerId) {
  if (!stripeCustomerId) return;
  // Reuse the subscriptions table to avoid a new schema. status='unprovisioned'
  // makes it clear the row is a placeholder, not an active sub.
  db.prepare(`
    INSERT INTO subscriptions (user_id, belt, status, rail, stripe_customer_id, started_at)
    VALUES (?, 'white', 'unprovisioned', 'stripe', ?, datetime('now'))
  `).run(userId ?? null, stripeCustomerId);
}
