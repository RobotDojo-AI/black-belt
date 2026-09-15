#!/usr/bin/env node
/**
 * Backfill chunks.quality_score across the entire corpus.
 *
 * st_566ad80b. Idempotent. Re-running picks up new rows (quality_score
 * defaults to 0.0 on INSERT; this script updates anything <= 0.0). Safe
 * to run mid-flight.
 *
 * INTELLIGENCE_TIER: extraction
 *   This script does not call an LLM. It computes a numeric score per row
 *   from chunks.source_type + chunks.event_time using a closed-form
 *   formula (see lib/ann/quality-score.js). No synthesis, no model calls.
 *
 * Operational notes:
 *   - Uses better-sqlite3 transactions in 10K-row batches.
 *   - Calls `db.pragma('wal_checkpoint(RESTART)')` before each batch to
 *     clear stale WAL reader marks (matches the Migration Protocol in
 *     CLAUDE.md — prevents SQLITE_BUSY_SNAPSHOT after a killed run).
 *   - Total wall-clock on the 1.2M-row corpus: 3–5 minutes.
 *   - Re-runs after a formula change: bump QUALITY_VERSION in
 *     usearch-adapter.js, then explicitly run:
 *
 *       UPDATE chunks SET quality_score = 0.0 WHERE embedded = 1;
 *       node scripts/backfill-quality-scores.js
 *
 *     (Skipping the reset means rows already > 0.0 are kept at the old
 *     formula value — silently wrong.)
 *
 * Exit codes:
 *   0  = success
 *   1  = SQLite/IO error (logged; safe to re-run)
 */

export const INTELLIGENCE_TIER = 'extraction';

import db from '../lib/db.js';
import { computeQualityScore, markQualityRecomputed } from '../lib/ann/quality-score.js';
import { BACKFILL_BATCH_SIZE } from '../lib/ann/ann-config.js';

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

function log(...args) {
  if (VERBOSE) console.log(...args);
}

function main() {
  const started = Date.now();

  // WAL checkpoint before any large write transaction (st_566ad80b plan;
  // pattern from build-conventions Migration Protocol). Skipping causes
  // SQLITE_BUSY_SNAPSHOT when prior killed processes left stale reader
  // marks in the SHM file.
  try {
    db.pragma('wal_checkpoint(RESTART)');
  } catch (err) {
    console.warn('[backfill] wal_checkpoint failed (continuing):', err.message);
  }

  // Count rows needing backfill — gives a stable upper bound for progress.
  const total = db.prepare(
    'SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1 AND quality_score <= 0.0',
  ).get().n;
  console.info(`[backfill] ${total} embedded chunks need quality_score`);

  if (total === 0) {
    console.info('[backfill] nothing to do — all rows already scored');
    try { markQualityRecomputed(db); } catch (err) {
      console.warn('[backfill] markQualityRecomputed failed:', err.message);
    }
    process.exit(0);
  }

  // WHY id-keyset pagination (not OFFSET, not single-streaming-iterate):
  //   - OFFSET N restarts the index scan every batch → O(N²) wall-clock.
  //   - Streaming iterate() + transactional UPDATE on the same connection
  //     deadlocks (better-sqlite3 errors "connection busy executing a
  //     query" when a transaction starts mid-iteration).
  //   - id-keyset pagination (WHERE id > last_id LIMIT N) lets each batch
  //     finalize its read before the write transaction begins, and uses
  //     the rowid index for O(1) per-batch lookup cost.
  const selectBatch = db.prepare(`
    SELECT id, source_type, event_time
    FROM chunks
    WHERE embedded = 1 AND quality_score <= 0.0 AND id > ?
    ORDER BY id
    LIMIT ?
  `);
  const updateScore = db.prepare(
    'UPDATE chunks SET quality_score = ? WHERE id = ?',
  );

  const writeBatch = db.transaction((rows) => {
    for (const { id, score } of rows) {
      updateScore.run(score, id);
    }
  });

  let processed = 0;
  let lastId = 0;
  const nowMs = Date.now();
  while (true) {
    const rows = selectBatch.all(lastId, BACKFILL_BATCH_SIZE);
    if (!rows.length) break;
    const scored = rows.map(r => ({
      id: r.id,
      score: computeQualityScore(r.source_type, r.event_time, nowMs),
    }));
    writeBatch(scored);
    lastId = rows[rows.length - 1].id;
    processed += rows.length;
    if (processed % (BACKFILL_BATCH_SIZE * 5) === 0) {
      const pct = ((processed / total) * 100).toFixed(1);
      const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
      console.info(`[backfill] ${processed}/${total} (${pct}%) in ${elapsedSec}s`);
    }
  }

  markQualityRecomputed(db, nowMs);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.info(`[backfill] complete: ${processed} rows in ${elapsed}s`);
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error('[backfill] fatal:', err.message);
  process.exit(1);
}
