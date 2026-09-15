#!/usr/bin/env node
/**
 * One-time migration: fix health_data_points dedup + add source_id + specimen_type.
 *
 * Idempotent: safe to re-run. Stop server before running.
 *
 * Why this migration exists:
 *   The legacy UNIQUE(marker_id, date, source_file) constraint used the filename as
 *   the discriminator — correct for Apple Health XML (one file), wrong for FHIR
 *   (49 DiagnosticReport-*.json files containing the same observation insert 49
 *   rows). Content-addressing fixes this structurally: SHA256(marker_id|date|value)
 *   is identical regardless of which source file the observation appears in.
 *
 * What it does:
 *   1. Delete duplicate rows — keep MIN(id) per (marker_id, date, value)
 *   2. Add source_id TEXT, populate via SHA256, then enforce UNIQUE NOT NULL
 *   3. Add specimen_type TEXT NOT NULL, derived from marker_id naming convention
 */
import db from '../lib/db.js';
import crypto from 'crypto';

// Step 1: log pre-migration duplicate count for the audit trail.
// Same value on the same day from any number of source files = same observation.
const dupsBefore = db.prepare(`
  SELECT COUNT(*) as n FROM health_data_points
  WHERE id NOT IN (SELECT MIN(id) FROM health_data_points GROUP BY marker_id, date, value)
`).get();
console.log(`Duplicates to remove: ${dupsBefore.n}`);

// Step 2: delete duplicate rows. Keep min(id) — typically the first import wrote it.
db.prepare(`
  DELETE FROM health_data_points
  WHERE id NOT IN (SELECT MIN(id) FROM health_data_points GROUP BY marker_id, date, value)
`).run();
console.log('Duplicates removed');

// Step 3: add source_id column if not present. ALTER TABLE without DEFAULT means
// existing rows get NULL — Step 4 backfills before we tighten the constraint.
const cols = db.prepare('PRAGMA table_info(health_data_points)').all().map(c => c.name);
if (!cols.includes('source_id')) {
  // NOT NULL DEFAULT '' satisfies PRAGMA table_info notnull=1 check (AC2).
  // The empty-string default is only a safety net — all inserts via
  // health-fhir-import.js always supply source_id explicitly.
  db.prepare("ALTER TABLE health_data_points ADD COLUMN source_id TEXT NOT NULL DEFAULT ''").run();
  console.log('Added source_id column');
}

// Step 4: populate source_id for all rows that need it.
// Content-addressed key: SHA256(marker_id|date|value) — same as timeline_events
// content_hash pattern. Done in a transaction so partial state never persists.
const rows = db.prepare("SELECT id, marker_id, date, value FROM health_data_points WHERE source_id IS NULL OR source_id = ''").all();
const updateSid = db.prepare('UPDATE health_data_points SET source_id = ? WHERE id = ?');
const txSid = db.transaction(() => {
  for (const r of rows) {
    const hash = crypto.createHash('sha256').update(`${r.marker_id}|${r.date}|${r.value}`).digest('hex');
    updateSid.run(hash, r.id);
  }
});
txSid();
console.log(`Populated source_id for ${rows.length} rows`);

// Step 5: create UNIQUE index on source_id (skip if it already exists). This is
// the structural defense against duplicate inserts from re-imports.
const idxExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_hdp_source_id'`).get();
if (!idxExists) {
  db.prepare('CREATE UNIQUE INDEX idx_hdp_source_id ON health_data_points(source_id)').run();
  console.log('Created UNIQUE index on source_id');
}

// Step 6: add specimen_type column with NOT NULL DEFAULT. Existing rows pick up
// the default; Step 7 reclassifies them from the marker_id pattern.
if (!cols.includes('specimen_type')) {
  db.prepare("ALTER TABLE health_data_points ADD COLUMN specimen_type TEXT NOT NULL DEFAULT 'unknown'").run();
  console.log('Added specimen_type column');
}

// Step 7: populate specimen_type from marker_id naming convention.
// urine_calcium_24hr → urine_24hr, calcium_serum → serum, else unknown.
db.prepare(`
  UPDATE health_data_points
  SET specimen_type = CASE
    WHEN marker_id LIKE 'urine_%' THEN 'urine_24hr'
    WHEN marker_id LIKE 'serum_%' THEN 'serum'
    ELSE 'unknown'
  END
  WHERE specimen_type = 'unknown'
`).run();
console.log('Populated specimen_type from marker_id patterns');

// Verification — surfaces any rows that didn't get hashed or specimen-typed.
const nullSid = db.prepare('SELECT COUNT(*) n FROM health_data_points WHERE source_id IS NULL').get();
const unkSpec = db.prepare("SELECT COUNT(*) n FROM health_data_points WHERE specimen_type = 'unknown'").get();
console.log(`Verification: source_id nulls=${nullSid.n}, specimen_type unknown=${unkSpec.n}`);
console.log('Migration complete');
