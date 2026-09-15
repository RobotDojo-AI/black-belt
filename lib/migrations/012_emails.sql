-- 012_emails.sql
-- Email storage — one row per email, keyed by provider message id.
-- Populated by the email sync pipeline (Gmail + MS Graph). Queried by:
--   - lib/person-professional.js  (signature extraction, newsletter scan)
--   - lib/referral.js              (tool-spend keyword scan)
--   - lib/timeline-ingest.js       (email events into timeline)
--   - lib/address-extract.js       (address extraction from high-signal senders)
--   - lib/document-vault.js        (document category classification)
--
-- Schema matches the producer at ~/dojo (Miyagi email sync) so the migration
-- plan can copy rows across with no transform. Columns added via later
-- migrations (account_id, is_newsletter, list_unsubscribe) are inline here.
--
-- All text columns default to '' (empty string) to match producer semantics —
-- the FTS5 index and existing queries rely on NOT NULL bodies.

CREATE TABLE IF NOT EXISTS emails (
  id              TEXT PRIMARY KEY,                       -- provider message id
  thread_id       TEXT NOT NULL DEFAULT '',
  subject         TEXT NOT NULL DEFAULT '',
  sender          TEXT NOT NULL DEFAULT '',               -- display name
  sender_email    TEXT NOT NULL DEFAULT '',
  snippet         TEXT NOT NULL DEFAULT '',
  body_text       TEXT NOT NULL DEFAULT '',
  labels          TEXT NOT NULL DEFAULT '[]',             -- JSON array
  is_read         INTEGER NOT NULL DEFAULT 0,
  is_starred      INTEGER NOT NULL DEFAULT 0,
  received_at     TEXT NOT NULL DEFAULT '',               -- ISO8601
  synced_at       TEXT NOT NULL DEFAULT (datetime('now')),
  account_id      TEXT,                                   -- FK to accounts (nullable for legacy rows)
  is_newsletter   INTEGER NOT NULL DEFAULT 0,
  list_unsubscribe TEXT DEFAULT NULL                      -- non-null = newsletter
);

CREATE INDEX IF NOT EXISTS idx_emails_thread        ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_received      ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_unread        ON emails(is_read, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_sender_email  ON emails(sender_email);
CREATE INDEX IF NOT EXISTS idx_emails_account       ON emails(account_id);
CREATE INDEX IF NOT EXISTS idx_emails_newsletter    ON emails(is_newsletter);
CREATE INDEX IF NOT EXISTS idx_emails_list_unsub    ON emails(list_unsubscribe) WHERE list_unsubscribe IS NOT NULL;
