-- 036: Hide technical topic; archive generic Claude Code sessions; surface T2-linked ones.
--
-- Context: 219 conversations imported via the onboarding dump flow are tagged
-- import-claude-code. Most are already archived=1 in the DB, but GET /api/conversations
-- omits the `archived` column from its SELECT so the frontend always sees archived=0.
-- That SELECT bug is fixed in routes/api.js (build 036). This migration handles the
-- data side: correct topology for each session, and hides the Technical topic.

-- 1. Hide the Technical topic — generic coding sessions are noise in the main nav.
UPDATE user_topics SET visible = 0 WHERE slug = 'technical';

-- 2. Unarchive sessions that have a real visible T2 topic (a named life area, not technical).
--    These were incorrectly archived=1 and should appear in their topic view.
UPDATE conversations
SET archived = 0
WHERE tags LIKE '%import-claude-code%'
  AND json_valid(tags)
  AND id IN (
    SELECT DISTINCT c.id
    FROM conversations c, json_each(c.tags) je
    JOIN user_topics ut ON LOWER(ut.label) = LOWER(je.value)
    WHERE ut.visible = 1
      AND ut.slug NOT IN ('projects', 'technical')
      AND c.tags LIKE '%import-claude-code%'
  );

-- 3. Tag + archive sessions with no real T2 topic as technical.
--    json_insert appends to the JSON array without duplicating if tag is absent.
UPDATE conversations
SET
  archived = 1,
  tags     = json_insert(tags, '$[#]', 'technical')
WHERE tags LIKE '%import-claude-code%'
  AND tags NOT LIKE '%"technical"%'
  AND json_valid(tags)
  AND id NOT IN (
    SELECT DISTINCT c.id
    FROM conversations c, json_each(c.tags) je
    JOIN user_topics ut ON LOWER(ut.label) = LOWER(je.value)
    WHERE ut.visible = 1
      AND ut.slug NOT IN ('projects', 'technical')
      AND c.tags LIKE '%import-claude-code%'
  );
