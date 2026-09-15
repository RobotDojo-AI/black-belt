-- st_93fddaf0 Phase 8 / AC 7 — companies.archived column for VC7 compatibility.
--
-- The companies table historically had no `archived` column. VC7 of
-- st_93fddaf0 references `companies.archived=0` so we add the column with
-- DEFAULT 0. Future archive logic (Phase 6 company archive — out of scope for
-- this story) writes archived=1.
--
-- Idempotency: SQLite ADD COLUMN errors on existing columns are caught by the
-- migration runner via the "duplicate column name" branch.
--
-- Down migration: ALTER TABLE companies DROP COLUMN archived;

ALTER TABLE companies ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_companies_archived_name
  ON companies(archived, name) WHERE archived = 0;
