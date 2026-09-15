import db from '../../db.js';
import { defineTool, ok } from '../registry.js';

const stmts = {
  byName: db.prepare(`
    SELECT id, display_name as name, notes, tier, score
    FROM people WHERE display_name LIKE ? ORDER BY score DESC LIMIT ?
  `),
  byIdentifier: db.prepare(`
    SELECT p.id, p.display_name as name, p.notes, p.tier, p.score
    FROM people p
    JOIN person_identifiers pi ON pi.person_id = p.id
    WHERE pi.value LIKE ? LIMIT ?
  `),
};

defineTool('search_people', {
  description: 'Search for a person by name, email, or phone. Always call before add_person to prevent duplicates.',
  parameters: {
    properties: {
      query: { type: 'string', description: 'Name, email, or phone to search for' },
      limit: { type: 'number', description: 'Max results (default 5)' },
    },
    required: ['query'],
  },
  execute({ query, limit }) {
    const q = String(query || '').trim().slice(0, 100);
    if (!q) return ok({ people: [], count: 0 });
    const maxResults = Math.min(limit || 5, 20);

    const byName = stmts.byName.all(`%${q}%`, maxResults);
    const byIdentifier = stmts.byIdentifier.all(`%${q}%`, maxResults);

    const seen = new Set();
    const results = [];
    for (const r of [...byName, ...byIdentifier]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        results.push(r);
      }
    }

    return ok({ people: results.slice(0, maxResults), count: results.length });
  },
});
