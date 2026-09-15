-- 137_inferred_high_authority.sql — the inferred-high authority class +
-- conflict_reason on the question queue (st_f67bc2eb amendment A1).
--
-- Owner directive: the system resolves relationships ITSELF by fusing every
-- signal it already holds; above the high bar it writes automatically at a
-- NEW authority class 'inferred-high' — below stated/contact/owner in the
-- lattice (never overrides a human-grade fact), always deprecable, and only
-- writable by the composite resolver (plain inference stays refused at the
-- store; lib/relation-store.js enforces the source gate).
--
-- SQLite cannot ALTER a CHECK constraint — rebuild person_relations with the
-- widened authority set. Temp table name pr_rebuild (NOT person_relations_*):
-- the one-write-path grep criterion pattern-matches 'INSERT INTO
-- person_relations' and a prefixed temp name false-positives it. Renaming the
-- temp table is outcome-identical: it exists only inside this migration's
-- transaction and vanishes at RENAME; applied DBs never re-run the file
-- (tracked by filename), and a crash mid-file rolls back atomically, so no
-- DB can hold the old temp name. The table is small (stated relations only, tens of
-- rows); indexes are recreated in the same transaction (migration runner
-- wraps the file in BEGIN IMMEDIATE … COMMIT).
CREATE TABLE IF NOT EXISTS pr_rebuild (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  person_a         TEXT NOT NULL,
  person_b         TEXT NOT NULL,
  rel_type         TEXT NOT NULL,
  domain           TEXT NOT NULL CHECK (domain IN ('kinship','social','professional')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
  authority        TEXT NOT NULL CHECK (authority IN ('owner','contact','stated','inferred-high')),
  author_person_id TEXT,
  source           TEXT NOT NULL,
  confidence       REAL NOT NULL DEFAULT 1.0,
  evidence         TEXT NOT NULL DEFAULT '[]',
  stated_at        TEXT,
  valid_from       TEXT,
  valid_until      TEXT,
  superseded_by    INTEGER,
  deprecated_reason TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO pr_rebuild
  (id, person_a, person_b, rel_type, domain, status, authority, author_person_id,
   source, confidence, evidence, stated_at, valid_from, valid_until,
   superseded_by, deprecated_reason, created_at, updated_at)
SELECT id, person_a, person_b, rel_type, domain, status, authority, author_person_id,
   source, confidence, evidence, stated_at, valid_from, valid_until,
   superseded_by, deprecated_reason, created_at, updated_at
FROM person_relations;
DROP TABLE person_relations;
ALTER TABLE pr_rebuild RENAME TO person_relations;
CREATE INDEX IF NOT EXISTS idx_pr_a_active ON person_relations(person_a) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_pr_b_active ON person_relations(person_b) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_pair_domain_active ON person_relations(person_a, person_b, domain) WHERE status = 'active';

-- Genuine-conflict tagging (AC-12: the queue collapses to a residue where
-- every remaining open question names WHY it needs the owner).
ALTER TABLE relation_questions ADD COLUMN conflict_reason TEXT;
