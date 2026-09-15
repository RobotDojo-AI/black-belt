-- Subscriptions + payment intents (Phase A3).
-- Replaces the minimal billing table in lib/billing.js. Two rails:
--   stripe — card via Stripe Payment Element + webhook
--   usdc   — Alchemy eth_subscribe watcher on USDC/Base Transfer logs
--
-- Both rails share the same post-confirmation path: issue an encryption
-- key via the tunnel gateway's POST /internal/push-key endpoint.
--
-- Spec references: docs/integrations/stripe.md, docs/integrations/usdc-base.md,
-- docs/integrations/alchemy-base.md
--
-- Privacy
--   Wallet addresses are stored lowercased (see usdc-base.md gotcha #1).
--   Raw payment instrument details never land here — Stripe tokenizes on the
--   client and we only reference IDs.

CREATE TABLE IF NOT EXISTS subscriptions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                 INTEGER NOT NULL,
  belt                    TEXT    NOT NULL,                          -- 'black' | 'samurai'
  status                  TEXT    NOT NULL,                          -- 'active' | 'past_due' | 'cancelled' | 'incomplete'
  rail                    TEXT    NOT NULL,                          -- 'stripe' | 'usdc'
  started_at              TEXT    NOT NULL,
  current_period_end      TEXT,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  usdc_sender_wallet      TEXT,                                      -- lowercased, for usdc rail
  last_payment_tx_hash    TEXT,
  last_payment_at         TEXT,
  cancelled_at            TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user          ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status        ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub    ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_usdc_wallet   ON subscriptions(usdc_sender_wallet);

CREATE TABLE IF NOT EXISTS payment_intents (
  id                         TEXT PRIMARY KEY,                       -- our internal id
  user_id                    INTEGER NOT NULL,
  rail                       TEXT    NOT NULL,                       -- 'stripe' | 'usdc'
  amount_cents               INTEGER NOT NULL,
  status                     TEXT    NOT NULL,                       -- 'pending' | 'confirmed' | 'failed' | 'expired'
  stripe_payment_intent_id   TEXT,
  usdc_sender_wallet         TEXT,                                   -- lowercased
  usdc_tx_hash               TEXT,
  created_at                 TEXT    DEFAULT (datetime('now')),
  confirmed_at               TEXT,
  expires_at                 TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_user    ON payment_intents(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status  ON payment_intents(status);
CREATE INDEX IF NOT EXISTS idx_payment_intents_stripe  ON payment_intents(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_wallet  ON payment_intents(usdc_sender_wallet);

-- Stripe webhook dedup (Stripe retries for 3 days in live; we reject duplicates).
-- See stripe.md: "Idempotency on our side: dedupe by event.id".
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id     TEXT PRIMARY KEY,                                     -- evt_...
  type         TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_received ON stripe_webhook_events(received_at);

-- USDC log dedup. Key = transactionHash + logIndex (uniquely identifies a Transfer).
-- Needed because eth_subscribe re-emits on reconnect / we may also poll.
CREATE TABLE IF NOT EXISTS usdc_processed_logs (
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  from_wallet  TEXT NOT NULL,
  amount_raw   TEXT NOT NULL,                                        -- BigInt as string (uint256)
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_usdc_processed_from ON usdc_processed_logs(from_wallet);
