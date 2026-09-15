import db from '../../db.js';
import { defineTool, ok } from '../registry.js';
import { writeMedEvent } from '../../health-timeline.js';

defineTool('log_medication', {
  description: 'Add or update a medication/supplement. Tracks name, dose, frequency, status.',
  parameters: {
    properties: {
      name: { type: 'string', description: 'Medication or supplement name' },
      type: { type: 'string', enum: ['rx', 'supplement'], description: 'Prescription or supplement' },
      dose: { type: 'string', description: 'Dose (e.g., "500mg", "1000 IU")' },
      frequency: { type: 'string', description: 'How often (e.g., "twice daily", "once at night")' },
      status: { type: 'string', enum: ['active', 'stopped', 'episodic'], description: 'Current status' },
      notes: { type: 'string', description: 'Reason for taking, prescriber, etc.' },
    },
    required: ['name'],
  },
  execute({ name, type, dose, frequency, status, notes }) {
    const medType = type || 'supplement';
    const medStatus = status || 'active';

    // Upsert by name
    const existing = db.prepare('SELECT id FROM curated_medications WHERE LOWER(name) = LOWER(?)').get(name);
    if (existing) {
      db.prepare(`
        UPDATE curated_medications SET
          type = COALESCE(?, type), dose = COALESCE(?, dose), frequency = COALESCE(?, frequency),
          status = COALESCE(?, status), notes = COALESCE(?, notes), updated_at = datetime('now')
        WHERE id = ?
      `).run(medType, dose || null, frequency || null, medStatus, notes || null, existing.id);
      const today = new Date().toISOString().slice(0, 10);
      try { writeMedEvent(name, medStatus === 'stopped' ? 'stopped' : 'updated', today, { sourceId: `med|${existing.id}|${medStatus}|${today}` }); } catch { /* projection */ }
      return ok({ id: existing.id, name, updated: true, status: medStatus });
    }

    const started = new Date().toISOString().slice(0, 10);
    const inserted = db.prepare(`
      INSERT INTO curated_medications (name, type, dose, frequency, status, date_started, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, date('now'), ?, datetime('now'))
    `).run(name, medType, dose || null, frequency || null, medStatus, notes || null);
    try { writeMedEvent(name, 'started', started, { sourceId: `med|${inserted.lastInsertRowid}|started|${started}` }); } catch { /* projection */ }

    return ok({ name, type: medType, dose, status: medStatus, started });
  },
});
