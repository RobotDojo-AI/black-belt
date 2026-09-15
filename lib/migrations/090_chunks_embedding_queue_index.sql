-- Speed up Accounts memory-index status and chunk-worker queue checks.
-- The worker and the account surface both need to answer:
-- "how many chunks are eligible for local embedding right now?"
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_queue
  ON chunks(embedded, skip_embed)
  WHERE embedded = 0 AND skip_embed = 0;
