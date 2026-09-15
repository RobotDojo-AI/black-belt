-- Health ingestion log — tracks every import run to prevent re-importing
-- the same file/source twice. Keyed by (source, file_path) pair.

CREATE TABLE IF NOT EXISTS health_ingestion_log (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  file_path    TEXT,
  ingested_date TEXT,
  record_count INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hil_source ON health_ingestion_log(source);
CREATE INDEX IF NOT EXISTS idx_hil_path   ON health_ingestion_log(file_path);
