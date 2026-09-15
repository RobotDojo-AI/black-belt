-- st_c5c4e824 — one live conversation row per topic.
--
-- Continuity lives on the topic. Opening a topic always uses the live row.
-- History is a separate view of that topic's transcript plus older rows.
-- Coding-agent imported rows (origin / thread_id) are never auto-marked live.
ALTER TABLE conversations ADD COLUMN is_live INTEGER NOT NULL DEFAULT 0;

-- Newest owner-visible web chat per topic becomes live. Do not create empty
-- live rows here; first open find-or-creates. Skip coding-agent imports.
UPDATE conversations
   SET is_live = 1
 WHERE deleted_at IS NULL
   AND chat_type = 'chat'
   AND topic_slug IS NOT NULL
   AND thread_id IS NULL
   AND origin IS NULL
   AND (archived IS NULL OR archived = 0)
   AND id IN (
     SELECT c1.id
       FROM conversations c1
      WHERE c1.deleted_at IS NULL
        AND c1.chat_type = 'chat'
        AND c1.topic_slug IS NOT NULL
        AND c1.thread_id IS NULL
        AND c1.origin IS NULL
        AND (c1.archived IS NULL OR c1.archived = 0)
        AND NOT EXISTS (
          SELECT 1
            FROM conversations c2
           WHERE c2.topic_slug = c1.topic_slug
             AND c2.deleted_at IS NULL
             AND c2.chat_type = 'chat'
             AND c2.thread_id IS NULL
             AND c2.origin IS NULL
             AND (c2.archived IS NULL OR c2.archived = 0)
             AND (
               c2.updated_at > c1.updated_at
               OR (c2.updated_at = c1.updated_at AND c2.id > c1.id)
             )
        )
   );

-- One live row per topic_slug. Partial unique index is the uniqueness contract.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_one_live_per_topic
  ON conversations(topic_slug)
  WHERE is_live = 1
    AND deleted_at IS NULL
    AND chat_type = 'chat'
    AND topic_slug IS NOT NULL;
