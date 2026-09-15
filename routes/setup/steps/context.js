import { safeGet } from '../helpers.js';

function compute() {
  const row = safeGet(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN context_md IS NOT NULL AND length(trim(context_md)) > 40 THEN 1 ELSE 0 END) AS filled
    FROM user_topics
  `);
  const total = row?.total || 0;
  const filled = row?.filled || 0;
  if (!total) return { complete: false, preview: 'No topics yet — create topics first' };
  return {
    complete: filled >= Math.max(3, Math.ceil(total * 0.6)),
    preview: `${filled} of ${total} topics have context docs`,
  };
}

export default {
  id: 'context',
  title: 'Context per topic',
  description: 'What Miyagi should know about each topic',
  icon: 'auto_stories',
  compute,
  chat_context: 'setup-guide',
  chat_prompt: 'Let\'s fill in context for my topics. Start with the first one that\'s missing.',
  inline: false,
  category: 'core',
};
