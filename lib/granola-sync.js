/**
 * Granola meeting transcript sync.
 * Fetches meetings since last sync and stamps each call's topic from its Granola
 * folder (st_1169bfc7): the folder title is matched live against the topic
 * registry and the MECE decision table resolves it (a primary-work folder wins →
 * lone folder sets that topic → 2+ folders / no folder → personal). A folder-derived
 * topic is pinned (topic_set_method='folder') against reclassification; a
 * no-folder call is stamped personal directly (no calendar fallback at sync).
 * Stores in transcripts, seeds attendees into the entity graph (create-or-link),
 * and
 * records one person_interactions row per resolved attendee (channel
 * 'meeting'). The transcript INSERT and its Asana-task job enqueue commit in
 * one transaction (AC8 — a row exists iff its job exists).
 *
 * Attendee source (st_fd14cdd4 AC6): the document payload when it carries
 * people fields (lib/granola-client.js extractAttendeeEmails), else the
 * deterministic calendar join below — exact title + same-day match against
 * calendar_events inherits the invite's attendee emails. Both paths are
 * Tier 0; no LLM touches identity.
 */
import { createHash } from 'node:crypto';
import db from './db.js';
import { fetchGranolaMeetings, fetchGranolaListMembership } from './granola-client.js';
import { seedTranscriptAttendees } from './people-seed.js';
import { writeTranscriptFile } from './transcripts.js';
import { insertSegments } from './transcript-segments.js';
import { attributeTranscript, resolveOwnerPersonId } from './transcript-attribution.js';
import { scoreResidual } from './attribute-residual.js';
import { enqueueGranolaCallAsanaTask } from './granola-call-asana.js';
import { insertTimelineEvent } from './timeline-schema.js';
import { resolveCallTopic, loadAsanaRoutingConfig } from './call-routing.js';
import { topicSlugSet } from './topics.js';
import { PERSONAL_TOPIC } from './topic-routing-policy.js';

function meetingRowId(meeting) {
  return createHash('sha256')
    .update(`granola:${meeting.id}:${meeting.date}`)
    .digest('hex')
    .slice(0, 32);
}

const stmts = {
  getLastSync: db.prepare(`SELECT MAX(imported_at) AS last FROM transcripts WHERE source = 'granola'`),
  getExistingIds: db.prepare(`SELECT meeting_id FROM transcripts WHERE source = 'granola'`),
  getNewestMeetingDate: db.prepare(`SELECT MAX(meeting_date) AS mx FROM transcripts WHERE source = 'granola'`),
  getById: db.prepare('SELECT * FROM transcripts WHERE id = ?'),
};

/**
 * df_e1dcf732 AC8 — transcript INSERT + Asana-job enqueue as ONE transaction.
 *
 * The invariant is structural: a granola transcripts row exists if and only
 * if its granola_call_asana job row exists. Before this, the 45s sync
 * watchdog could SIGTERM between the INSERT and the enqueue; the next pass
 * then skipped the meeting forever via the existingIds guard — 21 calls lost
 * their task silently. If the enqueue throws now, the INSERT rolls back and
 * the meeting is re-fetched next pass (it never entered existingIds): worst
 * case is delay, never a silent skip.
 *
 * enqueuePassiveJob is a single INSERT…ON CONFLICT statement, safe inside
 * this transaction. Exported as a named unit so the rollback behavior is
 * unit-testable (tests/granola-sync-atomic.test.js). Thin-facade: database
 * injected; statements prepared per call so any injected handle works.
 *
 * @returns {boolean} true when this call genuinely inserted the row (and
 *   enqueued its job); false when the row already existed (nothing written).
 */
export function insertTranscriptWithAsanaJob(database, row) {
  const insertStmt = database.prepare(`
    INSERT OR IGNORE INTO transcripts (id, meeting_id, title, meeting_date, duration_minutes, transcript_text, call_notes, topic, topic_set_method, attendee_emails, calendar_event_id, ical_uid, source)
    VALUES (@id, @meetingId, @title, @meetingDate, @durationMinutes, @transcriptText, @callNotes, @topic, @topicSetMethod, @attendeeEmails, @calendarEventId, @icalUid, 'granola')
  `);
  const insertAndEnqueue = database.transaction((r) => {
    const result = insertStmt.run(r);
    if (result.changes > 0) {
      enqueueGranolaCallAsanaTask(database, { id: r.id, topic: r.topic });
    }
    return result.changes > 0;
  });
  return insertAndEnqueue(row);
}

