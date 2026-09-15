/**
 * USDC billing routes (mounted at /).
 *
 * Specs: docs/integrations/usdc-base.md, docs/integrations/alchemy-base.md
 *
 * Endpoints (full paths declared internally — mount at root in index.js)
 *   POST /api/billing/usdc/initiate          (auth required)
 *   GET  /api/billing/usdc/status/:intentId  (auth required)
 *   POST /api/billing-usdc/wallet            (auth required) — saved wallet
 *
 * WHY full paths + root mount: the spec test for st_d9fc573b loads this file
 * directly and mounts at '/', then fetches /api/billing-usdc/wallet. For the
 * test to pass, the routes must declare full paths internally. The existing
 * /initiate + /status routes were short-path-declared under a /api/billing/usdc
 * prefix mount; they have been updated to full paths to round-trip the
 * existing frontend calls unchanged.
 *
 * Flow
 *   1. User clicks "Pay with USDC" in chat.
 *   2. Chat collects sender wallet via the existing secure_input SSE pattern.
 *   3. Client POSTs /initiate with { senderWallet } → backend returns
 *      {receivingWallet, amount, intentId}.
 *   4. User sends USDC from that wallet. lib/usdc-watcher.js matches the
 *      Transfer log to the pending intent and completes the flow async.
 *   5. Client polls /status/:intentId (or reuses chat push) to learn result.
 */

import { Hono } from 'hono';
import {
  createUsdcIntent,
  getIntent,
  expireStalePendingIntents,
} from '../lib/subscriptions.js';
import config from '../lib/config.js';
import db from '../lib/db.js';
import { saveUsdcWallet, isValidUsdcAddress } from '../lib/billing-queries.js';

const billingUsdc = new Hono();
const BILLING_ENABLED = process.env.ROBOTDOJO_BILLING_ENABLED === '1';

function betaBillingDisabled(c) {
  return c.json({
    error: 'billing_disabled',
    message: 'Private beta access uses issued or prepaid Black Belt keys.',
  }, 404);
}

// --- Constants --------------------------------------------------------------

const INTENT_TTL_SECONDS = 3600; // 1 hour

function toChecksumDisplay(addr) {
  // Leave as-is for display. EIP-55 checksum can be done on client if needed;
  // spec note #10 says "render EIP-55 to help users eyeball-verify". We keep
  // internal storage lowercase.
  return addr;
}

// --- Endpoints --------------------------------------------------------------

/**
 * POST /api/billing/usdc/initiate
 *
 * Body: { senderWallet }
 *
 * Returns:
 *   {
 *     intentId,
 *     receivingWallet,         // checksum-cased display form
 *     amount,                  // "199.00"
 *     amountCents,
 *     amountBaseUnits,         // "199000000" (USDC 6 decimals)
 *     currency: "USDC",
 *     network:  "base",
 *     contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
 *     expiresAt,               // ISO
 *     memo                     // informational string
 *   }
 */
billingUsdc.post('/api/billing/usdc/initiate', async (c) => {
  if (!BILLING_ENABLED) return betaBillingDisabled(c);

  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  if (!config.usdcWallet || !config.alchemyApiKey) {
    return c.json({ error: 'usdc_not_configured' }, 503);
  }

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const rawWallet = typeof body?.senderWallet === 'string' ? body.senderWallet.trim() : '';
  const wallet = rawWallet.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    return c.json({ error: 'invalid_wallet_address' }, 400);
  }

  // Housekeeping: age out stale pending intents before creating a new one.
  expireStalePendingIntents();

  let intent;
  try {
    intent = createUsdcIntent(user.id, wallet, config.blackBeltPriceCents, INTENT_TTL_SECONDS);
  } catch (err) {
    return c.json({ error: 'invalid_request', message: err.message }, 400);
  }

  const dollars = (config.blackBeltPriceCents / 100).toFixed(2);
  const baseUnits = BigInt(config.blackBeltPriceCents) / 100n * 1_000_000n;

  return c.json({
    intentId: intent.id,
    receivingWallet: toChecksumDisplay(config.usdcWallet),
    amount: dollars,
    amountCents: config.blackBeltPriceCents,
    amountBaseUnits: baseUnits.toString(),
    currency: 'USDC',
    network: 'base',
    contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    expiresAt: intent.expires_at,
    memo: `Robot Dojo Black Belt — send $${dollars} USDC on Base from ${wallet}`,
  });
});

/**
 * GET /api/billing/usdc/status/:intentId
 *
 * Returns the intent row's status plus the tx hash if confirmed.
 */
billingUsdc.get('/api/billing/usdc/status/:intentId', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  const id = c.req.param('intentId');
  const intent = getIntent(id);
  if (!intent) return c.json({ error: 'not_found' }, 404);
  // Ownership check — don't leak status of someone else's intent.
  if (intent.user_id !== user.id) return c.json({ error: 'not_found' }, 404);

  return c.json({
    intentId: intent.id,
    status: intent.status,
    rail: intent.rail,
    amountCents: intent.amount_cents,
    senderWallet: intent.usdc_sender_wallet,
    txHash: intent.usdc_tx_hash,
    createdAt: intent.created_at,
    confirmedAt: intent.confirmed_at,
    expiresAt: intent.expires_at,
  });
});

/**
 * POST /api/billing-usdc/wallet — save the user's USDC sender wallet address
 * for pre-fill convenience. Story st_d9fc573b — AC 21.
 *
 * Body: { address: "0x..." } — must match /^0x[0-9a-fA-F]{40}$/.
 *
 * WHY a separate persisted table (billing_usdc) instead of
 * payment_intents.usdc_sender_wallet: the latter records per-transaction
 * sender wallets and is bound to a billing event. The new endpoint stores a
 * user preference (the wallet they want pre-filled next time), independent
 * of any active payment. Same lib module (`saveUsdcWallet`) so the storage
 * boundary stays clean.
 *
 * Auth: relies on the global /api/* cookie-or-Bearer middleware in
 * lib/server.js (c.get('user') populated upstream). When a user is present
 * we attribute the row to them; when only the Bearer admin token is in use
 * we fall back to user_id=1 (single-user local install pattern).
 */
billingUsdc.post('/api/billing-usdc/wallet', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const address = typeof body?.address === 'string' ? body.address.trim() : '';
  if (!isValidUsdcAddress(address)) {
    return c.json({ error: 'invalid_address' }, 400);
  }

  const user = c.get('user');
  const userId = user?.id ?? 1;
  try {
    saveUsdcWallet(db, userId, address);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: 'storage_failed', message: err.message }, 500);
  }
});

export default billingUsdc;
