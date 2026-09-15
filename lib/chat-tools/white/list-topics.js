import db from '../../db.js';
import { getTopicsHierarchy } from '../../topics.js';
import { defineTool, ok } from '../registry.js';

defineTool('list_topics', {
  description: 'List all topics in T1/T2 hierarchy (root topics with their children nested). Call this before creating a topic to avoid duplicates or to find a valid parent_slug for nesting.',
  parameters: { properties: {}, required: [] },
  execute() {
    const hierarchy = getTopicsHierarchy(db);
    const count = db.prepare('SELECT COUNT(*) AS n FROM user_topics').get()?.n || 0;
    return ok({ topics: hierarchy.topics, count });
  },
});