/**
 * Deterministic fallback when the Granola payload carries no attendees
 * (st_fd14cdd4 verify-at-build ledger 2): inherit attendees from the calendar
 * invite — exact title match + same calendar day. Live-verified at build:
 * 102 of 383 stored transcripts match an attendee-bearing event this way.
 *
 * Excludes `self` attendees (Google rows carry the flag). Returns
 * [{email, name}] — empty when no event matches (ad-hoc meetings have no
 * invite; that residual is reported by the backfill, never invented).
 *
 * Exported for lib reuse (scripts/backfill-participants.js) and unit tests.
 */
export function findCalendarAttendees(database, title, meetingDate) {
  const day = String(meetingDate || '').slice(0, 10);
  if (!day || !title) return [];
  const rows = database.prepare(`
    SELECT attendees FROM calendar_events
     WHERE summary = ?
       AND date(start_time) = ?
       AND attendees IS NOT NULL AND attendees != '' AND attendees != '[]'
  `).all(String(title).trim(), day);
  const found = new Map();
  for (const row of rows) {
    let parsed = [];
    try { parsed = JSON.parse(row.attendees); } catch { continue; }
    for (const attendee of parsed) {
      if (attendee?.self) continue;
      const email = String(attendee?.email || '').trim().toLowerCase();
      if (!email.includes('@')) continue;
      if (!found.has(email) || (attendee.name && !found.get(email))) {
        found.set(email, String(attendee.name || '').trim());
      }
    }
  }
  return [...found.entries()].map(([email, name]) => ({ email, name }));
}

