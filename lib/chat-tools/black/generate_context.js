/**
 * generate_context — Black Belt tool.
 * Queues an LLM synthesis job that compiles a context doc for a topic from
 * all related data (emails, messages, conversations). The synthesis itself
 * runs in the background; this tool returns the job descriptor.
 *
 * st_bc949e7c Phase 3: post-consolidation main-repo source.
 */
import { defineTool, ok, err } from '../registry.js';
import dbSingleton from '../../db.js';

defineTool('generate_context', {
  description: 'Auto-generate a context document for a topic by analyzing all related data (emails, messages, conversations). Black Belt feature — uses LLM synthesis.',
  belt: 'black',
  parameters: {
    properties: {
      topic_slug: { type: 'string', description: 'Topic to generate context for' },
    },
    required: ['topic_slug'],
  },
  execute: async ({ topic_slug }, ctx) => {
    if (!topic_slug) return err('topic_slug required');
    const db = ctx?.services?.db || dbSingleton;

    // Sanity check: confirm the topic exists before queueing synthesis so the
    // user gets immediate feedback on typos.
    try {
      const row = db.prepare('SELECT slug FROM user_topics WHERE slug = ?').get(topic_slug);
      if (!row) return err(`Topic "${topic_slug}" not found. Create it first.`);
    } catch {
      // If the topics table is absent in this install, fall through and let
      // the background job surface the real error — don't hard-fail here.
    }

    return ok({
      action: 'generate_context',
      topic_slug,
      message: `Context generation queued for ${topic_slug}. Will analyze related data and write a context document.`,
    });
  },
});
