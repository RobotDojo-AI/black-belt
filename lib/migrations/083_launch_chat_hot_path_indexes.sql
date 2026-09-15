-- Day 2 launch hardening: indexes for the chat/RAG/entity hot path.
-- All indexes are additive and idempotent.

-- RAG candidate scans often filter to embedded rows inside one topic and then
-- prefer recent, high-quality chunks for prompt context.
CREATE INDEX IF NOT EXISTS idx_chunks_embedded_topic_event_quality
  ON chunks(topic, event_time DESC, quality_score DESC)
  WHERE embedded = 1;

-- Entity-associated context orders recent chunks after chunk_entities lookup.
CREATE INDEX IF NOT EXISTS idx_chunks_created_at
  ON chunks(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chunk_entities_type_entity_chunk
  ON chunk_entities(entity_type, entity_id, chunk_id);

-- Fuzzy entity detection still uses LIKE, but this partial index keeps the
-- visible subset ordered by score for the LIMIT 30 scan.
CREATE INDEX IF NOT EXISTS idx_people_visible_score_name
  ON people(score DESC, display_name COLLATE NOCASE)
  WHERE archived = 0 AND score > 0 AND display_name IS NOT NULL;

-- Company detection should scan the launch-visible company subset, not every
-- extracted company row.
CREATE INDEX IF NOT EXISTS idx_companies_visible_name
  ON companies(name COLLATE NOCASE)
  WHERE n2 IS NOT NULL AND n2 != '' AND name IS NOT NULL;
