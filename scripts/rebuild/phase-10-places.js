/**
 * Phase 5 — Place classification (ontology + travel overlay).
 *
 * Delegates to lib/network-classify.js which is the single source of truth
 * for both this script and the admin /api/network/rebuild endpoint.
 */
import db from '../../lib/db.js';
import { getBBModule } from '../../lib/module-loader.js';

export function classifyPlaces(log) {
  const classifyPlace = getBBModule()?.classifyPlace ?? getBBModule()?.classifyVenue ?? (() => null);
  log('\n=== Phase 5: Place classification ===');

  const all = db.prepare('SELECT id FROM places').all();

  let sidebar = 0, hidden = 0, travel = 0;

  db.transaction(() => {
    for (const p of all) {
      const r = classifyPlace(p.id);
      if (!r) continue;
      if (r.travel) travel++;
      if (r.hidden_in_sidebar) hidden++; else sidebar++;
    }
  })();

  log(`  Places: ${sidebar} sidebar-visible, ${hidden} hidden (incl. ${travel} travel)`);
  return { sidebar, hidden, travel };
}
