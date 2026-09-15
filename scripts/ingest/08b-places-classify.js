/**
 * Phase 8b — Place subtype classification (st_93fddaf0 Phase 7)
 *
 * Walks all places, applies the Tier 0 keyword classifier in
 * lib/place-taxonomy.js, and writes `place_subtype` for matches. Places that
 * don't match any keyword keep `place_subtype='other'` (the existing default).
 *
 * Also sets `hidden_in_sidebar=1` for places classified as 'virtual' or
 * 'travel' — these are auxiliary subtypes that shouldn't surface in the
 * places sidebar.
 *
 * INTELLIGENCE_TIER = 'extraction' (Tier 0 regex/keyword, no LLM).
 *
 * Idempotent: a re-classify on already-classified names produces the same
 * result (deterministic keyword match). Re-runs are safe.
 *
 * Foursquare + OSM vocabulary references: see lib/place-taxonomy.js header.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { classifyPlaceName, HIDDEN_SUBTYPES } from '../../lib/place-taxonomy.js';

/**
 * Phase 8b entry. Classify all places by name → subtype.
 *
 * @param {Function} log
 * @returns {{ classified: number, byType: Record<string,number> }}
 */
export async function phasePlacesClassify(log, database = null) {
  log('\n=== Phase 8b: Places Classify (Foursquare/OSM keyword pass) ===');

  const db = database || (await import('../../lib/db.js')).default;

  // WHY: the chunk-worker can leave stale WAL marks from prior killed runs;
  // checkpoint before any batch UPDATE to avoid SQLITE_BUSY_SNAPSHOT hangs.
  try { db.pragma('wal_checkpoint(RESTART)'); } catch { /* tolerated */ }

  const hasHiddenColumn = db.prepare("PRAGMA table_info(places)").all()
    .some((col) => col.name === 'hidden_in_sidebar');

  const places = db.prepare(
    "SELECT id, name, place_subtype" +
    (hasHiddenColumn ? ", COALESCE(hidden_in_sidebar, 0) AS hidden_in_sidebar" : "") +
    " FROM places WHERE name IS NOT NULL AND name != ''"
  ).all();
  log(`  Walking ${places.length} places`);

  // places table has no updated_at column (places use created_at only).
  const updateSubtype = db.prepare(
    "UPDATE places SET place_subtype = ? WHERE id = ? AND COALESCE(place_subtype, '') != ?"
  );
  const updateHidden = hasHiddenColumn
    ? db.prepare("UPDATE places SET hidden_in_sidebar = 1 WHERE id = ? AND COALESCE(hidden_in_sidebar, 0) != 1")
    : null;

  const byType = {};
  let classified = 0;
  let updated = 0;
  let hiddenUpdated = 0;

  db.transaction(() => {
    for (const p of places) {
      const subtype = classifyPlaceName(p.name);
      if (!subtype) continue;
      updated += updateSubtype.run(subtype, p.id, subtype).changes;
      byType[subtype] = (byType[subtype] || 0) + 1;
      classified++;
      if (updateHidden && HIDDEN_SUBTYPES.has(subtype)) {
        hiddenUpdated += updateHidden.run(p.id).changes;
      }
    }
  })();

  log(`  Classified: ${classified} (${updated} subtype changes, ${hiddenUpdated} sidebar-hide changes)`);
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    log(`    ${type}: ${count}`);
  }

  return { classified, updated, hiddenUpdated, byType };
}

// CLI: run directly via `node scripts/ingest/08b-places-classify.js`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const log = (...args) => console.log(new Date().toISOString().slice(11,19), ...args);
  phasePlacesClassify(log).then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
