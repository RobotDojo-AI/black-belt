CREATE TABLE IF NOT EXISTS email_import_sources (
  email_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (email_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_email_import_sources_account_id
  ON email_import_sources(account_id);

CREATE INDEX IF NOT EXISTS idx_email_import_sources_email_id
  ON email_import_sources(email_id);
