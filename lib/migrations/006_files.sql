-- Drop folder index (Phase 2 — file management).
--
-- Every file that passes through the watcher at `~/Robot Dojo/Inbox/` is
-- classified, extracted, moved into the ontology tree, and recorded here.
--
-- Table name: `drop_folder_files` (the bare `files` name is taken in the
-- upstream miyagi.db by an unrelated SHA-256-of-disk index).
--
-- Primary key = final filesystem path. That makes the row unambiguous even
-- when files are reclassified (we move the file and UPDATE the row).
--
-- `hash_sha256` is UNIQUE so duplicate drops short-circuit to the original
-- row instead of re-processing.
--
-- `extracted_json` and `entity_refs` are JSON text. Kept as TEXT (not
-- JSON type) to stay compatible with older SQLite builds.
--
-- `status` enum (TEXT): 'processed' | 'processing' | 'errored' | 'credentials'

CREATE TABLE IF NOT EXISTS drop_folder_files (
  path             TEXT PRIMARY KEY,
  original_name    TEXT NOT NULL,
  topic_t1         TEXT,
  topic_t2         TEXT,
  topic_t3         TEXT,
  doc_type         TEXT,
  extracted_json   TEXT,
  entity_refs      TEXT,
  hash_sha256      TEXT NOT NULL UNIQUE,
  size_bytes       INTEGER,
  mime_type        TEXT,
  processed_at     TEXT,
  source           TEXT,
  status           TEXT NOT NULL DEFAULT 'processed',
  error_message    TEXT
);

CREATE INDEX IF NOT EXISTS idx_drop_files_topic        ON drop_folder_files(topic_t1, topic_t2, topic_t3);
CREATE INDEX IF NOT EXISTS idx_drop_files_doc_type     ON drop_folder_files(doc_type);
CREATE INDEX IF NOT EXISTS idx_drop_files_status       ON drop_folder_files(status);
CREATE INDEX IF NOT EXISTS idx_drop_files_processed_at ON drop_folder_files(processed_at);

-- Lightweight FTS over extracted content so /api/files/search is fast.
CREATE VIRTUAL TABLE IF NOT EXISTS drop_folder_files_fts USING fts5(
  path UNINDEXED,
  original_name,
  extracted_json,
  tokenize = 'unicode61 remove_diacritics 2'
);
