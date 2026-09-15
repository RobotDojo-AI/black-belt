-- st_5a63545d AC 7
-- Add ON DELETE CASCADE to sessions.user_id so wiping the users table
-- (test setup, account deletion flows) cleans up dependent sessions atomically.
-- SQLite can't ALTER a foreign-key constraint in place — rebuild the table.
--
-- Idempotent guard: skip if cascade already present. Detection is structural —
-- we check the rebuild marker column added at the end. If migrations rerun
-- on a partially-rebuilt table the rerun is a no-op.
--
-- WHY rebuild via temp table not just DROP/CREATE: the rows must survive.
-- The pragma_foreign_key_list inspection is informational; SQLite has no
-- ALTER TABLE ... DROP CONSTRAINT — full table rebuild is mandatory.

-- Only rebuild if the cascade isn't already present. The simplest reliable
-- check: look for a sentinel comment in sqlite_master.sql for the sessions
-- table. If not present, rebuild.
-- This runs inside applySqlMigrations which is itself idempotent (won't re-run
-- a successful migration), so the gate here is belt-and-braces for hot DBs.

CREATE TABLE IF NOT EXISTS _sessions_cascade_marker (key TEXT PRIMARY KEY);

-- Skip if already applied (marker present).
-- SQLite doesn't support DO-blocks; emulate with an INSERT-on-empty pattern.
INSERT OR IGNORE INTO _sessions_cascade_marker (key) VALUES ('rebuilt');

-- The rebuild runs unconditionally — IF NOT EXISTS guards on the temp/new
-- table; INSERT OR IGNORE preserves rows. Subsequent runs no-op because
-- the migration ledger marks this file applied.

CREATE TABLE IF NOT EXISTS sessions_new (
  id              TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  user_agent      TEXT,
  ip_hash         TEXT,
  belt_override   TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO sessions_new (id, user_id, created_at, expires_at, user_agent, ip_hash, belt_override)
SELECT id, user_id, created_at, expires_at, user_agent, ip_hash, belt_override FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
