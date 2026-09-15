-- Recreate person_edges with the correct 9-column schema and 4-column UNIQUE constraint.
-- Safe for both states:
--   fresh-install: 6 cols + 3-col UNIQUE(person_a, person_b, edge_type)
--   live DB: 9 cols + 4-col UNIQUE(person_a, person_b, edge_type, context) and 0 rows
-- The table recreation approach handles the UNIQUE constraint change that ALTER TABLE
-- cannot perform.
ALTER TABLE person_edges RENAME TO _person_edges_old;
CREATE TABLE person_edges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_a   TEXT NOT NULL,
  person_b   TEXT NOT NULL,
  edge_type  TEXT NOT NULL DEFAULT 'co_occurrence',
  weight     REAL DEFAULT 1.0,
  context    TEXT,
  first_seen TEXT,
  last_seen  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(person_a, person_b, edge_type, context)
);
-- Copy from old table using only columns present in both schemas.
INSERT INTO person_edges (id, person_a, person_b, edge_type, weight, created_at)
SELECT id, person_a, person_b, edge_type, weight, created_at FROM _person_edges_old;
DROP TABLE _person_edges_old;
CREATE INDEX IF NOT EXISTS idx_pe_a ON person_edges(person_a);
CREATE INDEX IF NOT EXISTS idx_pe_b ON person_edges(person_b);
