-- Durable passive data-plane job ledger.
--
-- This table is intentionally generic: drop-folder imports, session-log
-- materialization, OAuth sync mirrors, chunking, embeddings, integration
-- health refresh, and scheduled maintenance can all report the same lifecycle
-- without each subsystem inventing its own retry/quarantine shape.
--
-- Status contract:
--   queued      ready after run_after
--   running     leased by one worker until lease_expires_at
--   paused      delayed by CPU/memory/backpressure guard
--   done        completed successfully
--   failed      terminal non-quarantined failure, reserved for manual marking
--   quarantined poison record; do not retry until user/source changes

CREATE TABLE IF NOT EXISTS passive_jobs (
  id                 TEXT PRIMARY KEY,
  queue              TEXT NOT NULL DEFAULT 'default',
  job_type           TEXT NOT NULL,
  unique_key         TEXT NOT NULL,
  target_type        TEXT NOT NULL DEFAULT 'system',
  target_id          TEXT NOT NULL DEFAULT '',
  payload            TEXT NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'paused', 'done', 'failed', 'quarantined')),
  priority           INTEGER NOT NULL DEFAULT 50,
  attempts           INTEGER NOT NULL DEFAULT 0,
  max_attempts       INTEGER NOT NULL DEFAULT 5,
  retry_count        INTEGER NOT NULL DEFAULT 0,
  run_after          TEXT NOT NULL DEFAULT (datetime('now')),
  lease_owner        TEXT,
  lease_expires_at   TEXT,
  timeout_ms         INTEGER NOT NULL DEFAULT 30000,
  last_success_at    TEXT,
  last_failure_at    TEXT,
  last_error         TEXT,
  quarantine_reason  TEXT,
  metadata           TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  started_at         TEXT,
  finished_at        TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_passive_jobs_unique_key
  ON passive_jobs(unique_key);

CREATE INDEX IF NOT EXISTS idx_passive_jobs_claim
  ON passive_jobs(queue, status, run_after, priority DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_passive_jobs_type_status
  ON passive_jobs(job_type, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_passive_jobs_lease
  ON passive_jobs(status, lease_expires_at)
  WHERE status = 'running';
