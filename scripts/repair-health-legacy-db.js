#!/usr/bin/env node
/**
 * Recover Health chart substrate from the pre-live DB path.
 *
 * Current live app DB:     ~/.robotdojo/robotdojo.db
 * Legacy/raw-data DB path: ~/robotdojo/user/databases/robotdojo.db
 *
 * A prior transition left some installs with health notes in the live DB but
 * chart markers/data in the legacy DB. This script copies only missing Health
 * chart substrate into the live DB. It is safe to run repeatedly.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import db from '../lib/db.js';
import config from '../lib/config.js';
import { isPlaintext, readKey } from '../lib/db-encryption.js';

const destPath = resolve(process.env.ROBOTDOJO_DB || resolve(config.configDir, 'robotdojo.db'));
const legacyPath = resolve(
  process.env.ROBOTDOJO_HEALTH_LEGACY_DB
    || resolve(homedir(), 'robotdojo/user/databases/robotdojo.db'),
);

function log(message) {
  console.info(`[health-repair] ${message}`);
}

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}

function count(table, schema = 'main') {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.${table}`).get().n;
  } catch {
    return 0;
  }
}

function copyTable(table, columns) {
  const colList = columns.join(', ');
  const before = count(table);
  db.prepare(`
    INSERT OR IGNORE INTO main.${table} (${colList})
    SELECT ${colList}
    FROM legacy.${table}
  `).run();
  const after = count(table);
  return Math.max(0, after - before);
}

if (!existsSync(legacyPath)) {
  log('no legacy health DB found; no repair needed');
  process.exit(0);
}

if (legacyPath === destPath) {
  log('legacy and live DB paths are identical; no repair needed');
  process.exit(0);
}

const livePoints = count('health_data_points');

let attached = false;
try {
  const plaintext = await isPlaintext(legacyPath);
  if (plaintext) {
    db.exec(`ATTACH DATABASE '${sqlString(legacyPath)}' AS legacy`);
  } else {
    const key = readKey();
    if (!key) {
      log('legacy DB is encrypted but the local key is unavailable; skipping repair');
      process.exit(0);
    }
    db.exec(`ATTACH DATABASE '${sqlString(legacyPath)}' AS legacy KEY "x'${key}'"`);
  }
  attached = true;

  const legacyPoints = count('health_data_points', 'legacy');
  const legacyMarkers = count('health_markers', 'legacy');
  if (!legacyPoints || !legacyMarkers) {
    log('legacy DB has no health chart substrate; no repair needed');
    process.exit(0);
  }

  if (livePoints > 0) {
    log(`live DB already has ${livePoints} health data points; no repair needed`);
    process.exit(0);
  }

  const result = db.transaction(() => {
    const copied = {};
    copied.groups = copyTable('health_groups', ['id', 'name', 'description']);
    copied.markers = copyTable('health_markers', [
      'id', 'name', 'unit', 'group_id', 'view', 'ref_low', 'ref_high',
      'target', 'trend', 'description', 'recommendations', 'auto_created',
    ]);
    copied.data_points = copyTable('health_data_points', [
      'id', 'marker_id', 'date', 'value', 'source', 'source_file', 'source_id',
      'specimen_type', 'excluded', 'exclude_reason', 'created_at',
    ]);

    if (count('health_notes') === 0) {
      copied.notes = copyTable('health_notes', ['id', 'date', 'content', 'tags', 'created_at', 'source']);
    } else {
      copied.notes = 0;
    }

    if (count('fhir_staged_observations') === 0) {
      copied.fhir_staged = copyTable('fhir_staged_observations', [
        'id', 'source_file', 'effective_date', 'fhir_display_name', 'value',
        'unit', 'ref_low', 'ref_high', 'status', 'mapped_marker_id', 'created_at', 'reason',
      ]);
    } else {
      copied.fhir_staged = 0;
    }

    if (count('health_ingestion_log') === 0) {
      copied.ingestion_logs = copyTable('health_ingestion_log', [
        'id', 'source', 'file_path', 'ingested_date', 'record_count', 'created_at',
      ]);
    } else {
      copied.ingestion_logs = 0;
    }
    return copied;
  })();

  log(
    `restored ${result.markers} markers, ${result.data_points} data points, `
    + `${result.groups} groups, ${result.notes} notes, `
    + `${result.fhir_staged} staged FHIR rows, ${result.ingestion_logs} ingestion logs`,
  );
} catch (err) {
  console.warn(`[health-repair] skipped: ${err?.message || err}`);
  process.exit(0);
} finally {
  if (attached) {
    try { db.exec('DETACH DATABASE legacy'); } catch { /* non-fatal */ }
  }
}
