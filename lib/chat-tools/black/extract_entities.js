/**
 * extract_entities — Black Belt tool.
 * Kicks off entity extraction on imported data to discover people, companies
 * and relationships. The actual extraction runs as a background job; this
 * tool returns a job descriptor that the frontend/route layer picks up.
 *
 * st_bc949e7c Phase 3: post-consolidation main-repo source. Uses defineTool
 * registry pattern matching the rest of lib/chat-tools/black/.
 */
import { defineTool, ok } from '../registry.js';

defineTool('extract_entities', {
  description: 'Run entity extraction on imported data to automatically discover people, companies, and relationships. Black Belt feature.',
  belt: 'black',
  parameters: {
    properties: {
      source: {
        type: 'string',
        enum: ['email', 'calendar', 'imessage', 'all'],
        description: 'Which data source to extract from',
      },
      limit: {
        type: 'number',
        description: 'Max records to process (default 100)',
      },
    },
    required: [],
  },
  execute: async ({ source, limit }) => {
    return ok({
      action: 'start_extraction',
      source: source || 'all',
      limit: limit || 100,
      message: 'Entity extraction queued. The system will discover people and relationships from your data.',
    });
  },
});
