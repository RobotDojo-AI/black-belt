/**
 * Phase 3 — Score (compute tiers) + noise archive.
 */
import db from '../../lib/db.js';
import { computeAllScores, computePlaceScores } from '../../lib/scoring.js';

export function phaseScore(log) {
  log('\n=== Phase 3: Score + family inference ===');

  // Recompute interaction_count/first_seen/last_seen on people table
  db.exec(`
    UPDATE people SET
      interaction_count = COALESCE((SELECT COUNT(*) FROM person_interactions WHERE person_id = people.id), 0),
      first_seen = COALESCE((SELECT MIN(date) FROM person_interactions WHERE person_id = people.id), people.first_seen),
      last_seen = COALESCE((SELECT MAX(date) FROM person_interactions WHERE person_id = people.id), people.last_seen),
      imessage_msg_count = COALESCE((SELECT COUNT(*) FROM person_interactions WHERE person_id = people.id AND channel = 'imessage' AND direction NOT IN ('group_in','group_out')), 0),
      imessage_group_count = COALESCE((SELECT COUNT(*) FROM person_interactions WHERE person_id = people.id AND channel = 'imessage' AND direction IN ('group_in','group_out')), 0)
    WHERE archived = 0
  `);

  const { tierCounts, breaks } = computeAllScores({ verbose: false });
  log(`  Tiers: ${JSON.stringify(tierCounts)}`);
  log(`  Breaks: core=${breaks.core.toFixed(1)}, network=${breaks.network.toFixed(1)}, extended=${breaks.extended.toFixed(1)}`);

  computePlaceScores();

  // Archive people with zero interactions AND no contacts identifier (noise)
  const noise = db.prepare(`
    SELECT p.id FROM people p
    WHERE p.archived = 0
      AND p.interaction_count = 0
      AND NOT EXISTS (SELECT 1 FROM person_identifiers pi WHERE pi.person_id=p.id AND pi.source='contacts')
  `).all();
  if (noise.length) {
    const stmt = db.prepare('UPDATE people SET archived = 1 WHERE id = ?');
    db.transaction(() => { for (const n of noise) stmt.run(n.id); })();
  }
  log(`  Archived ${noise.length} noise people (0 interactions, no contacts)`);

  // Recompute company people_count
  db.exec(`
    UPDATE companies SET people_count = (
      SELECT COUNT(*) FROM people WHERE company_id = companies.id AND archived = 0
    )
  `);

  return { tierCounts, breaks };
}
