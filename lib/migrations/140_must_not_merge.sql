-- df_cbd30a5a Phase 2 (AC-10) — durable must-not-merge constraint.
--
-- When two wrongly-fused people are split (lib/entity-unmerge.js, or an
-- owner-confirmed over-merge-detector split), the pair MUST be recorded as a
-- persistent negative assertion or the next scripts/ingest/02-resolve.js pass
-- re-welds them via the same shared/forwarded contact identifier (the re-weld
-- loop). The declared-owner anchor covers only the OWNER; this table is the
-- general (non-owner) durable veto.
--
-- Written ONLY by deterministic code (lib/people-merge.js writeMustNotMerge);
-- no LLM writes a row (LLM-write boundary). Enforced at both merge sites via
-- lib/people-merge.js isMergeForbidden.
--
-- The pair is stored order-independent: person_id_a is always the
-- lexicographically-smaller id, person_id_b the larger, so UNIQUE(a,b) makes
-- one row per unordered pair and INSERT OR IGNORE dedups a reversed re-insert.
CREATE TABLE IF NOT EXISTS must_not_merge (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id_a  TEXT NOT NULL,               -- canonical: min(idX, idY)
  person_id_b  TEXT NOT NULL,               -- canonical: max(idX, idY)
  reason       TEXT NOT NULL DEFAULT 'unmerge-split',
  source       TEXT NOT NULL DEFAULT 'entity-unmerge',  -- entity-unmerge | over-merge-detector | manual
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(person_id_a, person_id_b)
);
-- Reverse-direction lookup ("all constraints involving X on the b-side"); the
-- UNIQUE(a,b) index already serves the canonical (a,b) enforcement lookup.
CREATE INDEX IF NOT EXISTS idx_mnm_b ON must_not_merge(person_id_b);
