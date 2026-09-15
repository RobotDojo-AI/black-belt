-- 100_person_speech_profile.sql — cross-call speech fingerprint (st_8a841c68 Phase 4).
--
-- One row per person, accumulated from confirmed/owner turns. This is the
-- mechanism behind "more confident as the same people recur": a fresh profile
-- (low token_count) contributes little; confidence from a fingerprint match
-- scales as token_count crosses the ~1k-token floor the research names.
--
-- DESIGN:
--   * Keyed by person_id, NOT overloaded onto chunk_vec_* (those are
--     chunk-keyed; mixing speaker vectors corrupts RAG retrieval). One vector
--     per person, updated as confirms accumulate.
--   * style_features is content-masked (function-word freqs, filler rates,
--     mean turn length) — the features that survive topic control. Topic-
--     leaking content features are excluded by construction.
--   * embedding is a mean-pooled LOCAL embedding (lib/rag.js LOCAL_EMBED_DIM),
--     stored as a BLOB. Local + free (Tier 0).

CREATE TABLE IF NOT EXISTS person_speech_profile (
  person_id      TEXT    PRIMARY KEY,            -- → people.id
  token_count    INTEGER NOT NULL DEFAULT 0,     -- confirmed tokens accumulated (the ~1k floor)
  style_features TEXT    NOT NULL DEFAULT '{}',  -- JSON: function-word freqs, filler rates, mean turn length
  embedding      BLOB,                           -- mean-pooled local embedding of confirmed turns
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
