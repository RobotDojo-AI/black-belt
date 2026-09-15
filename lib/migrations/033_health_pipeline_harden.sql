-- Health pipeline hardening migrations.
-- Additive only — no data loss. All existing rows unaffected.

-- 1. Track which health_markers were auto-created by the import pipeline vs curated.
--    Existing markers are curated (auto_created=0 by default).
ALTER TABLE health_markers ADD COLUMN auto_created INTEGER NOT NULL DEFAULT 0;

-- 2. Add reason field to fhir_staged_observations for auditing why a record
--    was staged or excluded rather than inserted.
--    CREATE TABLE IF NOT EXISTS first — ensures table exists on fresh installs
--    before the ALTER TABLE runs (which would fail on a missing table).
CREATE TABLE IF NOT EXISTS fhir_staged_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  fhir_display_name TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  ref_low REAL,
  ref_high REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  mapped_marker_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_file, effective_date, fhir_display_name, value)
);
ALTER TABLE fhir_staged_observations ADD COLUMN reason TEXT;

-- 3. Add 'excluded' to valid status values (documented — SQLite has no CHECK constraint alter).
--    status values: pending | mapped | skipped | excluded

-- 4. Rebuild health_ingestion_log with UNIQUE(source, file_path) enforcement.
--    SQLite cannot add a UNIQUE constraint via ALTER TABLE, so we recreate the table.
CREATE TABLE IF NOT EXISTS health_ingestion_log_new (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  file_path     TEXT,
  ingested_date TEXT,
  record_count  INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, file_path)
);
INSERT OR IGNORE INTO health_ingestion_log_new
  SELECT id, source, file_path, ingested_date, record_count, created_at
  FROM health_ingestion_log;
DROP TABLE health_ingestion_log;
ALTER TABLE health_ingestion_log_new RENAME TO health_ingestion_log;
CREATE INDEX IF NOT EXISTS idx_hil_source ON health_ingestion_log(source);
CREATE INDEX IF NOT EXISTS idx_hil_path   ON health_ingestion_log(file_path);

-- 5. Add auto_imported group for markers created by the import pipeline.
INSERT OR IGNORE INTO health_groups (id, name, description)
VALUES ('auto_imported', 'Auto-imported', 'Markers detected and created automatically during data import. Review and reclassify as needed.');
