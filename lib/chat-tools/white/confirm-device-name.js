// Mark the current device name as "confirmed" without renaming. Used by
// the setup flow when the user accepts the auto-detected hostname-based
// default, or at any time to dismiss the setup card once the slug is
// already what the user wants.

import { defineTool, ok } from '../registry.js';
import db from '../../db.js';

defineTool('confirm_device_name', {
  description: 'Acknowledge that the current device name (slug) is correct. Clears the "please confirm" state on the setup flow without doing a rename. Use when the user accepts the auto-detected name during install, or when calling get_device_name and the user says "yes that\'s right".',
  parameters: { properties: {}, required: [] },
  execute() {
    db.prepare(
      "INSERT INTO user_settings (key, value, updated_at) VALUES ('device_name_confirmed','1', datetime('now'))" +
      " ON CONFLICT(key) DO UPDATE SET value='1', updated_at=datetime('now')"
    ).run();
    const row = db.prepare('SELECT user_slug FROM users WHERE is_admin = 1 LIMIT 1').get();
    return ok({ slug: row?.user_slug, confirmed: true });
  },
});
