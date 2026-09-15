-- Add processed_at to stripe_webhook_events.
-- Dedup check now requires processed_at IS NOT NULL; a crash mid-handler
-- leaves processed_at NULL so Stripe's retry is still processed.
ALTER TABLE stripe_webhook_events ADD COLUMN processed_at TEXT;
