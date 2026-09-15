-- 084_canonical_versions_restore_sha_checks.sql
--
-- Migration 082 rebuilt canonical_versions to widen regen_source but dropped
-- the original sha/size/class CHECK constraints from 062/063. Restore them
-- without changing the accepted regen_source values.

PRAGMA foreign_keys = OFF;

CREATE TABLE canonical_versions_v4 (
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
  CHECK (length(content_sha256) = 64),
  CHECK (content_sha256 = lower(content_sha256)),
  CHECK (content_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (prev_sha256 IS NULL OR length(prev_sha256) = 64),
  CHECK (prev_sha256 IS NULL OR prev_sha256 = lower(prev_sha256)),
  CHECK (prev_sha256 IS NULL OR prev_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (content_size >= 0),
  CHECK (class IN ('human-authored', 'programmatically-generated')),
  CHECK (regen_source IN (
    'compound-agents', 'compound-architecture', 'compound-claude',
    'compound-companies', 'compound-entity', 'compound-health',
    'compound-kanban', 'compound-people', 'compound-places',
    'compound-sitemap', 'compound-skills', 'compound-structure',
    'compound-topics', 'compound-user', 'compound-voice',
    'generate-architecture', 'generate-sitemap', 'generate-structure',
    'manual', 'promote', 'rollback', 'skill-revert',
    'initial-revert', 'initial-classification', 'test',
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

INSERT INTO canonical_versions_v4
  SELECT id, doc_path, content_sha256, prev_sha256, content_size,
         regen_source, class, score_json, quality_json, story_id, created_at
    FROM canonical_versions;

DROP TABLE canonical_versions;
ALTER TABLE canonical_versions_v4 RENAME TO canonical_versions;

CREATE UNIQUE INDEX IF NOT EXISTS canonical_genesis
  ON canonical_versions(doc_path) WHERE prev_sha256 IS NULL;
CREATE INDEX IF NOT EXISTS canonical_versions_doc_path_created
  ON canonical_versions(doc_path, created_at);
CREATE INDEX IF NOT EXISTS canonical_versions_doc_path
  ON canonical_versions(doc_path, id);

PRAGMA foreign_keys = ON;
