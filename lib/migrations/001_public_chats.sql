-- Public chat logging (Phase A1).
-- Anonymous marketing-site chat conversations logged for analysis.
-- No user accounts. IP is hashed (SHA-256). Full transcript per session.
--
-- source:
--   'public_chat'       — widget chat on robotdojo.ai
--   'onboarding_share'  — transcript posted from user's local Robot Dojo after consent

CREATE TABLE IF NOT EXISTS public_chats (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL,
  ip_hash        TEXT,
  user_agent     TEXT,
  referrer       TEXT,
  messages_json  TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'public_chat',
  converted      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_public_chats_session ON public_chats(session_id);
CREATE INDEX IF NOT EXISTS idx_public_chats_created ON public_chats(created_at);
CREATE INDEX IF NOT EXISTS idx_public_chats_source  ON public_chats(source);

-- Daily per-IP rate limit counter. Key is "{ip_hash}:{yyyy-mm-dd}".
CREATE TABLE IF NOT EXISTS public_chat_rate (
  key        TEXT PRIMARY KEY,
  ip_hash    TEXT NOT NULL,
  day        TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_public_chat_rate_day ON public_chat_rate(day);
