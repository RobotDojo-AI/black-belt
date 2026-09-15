#!/usr/bin/env node
/**
 * One-time data correction for phantom values already in health_data_points
 * from pre-validation FHIR imports. Flags (not deletes) errant readings.
 *
 * Root causes:
 *   hemoglobin >20 g/dL  → MCHC values (31-37 g/dL) imported under hemoglobin via
 *                          FHIR field mapping error (old importer before lab-name-map.js)
 *   anc >10 x10³/µL      → raw ANC count or percentage imported without unit normalization
 *   homocysteine 79.0     → single outlier, source='self-reported'; flagged for review
 *
 * Safe to re-run (UPDATE WHERE excluded=0 only updates rows not already flagged).
 * All changes are logged to stdout.
 */

import path from 'path';
import Database from 'better-sqlite3';

const DRY_RUN = process.argv.includes('--dry-run');
const DB_PATH = process.env.ROBOTDOJO_DB_PATH
  || path.join(process.env.HOME, '.robotdojo/robotdojo-premerge.db');

const db = new Database(DB_PATH, { readonly: DRY_RUN });

const corrections = [
  {
    name: 'hemoglobin MCHC contamination',
    where: "marker_id='hemoglobin' AND value > 20 AND excluded=0",
    reason: 'fhir-unit-mismatch-mchc',
    description: 'MCHC values (31-37 g/dL) imported under hemoglobin marker by old FHIR importer',
  },
  {
    name: 'ANC unit parsing error',
    where: "marker_id='anc' AND value > 10 AND excluded=0",
    reason: 'fhir-unit-mismatch',
    description: 'ANC values >10 x10³/µL are implausible — likely raw count without unit normalization',
  },
  {
    name: 'homocysteine outlier 79.0 µmol/L',
    where: "marker_id='homocysteine' AND value > 50 AND excluded=0",
    reason: 'outlier-pending-review',
    description: 'Single reading 5× above ref_high (14.5). Source: self-reported. Flagged for clinical review.',
  },
];

let totalChanged = 0;

for (const c of corrections) {
  const rows = db.prepare(`SELECT id, date, value, source, source_file FROM health_data_points WHERE ${c.where}`).all();
  console.log(`\n${c.name}: ${rows.length} row(s) to flag`);
  console.log(`  Reason: ${c.reason}`);
  console.log(`  Note: ${c.description}`);
  for (const row of rows) {
    console.log(`    id=${row.id} date=${row.date} value=${row.value} source=${row.source} file=${row.source_file}`);
  }
  if (!DRY_RUN && rows.length > 0) {
    const result = db.prepare(
      `UPDATE health_data_points SET excluded=1, exclude_reason=? WHERE ${c.where}`
    ).run(c.reason);
    console.log(`  → ${result.changes} row(s) updated`);
    totalChanged += result.changes;
  } else if (DRY_RUN) {
    console.log(`  → DRY RUN — no changes made`);
  }
}

if (!DRY_RUN) db.close();

console.log(`\nTotal rows flagged: ${totalChanged}`);
if (DRY_RUN) console.log('(Dry run — nothing written)');
