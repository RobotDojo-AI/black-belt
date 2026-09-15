/**
 * backfill-event-time.js
 *
 * Fills chunks.event_time for email, calendar, and iMessage chunks by joining
 * to the source table and pulling the canonical timestamp.
 *
 * Idempotent: uses WHERE event_time = '' so re-running is always safe.
 * (CLAUDE.md: NOT NULL DEFAULT '' means IS NULL never matches — must use = '')
 *
 * Usage: ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/ingest/backfill-event-time.js
 */

import db from '../../lib/db.js';

function backfill() {
  // --- Email: received_at ---
  // chunks.source_id = emails.id (both are the Google message-id string)
  // COALESCE guards against NULL from subquery when emails.id doesn't match
  // (orphaned chunk). NOT NULL column: must stay as '' not NULL.
  const emailResult = db.prepare(`
    UPDATE chunks
    SET event_time = COALESCE(
      (SELECT e.received_at FROM emails e WHERE e.id = chunks.source_id),
      ''
    )
    WHERE source_type = 'email'
      AND (event_time IS NULL OR event_time = '')
  `).run();
  console.log(`[backfill-event-time] email: ${emailResult.changes} rows updated`);

  // --- Calendar: start_time ---
  // chunks.source_id = calendar_events.id
  // Primary: join to calendar_events.start_time.
  // Fallback: json_extract metadata.date (orphaned recurring event chunks like
  // '{event_id}_{dateZ}' always have date in their metadata JSON).
  const calResult = db.prepare(`
    UPDATE chunks
    SET event_time = COALESCE(
      (SELECT c.start_time FROM calendar_events c WHERE c.id = chunks.source_id),
      json_extract(chunks.metadata, '$.date'),
      ''
    )
    WHERE source_type = 'calendar'
      AND (event_time IS NULL OR event_time = '')
  `).run();
  console.log(`[backfill-event-time] calendar: ${calResult.changes} rows updated`);

  // --- iMessage: date ---
  // chunks.source_id format: 'imessage:{handle}:{date}' (e.g. imessage:+16505551234:2024-01-15)
  // Primary: join to imessages table for the date column.
  // Fallback: source_id date segment is always 10 chars (YYYY-MM-DD) at the tail.
  // WHY 10-char tail: the date is always ISO format YYYY-MM-DD (10 chars) as the
  // last segment. Handles all known patterns: +phone:date, email@host:date,
  // +phone(smsfp):date (the (smsfp) suffix is part of the handle, not the date).
  const imResult = db.prepare(`
    UPDATE chunks
    SET event_time = COALESCE(
      (SELECT i.date FROM imessages i WHERE i.source_id = chunks.source_id),
      CASE
        WHEN length(chunks.source_id) >= 21
             AND chunks.source_id LIKE 'imessage:%:%'
             AND substr(chunks.source_id, length(chunks.source_id) - 9, 1) >= '1'
          THEN substr(chunks.source_id, length(chunks.source_id) - 9, 10)
        ELSE ''
      END
    )
    WHERE source_type = 'imessage'
      AND (event_time IS NULL OR event_time = '')
  `).run();
  console.log(`[backfill-event-time] imessage: ${imResult.changes} rows updated`);

  // Verify: count remaining unfilled rows for these source types
  const unfilled = db.prepare(`
    SELECT COUNT(*) AS c
    FROM chunks
    WHERE source_type IN ('email', 'calendar', 'imessage')
      AND (event_time IS NULL OR event_time = '')
  `).get().c;

  if (unfilled > 0) {
    console.warn(`[backfill-event-time] WARNING: ${unfilled} rows still have empty event_time (source records may be missing)`);
  } else {
    console.log('[backfill-event-time] all email/calendar/imessage rows filled');
  }
}

backfill();
