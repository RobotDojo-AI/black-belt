#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/drop-main-db-chunk-vec-tables.mjs — st_8697bbe3
//
// One-shot migration: drops orphaned chunk_vec_* virtual tables from the main
// robotdojo.db. These tables were created by addTopic() before st_8697bbe3
// removed that code path. The embedding daemon now creates chunk_vec_* tables
// exclusively in embeddings.db.
//
// Usage: cd ~/robotdojo && node scripts/drop-main-db-chunk-vec-tables.mjs
//
// Safety:
//   - Guards with pragma_module_list() before any DROP — exits non-zero if
//     the sqlite-vec extension is not loaded (lib/db.js loads it at import).
//   - WAL checkpoint RESTART before DDL to prevent SQLITE_BUSY_SNAPSHOT.
//   - Discovers tables dynamically from sqlite_master so the list reflects
//     actual DB state rather than hard-coded assumptions.
//   - Verifies zero remaining chunk_vec_* tables after drops; exits 1 if any
//     remain.
//   - Does NOT touch chunk_vec_general in embeddings.db — only main DB tables.
// ─────────────────────────────────────────────────────────────────────────────

import { homedir } from 'node:os';
import { resolve } from 'node:path';

const HOME = process.env.HOME || homedir();
const ROOT = process.env.ROBOTDOJO_HOME || resolve(HOME, 'robotdojo');

// lib/db.js loads the sqlite-vec extension at import time (sqliteVec.load(db)
// at line 310). Importing db is sufficient — no manual loadExtension() needed.
const { default: db } = await import(resolve(ROOT, 'lib/db.js'));

// GUARD: confirm vec0 is registered before any DROP. A DROP TABLE on a vec0
// virtual table without the extension loaded would attempt to call the xDestroy
// vtab method via a null pointer, crashing the process or corrupting the DB.
// pragma_module_list() returns one row per registered module; we need vec0.
const hasVec0 = db.prepare("SELECT name FROM pragma_module_list() WHERE name='vec0'").get();
if (!hasVec0) {
  console.error('FATAL: sqlite-vec not loaded — vec0 extension absent. Aborting.');
  process.exit(1);
}
console.log('sqlite-vec present (vec0 registered). Proceeding with DROP sequence.');

// WAL CHECKPOINT RESTART: before batch DDL writes, flush any WAL frames from
// a prior interrupted session. A killed process mid-write can leave reader
// marks that cause SQLITE_BUSY_SNAPSHOT on the next writer. RESTART blocks
// until all readers have cleared, then resets the write-lock.
// WHY RESTART not PASSIVE: DDL writes to the main db file (not WAL) after the
// checkpoint; we need all frames applied before the schema changes.
db.pragma('wal_checkpoint(RESTART)');
console.log('WAL checkpoint RESTART done.');

// Discover tables dynamically — safer than a hard-coded list that could miss
// tables added since research or include tables already dropped.
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE name LIKE 'chunk_vec_%' AND type='table' ORDER BY name"
).all().map((r) => r.name);

if (tables.length === 0) {
  console.log('No chunk_vec_* tables found in main DB. Nothing to drop.');
} else {
  console.log(`Found ${tables.length} table(s) to drop: ${tables.join(', ')}`);

  // Drop each table. sqlite-vec's xDestroy handles shadow table cleanup
  // automatically when the extension is loaded — dropping the root table
  // cascades to all 5 shadow tables (chunks, meta, info, rowids, shadow).
  for (const tableName of tables) {
    try {
      // Use DROP TABLE (not IF EXISTS) so we surface any unexpected state.
      // The table list came from sqlite_master so each name is known to exist.
      db.exec(`DROP TABLE ${tableName}`);
      console.log(`  Dropped: ${tableName}`);
    } catch (err) {
      console.error(`  FATAL: failed to drop ${tableName}: ${err?.message}`);
      process.exit(1);
    }
  }
}

// VERIFY: zero remaining chunk_vec_* tables.
const remaining = db.prepare(
  "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'chunk_vec_%'"
).get().n;

console.log(`Remaining chunk_vec_* tables in main DB: ${remaining}`);
if (remaining > 0) {
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'chunk_vec_%'"
  ).all().map((r) => r.name);
  console.error(`FATAL: ${remaining} table(s) still present: ${names.join(', ')}`);
  process.exit(1);
}

// WAL CHECKPOINT PASSIVE after DDL: reclaim WAL frames written during the
// DROP sequence. Non-blocking — a reader holding the snapshot makes this a
// fast no-op; the next checkpoint picks up the frames.
db.pragma('wal_checkpoint(PASSIVE)');
console.log('WAL checkpoint PASSIVE done. Migration complete.');
