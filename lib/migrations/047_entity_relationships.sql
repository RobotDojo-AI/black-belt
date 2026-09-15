-- Entity relationship graph: typed, weighted edges between any two entities.
-- Distinct from person_edges (raw co-occurrence signal) — this table stores
-- derived, classified relationships with typed labels.
CREATE TABLE IF NOT EXISTS entity_relationships (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id_a    TEXT NOT NULL,
  entity_id_b    TEXT NOT NULL,
  entity_type_a  TEXT NOT NULL DEFAULT 'person',
  entity_type_b  TEXT NOT NULL DEFAULT 'person',
  relationship_type TEXT NOT NULL,
  weight         REAL NOT NULL DEFAULT 1.0,
  first_seen     TEXT,
  last_seen      TEXT,
  source         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id_a, entity_id_b, relationship_type, source)
);
CREATE INDEX IF NOT EXISTS idx_er_a ON entity_relationships(entity_id_a);
CREATE INDEX IF NOT EXISTS idx_er_b ON entity_relationships(entity_id_b);
