-- 099_transcript_segments.sql — per-turn speaker attribution substrate (st_8a841c68).
--
-- The whole feature stands on one row per turn. Granola returns per-segment
-- `source` (microphone | system) and start/end timestamps; today
-- lib/granola-client.js flattens them into one anonymous string and the
-- structure is lost. This table preserves it so each turn can be attributed
-- to a person — or honestly left unassigned.
--
-- DESIGN (Stonebraker bar — constraints in the data layer, migration explicit):
--   * UNIQUE (transcript_id, turn_index) makes the backfill idempotent by
--     construction: re-running upserts the same turn, never duplicates
--     (INSERT OR IGNORE keyed on the pair).
--   * speaker_person_id is NULLABLE on purpose. NULL is the honest terminal
--     state for an unassigned turn — "unassigned beats a wrong guess" (owner,
--     2026-06-11). No sentinel person row; no NOT NULL here.
--   * method is the audit trail: every assignment records which layer set it,
--     so QA can prove the deterministic layer ran before the model and a
--     confirmed turn is never silently overwritten.
--   * speaker_person_id is TEXT (people.id is p_...). No FK constraint declared
--     (SQLite; merge-cleanup reassigns ids) — the index carries the lookup.
--   * source is captured verbatim from Granola, never re-derived.

CREATE TABLE IF NOT EXISTS transcript_segments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  transcript_id     TEXT    NOT NULL,            -- FK → transcripts.id
  turn_index        INTEGER NOT NULL,            -- 0-based order within the call
  start_ms          INTEGER,                     -- segment.start_timestamp → epoch ms
  end_ms            INTEGER,                     -- segment.end_timestamp → epoch ms
  source            TEXT    NOT NULL,            -- 'microphone' | 'system'
  text              TEXT    NOT NULL,
  speaker_person_id TEXT,                        -- nullable → people.id; NULL = unassigned
  confidence        REAL    NOT NULL DEFAULT 0,  -- 0..1, margin-based
  method            TEXT    NOT NULL DEFAULT 'unassigned', -- mic_anchor|name_mention|handoff|turntaking|fingerprint|llm|confirmed|unassigned
  needs_confirm     INTEGER NOT NULL DEFAULT 0,  -- 1 = surfaced for pull-based confirm
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (transcript_id, turn_index)
);
CREATE INDEX IF NOT EXISTS idx_segments_transcript ON transcript_segments(transcript_id);
CREATE INDEX IF NOT EXISTS idx_segments_speaker    ON transcript_segments(speaker_person_id);

-- transcripts: the roster-join keys + talk-share + attribution timestamp.
-- ALTER ADD COLUMN is not idempotent in SQLite, but applySqlMigrations records
-- each file once after a clean run, so a single application is correct.
ALTER TABLE transcripts ADD COLUMN calendar_event_id TEXT;            -- Granola google_calendar_event.id (Google roster join key)
ALTER TABLE transcripts ADD COLUMN ical_uid TEXT;                     -- Granola google_calendar_event.iCalUID (cross-provider bridge)
ALTER TABLE transcripts ADD COLUMN talk_share TEXT NOT NULL DEFAULT '{}'; -- { byPerson:{id:ms}, unassignedMs, totalMs } JSON
ALTER TABLE transcripts ADD COLUMN attributed_at TEXT;               -- last attribution pass; NULL = not yet attributed

-- calendar_events: the cross-provider stable key so the roster join survives
-- Microsoft/Apple-synced calendars. For v1 the Google direct-id join is the
-- verified path; this column is populated now so the join is cross-provider
-- ready (research §5b owner waiver).
ALTER TABLE calendar_events ADD COLUMN ical_uid TEXT;
CREATE INDEX IF NOT EXISTS idx_calendar_ical ON calendar_events(ical_uid);
