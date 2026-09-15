-- 093_apple_local_notes.sql — local macOS Notes (st_fcdbe84f).
-- Populated by lib/apple-notes-reader.js from the Notes group-container
-- NoteStore.sqlite when Full Disk Access is granted. Encrypted notes are skipped.
CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,          -- 'apple:<pk>'
  title        TEXT NOT NULL DEFAULT '',
  snippet      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  folder       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT '',  -- ISO8601
  modified_at  TEXT NOT NULL DEFAULT '',  -- ISO8601
  source       TEXT NOT NULL DEFAULT 'apple-local',
  synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_modified ON notes(modified_at DESC);
