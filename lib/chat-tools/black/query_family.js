/**
 * query_family — Black Belt tool.
 * Surfaces the inferred family tree from the people graph + edges.
 *
 * st_bc949e7c Phase 3: post-consolidation main-repo source. Uses defineTool
 * registry pattern matching the rest of lib/chat-tools/black/.
 */
import { defineTool, ok, err } from '../registry.js';
import dbSingleton from '../../db.js';

defineTool('query_family', {
  description: 'Show inferred family tree and family relationships. Black Belt feature.',
  belt: 'black',
  parameters: { properties: {}, required: [] },
  execute: async (_args, ctx) => {
    const db = ctx?.services?.db || dbSingleton;
    try {
      const family = db.prepare(`
        SELECT p.id, p.display_name as name, pe.edge_type, pe.weight
        FROM people p
        JOIN person_edges pe ON (pe.person_a = p.id OR pe.person_b = p.id)
        WHERE pe.edge_type IN ('family', 'spouse', 'parent', 'child', 'sibling')
        ORDER BY pe.weight DESC LIMIT 50
      `).all();
      return ok({ family_members: family, count: family.length });
    } catch (e) {
      return err(`query_family failed: ${e.message}`);
    }
  },
});
