-- Migration 031: taxonomy generic cleanup
--
-- Normalizes generic T2 topics. Owner-specific T2 topics are managed entirely
-- via ~/.robotdojo/taxonomy.user.json at boot via syncTaxonomyToDb().
-- Idempotent: every statement uses WHERE slug = '...' so replaying is safe.
--
-- WHY CREATE TABLE IF NOT EXISTS: SQL migrations run BEFORE inline migrate()
-- calls in lib/db.js. On a fresh DB (test :memory:), user_topics doesn't
-- exist yet, so UPDATE fails. The CREATE here mirrors the schema in
-- the inline 'create-user-topics' migration; on a populated DB this is a
-- no-op (st_bc949e7c, 2026-05-15).
CREATE TABLE IF NOT EXISTS user_topics (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  icon TEXT DEFAULT 'label',
  visible INTEGER DEFAULT 1,
  parent_slug TEXT
);

-- 1. Move 'writing' to Work (generic topic — belongs under work, not personal)
UPDATE user_topics
SET parent_slug = 'work', sort_order = 7, updated_at = datetime('now')
WHERE slug = 'writing';

-- 2. Newsletter T2s — make visible
UPDATE user_topics
SET visible = 1, updated_at = datetime('now')
WHERE parent_slug = 'newsletters';

-- 3. Generic seed T2s — hide from nav (these come from old seed data, not taxonomy.user.json)
UPDATE user_topics
SET visible = 0, updated_at = datetime('now')
WHERE slug IN ('projects', 'clients', 'meetings', 'immediate', 'extended',
               'finance', 'interests', 'courses', 'reading', 'tech', 'business')
  AND parent_slug IS NOT NULL;

-- 4. Park rogue generic seed topics out of display range
UPDATE user_topics SET visible = 0, sort_order = 99 WHERE slug = 'projects' AND parent_slug IS NOT NULL;
