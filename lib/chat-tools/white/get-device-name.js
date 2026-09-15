// Read the current device handle (slug). The slug appears in public URLs
// — <slug>.robotdojo.ai/chat. Use before rename so the user can
// confirm what they're changing, or when the user simply asks "what's my
// device called?".

import { defineTool, ok } from '../registry.js';
import db from '../../db.js';

defineTool('get_device_name', {
  description: 'Read this Mac\'s current device handle. The handle appears in public URLs like robotdojo.ai/<servername>/<handle>/chat.',
  parameters: { properties: {}, required: [] },
  execute() {
    const row = db.prepare('SELECT user_slug, user_handle, email FROM users WHERE is_admin = 1 LIMIT 1').get();
    if (!row) return ok({ slug: null, message: 'No admin user configured yet.' });
    return ok({
      slug: row.user_slug,
      handle: row.user_handle,
      email: row.email,
      publicUrl: `https://robotdojo.ai/${row.user_slug}/${row.user_handle}/chat`,
    });
  },
});
