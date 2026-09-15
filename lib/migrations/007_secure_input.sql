-- Chat-driven credential capture (Phase 3 — secure_input).
--
-- Flow
--   1. LLM calls the `request_credential` chat tool.
--   2. Tool handler inserts a row here and emits an SSE event carrying
--      `id` + `label` + `service`.
--   3. The chat UI renders a password-masked input above the composer.
--   4. User submits → POST /api/secure-input/submit → we write value to
--      Keychain and mark the row `consumed`. The value never travels
--      anywhere else.
--   5. If 2 min pass without submission, background sweeper marks expired.
--
-- Values are never persisted in this table. Only metadata.

CREATE TABLE IF NOT EXISTS secure_input_requests (
  id          TEXT PRIMARY KEY,                             -- 64-hex random
  session_id  TEXT NOT NULL,                                -- ties request to chat session
  service     TEXT NOT NULL,                                -- canonical keychain service name
  label       TEXT NOT NULL,                                -- human-readable UI label
  purpose     TEXT,                                         -- optional: why LLM asked
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,                                -- 2 min after created_at
  consumed_at TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'               -- pending | submitted | expired | cancelled
);

CREATE INDEX IF NOT EXISTS idx_secure_input_session
  ON secure_input_requests(session_id, status);

CREATE INDEX IF NOT EXISTS idx_secure_input_expires
  ON secure_input_requests(expires_at);
