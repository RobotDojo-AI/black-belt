-- Staging table for FHIR observations that don't map to a known health_marker.
-- Captures all Apple Health clinical data without losing it.
-- A curation pipeline can later promote these to health_markers + health_data_points.

CREATE TABLE IF NOT EXISTS fhir_staged_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  fhir_display_name TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  ref_low REAL,
  ref_high REAL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | mapped | skipped
  mapped_marker_id TEXT REFERENCES health_markers(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_file, effective_date, fhir_display_name, value)
);

CREATE INDEX IF NOT EXISTS idx_fhir_staged_status ON fhir_staged_observations(status);
CREATE INDEX IF NOT EXISTS idx_fhir_staged_name ON fhir_staged_observations(fhir_display_name);
