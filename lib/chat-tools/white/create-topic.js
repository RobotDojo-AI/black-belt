import db from '../../db.js';
import { createTopic } from '../../topics.js';
import { ensureTopicWorkbench } from '../../topic-workbench-seed.js';
import { defineTool, ok, err, slugify } from '../registry.js';

defineTool('create_topic', {
  description: 'Create a new topic. ONLY call this when the user has EXPLICITLY asked to create or add a topic (e.g. "add a topic", "create a label called X", "I want a new topic for Y"). NEVER call this based on conversation content alone — topic creation is a deliberate user action, not an inference. Always call list_topics first to check for duplicates.',
  parameters: {
    properties: {
      label: { type: 'string', description: 'Display name (e.g., "Marathon Training")' },
      description: { type: 'string', description: 'What this topic covers — used for automatic classification' },
      icon: { type: 'string', description: 'Material Symbols icon name (default: label). Common options: label, work, family_restroom, person, school, mail, folder, handshake, groups, home, group, favorite, account_balance, star, menu_book, library_books, computer, business_center' },
      parent_slug: { type: 'string', description: 'Optional: slug of an existing topic to nest under (creates parent→child hierarchy).' },
    },
    required: ['label'],
  },
  async execute({ label, description, icon, parent_slug }) {
    const slug = slugify(label);
    const existing = db.prepare('SELECT slug FROM user_topics WHERE slug = ?').get(slug);
    if (existing) return err(`Topic "${label}" already exists (slug: ${slug})`);
    const result = createTopic(db, { slug, label, description: description || label, icon, parent_slug: parent_slug || null, visible: 1 });
    if (result.error) return err(result.message || result.error);
    const workbench = await ensureTopicWorkbench(db, result.slug, {
      maxFiles: 1000,
      ...(process.env.ROBOTDOJO_REPO_ROOT ? { repoRoot: process.env.ROBOTDOJO_REPO_ROOT } : {}),
    });
    return ok({
      slug: result.slug,
      label: result.label,
      description: result.description,
      parent_slug: result.parent_slug,
      workbench_id: workbench.workbench_id,
      workbench_ready: true,
    });
  },
});
