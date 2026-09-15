-- Migration 063 — drop UNIQUE(doc_path, content_sha256) from canonical_versions.
-- Story st_a78848a0. Rollback must be able to insert a row whose content_sha256
-- matches a prior row in the chain (the rollback target). The original UNIQUE
-- constraint in migration 062 prevented this. Chain integrity is enforced by
-- application logic (prev_sha256 must point at an existing sha for this doc)
-- and by the canonical_genesis UNIQUE INDEX (one NULL-prev per doc).
--
-- SQLite doesn't support DROP CONSTRAINT directly — table rebuild is the
-- supported path. The rebuild preserves all data, indexes, and CHECK
-- constraints; only the UNIQUE(doc_path, content_sha256) clause is omitted.

PRAGMA foreign_keys = OFF;

CREATE TABLE canonical_versions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  prev_sha256 TEXT,
  content_size INTEGER NOT NULL,
  regen_source TEXT NOT NULL,
  class TEXT NOT NULL,
  score_json TEXT,
  story_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(content_sha256) = 64),
  CHECK (content_sha256 = lower(content_sha256)),
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
    'initial-revert', 'initial-classification', 'test'
  ))
);

INSERT INTO canonical_versions_new
  SELECT id, doc_path, content_sha256, prev_sha256, content_size,
         regen_source, class, score_json, story_id, created_at
    FROM canonical_versions;

DROP TABLE canonical_versions;
ALTER TABLE canonical_versions_new RENAME TO canonical_versions;

CREATE UNIQUE INDEX IF NOT EXISTS canonical_genesis
  ON canonical_versions (doc_path, ifnull(prev_sha256, ''));
CREATE INDEX IF NOT EXISTS canonical_versions_doc_path
  ON canonical_versions (doc_path, id);

PRAGMA foreign_keys = ON;
