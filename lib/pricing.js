/**
 * Pricing — single source of truth for belt tier prices.
 *
 * Every price string shown to a user (marketing HTML, account UI, FAQ, etc.)
 * and every price integer used in billing (Stripe, USDC watcher, webhooks)
 * must read from this file. Do NOT duplicate `$99` / `$199` / `19900`
 * anywhere else in the codebase.
 *
 * Units:
 *   cents    — integer, source of truth for charging logic.
 *   display  — human-facing string including currency + cadence.
 *   currency — ISO 4217 code.
 *
 * Status:
 *   active    — the belt is buyable today.
 */

export const PRICING = {
  black: {
    cents: 19900,
    display: '$200/mo',
    priceDollars: '200',
    currency: 'USD',
    status: 'active',
    cadence: 'month',
  },
};

/** Convenience: get cents for a belt key, throws on unknown belt. */
export function priceCents(belt) {
  const row = PRICING[belt];
  if (!row) throw new Error(`unknown belt: ${belt}`);
  return row.cents;
}

/** Convenience: get the display string ("$199/mo") for a belt key. */
export function priceDisplay(belt) {
  const row = PRICING[belt];
  if (!row) throw new Error(`unknown belt: ${belt}`);
  return row.display;
}

export default PRICING;
