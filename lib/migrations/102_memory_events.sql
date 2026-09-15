CREATE TABLE IF NOT EXISTS memory_events (
  global_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  stream_type TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  actor TEXT NOT NULL DEFAULT 'system',
  source TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  valid_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL,
  pii_class TEXT NOT NULL DEFAULT 'private',
  UNIQUE(stream_type, stream_id, stream_sequence),
  UNIQUE(source, idempotency_key)
);

CREATE TABLE IF NOT EXISTS memory_event_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES memory_events(event_id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'subject',
  UNIQUE(event_id, target_type, target_id, role)
);

CREATE TABLE IF NOT EXISTS memory_projection_runs (
  id TEXT PRIMARY KEY,
  projection_name TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source_event_from INTEGER,
  source_event_to INTEGER,
  source_set_hash TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  prompt_version TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  generated_at TEXT NOT NULL,
  generated_by TEXT NOT NULL DEFAULT 'system',
  output_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(projection_name, target_type, target_id, source_event_to, source_set_hash)
);

CREATE INDEX IF NOT EXISTS idx_memory_events_stream
  ON memory_events(stream_type, stream_id, stream_sequence);
CREATE INDEX IF NOT EXISTS idx_memory_events_valid_at
  ON memory_events(valid_at);
CREATE INDEX IF NOT EXISTS idx_memory_events_recorded_at
  ON memory_events(recorded_at);
CREATE INDEX IF NOT EXISTS idx_memory_events_subject
  ON memory_events(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_memory_events_type
  ON memory_events(event_type);
CREATE INDEX IF NOT EXISTS idx_memory_event_links_target
  ON memory_event_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_memory_projection_target
  ON memory_projection_runs(projection_name, target_type, target_id, generated_at);

CREATE TRIGGER IF NOT EXISTS memory_events_no_update
BEFORE UPDATE ON memory_events
BEGIN
  SELECT RAISE(ABORT, 'memory_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS memory_events_no_delete
BEFORE DELETE ON memory_events
BEGIN
  SELECT RAISE(ABORT, 'memory_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS memory_projection_runs_no_update
BEFORE UPDATE ON memory_projection_runs
BEGIN
  SELECT RAISE(ABORT, 'memory_projection_runs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS memory_projection_runs_no_delete
BEFORE DELETE ON memory_projection_runs
BEGIN
  SELECT RAISE(ABORT, 'memory_projection_runs is append-only');
END;
