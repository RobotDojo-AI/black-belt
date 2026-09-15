-- Migration 068 — warmup_events observability table
-- Story st_566ad80b (rag-hnsw-migration).
--
-- Records every warmup invocation (boot, periodic plist, model-change)
-- with provider, model, trigger_reason, latency, and timestamps. Powers:
--   (a) AC 10 verification — was a model-change warmup fired within 100ms?
--   (b) ops debug — which provider's first-token latency regressed?
--   (c) cold-start tuning — does the boot warmup actually reduce TTFB?
--
-- This table is append-only. No UPDATE path. Each warmup writes one row.
--
-- WHY trigger_reason as TEXT not CHECK enum: the set is small today
-- (boot, model-change, periodic) but will grow (manual-test,
-- recovery-after-error). Keeping it TEXT lets new triggers join without
-- a CHECK rebuild migration.
--
-- WHY no foreign key to accounts: warmup events fire from server boot,
-- which has no user context. The provider/model values are free-form
-- identifiers (anthropic / claude-haiku) — accounts is keyed differently.
--
-- Rollback: `DROP TABLE warmup_events;` (additive, safe).

CREATE TABLE IF NOT EXISTS warmup_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  latency_ms INTEGER,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT
);

-- Trigger_reason + started_at is the dominant access pattern: "show me
-- the most recent model-change warmups". A composite index here pays
-- for itself on every ops dashboard hit.
CREATE INDEX IF NOT EXISTS idx_warmup_events_trigger_time
  ON warmup_events (trigger_reason, started_at DESC);
