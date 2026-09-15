-- Ensure calendar_events table exists in the baseline migration chain.
-- The table is also created by lib/graph-calendar-sync.js inline migrate() calls,
-- but those only run when that module is imported. This migration ensures
-- any module that imports lib/db.js (e.g. chunk-worker.js) has the table available.
-- All columns match the canonical schema in graph-calendar-sync.js exactly.
CREATE TABLE IF NOT EXISTS calendar_events (
  id          TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  summary     TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  start_time  TEXT NOT NULL DEFAULT '',
  end_time    TEXT NOT NULL DEFAULT '',
  all_day     INTEGER NOT NULL DEFAULT 0,
  attendees   TEXT NOT NULL DEFAULT '[]',
  organizer   TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'confirmed',
  html_link   TEXT NOT NULL DEFAULT '',
  synced_at   TEXT NOT NULL DEFAULT (datetime('now')),
  account_id  TEXT,
  source      TEXT NOT NULL DEFAULT 'api'
);

CREATE INDEX IF NOT EXISTS idx_calendar_start   ON calendar_events(start_time);
CREATE INDEX IF NOT EXISTS idx_calendar_account ON calendar_events(account_id);
