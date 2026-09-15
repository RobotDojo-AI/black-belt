#!/usr/bin/env node
/**
 * scripts/backfill-granola-segments.js — corpus segment backfill
 * (st_8a841c68 Phase 2).
 *
 * Compute tier: Tier 0 (extraction) — a live Granola re-pull plus deterministic
 * row writes. No LLM. Gated on Phase 0 (scripts/granola-segment-spike.js)
 * proving the at-scale re-pull returns per-segment source + timestamps.
 *
 * The per-turn segments are not stored and not recoverable from the DB (the
 * flat transcript_text was the only narrative column), so each stored Granola
 * transcript is re-fetched live by meeting_id and its segments populated into
 * transcript_segments. The transcript's calendar_event_id / ical_uid (the
 * roster-join keys) are backfilled in the same pass when the document carries
 * a google_calendar_event.
 *
 * Idempotent by construction: insertSegments upserts on
 * (transcript_id, turn_index), so a re-run over the same call writes nothing
 * new. wal_checkpoint(RESTART) runs first per the batch-write discipline
 * (build-conventions Migration).
 *
 * Usage:
 *   cd ~/robotdojo && ROBOTDOJO_ALLOW_PLAINTEXT=1 \
 *     node scripts/backfill-granola-segments.js [--limit N] [--concurrency N]
 */
export const INTELLIGENCE_TIER = 'extraction';

import db from '../lib/db.js';
import { getGranolaToken, GRANOLA_REST_URL, captureSegments } from '../lib/granola-client.js';
import { insertSegments } from '../lib/transcript-segments.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const LIMIT = Number(arg('--limit', '0')) || 0;
const CONCURRENCY = Number(arg('--concurrency', '6'));

async function restPost(token, path, body) {
  const res = await fetch(`${GRANOLA_REST_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Granola REST ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function mapPool(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main() {
  // wal_checkpoint(RESTART) before the batch (build-conventions Migration): a
  // transaction that may re-run after an interrupted session must checkpoint
  // first or a killed-process reader mark causes SQLITE_BUSY_SNAPSHOT hangs.
  // Best-effort: a healthy live server owns the WAL and RESTART can contend; the
  // shared db.js connection writes safely regardless, so a failure is non-fatal.
  try { db.pragma('wal_checkpoint(RESTART)'); }
  catch (e) { console.warn(`[backfill-segments] checkpoint skipped: ${e.message}`); }

  const token = await getGranolaToken();
  if (!token) {
    console.error('[backfill-segments] BLOCKED — no Granola token available.');
    process.exit(1);
  }

  // Live document map keyed by Granola doc id, for the calendar-event backfill.
  const docs = await restPost(token, '/v1/get-documents', {});
  const list = Array.isArray(docs) ? docs : (docs?.documents || []);
  const docById = new Map();
  for (const d of list) docById.set(d.id || d.document_id, d);

  let rows = db.prepare(
    "SELECT id, meeting_id FROM transcripts WHERE source = 'granola' AND meeting_id IS NOT NULL",
  ).all();
  if (LIMIT > 0) rows = rows.slice(0, LIMIT);

  const hasSegments = db.prepare('SELECT 1 FROM transcript_segments WHERE transcript_id = ? LIMIT 1');
  const setCalKeys = db.prepare('UPDATE transcripts SET calendar_event_id = ?, ical_uid = ? WHERE id = ?');

  let processed = 0;
  let segmentRows = 0;
  let calBackfilled = 0;
  let fetchErrors = 0;
  let skippedComplete = 0;

  await mapPool(rows, CONCURRENCY, async (row) => {
    // Backfill the calendar keys from the live doc (cheap, idempotent UPDATE).
    const meta = docById.get(row.meeting_id);
    const cal = meta?.google_calendar_event;
    if (cal?.id) {
      setCalKeys.run(cal.id, cal.iCalUID || cal.ical_uid || null, row.id);
      calBackfilled++;
    }

    // Skip the segment re-pull when this transcript already has segments —
    // makes the backfill cheap to re-run (idempotent + skips network).
    if (hasSegments.get(row.id)) { skippedComplete++; return; }

    let data;
    try {
      data = await restPost(token, '/v1/get-document-transcript', { document_id: row.meeting_id });
    } catch (e) {
      fetchErrors++;
      console.error(`[backfill-segments] fetch failed ${row.meeting_id}: ${e.message}`);
      return;
    }
    const raw = Array.isArray(data) ? data : (data?.segments || data?.transcript?.segments || []);
    const segments = captureSegments(raw);
    if (segments.length === 0) return;
    const { inserted } = insertSegments(db, row.id, segments);
    segmentRows += inserted;
    processed++;
  });

  console.log('--- backfill-granola-segments report ---');
  console.log(`transcripts scanned:        ${rows.length}`);
  console.log(`transcripts segmented now:  ${processed}`);
  console.log(`already-segmented skipped:  ${skippedComplete}`);
  console.log(`segment rows inserted:      ${segmentRows}`);
  console.log(`calendar keys backfilled:   ${calBackfilled}`);
  console.log(`fetch errors:               ${fetchErrors}`);
}

main().catch((e) => {
  console.error(`[backfill-segments] BLOCKED — ${e.message}`);
  process.exit(1);
});
