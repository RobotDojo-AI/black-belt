import db from '../../db.js';
import { updateTopic } from '../../topics.js';
import { defineTool, ok, err } from '../registry.js';

defineTool('delete_topic', {
  description: 'Delete (hide) a topic. ONLY call when the user explicitly asks to delete or hide a topic.',
  parameters: {
    properties: {
      slug: { type: 'string', description: 'Topic slug to delete' },
    },
    required: ['slug'],
  },
  execute({ slug }) {
    const existing = db.prepare('SELECT slug, label FROM user_topics WHERE slug = ?').get(slug);
    if (!existing) return err(`Topic "${slug}" not found`);

    const result = updateTopic(db, slug, { visible: 0 });
    if (!result) return err(`Topic "${slug}" not found`);
    if (result.error) return err(result.message || result.error);
    return ok({ slug, label: existing.label, hidden: true });
  },
});
