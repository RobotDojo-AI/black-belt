-- st_f6315f0b — worker_backoff
--
-- Persistent backoff state for background workers that hit unrecoverable
-- conditions and must self-throttle across launchd fires.
--
-- WHY a SQLite table instead of a /tmp file:
-- - /tmp survives reboot but is opaque to inspection; SQL is greppable.
-- - One canonical place to read backoff state; no parallel state surfaces.
-- - Atomic upsert via INSERT OR REPLACE matches the read-modify-write
--   pattern we need (one row per worker_key).
--
-- Schedule (managed in code, not constraint):
--   1m → 5m → 15m → 30m → 60m, sticky at 60m until the worker succeeds.
-- On success, the row is deleted, resetting future failures to step 1.
--
-- Idempotent. Safe to apply on fresh and existing DBs.
--
-- Down migration (manual):  DROP TABLE IF EXISTS worker_backoff;

CREATE TABLE IF NOT EXISTS worker_backoff (
  worker_key       TEXT PRIMARY KEY,
  next_attempt_at  INTEGER NOT NULL,           -- unix seconds (epoch)
  attempt_count    INTEGER NOT NULL DEFAULT 1, -- current step in the schedule (1..5)
  last_error       TEXT,
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_worker_backoff_next_attempt_at
  ON worker_backoff(next_attempt_at);
