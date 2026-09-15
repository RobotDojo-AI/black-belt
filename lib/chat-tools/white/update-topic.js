import db from '../../db.js';
import { updateTopic } from '../../topics.js';
import { defineTool, ok, err } from '../registry.js';

defineTool('update_topic', {
  description: "Update a topic's label, description, icon, visibility, or parent. ONLY call when the user has explicitly asked to rename, move, or change a topic. Never infer topic changes from conversation content.",
  parameters: {
    properties: {
      slug: { type: 'string', description: 'Topic slug to update' },
      label: { type: 'string', description: 'New display name' },
      description: { type: 'string', description: 'New description' },
      icon: { type: 'string', description: 'New icon' },
      visible: { type: 'boolean', description: 'Whether to show in sidebar' },
      parent_slug: { type: 'string', description: "New parent topic slug. Empty string ('') unparents (root topic)." },
    },
    required: ['slug'],
  },
  execute({ slug, label, description, icon, visible, parent_slug }) {
    const existing = db.prepare('SELECT slug FROM user_topics WHERE slug = ?').get(slug);
    if (!existing) return err(`Topic "${slug}" not found`);

    const body = { label, description, icon };
    if (visible !== undefined) body.visible = visible;
    if (parent_slug !== undefined) body.parent_slug = parent_slug || null;
    const result = updateTopic(db, slug, body);
    if (!result) return err(`Topic "${slug}" not found`);
    if (result.error) return err(result.message || result.error);
    return ok({ slug, updated: true });
  },
});
