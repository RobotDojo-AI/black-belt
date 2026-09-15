-- Canonical workbench layer for Codex/coding-agent deep work.
--
-- A workbench is durable in-flight substrate. It is not canonical truth by
-- itself; reviewed promotions move compact conclusions back into topic or
-- entity context.

CREATE TABLE IF NOT EXISTS workbenches (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  root_path TEXT NOT NULL,
  summary TEXT DEFAULT '',
  current_question TEXT DEFAULT '',
  latest_state TEXT DEFAULT '',
  next_action TEXT DEFAULT '',
  resume_path TEXT DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  last_activity_at TEXT,
  last_resumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workbenches_status ON workbenches(status);
CREATE INDEX IF NOT EXISTS idx_workbenches_last_activity ON workbenches(last_activity_at);

CREATE TABLE IF NOT EXISTS workbench_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workbench_id TEXT NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL
    CHECK (target_type IN ('topic', 'person', 'company', 'place')),
  target_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'primary'
    CHECK (role IN ('primary', 'secondary', 'related', 'promotion_target')),
  label TEXT DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workbench_id, target_type, target_id, role)
);

CREATE INDEX IF NOT EXISTS idx_workbench_attachments_target
  ON workbench_attachments(target_type, target_id);

CREATE TABLE IF NOT EXISTS workbench_items (
  id TEXT PRIMARY KEY,
  workbench_id TEXT NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT DEFAULT '',
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'current'
    CHECK (status IN ('current', 'stale', 'unresolved', 'promoted')),
  staleness TEXT NOT NULL DEFAULT 'current'
    CHECK (staleness IN ('current', 'stale', 'unknown')),
  metadata TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workbench_id, path)
);

CREATE INDEX IF NOT EXISTS idx_workbench_items_workbench_kind
  ON workbench_items(workbench_id, kind);

CREATE TABLE IF NOT EXISTS workbench_promotions (
  id TEXT PRIMARY KEY,
  workbench_id TEXT NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES workbench_items(id) ON DELETE SET NULL,
  source_path TEXT DEFAULT '',
  target_type TEXT NOT NULL
    CHECK (target_type IN ('topic', 'person', 'company', 'place')),
  target_id TEXT NOT NULL,
  target_path TEXT DEFAULT '',
  reviewer TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  promoted_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reviewed'
    CHECK (status IN ('dry_run', 'reviewed', 'applied')),
  metadata TEXT NOT NULL DEFAULT '{}',
  promoted_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workbench_promotions_workbench
  ON workbench_promotions(workbench_id, promoted_at DESC);
CREATE INDEX IF NOT EXISTS idx_workbench_promotions_target
  ON workbench_promotions(target_type, target_id);
