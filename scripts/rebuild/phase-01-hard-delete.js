/**
 * Phase 1 — Hard delete people/companies/places/address_timeline and all
 * derived per-person tables in a single transaction.
 *
 * Source data (emails, imessage, calendar, contacts, extracted_addresses)
 * is never touched.
 */
import db from '../../lib/db.js';

export function hardDelete(log) {
  log('\n=== Phase 1: Hard delete (single transaction) ===');

  const before = {
    people: db.prepare('SELECT COUNT(*) AS n FROM people').get().n,
    companies: db.prepare('SELECT COUNT(*) AS n FROM companies').get().n,
    places: db.prepare('SELECT COUNT(*) AS n FROM places').get().n,
    person_identifiers: db.prepare('SELECT COUNT(*) AS n FROM person_identifiers').get().n,
    person_interactions: db.prepare('SELECT COUNT(*) AS n FROM person_interactions').get().n,
    // st_87a0d072 Phase 6: person_edges dropped — omitted from before-counts.
    person_groups: db.prepare('SELECT COUNT(*) AS n FROM person_groups').get().n,
    person_topics: db.prepare('SELECT COUNT(*) AS n FROM person_topics').get().n,
    address_timeline: db.prepare('SELECT COUNT(*) AS n FROM address_timeline').get().n,
    company_domains: db.prepare('SELECT COUNT(*) AS n FROM company_domains').get().n,
  };
  log(`  Before: ${JSON.stringify(before)}`);

  // st_87a0d072 Phase 6: person_edges dropped — omit from wipe sequence.
  const wipe = db.transaction(() => {
    db.exec(`
      DELETE FROM person_topics;
      DELETE FROM person_groups;
      DELETE FROM person_interactions;
      DELETE FROM person_identifiers;
      DELETE FROM people;
      DELETE FROM company_domains;
      DELETE FROM companies;
      DELETE FROM places;
      DELETE FROM address_timeline;
    `);
    // st_f1a40461: also clear DERIVED entity→chunk / entity→timeline link tables.
    // They key on entity ids; after a hard delete every entity gets a NEW id,
    // so the old rows are orphaned garbage that (a) pollute downstream joins and
    // (b) made place-scoring scan 390K stale rows. They are rebuilt fresh:
    // chunk_entities by scripts/ingest/link-chunk-entities.js, timeline_events by
    // timeline-wire.js, timeline_event_entities by Phase 8 entity-link. Raw
    // `chunks` (source data) is preserved — only the entity links are cleared.
    for (const t of ['chunk_entities', 'timeline_event_entities', 'timeline_events']) {
      try { db.exec(`DELETE FROM ${t};`); } catch { /* table absent in minimal envs */ }
    }
    // Also reset extracted_addresses so the timeline rebuilds from scratch
    // (keep the table; we'll rescan below)
  });
  wipe();

  return before;
}
