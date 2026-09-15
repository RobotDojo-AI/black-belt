-- Topic chat sessions: one live thread per topic, but each visit is a session.
-- Start = first message after idle (or empty). End = idle, leave topic, or /close.
-- session_started_at counts the 1–3 open turns that load log/timeline.
ALTER TABLE conversations ADD COLUMN session_started_at TEXT;
ALTER TABLE conversations ADD COLUMN session_closed_at TEXT;
