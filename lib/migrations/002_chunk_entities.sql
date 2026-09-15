-- WHY: chunk_entities maps RAG chunks to the people/companies/places they mention.
-- This powers chat-context.js Layer 2 — when a user's query names an entity,
-- we pull chunks linked to that entity_id.
-- The table is created IF NOT EXISTS so the migration is safe to retry.
-- chunk_id references chunks(id) with CASCADE so entity links disappear
-- when a chunk is deleted (data deletion path in account-deletion.js).
CREATE TABLE IF NOT EXISTS chunk_entities (
  chunk_id   INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  entity_id  INTEGER NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'person',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chunk_id, entity_id)
);
-- entity_id lookup: given a person/company, find all their chunks fast.
CREATE INDEX IF NOT EXISTS idx_chunk_entities_entity ON chunk_entities(entity_id);
-- chunk_id lookup: given a chunk, find all its linked entities fast.
CREATE INDEX IF NOT EXISTS idx_chunk_entities_chunk  ON chunk_entities(chunk_id);
