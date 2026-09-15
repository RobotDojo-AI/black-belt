-- Viewer/entity identity fallback resolves packages by context_file_path.
-- These indexes keep stale or frontmatter-light Markdown URLs from blocking
-- the interactive server on encrypted full-table scans.
--
-- people.context_file_path is created by 026_pipeline_v2 before this migration.
-- companies/places receive their context_file_path columns from the guarded JS
-- migration in lib/db.js because SQL migrations run before that legacy inline
-- backfill on fresh DBs.
CREATE INDEX IF NOT EXISTS idx_people_context_file_path
  ON people(context_file_path)
  WHERE context_file_path IS NOT NULL;
