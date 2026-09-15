import db from '../../db.js';
import crypto from 'node:crypto';
import { appendMemory } from '../../memory.js';
import { markMaintenanceDirty } from '../../maintenance.js';
import { applyTopicContext } from '../../topic-context-apply.js';
import { defineTool, ok, err } from '../registry.js';

function kebabSlug(value) {
  return String(value || 'topic')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'topic';
}

defineTool('update_context', {
  description: 'Write or update the context document for an existing topic. ONLY call when the user explicitly asks to update, save, or write context for a topic. Never write context autonomously — this is a deliberate user action. Use markdown format.',
  parameters: {
    properties: {
      topic_slug: { type: 'string', description: 'Topic slug to update context for' },
      content: { type: 'string', description: 'Full markdown context document content' },
      append: { type: 'boolean', description: 'If true, append to existing context instead of replacing' },
    },
    required: ['topic_slug', 'content'],
  },
  async execute({ topic_slug, content, append }, ctx = {}) {
    const database = ctx.services?.db || db;
    const existing = database.prepare('SELECT slug, context_md FROM user_topics WHERE slug = ?').get(topic_slug);
    if (!existing) return err(`Topic "${topic_slug}" not found. Create the topic first.`);

    const newContent = append && existing.context_md
      ? existing.context_md + '\n\n' + content
      : content;

    const now = new Date().toISOString();
    await applyTopicContext(database, {
      slug: topic_slug,
      contextMd: newContent,
      sourceType: 'chat_context_update',
      source: 'chat:update_context',
      events: [{
        date: now,
        summary: `Topic context updated from chat: ${topic_slug}`,
        metadata: { topic_slug, mode: append ? 'append' : 'replace', tool: 'update_context' },
      }],
    });

    try {
      markMaintenanceDirty(database, {
        targetType: 'topic',
        targetId: topic_slug,
        reason: 'chat_context_update',
        priority: 80,
        metadata: { mode: append ? 'append' : 'replace', tool: 'update_context' },
      });
    } catch {
      // Fresh test databases may omit maintenance_queue; the canonical context
      // write and audit row above remain the durable contract.
    }

    try {
      const hash = crypto.createHash('sha256').update(`${topic_slug}|${now}|${newContent}`).digest('hex').slice(0, 10);
      await appendMemory({
        type: 'session-note',
        name: `topic-context-${kebabSlug(topic_slug)}-${hash}`,
        description: `Topic context updated for ${topic_slug}`,
        author: 'chat',
        source: 'chat:update_context',
        tags: ['topic-context', kebabSlug(topic_slug)],
        body: [
          `Topic context updated for ${topic_slug}.`,
          `Mode: ${append ? 'append' : 'replace'}.`,
          `Length: ${newContent.length} chars.`,
          `Canonical history: topic_context_history source chat:update_context.`,
        ].join('\n'),
      });
    } catch {
      // Memory append is additive. A chain repair should not roll back the
      // explicit context update the user just requested.
    }

    return ok({ topic_slug, length: newContent.length, versioned: true });
  },
});
