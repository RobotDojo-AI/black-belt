import db from '../../db.js';
import { queueHealthIntelRegeneration } from '../../health-intel-regeneration.js';
import { defineTool, ok, err } from '../registry.js';

defineTool('log_health_note', {
  description: 'Log a health observation, symptom, or note. For things like "felt dizzy after workout" or "slept poorly, woke at 3am".',
  parameters: {
    properties: {
      note: { type: 'string', description: 'The health observation' },
      date: { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags like ["symptom", "sleep", "exercise"]' },
    },
    required: ['note'],
  },
  execute({ note, date, tags }) {
    const noteDate = date || new Date().toISOString().slice(0, 10);
    try {
      const result = db.prepare(`
        INSERT INTO health_notes (date, content, tags, source, created_at)
        VALUES (?, ?, ?, 'chat', datetime('now'))
      `).run(noteDate, note, JSON.stringify(tags || []));
      const regeneration = result.changes > 0
        ? queueHealthIntelRegeneration({ reason: 'user_added_health_note', inserted: result.changes })
        : null;
      return ok({ date: noteDate, note, tags: tags || [], regeneration });
    } catch (e) {
      return err(`Failed to log note: ${e.message}`);
    }
  },
});
