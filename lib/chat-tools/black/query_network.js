/**
 * query_network — Black Belt tool.
 * Queries the user's relationship graph.
 *
 * st_bc949e7c Phase 3: post-consolidation, this tool is a normal source file in
 * the main repo. It imports the shared db singleton directly (the bundle
 * pattern of reading off ctx.services.db is preserved as a fallback so
 * existing chat-tools test ctxs still work).
 */
import { defineTool, ok, err } from '../registry.js';
import dbSingleton from '../../db.js';

defineTool('query_network', {
  description: 'Query the relationship network. Ask questions like "Who do I know at Stripe?" or "Who have I talked to most this month?" Black Belt feature.',
  belt: 'black',
  parameters: {
    properties: {
      query: { type: 'string', description: 'Natural language network query' },
      company: { type: 'string', description: 'Filter by company name' },
      tier: { type: 'number', description: 'Filter by relationship tier (1=closest, 5=peripheral)' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['query'],
  },
  execute: async ({ query, company, tier, limit }, ctx) => {
    const db = ctx?.services?.db || dbSingleton;
    const maxResults = limit || 10;
    let sql = `SELECT p.id, p.display_name as name, p.tier, p.score, p.notes,
      c.name as company FROM people p LEFT JOIN companies c ON p.company_id = c.id WHERE 1=1`;
    const params = [];

    if (company) { sql += ` AND c.name LIKE ?`; params.push(`%${company}%`); }
    if (tier) { sql += ` AND p.tier = ?`; params.push(tier); }
    if (query && !company) {
      sql += ` AND (p.display_name LIKE ? OR c.name LIKE ?)`;
      params.push(`%${query}%`, `%${query}%`);
    }
    sql += ` ORDER BY p.score DESC LIMIT ?`;
    params.push(maxResults);

    try {
      const results = db.prepare(sql).all(...params);
      return ok({ people: results, count: results.length, query });
    } catch (e) {
      return err(`query_network failed: ${e.message}`);
    }
  },
});
