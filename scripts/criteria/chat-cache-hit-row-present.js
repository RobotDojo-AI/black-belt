#!/usr/bin/env node
/**
 * chat-cache-hit-row-present.js
 *
 * st_74f45a1a AC 11 — assert that prompt caching is enabled and at least
 * one chat turn within the last 5 minutes wrote a chat_turn_metrics row
 * with cache_read_input_tokens > 0. After the Playwright warm-TTFB spec
 * runs (two turns in the same conversation), the SECOND turn should
 * read cached system tokens.
 *
 * Exits 0 when a recent row has cache_read_input_tokens > 0; 1 otherwise.
 */
import db from '../../lib/db.js';

const FIVE_MIN_MS = 5 * 60 * 1000;
const since = Date.now() - FIVE_MIN_MS;

// Look for the most recent row in the window that has a non-null cache
// counter. The first turn typically writes cache_creation_input_tokens
// (cache build); the second turn writes cache_read_input_tokens (hit).
const row = db.prepare(`
  SELECT turn_id, conversation_id, request_start_ms,
         cache_creation_input_tokens, cache_read_input_tokens,
         input_tokens, output_tokens, error_type
  FROM chat_turn_metrics
  WHERE request_start_ms >= ?
    AND (cache_read_input_tokens > 0 OR cache_creation_input_tokens > 0)
  ORDER BY request_start_ms DESC
  LIMIT 1
`).get(since);

if (!row) {
  console.error('[ac11] FAIL — no chat_turn_metrics row in last 5 minutes has cache_creation/cache_read tokens > 0');
  // Diagnostic: show the most recent rows so we can see whether the
  // turn fired at all but cache columns were null.
  const recent = db.prepare(`
    SELECT turn_id, request_start_ms,
           cache_creation_input_tokens, cache_read_input_tokens,
           input_tokens, output_tokens, error_type
    FROM chat_turn_metrics
    WHERE request_start_ms >= ?
    ORDER BY request_start_ms DESC
    LIMIT 5
  `).all(since);
  console.error('[ac11] last 5 rows:', JSON.stringify(recent, null, 2));
  process.exit(1);
}

const read = row.cache_read_input_tokens || 0;
const created = row.cache_creation_input_tokens || 0;
console.log(`[ac11] ok — turn_id=${row.turn_id} cache_read=${read} cache_creation=${created} input=${row.input_tokens} output=${row.output_tokens}`);

// AC 11 strictly requires cache_read > 0 on at least one row. If the
// most recent matching row only has cache_creation set, look harder for a
// read hit — a read hit proves caching is working end-to-end.
const readRow = db.prepare(`
  SELECT turn_id, request_start_ms, cache_read_input_tokens
  FROM chat_turn_metrics
  WHERE request_start_ms >= ? AND cache_read_input_tokens > 0
  ORDER BY request_start_ms DESC LIMIT 1
`).get(since);

if (!readRow) {
  console.error('[ac11] PARTIAL — cache writes observed (cache_creation_input_tokens > 0) but no cache hits yet.');
  console.error('[ac11] AC contract requires cache_read_input_tokens > 0. Run a SECOND turn in the same conversation.');
  process.exit(1);
}

console.log(`[ac11] cache hit confirmed — turn_id=${readRow.turn_id} cache_read=${readRow.cache_read_input_tokens}`);
process.exit(0);
