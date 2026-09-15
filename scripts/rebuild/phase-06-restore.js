/**
 * Phase 2e — Restore interactions/groups/topics/edges from pre-wipe snapshot.
 *
 * Snapshot tables were created in phase-00. We resolve each row's person_id
 * from the freshly-rebuilt registry by email first, then display_name.
 */
import db from '../../lib/db.js';

export function restoreDerivedData(log) {
  log('\n=== Phase 2e: Restore interactions/groups/topics/edges ===');

  // Build email → person_id and name → person_id maps
  const emailMap = new Map();
  for (const r of db.prepare(`
    SELECT value, person_id FROM person_identifiers WHERE type='email'
  `).all()) {
    emailMap.set(r.value.toLowerCase(), r.person_id);
  }

  const nameMap = new Map();
  for (const r of db.prepare(`
    SELECT id, display_name FROM people WHERE archived = 0
  `).all()) {
    nameMap.set(r.display_name.toLowerCase(), r.id);
  }

  function resolveId(email, name) {
    if (email && emailMap.has(email.toLowerCase())) return emailMap.get(email.toLowerCase());
    if (name && nameMap.has(String(name).toLowerCase())) return nameMap.get(String(name).toLowerCase());
    return null;
  }

  // ── Interactions ──
  const insInt = db.prepare(`
    INSERT OR IGNORE INTO person_interactions (person_id, channel, direction, source_id, date)
    VALUES (?, ?, ?, ?, ?)
  `);
  let iRest = 0, iSkip = 0;
  const intRows = db.prepare('SELECT * FROM tantei_interactions_snap').all();
  db.transaction(() => {
    for (const r of intRows) {
      const pid = resolveId(r.email, r.name);
      if (!pid) { iSkip++; continue; }
      try { insInt.run(pid, r.channel, r.direction, r.source_id, r.date); iRest++; }
      catch { iSkip++; }
    }
  })();
  log(`  Interactions: ${iRest} restored, ${iSkip} dropped (unresolved)`);

  // ── Groups (deliberate lists, milestones) ──
  const insGrp = db.prepare(`
    INSERT OR IGNORE INTO person_groups (person_id, group_name, group_type, group_identifier)
    VALUES (?, ?, ?, ?)
  `);
  let gRest = 0, gSkip = 0;
  const grpRows = db.prepare('SELECT * FROM tantei_groups_snap').all();
  db.transaction(() => {
    for (const r of grpRows) {
      const pid = resolveId(r.email, r.name);
      if (!pid) { gSkip++; continue; }
      try { insGrp.run(pid, r.group_name, r.group_type, r.group_identifier); gRest++; }
      catch { gSkip++; }
    }
  })();
  log(`  Groups: ${gRest} restored, ${gSkip} dropped`);

  // ── Topics ──
  const insTop = db.prepare(`
    INSERT INTO person_topics (person_id, topic, weight)
    VALUES (?, ?, ?)
    ON CONFLICT(person_id, topic) DO UPDATE SET weight = person_topics.weight + excluded.weight
  `);
  let tRest = 0, tSkip = 0;
  const topRows = db.prepare('SELECT * FROM tantei_topics_snap').all();
  db.transaction(() => {
    for (const r of topRows) {
      const pid = resolveId(r.email, r.name);
      if (!pid) { tSkip++; continue; }
      try { insTop.run(pid, r.topic, r.weight); tRest++; }
      catch { tSkip++; }
    }
  })();
  log(`  Topics: ${tRest} restored, ${tSkip} dropped`);

  // ── Edges ──
  // st_87a0d072 Phase 6: person_edges dropped. The snapshot table is empty
  // by construction (see phase-00-snapshot.js). No restore needed.
  const eRest = 0, eSkip = 0;
  log(`  Edges: ${eRest} restored, ${eSkip} dropped`);

  return { interactions: iRest, groups: gRest, topics: tRest, edges: eRest };
}
