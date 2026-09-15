-- User chart archive preferences. Auto-archive remains deterministic; this
-- table records the user's explicit show/hide override for individual charts.

CREATE TABLE IF NOT EXISTS health_chart_archive_preferences (
  marker_id  TEXT PRIMARY KEY,
  archived   INTEGER NOT NULL CHECK (archived IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_health_chart_archive_preferences_updated
ON health_chart_archive_preferences(updated_at);
