import db from '../../db.js';
import { defineTool, ok } from '../registry.js';

defineTool('list_integrations', {
  description: 'List connected accounts and their sync status. Shows what data sources are available.',
  parameters: { properties: {}, required: [] },
  execute() {
    try {
      const accounts = db.prepare('SELECT id, vendor, type, display_name, email, status, created_at FROM accounts ORDER BY created_at DESC').all();
      // Mask sensitive fields
      const safe = accounts.map(a => ({
        id: a.id, vendor: a.vendor, type: a.type,
        display_name: a.display_name, email: a.email,
        status: a.status || 'active', connected: a.created_at,
      }));
      return ok({ integrations: safe, count: safe.length });
    } catch {
      return ok({ integrations: [], count: 0 });
    }
  },
});
