CREATE TABLE IF NOT EXISTS drive_files (
  id TEXT PRIMARY KEY,
  drive_file_id TEXT NOT NULL UNIQUE,
  account_id TEXT,
  name TEXT,
  mime_type TEXT,
  modified_at TEXT,
  topic TEXT,
  text_content TEXT,
  indexed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drive_files_account ON drive_files(account_id);
CREATE INDEX IF NOT EXISTS idx_drive_files_topic ON drive_files(topic);
CREATE INDEX IF NOT EXISTS idx_drive_files_indexed ON drive_files(indexed_at);
