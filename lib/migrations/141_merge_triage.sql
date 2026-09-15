-- df_cbd30a5a Phase 3 (AC-13) — merge triage queue.
--
-- The precision merge rule (AC-12 shouldMerge) diverts every case it cannot
-- decide confidently to this queue instead of guessing: a borderline name
-- match, >4 distinct-content cards collapsing into one person, a suspected
-- maiden-name surname change, or an ambiguous bridge that would join two
-- name-disjoint sub-clusters. The resolver NEVER blocks on triage — its
-- default is keep-separate; this table is asynchronous owner review, off the
-- critical path (the deliberate, owner-approved reversal of the binary-match
-- principle). Written ONLY by deterministic code (lib/people-merge.js
-- writeMergeTriage); no LLM writes a row (LLM-write boundary).
--
-- Pair stored order-independent (a = min id, b = max id) so
-- UNIQUE(a,b,reason) is one row per unordered pair per reason and a
-- re-resolve INSERT OR IGNORE never spams duplicates. person_id_b MAY be a
-- second person id (both records exist and stay separate).
CREATE TABLE IF NOT EXISTS merge_triage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id_a   TEXT NOT NULL,              -- canonical: min(idA, idB)
  person_id_b   TEXT NOT NULL,              -- canonical: max(idA, idB)
  reason        TEXT NOT NULL,              -- borderline-name | over-4-cards | suspected-maiden-name | ambiguous-bridge
  bridge_type   TEXT,                       -- email | phone | NULL
  bridge_value  TEXT,                       -- the shared identifier value, or NULL
  name_a        TEXT,
  name_b        TEXT,
  detail        TEXT,                       -- JSON provenance: name verdict, component tokens, card count, popular flag
  source        TEXT NOT NULL DEFAULT 'resolve',  -- resolve | detector | manual
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | merged | kept-separate | dismissed
  resolved_by   TEXT,                       -- owner | miyagi | NULL
  resolved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(person_id_a, person_id_b, reason)
);
CREATE INDEX IF NOT EXISTS idx_merge_triage_status ON merge_triage(status);
CREATE INDEX IF NOT EXISTS idx_merge_triage_b ON merge_triage(person_id_b);
