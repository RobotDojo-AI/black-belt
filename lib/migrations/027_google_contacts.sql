CREATE TABLE IF NOT EXISTS google_contacts (
  id            TEXT PRIMARY KEY,        -- sha256(account_id:resource_name)[:24]
  account_id    TEXT NOT NULL,           -- google email
  resource_name TEXT NOT NULL,           -- people/cXXXX
  display_name  TEXT,
  emails        TEXT DEFAULT '[]',       -- JSON array
  phones        TEXT DEFAULT '[]',       -- JSON array
  organizations TEXT DEFAULT '[]',       -- JSON array
  raw           TEXT,                    -- full JSON from People API
  synced_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, resource_name)
);
CREATE INDEX IF NOT EXISTS idx_google_contacts_account ON google_contacts(account_id);
