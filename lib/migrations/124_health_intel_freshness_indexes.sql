-- Health intel freshness asks for MAX(updated/created timestamps) on hot local
-- health tables. These indexes keep that check bounded on large Apple Health
-- and Oura imports, especially under SQLCipher.

CREATE INDEX IF NOT EXISTS idx_hdp_created_at
ON health_data_points(created_at);

CREATE INDEX IF NOT EXISTS idx_hil_nonempty_created_at
ON health_ingestion_log(created_at)
WHERE COALESCE(record_count, 0) > 0;

CREATE INDEX IF NOT EXISTS idx_health_markers_updated_at
ON health_markers(updated_at);

CREATE INDEX IF NOT EXISTS idx_health_notes_created_at
ON health_notes(created_at);

CREATE INDEX IF NOT EXISTS idx_curated_medications_updated_at
ON curated_medications(updated_at);
