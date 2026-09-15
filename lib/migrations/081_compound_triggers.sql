-- 081_compound_triggers.sql — st_ae536261 Phase 4.
-- Queue of pending compound synthesis triggers. Memory router writes rows;
-- trigger dispatcher drains them by invoking compound-doc.js per row.

CREATE TABLE IF NOT EXISTS compound_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_path TEXT NOT NULL,
  source_event TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_compound_triggers_status_created
  ON compound_triggers(status, created_at);

CREATE INDEX IF NOT EXISTS idx_compound_triggers_doc_path_created
  ON compound_triggers(doc_path, created_at);
