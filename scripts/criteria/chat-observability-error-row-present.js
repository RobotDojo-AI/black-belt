#!/usr/bin/env node
/**
 * chat-observability-error-row-present.js
 *
 * st_74f45a1a error-path criterion — assert the most recent chat turn
 * (within the last 5 minutes) recorded an error_type. Run AFTER the
 * chat-error-retry Playwright spec executes against production.
 *
 * Exits 0 on pass, 1 on fail.
 */
import db from '../../lib/db.js';

const FIVE_MIN_MS = 5 * 60 * 1000;
const since = Date.now() - FIVE_MIN_MS;

const row = db.prepare(`
  SELECT turn_id, error_type, error_message, recovery_path, request_start_ms
  FROM chat_turn_metrics
  WHERE request_start_ms >= ? AND error_type IS NOT NULL
  ORDER BY request_start_ms DESC
  LIMIT 1
`).get(since);

if (!row) {
  console.error('[err] FAIL — no chat_turn_metrics row with error_type in the last 5 minutes');
  process.exit(1);
}

if (!row.error_type || typeof row.error_type !== 'string' || row.error_type.length === 0) {
  console.error('[err] FAIL — error_type column empty on turn_id=' + row.turn_id);
  process.exit(1);
}

console.log(`[err] ok — turn_id=${row.turn_id} error_type=${row.error_type} recovery_path=${row.recovery_path || '-'}`);
process.exit(0);
