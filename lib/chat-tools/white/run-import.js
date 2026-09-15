import { defineTool, ok } from '../registry.js';

defineTool('run_import', {
  description: 'Trigger a data import from a connected source. Sources: contacts (Mac Contacts), calendar (Google Calendar), email (Gmail/Outlook). This starts a background job.',
  parameters: {
    properties: {
      source: {
        type: 'string',
        enum: ['contacts', 'calendar', 'email', 'imessage'],
        description: 'Data source to import from',
      },
      since: {
        type: 'string',
        description: 'Only import data after this date (YYYY-MM-DD). Default: all available.',
      },
    },
    required: ['source'],
  },
  execute({ source, since }) {
    // This returns a job descriptor. The actual import is triggered by the frontend/route layer.
    return ok({
      action: 'start_import',
      source,
      since: since || null,
      message: `Import from ${source} queued. This runs in the background.`,
    });
  },
});
