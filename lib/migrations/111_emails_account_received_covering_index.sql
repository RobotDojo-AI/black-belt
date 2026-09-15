-- Per-account email counts and freshness must be index-only.
-- Without this, account health/import fallbacks that ask for COUNT + MIN/MAX
-- received_at can touch the fat email rows, including body_text.
CREATE INDEX IF NOT EXISTS idx_emails_account_received
  ON emails(account_id, received_at DESC);
