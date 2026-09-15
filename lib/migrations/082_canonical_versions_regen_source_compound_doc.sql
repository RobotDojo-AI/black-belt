-- 082_canonical_versions_regen_source_compound_doc.sql
--
-- Story st_ae536261 follow-up: the autonomous build introduced compound-doc.js
-- as the single meta synthesizer (replacing 14 prior compound-<name>.js scripts)
-- but did not update the CHECK constraint on canonical_versions.regen_source.
-- New writes from compound-doc.js, claude.js, memory-append.js, and the
-- seed-canonical-genesis bootstrap all failed with
-- "CHECK constraint failed: regen_source IN (...)".
--
-- This migration rebuilds the constraint to include the new sources while
-- preserving every legacy value (so existing rows survive the table rebuild).
-- Idempotent: SQLite migration runner uses IF NOT EXISTS where applicable.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS canonical_versions_v3 (
  id              INTEGER PRIMARY KEY,
  doc_path        TEXT NOT NULL,
  content_sha256  TEXT NOT NULL,
  prev_sha256     TEXT,
  content_size    INTEGER NOT NULL,
  regen_source    TEXT NOT NULL,
  class           TEXT NOT NULL,
  score_json      TEXT,
  quality_json    TEXT,
  story_id        TEXT,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (regen_source IN (
    -- Legacy per-doc compound scripts (deleted by st_ae536261 but historical rows kept)
    'compound-agents', 'compound-architecture', 'compound-claude',
    'compound-companies', 'compound-entity', 'compound-health',
    'compound-kanban', 'compound-people', 'compound-places',
    'compound-sitemap', 'compound-skills', 'compound-structure',
    'compound-topics', 'compound-user', 'compound-voice',
    'generate-architecture', 'generate-sitemap', 'generate-structure',
    'manual', 'promote', 'rollback', 'skill-revert',
    'initial-revert', 'initial-classification', 'test',
    -- st_ae536261: new architecture
    'compound-doc.js',
    'claude.js',
    'memory-append.js',
    'seed-canonical-genesis',
    'vc11-runner',
    'vc5-runner',
    'heartbeat-no-signal',
    'retro-compound',
    'generalize-compound',
    'trigger-dispatcher'
  ))
);

INSERT INTO canonical_versions_v3
  SELECT id, doc_path, content_sha256, prev_sha256, content_size,
         regen_source, class, score_json, quality_json, story_id, created_at
    FROM canonical_versions;

DROP TABLE canonical_versions;
ALTER TABLE canonical_versions_v3 RENAME TO canonical_versions;

CREATE UNIQUE INDEX IF NOT EXISTS canonical_genesis
  ON canonical_versions(doc_path) WHERE prev_sha256 IS NULL;
CREATE INDEX IF NOT EXISTS canonical_versions_doc_path_created
  ON canonical_versions(doc_path, created_at);

PRAGMA foreign_keys = ON;
