// Show the history of a section — every supersede, newest first. Lets the
// user see how their identity has evolved without touching the log files.

import { defineTool, ok, err } from '../registry.js';
import { sectionHistory } from '../../identity-log.js';

defineTool('section_history', {
  description: 'List every saved version of one identity section, newest first. Useful when the user asks "when did I change my style?" or "what was my soul before?".',
  parameters: {
    properties: {
      section: { type: 'string', description: 'Section slug, e.g. "soul" or "style".' },
      limit:   { type: 'number', description: 'Max entries to return (default 20).' },
    },
    required: ['section'],
  },
  async execute({ section, limit = 20 }) {
    const slug = (section || '').toLowerCase().trim();
    if (!slug) return err('section is required');
    const entries = await sectionHistory(slug);
    if (!entries.length) return ok({ section: slug, entries: [], note: 'no entries for this section yet' });
    return ok({
      section: slug,
      count: entries.length,
      entries: entries.slice(0, limit).map((e) => ({
        name: e.name,
        timestamp: e.timestamp,
        description: e.description,
        author: e.author,
      })),
    });
  },
});
