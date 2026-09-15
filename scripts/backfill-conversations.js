#!/usr/bin/env node
/**
 * scripts/backfill-conversations.js
 *
 * Writes flat-file exports for all conversations that lack file_path.
 * Idempotent: re-running skips rows that already have file_path set.
 *
 * Usage:
 *   cd ~/robotdojo && ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/backfill-conversations.js
 *
 * NOTE: ~1,854 conversations, each pulling messages. Expected runtime: 2-5 minutes.
 */

import db from '../lib/db.js';
import { writeConversationFile } from '../lib/transcripts.js';

db.pragma('wal_checkpoint(RESTART)');

const rows = db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL AND file_path IS NULL').all();
console.log(`[backfill-conversations] ${rows.length} rows to write`);

let written = 0;
for (const row of rows) {
  try {
    const fp = await writeConversationFile(row.id);
    if (fp) written++;
  } catch (e) {
    console.error(`[backfill-conversations] FAILED id=${row.id}: ${e.message}`);
  }
}

console.log(`[backfill-conversations] done: wrote ${written}/${rows.length}`);
