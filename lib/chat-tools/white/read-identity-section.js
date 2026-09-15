// Read one or all identity sections from the user's hash-chained log.
// Use before editing so the model has current state to modify.

import { defineTool, ok, err } from '../registry.js';
import { currentSnapshot, DEFAULT_SECTIONS } from '../../identity-log.js';

defineTool('read_identity_section', {
  description: 'Read the current content of one or all identity cards (Identity, Soul, Philosophy, Style, User, or any custom card the user has created). Call before update_identity_section to see what you\'re replacing. If `section` is omitted, returns all sections.',
  parameters: {
    properties: {
      section: {
        type: 'string',
        description: 'Optional section slug (e.g. "soul", "style", "philosophy"). Omit to return all sections.',
      },
    },
    required: [],
  },
  async execute({ section }) {
    const snap = await currentSnapshot();
    if (section) {
      const key = section.toLowerCase().trim();
      const s = snap.sections[key];
      if (!s) return err(`no section named "${section}" — try one of: ${snap.order.join(', ')}`);
      return ok({ section: key, body: s.body, updatedAt: s.updatedAt, sourceName: s.sourceName });
    }
    const out = {};
    for (const name of snap.order) {
      const s = snap.sections[name];
      out[name] = {
        body: s.body || '',
        updatedAt: s.updatedAt,
        sourceName: s.sourceName,
        bytes: Buffer.byteLength(s.body || '', 'utf8'),
      };
    }
    return ok({ order: snap.order, sections: out, defaults: DEFAULT_SECTIONS });
  },
});
