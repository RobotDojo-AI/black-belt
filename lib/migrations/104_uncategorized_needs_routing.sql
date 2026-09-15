INSERT OR IGNORE INTO user_topics
  (slug, label, description, icon, sort_order, parent_slug, visible, created_at, updated_at)
VALUES
  (
    'uncategorized',
    'Uncategorized',
    'Holding area for data that has not yet earned a coherent Work, Personal, Family, Education, or user-defined route.',
    'inbox',
    999,
    NULL,
    0,
    datetime('now'),
    datetime('now')
  );
