/**
 * Phase 0 — Snapshot derived data so we can restore interactions by email/name.
 *
 * Extracted from scripts/tantei-rebuild.js during the Tantei decomposition.
 * Pure behavior — no logic changes.
 */
import db from '../../lib/db.js';

export function snapshot(log) {
  log('\n=== Phase 0: Snapshot (preserve by email/name) ===');

  // Drop stale temp tables
  db.exec(`
    DROP TABLE IF EXISTS tantei_interactions_snap;
    DROP TABLE IF EXISTS tantei_edges_snap;
    DROP TABLE IF EXISTS tantei_groups_snap;
    DROP TABLE IF EXISTS tantei_topics_snap;
  `);

  // Snapshot interactions — keyed by email + display_name (not person_id)
  db.exec(`
    CREATE TABLE tantei_interactions_snap AS
    SELECT
      p.display_name AS name,
      (SELECT value FROM person_identifiers WHERE person_id = p.id AND type='email' ORDER BY is_primary DESC LIMIT 1) AS email,
      pi.channel, pi.direction, pi.source_id, pi.date
    FROM person_interactions pi
    JOIN people p ON p.id = pi.person_id;
    CREATE INDEX idx_tis_email ON tantei_interactions_snap(email);
    CREATE INDEX idx_tis_name ON tantei_interactions_snap(name);
  `);

  // Snapshot groups (deliberate lists, milestones, imessage groups)
  db.exec(`
    CREATE TABLE tantei_groups_snap AS
    SELECT
      p.display_name AS name,
      (SELECT value FROM person_identifiers WHERE person_id = p.id AND type='email' ORDER BY is_primary DESC LIMIT 1) AS email,
      pg.group_name, pg.group_type, pg.group_identifier
    FROM person_groups pg
    JOIN people p ON p.id = pg.person_id;
    CREATE INDEX idx_tgs_email ON tantei_groups_snap(email);
    CREATE INDEX idx_tgs_name ON tantei_groups_snap(name);
  `);

  // Snapshot topics
  db.exec(`
    CREATE TABLE tantei_topics_snap AS
    SELECT
      p.display_name AS name,
      (SELECT value FROM person_identifiers WHERE person_id = p.id AND type='email' ORDER BY is_primary DESC LIMIT 1) AS email,
      pt.topic, pt.weight
    FROM person_topics pt
    JOIN people p ON p.id = pt.person_id;
    CREATE INDEX idx_tts_email ON tantei_topics_snap(email);
  `);

  // Snapshot edges — both endpoints, keyed by email+name
  db.exec(`
    -- st_87a0d072 Phase 6: person_edges dropped. Snapshot an empty placeholder
    -- so downstream consumers (phase-06-restore) keep their schema.
    CREATE TABLE tantei_edges_snap (
      a_name TEXT, a_email TEXT, b_name TEXT, b_email TEXT,
      edge_type TEXT, weight REAL, context TEXT, first_seen TEXT, last_seen TEXT
    );
  `);

  const snapCounts = {
    interactions: db.prepare('SELECT COUNT(*) AS n FROM tantei_interactions_snap').get().n,
    groups: db.prepare('SELECT COUNT(*) AS n FROM tantei_groups_snap').get().n,
    topics: db.prepare('SELECT COUNT(*) AS n FROM tantei_topics_snap').get().n,
    edges: 0,  // person_edges dropped by st_87a0d072
  };
  log(`  Snapshotted: ${JSON.stringify(snapCounts)}`);
  return snapCounts;
}

export function cleanupSnapshotTables() {
  db.exec(`
    DROP TABLE IF EXISTS tantei_interactions_snap;
    DROP TABLE IF EXISTS tantei_edges_snap;
    DROP TABLE IF EXISTS tantei_groups_snap;
    DROP TABLE IF EXISTS tantei_topics_snap;
  `);
}
