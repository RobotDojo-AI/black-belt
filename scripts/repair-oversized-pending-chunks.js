#!/usr/bin/env node
/**
 * Split oversized pending transcript chunks through the normal transcript
 * re-chunker. This keeps topic/source/vector ownership intact and avoids
 * feeding giant meeting bodies to the embedding model.
 */

import db from '../lib/db.js';
import { rechunkTranscript } from '../lib/chunk-worker.js';

const maxChars = Number(process.env.ROBOTDOJO_STOPLIGHT_MAX_PENDING_CHUNK_CHARS || 200000);
const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Math.max(1, Number(limitArg.slice('--limit='.length)) || 0) : 100;

const rows = db.prepare(`
  SELECT id, topic, source_type, source_id, LENGTH(COALESCE(content, '')) AS chars
  FROM chunks
  WHERE embedded = 0
    AND COALESCE(skip_embed, 0) = 0
    AND LENGTH(COALESCE(content, '')) > ?
  ORDER BY chars DESC
  LIMIT ?
`).all(maxChars, limit);

const unsupported = rows.filter((row) => row.source_type !== 'transcript' || !String(row.source_id || '').startsWith('transcript:'));
if (unsupported.length) {
  console.error(`[repair-oversized-pending-chunks] unsupported oversized rows=${unsupported.length}`);
  for (const row of unsupported.slice(0, 10)) {
    console.error(`[repair-oversized-pending-chunks] unsupported id=${row.id} source=${row.source_type}:${row.source_id} chars=${row.chars}`);
  }
  process.exit(1);
}

let repaired = 0;
for (const row of rows) {
  const transcriptId = String(row.source_id).slice('transcript:'.length);
  console.log(`[repair-oversized-pending-chunks] ${dryRun ? 'would_rechunk' : 'rechunk'} chunk=${row.id} transcript=${transcriptId} topic=${row.topic || ''} chars=${row.chars}`);
  if (dryRun) continue;
  const ok = await rechunkTranscript(transcriptId);
  if (!ok) {
    console.error(`[repair-oversized-pending-chunks] rechunk failed transcript=${transcriptId}`);
    process.exit(1);
  }
  repaired++;
}

const remaining = db.prepare(`
  SELECT COUNT(*) AS n,
         MAX(LENGTH(COALESCE(content, ''))) AS max_chars
  FROM chunks
  WHERE embedded = 0
    AND COALESCE(skip_embed, 0) = 0
    AND LENGTH(COALESCE(content, '')) > ?
`).get(maxChars);

const ok = Number(remaining?.n || 0) === 0;
console.log(JSON.stringify({
  ok,
  dry_run: dryRun,
  max_chars: maxChars,
  seen: rows.length,
  repaired,
  remaining_oversized: Number(remaining?.n || 0),
  remaining_max_chars: Number(remaining?.max_chars || 0),
}, null, 2));

process.exit(ok ? 0 : 1);
