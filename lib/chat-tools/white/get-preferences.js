import db from '../../db.js';
import { defineTool, ok } from '../registry.js';

defineTool('get_preferences', {
  description: 'Read all user preferences/settings. Call before setting a preference to see current state.',
  parameters: { properties: {}, required: [] },
  execute() {
    const rows = db.prepare('SELECT key, value FROM user_settings ORDER BY key').all();
    const prefs = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return ok({ preferences: prefs });
  },
});
