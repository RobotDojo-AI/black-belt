CREATE TABLE IF NOT EXISTS maintenance_queue (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL
    CHECK (target_type IN ('topic', 'person', 'company', 'place', 'workbench', 'backup', 'system')),
  target_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'skipped', 'failed')),
  policy_tier TEXT NOT NULL DEFAULT 'auto'
    CHECK (policy_tier IN ('auto', 'cpu', 'haiku', 'sonnet')),
  estimated_cost_cents REAL NOT NULL DEFAULT 0,
  budget_cents INTEGER NOT NULL DEFAULT 2500,
  metadata TEXT NOT NULL DEFAULT '{}',
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_queue_status_priority
  ON maintenance_queue(status, priority DESC, queued_at ASC);

CREATE INDEX IF NOT EXISTS idx_maintenance_queue_target
  ON maintenance_queue(target_type, target_id, status);

CREATE TABLE IF NOT EXISTS maintenance_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  routine_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('planned', 'started', 'done', 'skipped', 'failed')),
  artifact_path TEXT DEFAULT '',
  artifact_hash TEXT DEFAULT '',
  cost_cents REAL NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_maintenance_ledger_target
  ON maintenance_ledger(target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_maintenance_ledger_routine
  ON maintenance_ledger(routine_id, created_at DESC);
