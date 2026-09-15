-- Migration 057 — multi-topic junction table.
-- A conversation can belong to multiple topics. is_primary=1 mirrors conversations.topic_slug.
-- is_primary=0 entries are secondary candidates from Haiku or Round 2 embedding similarity.
CREATE TABLE IF NOT EXISTS conversation_topics (
  conversation_id TEXT,
  topic_slug TEXT,
  is_primary INTEGER DEFAULT 1,
  similarity_score REAL,
  set_method TEXT,
  PRIMARY KEY (conversation_id, topic_slug)
);
