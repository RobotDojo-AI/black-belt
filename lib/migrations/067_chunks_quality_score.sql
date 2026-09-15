-- Migration 067 — chunks.quality_score + partial covering index
-- Story st_566ad80b (rag-hnsw-migration).
--
-- Adds a composite quality_score on every chunk so the per-topic hot-tier
-- HNSW index can be built from "top-N by quality_score WHERE embedded=1"
-- in a single planner-friendly query.
--
-- Formula (computed at backfill time, NOT in SQL):
--   quality_score = 0.5 * source_tier + 0.5 * recency_decay
-- where source_tier is a fixed-by-source-type weight (contacts > photos >
-- calendar > messages > notes > transcripts > email — see lib/ann/
-- quality-score.js) and recency_decay is an event_time-based exponential
-- decay (1.0 today → 0.5 at one year → 0.25 at two years).
--
-- WHY NOT NULL DEFAULT 0.0: every chunk has a quality_score; new chunks
-- inserted before the backfill (e.g. live ingest mid-migration) get 0.0
-- temporarily and the backfill picks them up on the next pass (idempotent
-- because the backfill skips rows already set > 0.0... but we expressly
-- DELETE-then-INSERT in cases where the formula changes, see /02-design.md).
--
-- WHY partial covering index: `(topic, quality_score DESC) WHERE embedded=1`
-- is the exact query the hot-tier builder runs per-topic. A covering index
-- means the planner returns chunk_ids without touching the chunks table —
-- the build is ~100x faster on the 1.2 M-row corpus.
--
-- Rollback: `DROP INDEX idx_chunks_quality_embedded; ALTER TABLE chunks
-- DROP COLUMN quality_score;` (SQLite ≥3.35 supports DROP COLUMN).

ALTER TABLE chunks ADD COLUMN quality_score REAL NOT NULL DEFAULT 0.0;

-- Partial covering index — only embedded rows participate in HNSW builds.
-- WHY DESC: hot-tier wants the top-N by quality_score; DESC keeps the
-- planner from reversing the result.
CREATE INDEX IF NOT EXISTS idx_chunks_quality_embedded
  ON chunks (topic, quality_score DESC)
  WHERE embedded = 1;
