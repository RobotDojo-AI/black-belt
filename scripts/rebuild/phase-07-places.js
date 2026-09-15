/**
 * Phase 2f — Places (rebuild from calendar place extraction).
 */
import db from '../../lib/db.js';
import { extractCalendarPlaces } from '../../lib/calendar-extractor.js';
import { recomputePlaceFrequencies } from '../../lib/timeline-schema.js';

export function phasePlaces(log) {
  log('\n=== Phase 2f: Places from calendar extraction ===');
  const stats = extractCalendarPlaces();
  recomputePlaceFrequencies();
  const places = db.prepare('SELECT COUNT(*) AS n FROM places').get().n;
  log(`  Places after calendar extraction: ${places} (${stats.placesCreated} places + ${stats.citiesCreated} cities created)`);
  return { places, stats };
}
