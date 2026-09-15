-- st_f6315f0b — setup_tasks
--
-- Setup/onboarding surface for user-actionable issues that workers cannot
-- self-heal. Each row is a tiny piece of "needs you" state: a missing
-- macOS permission, an expired OAuth token, a misconfigured Keychain entry.
--
-- WHY a small dedicated table (not piggyback on existing accounts):
-- - The set of issues is broader than accounts (e.g. TCC denials are not
--   tied to a vendor row).
-- - The /onboard UI and account-status surfaces need a single list
--   they can render; one table keeps that read path simple.
-- - INSERT OR IGNORE on (kind, source_key) is the natural idempotency
--   primitive — a worker can blindly attempt to insert on every failure
--   without checking first; the unique constraint deduplicates.
--
-- kind examples: 'tcc_imessage', 'oauth_expired', 'keychain_missing'.
-- status: 'needs_user' | 'in_progress' | 'resolved'.
--
-- Idempotent. Safe to apply on fresh and existing DBs.
--
-- Down migration (manual):  DROP TABLE IF EXISTS setup_tasks;

CREATE TABLE IF NOT EXISTS setup_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                          -- short identifier (e.g. 'tcc_imessage')
  source_key  TEXT,                                   -- optional sub-key for multi-instance kinds
  status      TEXT NOT NULL DEFAULT 'needs_user',
  message     TEXT,                                   -- one-line user-readable description
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(kind, source_key)
);

CREATE INDEX IF NOT EXISTS idx_setup_tasks_status
  ON setup_tasks(status);
