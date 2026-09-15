-- 108_canonical_versions_restore_sha_checks_after_distill.sql
--
-- Migration 096 rebuilt canonical_versions to add regen_source='distill' but
-- accidentally dropped the sha/size/class CHECK constraints restored by 084.
-- Fresh installs are fixed in 096; this migration repairs already-migrated DBs.

PRAGMA foreign_keys = OFF;

CREATE TABLE canonical_versions_v5 (
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
    'trigger-dispatcher',
    'distill'
  ))
);

INSERT INTO canonical_versions_v5
  SELECT id, doc_path, content_sha256, prev_sha256, content_size,
         regen_source, class, score_json, quality_json, story_id, created_at
    FROM canonical_versions;

DROP TABLE canonical_versions;
ALTER TABLE canonical_versions_v5 RENAME TO canonical_versions;

CREATE UNIQUE INDEX IF NOT EXISTS canonical_genesis
  ON canonical_versions(doc_path) WHERE prev_sha256 IS NULL;
CREATE INDEX IF NOT EXISTS canonical_versions_doc_path_created
  ON canonical_versions(doc_path, created_at);
CREATE INDEX IF NOT EXISTS canonical_versions_doc_path
  ON canonical_versions(doc_path, id);

PRAGMA foreign_keys = ON;
