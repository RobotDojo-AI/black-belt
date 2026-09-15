/**
 * merge_people — Black Belt tool.
 * Merges two duplicate person rows: keeps the primary, moves identifiers and
 * edges off the secondary, deletes the secondary.
 *
 * st_bc949e7c Phase 3: post-consolidation main-repo source. Uses defineTool
 * registry pattern matching the rest of lib/chat-tools/black/.
 */
import { defineTool, ok, err } from '../registry.js';
import dbSingleton from '../../db.js';

defineTool('merge_people', {
  description: 'Merge two duplicate person records into one. Keeps the primary, absorbs the secondary. Black Belt feature.',
  belt: 'black',
  parameters: {
    properties: {
      primary_id: { type: 'string', description: 'Person ID to keep' },
      secondary_id: { type: 'string', description: 'Person ID to merge into primary (will be deleted)' },
    },
    required: ['primary_id', 'secondary_id'],
  },
  execute: async ({ primary_id, secondary_id }, ctx) => {
    const db = ctx?.services?.db || dbSingleton;
    const primary = db.prepare('SELECT id, display_name as name FROM people WHERE id = ?').get(primary_id);
    const secondary = db.prepare('SELECT id, display_name as name FROM people WHERE id = ?').get(secondary_id);
    if (!primary) return err(`Primary person ${primary_id} not found`);
    if (!secondary) return err(`Secondary person ${secondary_id} not found`);
    if (primary_id === secondary_id) return err('primary and secondary must differ');

    // Move identifiers / edges, then delete secondary. Wrapped in a transaction
    // so a failure mid-way doesn't leave a half-merged pair.
    const tx = db.transaction(() => {
      db.prepare('UPDATE person_identifiers SET person_id = ? WHERE person_id = ?').run(primary_id, secondary_id);
      db.prepare('UPDATE person_edges SET person_a = ? WHERE person_a = ?').run(primary_id, secondary_id);
      db.prepare('UPDATE person_edges SET person_b = ? WHERE person_b = ?').run(primary_id, secondary_id);
      db.prepare('DELETE FROM people WHERE id = ?').run(secondary_id);
    });

    try {
      tx();
      return ok({ merged: true, kept: primary.name, absorbed: secondary.name });
    } catch (e) {
      return err(`merge failed: ${e.message}`);
    }
  },
});
