#!/usr/bin/env node
/**
 * chat-observability-row-present.js
 *
 * st_74f45a1a AC 5 — assert that the most recent chat turn (within the
 * last 5 minutes) wrote a chat_turn_metrics row with non-null timestamps
 * and positive total_ms. Run AFTER a chat Playwright spec executes against
 * production.
 *
 * Exits 0 on pass, 1 on fail with the offending column.
 */
import db from '../../lib/db.js';

const FIVE_MIN_MS = 5 * 60 * 1000;
const since = Date.now() - FIVE_MIN_MS;

const row = db.prepare(`
  SELECT turn_id, request_start_ms, first_token_ms, completion_ms,
         (first_token_ms - request_start_ms) AS ttft_ms,
         (completion_ms - request_start_ms)  AS total_ms,
         error_type, recovery_path
  FROM chat_turn_metrics
  WHERE request_start_ms >= ?
  ORDER BY request_start_ms DESC
  LIMIT 1
`).get(since);

if (!row) {
  console.error('[ac5] FAIL — no chat_turn_metrics row written in the last 5 minutes');
  process.exit(1);
}

const fails = [];
if (row.request_start_ms == null || row.request_start_ms <= 0) fails.push('request_start_ms');
if (row.first_token_ms == null || row.first_token_ms <= 0) fails.push('first_token_ms');
if (row.completion_ms == null || row.completion_ms <= 0) fails.push('completion_ms');
if (row.ttft_ms == null || row.ttft_ms < 0) fails.push('ttft_ms (first_token - request_start)');
if (row.total_ms == null || row.total_ms <= 0) fails.push('total_ms (completion - request_start)');

if (fails.length > 0) {
  console.error('[ac5] FAIL — turn_id=' + row.turn_id + ' missing columns: ' + fails.join(', '));
  process.exit(1);
}

console.log(`[ac5] ok — turn_id=${row.turn_id} ttft_ms=${row.ttft_ms} total_ms=${row.total_ms}`);
process.exit(0);
