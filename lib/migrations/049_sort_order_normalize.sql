-- Normalize sort_order for user_topics: assign sequential values 0..N-1
-- ordered by rowid. Resolves the all-zeros collision that breaks DnD reorder.
UPDATE user_topics
SET sort_order = (
  SELECT COUNT(*)
  FROM user_topics u2
  WHERE u2.rowid < user_topics.rowid
);
