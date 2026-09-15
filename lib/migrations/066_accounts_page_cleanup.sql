-- Migration 066 — accounts-page-cleanup schema additions
-- Story: st_d9fc573b
--
-- Adds:
--   1. users.belt TEXT NOT NULL DEFAULT 'white'   — fast-read denormalized belt
--      tier, backfilled from any active subscription. Lets the auth layer read
--      the belt in a single query without joining subscriptions.
--   2. billing_usdc table — minimal persisted USDC wallet preferences. Separate
--      from payment_intents.usdc_sender_wallet (which is per-transaction).
--
-- WHY denormalized belt column: belt is checked on virtually every authenticated
-- request. A JSON parse in user_settings or a JOIN on subscriptions on the hot
-- path is unacceptable. users.subscription_status already established the
-- "redundant with subscriptions, lives on users for hot reads" pattern.

-- 1. Belt tier on users (fast-read, denormalized from subscriptions)
ALTER TABLE users ADD COLUMN belt TEXT NOT NULL DEFAULT 'white';

-- Backfill belt from active subscription if present. Idempotent: rows with
-- no active subscription stay at the DEFAULT 'white'.
UPDATE users
SET belt = (
  SELECT COALESCE(s.belt, 'white')
  FROM subscriptions s
  WHERE s.user_id = users.id
    AND s.status = 'active'
  ORDER BY s.started_at DESC
  LIMIT 1
)
WHERE belt = 'white'
  AND EXISTS (
    SELECT 1 FROM subscriptions s2
    WHERE s2.user_id = users.id AND s2.status = 'active'
  );

-- 2. USDC wallet address storage (separate from payment_intents).
-- payment_intents.usdc_sender_wallet stores the sender wallet per transaction;
-- billing_usdc holds the saved wallet preference for pre-fill convenience.
CREATE TABLE IF NOT EXISTS billing_usdc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  wallet_address TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS billing_usdc_user_id_idx
  ON billing_usdc (user_id, id DESC);
