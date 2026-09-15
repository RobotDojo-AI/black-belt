-- Migration 062 — canonical_versions hash chain + quarantine table.
-- Story st_a78848a0 (agent-personas-lost). Substrate for the canonical-surface
-- integrity ratchet: every accepted write to a classified surface extends a
-- per-doc hash chain; every rejected candidate is recorded in quarantine for
-- forensic review. See the st_a78848a0 02-design.md §A1, §A2 (in the wk_robot_dojo stories tree).
--
-- Schema choices:
--   - Viget-style chain: prev_sha256 FK to content_sha256 of the prior row for
--     the same doc_path. NULL only for the genesis row.
--   - UNIQUE INDEX canonical_genesis enforces at-most-one-NULL-prev row per
--     doc_path (ifnull collapses NULL into the empty string for the index).
--   - CHECK constraints enforce hex lowercase 64-char shas and the closed
--     regen_source / class enums. Full sha256 verification happens in JS at
--     write time (SQLite cannot compute sha256 in a CHECK without an
--     extension).
--   - regen_source enumeration is open to extension via future migrations;
--     additions are backwards-compatible.

CREATE TABLE IF NOT EXISTS canonical_versions (
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
  -- NOTE: deliberately NOT UNIQUE(doc_path, content_sha256) — rollback
  -- legitimately produces a row with the same content_sha256 as a prior
  -- row in the chain. Chain integrity is enforced at the application
  -- layer (prev_sha256 must point to a row with that sha for this doc)
  -- and by canonical_genesis (at-most-one-NULL-prev per doc).
);

-- One genesis row per doc_path. The ifnull trick collapses NULL to '' so the
-- UNIQUE INDEX can flag duplicate-NULL rows (which SQLite would otherwise
-- permit, since NULL != NULL under default uniqueness semantics).
CREATE UNIQUE INDEX IF NOT EXISTS canonical_genesis
  ON canonical_versions (doc_path, ifnull(prev_sha256, ''));

CREATE INDEX IF NOT EXISTS canonical_versions_doc_path
  ON canonical_versions (doc_path, id);

CREATE TABLE IF NOT EXISTS canonical_versions_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_path TEXT NOT NULL,
  candidate_sha256 TEXT NOT NULL,
  candidate_content TEXT NOT NULL,
  candidate_size INTEGER NOT NULL,
  prior_sha256 TEXT NOT NULL,
  prior_size INTEGER NOT NULL,
  edit_delta INTEGER NOT NULL,
  rejection_reason TEXT NOT NULL,
  score_json TEXT NOT NULL,
  regen_source TEXT NOT NULL,
  story_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(candidate_sha256) = 64),
  CHECK (candidate_size >= 0),
  CHECK (prior_size >= 0),
  CHECK (rejection_reason IN (
    'size-delta-disallow', 'structural-diff-disallow',
    'embedding-cosine-disallow', 'marker-tampered',
    'unclassified-surface', 'no-authorized-story', 'no-prior-row'
  ))
);

CREATE INDEX IF NOT EXISTS canonical_quarantine_doc_path
  ON canonical_versions_quarantine (doc_path, id);
