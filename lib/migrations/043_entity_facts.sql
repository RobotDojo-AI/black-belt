-- entity_facts: temporal fact store for the entity knowledge graph.
-- Facts are never deleted — invalid_at is set when superseded (Graphiti pattern).
-- model_tier records which compute tier extracted the fact (for cost auditing).
CREATE TABLE IF NOT EXISTS entity_facts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id        TEXT NOT NULL,
  entity_type      TEXT NOT NULL CHECK(entity_type IN ('person','company','place')),
  fact_type        TEXT NOT NULL CHECK(fact_type IN (
                     'job_title','employer','location','relationship_label',
                     'phone','email','bio_note','general'
                   )),
  fact_value       TEXT NOT NULL,
  source_event_ids TEXT,
  valid_at         TEXT,
  invalid_at       TEXT,
  extracted_at     TEXT NOT NULL DEFAULT (datetime('now','utc')),
  model_tier       TEXT NOT NULL CHECK(model_tier IN ('free','haiku','sonnet'))
);
CREATE INDEX IF NOT EXISTS ef_entity_current ON entity_facts(entity_id, invalid_at);
CREATE INDEX IF NOT EXISTS ef_entity_type_current ON entity_facts(entity_id, fact_type, invalid_at);
CREATE INDEX IF NOT EXISTS ef_fact_type ON entity_facts(fact_type, extracted_at);
