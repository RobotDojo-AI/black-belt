-- Migration 056 — track classification origin on conversations.
-- 'keyword' (Tier 0 match), 'haiku' (Tier 1 Haiku classifyIntent), 'user' (manual override).
-- 'user' rows are never overwritten by reclassify.
--
-- Guard: conversations is created inline in db.js via migrate(); SQL files run BEFORE
-- those inline calls, so we must CREATE TABLE IF NOT EXISTS first so this migration
-- succeeds on a fresh install.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  topic_slug TEXT,
  archived INTEGER DEFAULT 1,
  pinned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
ALTER TABLE conversations ADD COLUMN topic_set_method TEXT DEFAULT 'keyword';
