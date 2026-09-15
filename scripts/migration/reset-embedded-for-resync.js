#!/usr/bin/env node
/**
 * scripts/migration/reset-embedded-for-resync.js — st_1cfe9061
 *
 * One-time pre-start script: resets chunks.embedded = 0 in batches of 1000
 * rows with a 10ms sleep between batches to avoid holding the write lock
 * for the full table duration (~150k+ rows → 2–5s unbatched).
 *
 * After this runs, the embed daemon begins draining into embeddings.db
 * under the two-DB split architecture.
 *
 * Idempotent: safe to re-run if interrupted. Rows already at embedded=0
 * are simply updated again (no-op cost per SQLite; no data loss).
 *
 * Usage:
 *   node scripts/migration/reset-embedded-for-resync.js [--dry-run]
 *
 * Exit: 0 on completion.
 */

export const INTELLIGENCE_TIER = 'extraction';

import db from '../../lib/db.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 1000;
const SLEEP_MS = 10;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const totalStmt = db.prepare('SELECT COUNT(*) as n FROM chunks WHERE embedded = 1');
const total = totalStmt.get().n;

if (total === 0) {
  console.log('[reset-embedded] no embedded chunks found — nothing to do');
  process.exit(0);
}

console.log(`[reset-embedded] ${DRY_RUN ? '(dry-run) ' : ''}resetting ${total} embedded chunks in batches of ${BATCH_SIZE}…`);

if (DRY_RUN) {
  console.log(`[reset-embedded] dry-run: would reset ${total} rows`);
  process.exit(0);
}

const batchStmt = db.prepare(`
  UPDATE chunks
     SET embedded = 0,
         embedding_signature = NULL,
         embedding_model_id = NULL,
         embedding_dim = NULL,
         embedded_at = NULL
   WHERE id IN (
     SELECT id FROM chunks WHERE embedded = 1 LIMIT ${BATCH_SIZE}
   )
`);

let totalReset = 0;
let batch = 0;
while (true) {
  const result = batchStmt.run();
  if (result.changes === 0) break;
  totalReset += result.changes;
  batch++;
  const pct = Math.round((totalReset / total) * 100);
  if (batch % 10 === 0 || totalReset >= total) {
    console.log(`[reset-embedded] batch ${batch}: reset ${totalReset}/${total} (${pct}%)`);
  }
  if (result.changes < BATCH_SIZE) break; // fewer rows remaining than batch — done
  await sleep(SLEEP_MS);
}

console.log(`[reset-embedded] done — ${totalReset} chunks reset to embedded=0`);
process.exit(0);
