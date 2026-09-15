/**
 * Phase 2a — Contacts (tier 1, full trust).
 *
 * Reads Mac Contacts, creates canonical people records, tags family labels.
 */
import db from '../../lib/db.js';
import { extractContacts } from '../../lib/contacts-extractor.js';
import { getBBModule } from '../../lib/module-loader.js';
import { setRelationTag } from '../../lib/people-write.js';
import { wbResolvePerson } from '../../lib/wb-resolve-person.js';

function getResolvePerson() {
  // WB fallback (BB inactive) is the shared wbResolvePerson helper (st_180aa017
  // AC-4 — collapses the 3 diverged copies into one). Gate UNCHANGED: only the
  // fallback body moved to lib/.
  return getBBModule()?.resolvePerson ?? ((c) => wbResolvePerson(db, c));
}

export function phaseContacts(log) {
  const resolvePerson = getResolvePerson();
  log('\n=== Phase 2a: Contacts (tier 1 — full trust) ===');
  const contacts = extractContacts();
  const stats = { total: contacts.length, created: 0, matched: 0, skipped: 0 };

  for (const c of contacts) {
    try {
      if (c.emails.length > 0) {
        const r = resolvePerson({
          name: c.name, email: c.emails[0], phone: c.phones[0] || null, source: 'contacts',
        });
        r.created ? stats.created++ : stats.matched++;
        for (let i = 1; i < c.emails.length; i++) {
          resolvePerson({ name: c.name, email: c.emails[i], source: 'contacts' });
        }
        // Apply relation tags (spouse / parent / sibling) from Mac Contacts labels
        if (c.relations?.length > 0) {
          const personId = r.personId;
          const label = c.relations[0].label;
          const FAMILY_LABELS = new Set([
            'spouse','parent','sibling','child','aunt-uncle','cousin',
            'niece-nephew','grandparent','parent-in-law','sibling-in-law',
          ]);
          if (FAMILY_LABELS.has(label)) {
            // st_df0a8d71 QA round 2 — through the ONE write path (authority +
            // weak-evidence floors, supersede facts). 'aunt-uncle' is not in
            // FAMILY_TAGS; setRelationTag throws on it, so guard here (the old
            // direct UPDATE silently wrote an out-of-vocabulary tag).
            try {
              setRelationTag(db, personId, label, null, { source: 'contacts-relation' });
            } catch (err) {
              console.warn(`[phase-02] relation tag skipped for ${personId}: ${err.message}`);
            }
          }
        }
      } else if (c.name) {
        const r = resolvePerson({ name: c.name, phone: c.phones[0] || null, source: 'contacts' });
        r.created ? stats.created++ : stats.matched++;
      } else {
        stats.skipped++;
      }
    } catch (err) {
      stats.skipped++;
    }
  }
  log(`  ${stats.total} contacts: ${stats.created} created, ${stats.matched} matched, ${stats.skipped} skipped`);
  return stats;
}
