CREATE TABLE IF NOT EXISTS imports_snapshot (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT,           -- NULL for aggregate rows (llm imports, rag sources)
  account_key TEXT,           -- email or display_name
  vendor      TEXT,           -- google, microsoft, etc.
  import_type TEXT NOT NULL,  -- 'email' | 'calendar' | 'llm' | 'rag_source'
  source_label TEXT,          -- display name: 'Gmail', 'Google Calendar', 'ChatGPT import', etc.
  item_count  INTEGER DEFAULT 0,
  earliest_at TEXT,
  latest_at   TEXT,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_imports_snapshot_type ON imports_snapshot(import_type);
