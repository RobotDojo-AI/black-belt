-- 138_people_derived_phrase_index.sql — partial index for the derived-phrase
-- readers (st_f67bc2eb amendment A1).
--
-- Migration 132's lesson, relearned live: the derived-path chat answer
-- ("Who is my wife's cousin?") reads people WHERE relation_derived_phrase IS
-- NOT NULL — unindexed, that is a full scan over the ~385k-row people table
-- on the SQLCipher DB (measured 104s cold, which times out the chat stream).
-- The partial index bounds the read to the handful of walk-derived rows; the
-- query's WHERE clause matches the index predicate verbatim.
CREATE INDEX IF NOT EXISTS idx_people_derived_phrase
  ON people(relation_derived_phrase)
  WHERE relation_derived_phrase IS NOT NULL;
