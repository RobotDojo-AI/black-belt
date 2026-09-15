/**
 * Phase 2b — Calendar (tier 3: attendees + places).
 */
import db from '../../lib/db.js';
import { extractCalendarEntities } from '../../lib/calendar-extractor.js';
import { getBBModule } from '../../lib/module-loader.js';
import { wbResolvePerson } from '../../lib/wb-resolve-person.js';

function getResolvePerson() {
  // WB fallback (BB inactive) is the shared wbResolvePerson helper (st_180aa017
  // AC-4 — collapses the 3 diverged copies into one). Gate UNCHANGED: only the
  // fallback body moved to lib/.
  return getBBModule()?.resolvePerson ?? ((c) => wbResolvePerson(db, c));
}

export function phaseCalendar(log) {
  const resolvePerson = getResolvePerson();
  log('\n=== Phase 2b: Calendar (tier 3 — attendees + places) ===');
  const events = extractCalendarEntities();
  const stats = { events: events.length, attendees: 0, created: 0, places: 0 };

  for (const event of events) {
    for (const email of event.attendeeEmails || []) {
      try {
        const r = resolvePerson({ email, source: 'calendar' });
        stats.attendees++;
        if (r.created) stats.created++;
      } catch { /* skip */ }
    }
    if (event.place) stats.places++;
  }
  log(`  ${stats.events} events, ${stats.attendees} attendees resolved (${stats.created} created), ${stats.places} places`);
  return stats;
}
