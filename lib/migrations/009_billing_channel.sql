-- Billing channel — differentiates personal cards from corporate (Ramp)
-- cards so the flow can attach a first-month-free coupon automatically
-- and so reporting can break out corporate card revenue.
--
-- Values in practice:
--   'personal'        — default; user's personal card or USDC wallet.
--   'corporate_card'  — detected by isRampCard() at subscription creation.
--
-- The column is rail-agnostic (lives on the same row for Stripe + USDC) so
-- future rails (wire, ACH) can reuse it.

ALTER TABLE subscriptions ADD COLUMN billing_channel TEXT DEFAULT 'personal';
CREATE INDEX IF NOT EXISTS idx_subscriptions_channel ON subscriptions(billing_channel);
