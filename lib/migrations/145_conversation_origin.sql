-- st_abf246e4 — coding-agent chat capture/recover/clean/surface.
--
-- One durable column that records WHO/WHAT created a conversation row, so the
-- chat surfaces can hide agent-to-agent and internal-test traffic by provenance
-- instead of by fragile title/content heuristics (Stonebraker: one column, one
-- meaning). This is orthogonal to `archived` (a reversible hide flag):
--   origin = who created the row
--     'owner'    the owner's own coding session (isSidechain=false)
--     'subagent' a spawned sub-agent session (isSidechain=true)
--     'test'     an internal test chat (qa harness / probe)
--     NULL       pre-existing imports + web chats — treated as owner-visible
--
-- Additive, no rewrite, no downtime: default NULL on all existing rows. SQLite
-- permits CHECK on ADD COLUMN because the check admits NULL and the column has
-- no non-null default. SQL migrations run before inline migrate(); 144 is the
-- latest on disk, so 145 is the next number. No index: at personal scale the
-- conversation set is already fully scanned and ordered by updated_at, so an
-- origin index earns nothing (rejected deliberately).
ALTER TABLE conversations ADD COLUMN origin TEXT
  CHECK (origin IS NULL OR origin IN ('owner','subagent','test'));
