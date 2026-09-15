-- Add needs_regen flag to user_topics so ingest can mark stale topics
-- for overnight regeneration by nightly.js phaseTopics.
-- WHY NOT NULL DEFAULT 0: all existing topics start clean; flag is set by ingest
-- after new data arrives, not retroactively on migration.
ALTER TABLE user_topics ADD COLUMN needs_regen INTEGER NOT NULL DEFAULT 0;
