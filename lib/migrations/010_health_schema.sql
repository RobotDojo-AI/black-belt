-- Health schema — proper shape for Pulse app + log_metric/log_medication
-- chat tools. Replaces bogus shells that 000_base_entities.sql previously
-- declared (marker_name/value/recorded_at, etc.).
--
-- Fresh installs: creates all four tables in the shape routes/health.js and
-- lib/chat-tools.js expect. Existing dev DBs with these tables from the
-- legacy health pipeline — IF NOT EXISTS is a no-op there. Either path
-- ends with the same schema.
--
-- Seeding is handled by the `seed-health-groups` JS migration in lib/db.js
-- which runs after SQL migrations; keeping DDL and data seeding separate
-- makes it idempotent and easy to re-seed without touching user rows.

CREATE TABLE IF NOT EXISTS health_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS health_markers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  unit            TEXT NOT NULL DEFAULT '',
  group_id        TEXT NOT NULL REFERENCES health_groups(id),
  view            TEXT NOT NULL DEFAULT 'all',
  ref_low         REAL,
  ref_high        REAL,
  target          REAL,
  trend           TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  recommendations TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_hm_group ON health_markers(group_id);
CREATE INDEX IF NOT EXISTS idx_hm_name  ON health_markers(name);

CREATE TABLE IF NOT EXISTS health_data_points (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  marker_id      TEXT NOT NULL REFERENCES health_markers(id),
  date           TEXT NOT NULL,
  value          REAL NOT NULL,
  source         TEXT NOT NULL DEFAULT 'manual',
  source_file    TEXT NOT NULL DEFAULT '',
  source_id      TEXT NOT NULL DEFAULT '',
  specimen_type  TEXT NOT NULL DEFAULT 'unknown',
  excluded       INTEGER NOT NULL DEFAULT 0,
  exclude_reason TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(marker_id, date, source_file)
);
CREATE INDEX IF NOT EXISTS idx_hdp_marker ON health_data_points(marker_id);
CREATE INDEX IF NOT EXISTS idx_hdp_date   ON health_data_points(date);
CREATE INDEX IF NOT EXISTS idx_hdp_source ON health_data_points(source);

CREATE TABLE IF NOT EXISTS curated_medications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'supplement' CHECK(type IN ('rx', 'supplement')),
  dose         TEXT,
  frequency    TEXT,
  timing       TEXT,
  date_started TEXT,
  date_stopped TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'stopped', 'episodic')),
  notes        TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, date_started)
);
CREATE INDEX IF NOT EXISTS idx_cm_status ON curated_medications(status);
