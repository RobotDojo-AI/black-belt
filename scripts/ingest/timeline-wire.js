/**
 * timeline-wire.js — Wire all raw source events into timeline_events.
 *
 * WHY this script exists instead of doing this inline in each extractor:
 * Timeline wiring is a cross-cutting concern — it runs AFTER all extractors
 * complete so the timeline always reflects the full current state of the DB,
 * not a partial snapshot from whichever extractor happened to run last.
 * Running it here also makes idempotency trivial: INSERT OR IGNORE on the
 * UNIQUE(source_type, source_id) constraint means re-running never duplicates.
 *
 * Source mapping:
 *   emails          received_at   → source_type='email'
 *   calendar_events start_time    → source_type='calendar'
 *   imessages       date          → source_type='imessage'
 *   transcripts     meeting_date  → source_type='granola'   (skipped if 0 rows)
 *   health_notes    date          → source_type='oura'      (skipped if 0 rows)
 *
 * Compute tier: Tier 0 (free) — pure SQL + SQLite, no LLM, no embeddings.
 */

import db from '../../lib/db.js';
import { insertTimelineEvent } from '../../lib/timeline-schema.js';

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), '[timeline-wire]', ...args);

/**
 * Wire a single source into timeline_events inside one transaction.
 * @param {string} sourceType      - timeline source_type label
 * @param {string} table           - source table name
 * @param {string} idCol           - primary key column
 * @param {string} dateCol         - occurrence date column (stored as event_date)
 * @param {string} [summaryCol]    - optional column for summary text (truncated to 200 chars)
 * @returns {number} rows inserted
 */
function wireSource(sourceType, table, idCol, dateCol, summaryCol) {
  // Probe row count to support graceful-degradation on optional sources.
  const total = db.prepare(`SELECT count(*) as n FROM ${table} WHERE ${dateCol} IS NOT NULL`).get().n;
  if (total === 0) {
    log(`${sourceType}: 0 rows — skipped`);
    return 0;
  }

  const rows = db.prepare(
    `SELECT ${idCol}, ${dateCol}${summaryCol ? `, ${summaryCol}` : ''} FROM ${table} WHERE ${dateCol} IS NOT NULL`
  ).all();

  // One transaction per source — bulk insert is orders of magnitude faster
  // than per-row commits in better-sqlite3 (synchronous driver, no async overhead).
  let inserted = 0;
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const sourceId = String(row[idCol]);
      const eventDate = row[dateCol];
      // summary: use raw text field if available, truncate to 200 chars, never call LLM.
      const rawSummary = summaryCol ? (row[summaryCol] || '') : '';
      const summary = rawSummary.slice(0, 200);
      const result = insertTimelineEvent({
        sourceType,
        sourceId,
        eventDate,
        eventType: sourceType,
        summary,
        content: summary, // used for content_hash dedup
        metadata: {},
      });
      if (result.inserted) inserted++;
    }
  });
  tx(rows);

  return inserted;
}

function main() {
  log('start');

  const counts = {};

  // --- Required sources (must have data in production) ---
  counts.email    = wireSource('email',    'emails',          'id',  'received_at', 'subject');
  counts.calendar = wireSource('calendar', 'calendar_events', 'id',  'start_time',  'summary');
  counts.imessage = wireSource('imessage', 'imessages',       'id',  'date',        'handle');

  // --- Optional sources (gracefully skipped when empty) ---
  counts.granola  = wireSource('granola',  'transcripts',     'id',  'meeting_date', 'title');
  counts.oura     = wireSource('oura',     'health_notes',    'id',  'date',         'content');

  // Log final counts per source — format parsed by DC 8 grep check.
  log('complete —', Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', '));
}

main();
