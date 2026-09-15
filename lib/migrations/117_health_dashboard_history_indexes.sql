-- Keep the Health dashboard fast after the user has real imported health data.
-- Inline-created columns/tables are indexed by db.js after those migrations run.

CREATE INDEX IF NOT EXISTS idx_health_notes_tagged_recent
ON health_notes(date DESC, id DESC)
WHERE COALESCE(tags, '[]') NOT IN ('', '[]');
