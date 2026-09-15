-- 061_chat_turn_metrics.sql
-- Per-turn chat observability. Columns mirror OTEL GenAI semantic conventions
-- so we can rename → export to Langfuse / LangSmith / Helicone later without a
-- schema redesign.
--
-- Inserted at chat-route entry; updated as the turn progresses; one row per turn.
-- Writes are deterministic (parameterized statements from lib/observability/chat-turn.js).
-- LLMs NEVER write to this table — the LLM-write boundary is preserved.

CREATE TABLE IF NOT EXISTS chat_turn_metrics (
  turn_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_message_id INTEGER,
  assistant_message_id INTEGER,
  operation_name TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  request_model TEXT,
  response_model TEXT,
  request_start_ms INTEGER NOT NULL,
  first_token_ms INTEGER,
  completion_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_cents INTEGER,
  tools_used TEXT,
  error_type TEXT,
  error_message TEXT,
  recovery_path TEXT,
  belt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_turn_metrics_created
  ON chat_turn_metrics(request_start_ms);
CREATE INDEX IF NOT EXISTS idx_chat_turn_metrics_conv
  ON chat_turn_metrics(conversation_id, request_start_ms);
