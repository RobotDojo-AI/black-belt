-- 034_company_entities.sql
-- Universal company fields + company_topics.
-- All additive — no data loss. Tracked in migrations ledger (runs once only).
--
-- WHY these fields are here and NOT domain columns:
--   hq and year_founded are universal — every company might have them.
--   Domain-specific XLSX fields (BBB rating, digital capability, compliance
--   flags, credentials, ranking) go into context files ONLY, never as columns.
--
-- company_topics mirrors person_topics(person_id, topic, weight, updated_at).
--
-- Vec tables for topic chunks are created dynamically on first ingest by
-- scripts/ingest-agency-xlsx.js using chunk_vec_${safeTopic} naming. No
-- owner-specific vec table is bootstrapped here.

ALTER TABLE companies ADD COLUMN hq TEXT;
ALTER TABLE companies ADD COLUMN year_founded INTEGER;

CREATE TABLE IF NOT EXISTS company_topics (
  company_id TEXT NOT NULL,
  topic      TEXT NOT NULL,
  weight     REAL DEFAULT 1.0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (company_id, topic)
);

CREATE INDEX IF NOT EXISTS idx_ct_topic ON company_topics(topic);
