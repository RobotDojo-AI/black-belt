-- Public chat logging in Supabase (Phase A1 — Vercel-function writes).
--
-- Run once via Supabase dashboard SQL Editor OR `supabase db push`.
-- See docs/supabase-setup.md for the apply procedure.
--
-- Why Supabase instead of the local miyagi.db copy?
--   The public chat endpoint runs on Vercel's edge network and cannot reach
--   the operator's Mac reliably. Direct REST writes to Supabase with the
--   service-role key give us logging without a tunnel hop.
--
-- Security:
--   RLS is ENABLED on both tables. No permissive policies are created here.
--   The service_role key bypasses RLS. The public anon key hits RLS walls
--   and cannot read/write these tables. That's deliberate.

CREATE TABLE IF NOT EXISTS public_chats (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL,
  ip_hash         TEXT,
  user_agent      TEXT,
  referrer        TEXT,
  messages_json   JSONB NOT NULL,
  source          TEXT NOT NULL DEFAULT 'public_chat',
  converted       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (session_id, source). Upserts merge the transcript.
CREATE UNIQUE INDEX IF NOT EXISTS public_chats_session_source_key
  ON public_chats (session_id, source);

CREATE INDEX IF NOT EXISTS idx_public_chats_created
  ON public_chats (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_public_chats_source
  ON public_chats (source);

-- Daily per-IP-hash rate limit counter. Key: (ip_hash, date_utc).
CREATE TABLE IF NOT EXISTS public_chat_rate (
  ip_hash    TEXT NOT NULL,
  date_utc   DATE NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ip_hash, date_utc)
);

CREATE INDEX IF NOT EXISTS idx_public_chat_rate_date
  ON public_chat_rate (date_utc);

-- RLS: default Supabase behavior is "RLS enabled, no policies" which means
-- only the service_role key can touch these tables. Make it explicit.
ALTER TABLE public_chats      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_chat_rate  ENABLE ROW LEVEL SECURITY;
