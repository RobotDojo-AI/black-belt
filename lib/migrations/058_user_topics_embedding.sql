-- Migration 058 — topic-level embeddings + suggested label.
-- description_embedding feeds Round 2 similarity classification (Tier 0 free).
-- suggested_label stores a Haiku rename suggestion when current label is weak vs context_md.
--
-- Guard: user_topics is created inline in db.js via migrate(); SQL files run BEFORE
-- those inline calls. CREATE TABLE IF NOT EXISTS keeps fresh installs green.
CREATE TABLE IF NOT EXISTS user_topics (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  visible INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE user_topics ADD COLUMN description_embedding BLOB;
ALTER TABLE user_topics ADD COLUMN suggested_label TEXT;
