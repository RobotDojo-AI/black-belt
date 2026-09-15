#!/usr/bin/env node
/**
 * scripts/backfill-transcripts.js
 *
 * Writes flat-file transcripts for all granola rows that lack file_path.
 * Idempotent: re-running produces no new files if all rows already have file_path.
 *
 * Usage:
 *   cd ~/robotdojo && ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/backfill-transcripts.js
 */

import db from '../lib/db.js';
import { writeTranscriptFile } from '../lib/transcripts.js';

db.pragma('wal_checkpoint(RESTART)');

const rows = db.prepare("SELECT * FROM transcripts WHERE source = 'granola' AND file_path IS NULL").all();
console.log(`[backfill-transcripts] ${rows.length} rows to write`);

let written = 0;
for (const row of rows) {
  try {
    await writeTranscriptFile(row);
    written++;
  } catch (e) {
    console.error(`[backfill-transcripts] FAILED id=${row.id}: ${e.message}`);
  }
}

console.log(`[backfill-transcripts] done: wrote ${written}/${rows.length}`);
