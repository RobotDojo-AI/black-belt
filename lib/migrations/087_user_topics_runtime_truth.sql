-- df_d3c6287b: user_topics is the canonical runtime truth for chat topics.
-- Normalize legacy T1 visibility semantics in place:
--   canonical: visible=1 shown, visible=0 hidden
--   legacy T1: visible=0 shown, visible=2 hidden
UPDATE user_topics
   SET visible = CASE
       WHEN parent_slug IS NULL AND visible = 2 THEN 0
       WHEN parent_slug IS NULL THEN 1
       WHEN visible = 0 THEN 0
       ELSE 1
     END,
       updated_at = datetime('now')
 WHERE visible IS NULL
    OR visible NOT IN (0, 1)
    OR (parent_slug IS NULL AND visible = 0);

-- Repair order collisions/gaps without moving topics across parents.
WITH ranked AS (
  SELECT
    rowid AS topic_rowid,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(parent_slug, '__root__')
      ORDER BY COALESCE(sort_order, 999999), lower(label), slug
    ) - 1 AS next_sort_order
  FROM user_topics
)
UPDATE user_topics
   SET sort_order = (
         SELECT next_sort_order
           FROM ranked
          WHERE ranked.topic_rowid = user_topics.rowid
       ),
       updated_at = datetime('now')
 WHERE EXISTS (
       SELECT 1
         FROM ranked
        WHERE ranked.topic_rowid = user_topics.rowid
          AND ranked.next_sort_order != COALESCE(user_topics.sort_order, -1)
     );

CREATE INDEX IF NOT EXISTS idx_user_topics_parent_order
  ON user_topics(parent_slug, sort_order, slug);

CREATE INDEX IF NOT EXISTS idx_user_topics_visible_parent
  ON user_topics(visible, parent_slug);
