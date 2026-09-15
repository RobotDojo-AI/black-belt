import db from '../../db.js';
import { defineTool, ok, err } from '../registry.js';

defineTool('update_person', {
  description: 'Update an existing person\'s details. Use the person_id from search_people results.',
  parameters: {
    properties: {
      person_id: { type: 'string', description: 'Person ID to update' },
      name: { type: 'string' },
      email: { type: 'string' },
      phone: { type: 'string' },
      company: { type: 'string' },
      title: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['person_id'],
  },
  execute({ person_id, name, email, phone, company, title, notes }) {
    const existing = db.prepare('SELECT id FROM people WHERE id = ?').get(person_id);
    if (!existing) return err(`Person ${person_id} not found`);

    db.prepare(`
      UPDATE people SET
        display_name = COALESCE(?, display_name), notes = COALESCE(?, notes),
        needs_regen = 1,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(name || null, notes || null, person_id);

    return ok({ person_id, updated: true, regen_pending: true });
  },
});
