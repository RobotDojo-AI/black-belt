#!/usr/bin/env node
// One-time FTS rebuild — run after adding chunks_fts triggers (044_chunks_fts_triggers.sql).
// Safe to re-run: INSERT INTO chunks_fts VALUES('rebuild') is idempotent.
import db from '../lib/db.js';

const before = db.prepare('SELECT COUNT(*) as n FROM chunks_fts_docsize').get().n;
const chunks = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;
console.log(`Before: chunks_fts_docsize=${before}, chunks=${chunks}`);

console.log('Running wal_checkpoint(RESTART)...');
db.pragma('wal_checkpoint(RESTART)');

console.log('Rebuilding FTS index (may take 30–120s on large corpora)...');
const start = Date.now();
db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run();
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

db.pragma('wal_checkpoint(FULL)');

const after = db.prepare('SELECT COUNT(*) as n FROM chunks_fts_docsize').get().n;
console.log(`After: chunks_fts_docsize=${after} (${elapsed}s)`);

if (after !== chunks) {
  console.error(`MISMATCH: fts=${after} chunks=${chunks}`);
  process.exit(1);
}
console.log('FTS rebuild complete.');
