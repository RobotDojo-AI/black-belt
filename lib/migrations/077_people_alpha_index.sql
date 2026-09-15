-- st_93fddaf0 — Phase 9 amendment. Composite index on
--   (archived, n1, n2, display_name COLLATE NOCASE)
-- for the alphabetical-within-bucket ordering introduced by the scope
-- amendment (intra-tier rank dropped; within-bucket order is alphabetical
-- by display_name, case-insensitive).
--
-- WHY a new index alongside 074's (n1, n2, score DESC):
-- - The score-DESC index still serves any path that orders by score
--   (lib/chat-context.js, lib/scoring.js consumers, BB tier ladders).
-- - The alphabetical index serves the WB teaser path getPeopleTeaser()
--   and the /api/network/people default response.
-- - Both indexes are partial on archived=0, so on-disk cost is bounded
--   to the visible-people subset.
--
-- Idempotency: CREATE INDEX IF NOT EXISTS is unconditionally safe.
--
-- Down migration (manual rollback, not auto-applied):
--   DROP INDEX IF EXISTS idx_people_n1_n2_name_nocase;

CREATE INDEX IF NOT EXISTS idx_people_n1_n2_name_nocase
  ON people(n1, n2, display_name COLLATE NOCASE) WHERE archived = 0;
