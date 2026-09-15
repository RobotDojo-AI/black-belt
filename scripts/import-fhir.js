#!/usr/bin/env node
/**
 * CLI wrapper for the Apple Health FHIR clinical records importer.
 *
 * Core logic lives in lib/health-fhir-import.js — this wrapper handles
 * CLI args and progress reporting. DB is opened via lib/db.js (cipher-aware).
 *
 * Usage:
 *   node scripts/import-fhir.js [--dry-run] [--verbose] [--dir /path/to/clinical-records]
 *
 * DB path: controlled by ROBOTDOJO_DB_PATH env var (or default ~/.robotdojo/robotdojo.db).
 * Set ROBOTDOJO_ALLOW_PLAINTEXT=1 if the DB is unencrypted (dev/test only).
 */

import db from '../lib/db.js';
import { importFhirClinicalRecords, formatImportReport } from '../lib/health-fhir-import.js';
import { queueHealthIntelRegenerationIfChanged } from '../lib/health-intel-regeneration.js';

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const dirArg = process.argv.find((a, i) => process.argv[i - 1] === '--dir');

console.log(`DB: ${db.name}${DRY_RUN ? ' [DRY RUN]' : ''}`);

const stats = importFhirClinicalRecords({
  db,
  clinicalDir: dirArg,
  dryRun: DRY_RUN,
  verbose: VERBOSE,
});

console.log(formatImportReport(stats, { verbose: VERBOSE }));
queueHealthIntelRegenerationIfChanged({
  dryRun: DRY_RUN,
  inserted: stats.inserted + (stats.updated || 0),
  reason: 'apple_health_import',
});