export async function syncGranola(opts = {}) {
  // Pre-query existing meeting_ids so fetchGranolaMeetings can skip already-stored meetings
  const existingIds = new Set(stmts.getExistingIds.all().map(r => r.meeting_id));

  // st_1169bfc7 — Granola folder membership is THE topic signal. The registry
  // (classifiable user_topics slugs + config topicAliases) is threaded in so
  // recognition is registry-driven: a folder named like any topic maps with no
  // code change. The resolved map value already ran through the MECE decision
  // table (primary-work folder wins → lone folder → 2+ folders = personal), so the topic
  // stamp trusts it verbatim. Empty map (broken feed / unreadable cache) → every
  // new call falls to the personal fail-safe below.
  const listMembership = await fetchGranolaListMembership({
    topicSlugs: topicSlugSet(db),
    aliases: loadAsanaRoutingConfig().topicAliases || {},
  });

  // Bound the public-API listing to what we don't already have. Deep cursor
  // pagination back through the full history has been observed to 500
  // server-side, and re-walking years of notes to find the last few is waste.
  // A day of overlap absorbs clock skew; a cold DB pulls everything.
  const newest = stmts.getNewestMeetingDate?.get()?.mx || null;
  const createdAfter = newest
    ? new Date(new Date(newest).getTime() - 86400000).toISOString()
    : null;

  let meetings;
  try {
    meetings = await fetchGranolaMeetings({ existingIds, createdAfter });
  } catch (e) {
    console.error('[granola-sync] fetch failed:', e.message);
    return { synced: 0, error: e.message };
  }

  let synced = 0;
  let attendeesSeeded = 0;
  let attributed = 0;
  let asanaQueued = 0;
  const ownerPersonId = resolveOwnerPersonId();
  // Accumulate newly-inserted transcript rows so onNewTranscripts can fire
  // once after the loop with the exact set of new rows (st_2fc47782).
  const newRows = [];
  for (const meeting of meetings) {
    if (!meeting.transcript) continue; // skip meetings with no transcript text

    // Payload attendees first; calendar-invite join when the payload has none.
    let attendees = meeting.attendeeDetails?.length
      ? meeting.attendeeDetails
      : findCalendarAttendees(db, meeting.title, meeting.date);

    const attendeeEmails = attendees.map((a) => a.email).join(',');
    const rowId = meetingRowId(meeting);

    // st_1169bfc7 — the Granola folder decides the topic. A resolved folder slug
    // is folder-authoritative and PINNED (topic_set_method='folder') so the
    // retrieval reclassification pass cannot overwrite it (AC4). No folder slug →
    // the personal fail-safe (AC3); the calendar classifier is deliberately NOT
    // consulted at the sync stamp (owner rule: Granola tags only, calendar for
    // enrichment; no folder → personal). resolveCallTopic with a folder slug just
    // re-applies normalize+alias — idempotent on the already-clean map slug.
    const folderSlug = listMembership.get(meeting.id) ?? null;
    const topic = folderSlug
      ? resolveCallTopic(db, {
          id: rowId,
          title: meeting.title,
          meeting_date: meeting.date,
          calendar_event_id: meeting.calendarEventId || null,
          ical_uid: meeting.icalUid || null,
          attendee_emails: attendeeEmails,
        }, folderSlug)
      : PERSONAL_TOPIC;
    const topicSetMethod = folderSlug ? 'folder' : 'sync';

    let inserted = false;
    try {
      inserted = insertTranscriptWithAsanaJob(db, {
        id: rowId,
        meetingId: meeting.id,
        title: meeting.title,
        meetingDate: meeting.date,
        durationMinutes: meeting.durationMinutes,
        transcriptText: meeting.transcript,
        callNotes: meeting.callNotes || null,
        topic,
        topicSetMethod,
        attendeeEmails,
        calendarEventId: meeting.calendarEventId || null,
        icalUid: meeting.icalUid || null,
      });
    } catch (err) {
      // Transaction rolled back — no row, no job. The meeting never entered
      // existingIds, so the next pass re-fetches it: delayed, never skipped.
      console.warn(`[granola-sync] transcript insert+enqueue failed for ${meeting.id}: ${err.message}`);
      continue;
    }
    if (inserted) {
      asanaQueued++;
      insertTimelineEvent({
        sourceType: 'granola',
        sourceId: rowId,
        eventDate: meeting.date,
        eventType: 'meeting_transcript',
        summary: meeting.title || 'Meeting transcript',
        content: `${meeting.title || ''}\n${attendeeEmails}`,
        metadata: { topic, meeting_id: meeting.id, source: 'granola' },
      });
    }
    // st_8a841c68 Phase 1: persist the structured per-turn segments for newly
    // inserted calls. insertSegments is idempotent on (transcript_id,
    // turn_index), so a re-returned stored meeting writes nothing new.
    if (inserted && meeting.segments?.length) {
      try {
        insertSegments(db, rowId, meeting.segments);
      } catch (err) {
        console.warn(`[granola-sync] segment insert failed for ${meeting.id}: ${err.message}`);
      }
    }
    // st_fd14cdd4 AC6: attendees seed create-or-link + one meeting
    // interaction per resolved person. Idempotent (unique source_id), so a
    // re-run over the same meeting writes nothing new.
    try {
      const seeded = seedTranscriptAttendees(db, {
        meetingId: meeting.id,
        date: meeting.date,
        attendees,
      }, { source: 'transcript' });
      attendeesSeeded += seeded.seeded;
    } catch (err) {
      console.warn(`[granola-sync] attendee seeding failed for ${meeting.id}: ${err.message}`);
    }

    // Attribute every new segmented Granola call before it reaches disk or
    // Asana. Attendee seeding runs first so the roster can resolve invitees by
    // email even when this is the first time a person appears in the corpus.
    // (The Asana job is already enqueued atomically above, but it drains in a
    // later idle-gated pass — after this pass finishes attribution.)
    if (inserted && meeting.segments?.length) {
      try {
        await attributeTranscript(db, rowId, { ownerPersonId, residualScorer: scoreResidual });
        attributed++;
      } catch (err) {
        console.warn(`[granola-sync] attribution failed for ${meeting.id}: ${err.message}`);
      }
    }

    // Write flat file after attribution. writeTranscriptFile is idempotent and
    // uses attributed turns when they exist.
    const storedRow = stmts.getById.get(rowId);
    if (storedRow) {
      await writeTranscriptFile(storedRow);
      // Accumulate ONLY rows this run genuinely inserted (st_2fc47782): keying
      // the callback off the atomic insert result — not off `storedRow`
      // existing, which is always truthy after the upsert — guarantees
      // onNewTranscripts fires at most once per transcript even if the API
      // re-returns a stored meeting. The Asana enqueue itself happened inside
      // insertTranscriptWithAsanaJob's transaction (df_e1dcf732 AC8).
      if (inserted) {
        newRows.push(storedRow);
      }
    }
    synced++;
  }

  // st_2fc47782: notify caller of new rows after sync loop completes.
  // Callback is optional; errors must not propagate to the caller.
  if (opts.onNewTranscripts && newRows.length > 0) {
    try {
      await opts.onNewTranscripts(newRows);
    } catch (err) {
      console.warn(`[granola-sync] onNewTranscripts callback error: ${err.message}`);
    }
  }

  console.info(`[granola-sync] synced ${synced} meetings, seeded ${attendeesSeeded} attendees, attributed ${attributed}, queued ${asanaQueued} Asana call tasks (${existingIds.size} already stored, skipped)`);
  return { synced, attributed, asanaQueued };
}
