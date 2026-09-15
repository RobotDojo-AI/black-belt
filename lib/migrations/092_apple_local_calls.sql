-- 092_apple_local_calls.sql — local macOS Call / FaceTime history (st_fcdbe84f).
-- Populated by lib/apple-calls-reader.js from CallHistoryDB/CallHistory.storedata
-- when Full Disk Access is granted. A who/when/duration timeline source.
CREATE TABLE IF NOT EXISTS calls (
  id            TEXT PRIMARY KEY,          -- ZUNIQUE_ID, or synthesized from pk
  address       TEXT NOT NULL DEFAULT '',  -- phone number / handle
  name          TEXT NOT NULL DEFAULT '',  -- contact name if macOS resolved it
  direction     TEXT NOT NULL DEFAULT '',  -- 'incoming' | 'outgoing'
  answered      INTEGER NOT NULL DEFAULT 0,
  duration_sec  INTEGER NOT NULL DEFAULT 0,
  service       TEXT NOT NULL DEFAULT '',  -- telephony / FaceTime / etc.
  call_time     TEXT NOT NULL DEFAULT '',  -- ISO8601
  source        TEXT NOT NULL DEFAULT 'apple-local',
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_calls_time    ON calls(call_time DESC);
CREATE INDEX IF NOT EXISTS idx_calls_address ON calls(address);
