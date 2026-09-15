-- st_93fddaf0 Phase 7 / AC 8 — places.archived column for VC8 compatibility.
--
-- The places table historically used `hidden_in_sidebar` for soft-hide and
-- had no `archived` column. VC8 of st_93fddaf0 references `places.archived=0`,
-- so we add the column with DEFAULT 0 to make all existing places visible by
-- default. Future place-archive logic (none today) writes archived=1.
--
-- Idempotency: SQLite ADD COLUMN errors on existing columns are caught by the
-- migration runner via the "duplicate column name" branch in applySqlMigrations.
--
-- Down migration: ALTER TABLE places DROP COLUMN archived;
-- DROP INDEX IF EXISTS idx_places_archived_subtype;
--
-- Amended 2026-05-14 (st_5a63545d): added `place_subtype` column here too.
-- `place_subtype` is otherwise added by an inline migration in lib/db.js,
-- which runs AFTER SQL migrations per the documented order — so on a fresh
-- DB the CREATE INDEX below failed with "no such column: place_subtype"
-- and aborted the whole migration chain, breaking every unit test that
-- uses :memory:. Adding the column here too is idempotent (the runner's
-- duplicate-column tolerance catches the second add) and lets the index
-- build succeed on first-run installs and test DBs alike.

ALTER TABLE places ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE places ADD COLUMN place_subtype TEXT DEFAULT 'other';

CREATE INDEX IF NOT EXISTS idx_places_archived_subtype
  ON places(archived, place_subtype) WHERE archived = 0;
