-- 133_person_relations.sql — typed person-to-person relationship edges
-- (st_f67bc2eb D1). The stated-relations truth source: GEDCOM-X-shaped,
-- authority-ranked, deprecate-never-delete. Owner-anchored relation_tag /
-- relation_label columns become a walker-derived CACHE of this table.
--
-- WHY a new table and not entity_relationships: that table holds 5.65M
-- auto-derived colleague rows with MAX-weight upsert (confidence can never go
-- down), UNIQUE-with-source (contradictory types coexist), no direction, no
-- author, no temporal validity. The two truth grades are separated
-- structurally; the legacy table is never read for kinship again.
--
-- Direction convention (enforced in lib/relation-store.js, the ONE writer):
--   directional types store one canonical representation — person_a holds the
--   rel_type role of person_b (parent = a is b's parent; child normalizes to
--   parent with swapped endpoints, mentee to mentor). Symmetric types store
--   canonical order person_a < person_b.
--
-- Partial indexes up front — migration 132's 458-second lesson: new access
-- paths ship with their indexes in the same migration. The partial UNIQUE
-- enforces one active edge per (canonical pair, domain): cousin AND colleague
-- coexist across domains; two conflicting kinship claims can never both be
-- active.
CREATE TABLE IF NOT EXISTS person_relations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  person_a         TEXT NOT NULL,
  person_b         TEXT NOT NULL,
  rel_type         TEXT NOT NULL,   -- closed vocabulary, code-validated in lib/relation-store.js
  domain           TEXT NOT NULL CHECK (domain IN ('kinship','social','professional')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
  authority        TEXT NOT NULL CHECK (authority IN ('owner','contact','stated')),
  author_person_id TEXT,            -- speaker-relative anchor: who stated it
  source           TEXT NOT NULL,   -- provenance token (chat-correction, question-answer, mining-chat, mining-email, mining-notes, contact-card, legacy-backfill)
  confidence       REAL NOT NULL DEFAULT 1.0,
  evidence         TEXT NOT NULL DEFAULT '[]',  -- JSON [{kind, source_id, date}] — cross-instance confirmations, deduped per source
  stated_at        TEXT,            -- newest statement date (temporal supersede)
  valid_from       TEXT,
  valid_until      TEXT,            -- non-null = former/ended ("my former colleague X")
  superseded_by    INTEGER,         -- id of the replacing edge
  deprecated_reason TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pr_a_active ON person_relations(person_a) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_pr_b_active ON person_relations(person_b) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_pair_domain_active ON person_relations(person_a, person_b, domain) WHERE status = 'active';
