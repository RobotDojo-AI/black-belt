-- File entities — links uploaded files to resolved people/companies.
-- Created lazily by entity-nodes.js on first use; migration ensures the
-- table exists on all installs even before the first upload.
CREATE TABLE IF NOT EXISTS file_entities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_file_entities ON file_entities(entity_id);
