import { defineTool, ok, err } from '../registry.js';
import { NEEDS_ROUTING_TOPIC, normalizeMemoryTopicSlug } from '../../topic-routing-policy.js';
import { storeUserFact } from '../user-fact-store.js';

defineTool('add_fact', {
  description: 'Store a fact the user wants remembered. Creates a RAG-searchable chunk tied to a topic. Use for things like anniversaries, allergies, preferences, biographical facts.',
  parameters: {
    properties: {
      fact: { type: 'string', description: 'The fact to remember (e.g., "My anniversary is June 12")' },
      topic_slug: { type: 'string', description: 'Topic to file this under. Use "uncategorized" if no topic fits.' },
    },
    required: ['fact'],
  },
  async execute({ fact, topic_slug }) {
    const content = String(fact || '').trim();
    if (!content) return err('Fact is required.');

    const slug = normalizeMemoryTopicSlug(topic_slug, { fallback: true }) || NEEDS_ROUTING_TOPIC;

    const stored = await storeUserFact({
      content,
      topic: slug,
      metadata: {
        source: 'chat',
        type: 'user-fact',
        routing: slug === NEEDS_ROUTING_TOPIC ? 'uncategorized' : 'explicit',
      },
    });

    if (!stored.ok) return err(`Failed to store fact: ${stored.error}`);

    return ok({
      id: stored.chunk_id,
      source_id: stored.source_id,
      fact: stored.fact,
      topic: slug,
      searchable: stored.searchable,
      degraded: stored.searchable ? false : true,
      reason: stored.searchable ? 'embedded_now' : 'embedding_unavailable',
      embedding_error: stored.searchable ? null : stored.embedding?.error || 'embedding_unavailable',
      note: stored.searchable
        ? 'Stored and searchable now.'
        : 'Stored; semantic search will catch up when local embeddings are available.',
    });
  },
});
