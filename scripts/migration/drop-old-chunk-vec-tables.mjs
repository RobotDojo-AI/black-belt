#!/usr/bin/env node
/**
 * scripts/migration/drop-old-chunk-vec-tables.mjs — st_1cfe9061
 *
 * After fast-embed-targets completes migration to embeddings.db, drop the now-
 * redundant chunk_vec_* tables from robotdojo.db for all migrated non-personal
 * topics. Personal topic tables are preserved until the follow-on story
 * migrates the 338k personal chunks.
 *
 * Safety check: only drops tables for topics in topic_vec_migrations.
 * Personal topic is always excluded.
 *
 * Usage:
 *   node scripts/migration/drop-old-chunk-vec-tables.mjs [--dry-run]
 */

export const INTELLIGENCE_TIER = 'extraction';

import { resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(homedir(), 'robotdojo');
const { default: db } = await import(resolve(ROOT, 'lib/db.js'));

const dryRun = process.argv.includes('--dry-run');

// Only drop tables for topics that are fully migrated to embeddingsDb.
const migratedTopics = new Set(
  db.prepare('SELECT topic FROM topic_vec_migrations').all().map((r) => r.topic)
);
migratedTopics.delete('personal'); // never drop personal tables until follow-on story

// Find all chunk_vec_* tables in robotdojo.db.
const allVecTables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'chunk_vec_%' ORDER BY name")
  .all()
  .map((r) => r.name);

// Convert a topic name to its table-safe form (hyphens → underscores).
function toTableSafe(topic) {
  return topic.replace(/[^a-z0-9_]/g, '_');
}

// Build the set of table-safe prefixes for migrated topics.
const migratedPrefixes = new Set(
  [...migratedTopics].map((t) => `chunk_vec_${toTableSafe(t)}`)
);

// A table belongs to a migrated topic if its name IS the prefix or STARTS WITH prefix_.
function isMigratedTable(tableName) {
  if (migratedPrefixes.has(tableName)) return true;
  for (const prefix of migratedPrefixes) {
    if (tableName.startsWith(`${prefix}_`)) return true;
  }
  return false;
}

// Only drop tables for migrated topics (excluding personal).
const toDrop = allVecTables.filter((name) => isMigratedTable(name));

const toKeep = allVecTables.filter((name) => !toDrop.includes(name));

console.log(`[drop-tables] ${migratedTopics.size} migrated topics (excluding personal)`);
console.log(`[drop-tables] Tables to drop: ${toDrop.length}`);
console.log(`[drop-tables] Tables to keep: ${toKeep.length} (personal + non-migrated)`);

if (dryRun) {
  console.log('[drop-tables] DRY RUN — no tables dropped');
  console.log('Would drop:', toDrop.join(', '));
  process.exit(0);
}

if (toDrop.length === 0) {
  console.log('[drop-tables] nothing to drop — done');
  process.exit(0);
}

let dropped = 0;
let errors = 0;
for (const tableName of toDrop) {
  try {
    db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
    dropped++;
  } catch (err) {
    console.error(`[drop-tables] ERROR dropping ${tableName}: ${err.message}`);
    errors++;
  }
}

console.log(`[drop-tables] dropped ${dropped} tables, ${errors} errors`);
if (errors > 0) {
  console.error('[drop-tables] some tables could not be dropped — check errors above');
  process.exit(1);
}
console.log('[drop-tables] done');
