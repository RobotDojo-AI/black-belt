-- Migration 065 — quality_json + quality-gate-fail rejection reason
-- Story st_0b5e7458 (canonical-degradation-signals).
--
-- Adds:
--   1. nullable canonical_versions.quality_json TEXT  — Sonnet-judge verdict
--      (dimensions, aggregate, rationale, judge_model, rubric_hash, intent_hash).
--      Pre-migration rows stay NULL — historical content is not recoverable.
--   2. extends canonical_versions_quarantine.rejection_reason CHECK to allow
--      'quality-gate-fail'. SQLite cannot ALTER a CHECK constraint, so the
--      quarantine table is rebuilt via the established _new + INSERT SELECT +
--      DROP + RENAME pattern (mirrors migration 063).
--
-- WHY two-table approach: canonical_versions only needs an additive column
-- (no constraint change) — `ALTER TABLE ADD COLUMN` is cheap. The quarantine
-- table needs an expanded CHECK enum, which requires a full rebuild.

PRAGMA foreign_keys = OFF;

-- ── 1. Additive column on canonical_versions ─────────────────────────────────
ALTER TABLE canonical_versions ADD COLUMN quality_json TEXT;

-- ── 2. Rebuild canonical_versions_quarantine with extended CHECK ─────────────
CREATE TABLE canonical_versions_quarantine_new (
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
    'unclassified-surface', 'no-authorized-story', 'no-prior-row',
    'quality-gate-fail'
  ))
);

INSERT INTO canonical_versions_quarantine_new
  SELECT id, doc_path, candidate_sha256, candidate_content, candidate_size,
         prior_sha256, prior_size, edit_delta, rejection_reason, score_json,
         regen_source, story_id, created_at
    FROM canonical_versions_quarantine;

DROP TABLE canonical_versions_quarantine;
ALTER TABLE canonical_versions_quarantine_new RENAME TO canonical_versions_quarantine;

CREATE INDEX IF NOT EXISTS canonical_quarantine_doc_path
  ON canonical_versions_quarantine (doc_path, id);

PRAGMA foreign_keys = ON;
