-- 132_people_relation_tag_index.sql
-- st_df0a8d71 fix-forward — the ego render, both fact quizzes, and the card
-- consistency gate all read "people WHERE relation_tag IS NOT NULL". With no
-- index that is a FULL SCAN of the people table; measured cold on the live
-- SQLCipher DB it ran 458 SECONDS (page-decrypt churn), and the render's
-- refresh paths (boot prime, graph-change, idle tick) execute on the server's
-- main thread — a scan there is exactly the event-loop pinning this story
-- exists to eliminate. The research constraint was explicit: anything on the
-- render path must be a bounded index read.
--
-- Partial index over the ~30-row family-tagged set: the WHERE clause matches
-- the readers' predicate verbatim, so the scan becomes a ~30-entry index
-- walk. Additive, tiny, reversible by ignoring it.
CREATE INDEX IF NOT EXISTS idx_people_relation_tag
  ON people(relation_tag)
  WHERE relation_tag IS NOT NULL;
