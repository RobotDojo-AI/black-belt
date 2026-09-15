import db from '../../db.js';
import { defineTool, ok, err } from '../registry.js';
import { searchAll } from '../../rag-search.js';

// WHY vector RAG instead of LIKE %query%: the old `chunks.content LIKE ?`
// path was a full-table scan over 1.2M rows — 30–60s per tool call,
// blocking the sonnet turn for minutes when the model chained 2–3 searches.
// searchAll is the same hybrid FTS+vector entry the main chat context layer
// uses; with `topicScope` it post-filters via the conversation_topics
// junction (st_74f45a1a R2 lets us scope 39-table fan-out → 1 topic in <2s).
// Token cost is identical; tokens-per-second on the user-visible turn is
// the load-bearing metric. Context-doc lookup stays a quick LIKE since
// user_topics is small (<200 rows).
const stmts = {
  contexts: db.prepare(`
    SELECT slug, label, context_md FROM user_topics
    WHERE context_md LIKE ? AND context_md IS NOT NULL
    LIMIT 20
  `),
  conversationTopics: db.prepare(`
    SELECT topic_slug FROM conversation_topics WHERE conversation_id = ?
  `),
};

// Resolve topic scope for the search:
//   - If the LLM passes `topic` (single string) → use it.
//   - Else if `conversation_id` is in the execution context → look up
//     conversation_topics, plus the ambient `general` shard.
//   - Else → cross-topic (null), the slowest path but kept as a fallback.
function resolveScope({ topic, conversation_id }) {
  if (topic && typeof topic === 'string') return [topic];
  if (conversation_id) {
    try {
      const rows = stmts.conversationTopics.all(conversation_id);
      const topics = rows.map(r => r.topic_slug).filter(Boolean);
      return topics.length > 0
        ? [...new Set([...topics, 'general'])]
        : ['general'];
    } catch { /* table missing on fresh install — fall through */ }
  }
  return null;
}

defineTool('search_memory', {
  description: 'Search across all stored knowledge — RAG chunks, context docs, and user facts. Use to check what the system already knows before adding duplicates.',
  parameters: {
    properties: {
      query: { type: 'string', description: 'Search query' },
      topic: { type: 'string', description: 'Optional topic to scope search' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['query'],
  },
  async execute({ query, topic, limit }, ctx = {}) {
    const q = String(query || '').trim().slice(0, 200);
    if (!q) return ok({ chunks: [], context_docs: [], total: 0 });
    const maxResults = Math.min(limit || 10, 50);
    try {
      const topicScope = resolveScope({ topic, conversation_id: ctx.conversation_id });
      const rows = await searchAll(q, { limit: maxResults, topicScope });
      const contexts = stmts.contexts.all(`%${q}%`);

      return ok({
        chunks: rows.map(r => ({
          id: r.chunk_id ?? r.id,
          content: String(r.content || '').slice(0, 200),
          source: r.source_type,
          topic: r.topic,
        })),
        context_docs: contexts.map(c => ({ slug: c.slug, label: c.label, excerpt: c.context_md.slice(0, 200) })),
        total: rows.length + contexts.length,
        scope: topicScope ? topicScope.join(',') : 'all',
      });
    } catch (e) {
      return err(`Search failed: ${e.message}`);
    }
  },
});
