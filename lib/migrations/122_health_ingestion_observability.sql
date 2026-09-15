-- Health ingestion observability.
-- The original ledger only stored source/file/count, which made failed imports
-- indistinguishable from files that were deliberately processed and had no data.

ALTER TABLE health_ingestion_log ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE health_ingestion_log ADD COLUMN error TEXT;
ALTER TABLE health_ingestion_log ADD COLUMN metadata_json TEXT;

UPDATE health_ingestion_log
SET status = CASE
  WHEN COALESCE(record_count, 0) > 0 THEN 'ok'
  ELSE 'no_data'
END
WHERE status = 'ok';

CREATE INDEX IF NOT EXISTS idx_hil_status ON health_ingestion_log(status);
