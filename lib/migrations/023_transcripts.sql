CREATE TABLE IF NOT EXISTS transcripts (
  id               TEXT PRIMARY KEY,
  meeting_id       TEXT UNIQUE,
  title            TEXT,
  meeting_date     TEXT,
  duration_minutes INTEGER,
  transcript_text  TEXT,
  call_notes       TEXT,
  topic            TEXT,
  attendee_emails  TEXT,
  source           TEXT DEFAULT 'granola',
  imported_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transcripts_date  ON transcripts(meeting_date);
CREATE INDEX IF NOT EXISTS idx_transcripts_topic ON transcripts(topic);
