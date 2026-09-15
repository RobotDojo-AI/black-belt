-- Add priority ordering columns to chunks table.
-- content_rank: 0=iMessage (highest signal), 1=transcript, 2=calendar, 3=email (lowest signal)
-- is_starred: mirrors emails.is_starred for starred email chunks; 0 for all other sources.
-- Default 0 for both — existing rows get lowest priority until backfill.
ALTER TABLE chunks ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chunks ADD COLUMN content_rank INTEGER NOT NULL DEFAULT 0;

-- Backfill existing email chunks to content_rank=3. Other source types stay at 0
-- (they're already the correct rank — email is the only source that needs correction
-- since 0 = iMessage which is actually higher priority than email).
UPDATE chunks SET content_rank = 3 WHERE source_type = 'email';
UPDATE chunks SET content_rank = 1 WHERE source_type = 'transcript' OR source_type = 'meeting';
UPDATE chunks SET content_rank = 2 WHERE source_type = 'calendar';
-- iMessage and imessage stay at 0 (already correct).
