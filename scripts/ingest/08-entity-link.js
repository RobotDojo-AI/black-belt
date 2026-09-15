/**
 * Phase 8 — Entity Linking: populate timeline_event_entities.
 *
 * Links every timeline event to the people who participated in it, creating
 * the event → person join table that enables co-occurrence edge computation
 * and entity-scoped timeline queries.
 *
 * WHY three passes: email, iMessage, and calendar have different schemas for
 * finding participant emails/phones. Each pass uses the native column structure
 * of its source table. INSERT OR IGNORE ensures idempotency — safe to re-run.
 *
 * Compute tier: free. All joins are pure SQL against existing tables.
 * No LLM calls. This is structural wiring, not synthesis.
 *
 * Pass A — email (SQL only):
 *   timeline_events JOIN emails ON emails.id = source_id
 *   JOIN person_identifiers ON value = sender_email AND type = 'email'
 *
 * Pass B — iMessage (SQL only):
 *   timeline_events.summary contains E.164 phone number (+1XXXXXXXXXX)
 *   JOIN person_identifiers ON value = summary AND type = 'phone'
 *
 * Pass C — calendar (JS loop):
 *   calendar_events.attendees is a JSON array of email strings
 *   Parse each, lookup in person_identifiers, INSERT OR IGNORE
 */

import { runWithSqliteBusyRetry } from './02-resolve.js';
import { linkCompanyChunkEvidence } from '../../lib/entity-company-evidence.js';
import { linkTimelineChunkEvidence } from '../../lib/entity-source-evidence.js';

/**
 * Phase 8 main: link timeline events to entity participants.
 * @param {Object} db - better-sqlite3 database instance
 * @param {Function} log
 * @returns {{ email: number, imessage: number, calendar: number, companyChunks: number, companyTimeline: number, timelineChunks: number, total: number, linkedPersonIds: string[], linkedCompanyIds: string[], linkedPlaceIds: string[] }}
 */
export async function phaseEntityLink(db, log) {
  log('\n=== Phase 8: Entity linking ===');
  const linkedPersonIds = new Set();
  const linkedCompanyIds = new Set();
  const linkedPlaceIds = new Set();

  // ── Pass A: email events ──────────────────────────────────────────────────
  // Joins timeline_events → emails via emails.id = source_id (confirmed by PRAGMA check).
  // Note: emails.id is the same as emails.thread_id in this dataset — the timeline-wire.js
  // deduplication uses thread_id as the canonical join key.
  const emailRows = await runWithSqliteBusyRetry('entity-link email', () => db.prepare(`
    INSERT OR IGNORE INTO timeline_event_entities (event_id, person_id, role, entity_type, entity_id)
    SELECT te.id, pid.person_id, 'participant', 'person', pid.person_id
    FROM timeline_events te
    JOIN emails e ON e.id = te.source_id
    JOIN person_identifiers pid ON pid.value = LOWER(e.sender_email) AND pid.type = 'email'
    WHERE te.source_type = 'email'
      AND e.sender_email IS NOT NULL
    RETURNING person_id
  `).all(), log);
  for (const row of emailRows) linkedPersonIds.add(row.person_id);
  log(`  Pass A (email): ${emailRows.length} links`);

  // ── Pass B: iMessage events ──────────────────────────────────────────────
  // iMessage timeline_events.summary contains the E.164 phone number of the conversation
  // participant (e.g., "+16072795611"). Match against person_identifiers.type='phone'.
  const imessageRows = await runWithSqliteBusyRetry('entity-link imessage', () => db.prepare(`
    INSERT OR IGNORE INTO timeline_event_entities (event_id, person_id, role, entity_type, entity_id)
    SELECT te.id, pid.person_id, 'participant', 'person', pid.person_id
    FROM timeline_events te
    JOIN person_identifiers pid ON pid.value = te.summary AND pid.type = 'phone'
    WHERE te.source_type = 'imessage'
      AND te.summary IS NOT NULL
    RETURNING person_id
  `).all(), log);
  for (const row of imessageRows) linkedPersonIds.add(row.person_id);
  log(`  Pass B (iMessage): ${imessageRows.length} links`);

  // ── Pass C: calendar events (JS loop for JSON attendees) ─────────────────
  // calendar_events.attendees is a JSON array of email strings.
  // Parse in JS, lookup each in person_identifiers — can't do this in pure SQL.
  const calendarEventRows = db.prepare(`
    SELECT te.id as event_id, ce.attendees
    FROM timeline_events te
    JOIN calendar_events ce ON ce.id = te.source_id
    WHERE te.source_type = 'calendar'
      AND ce.attendees IS NOT NULL
      AND ce.attendees != '[]'
      AND ce.attendees != ''
  `).all();

  const lookupByEmail = db.prepare(
    "SELECT person_id FROM person_identifiers WHERE type='email' AND value=? LIMIT 1"
  );
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO timeline_event_entities (event_id, person_id, role, entity_type, entity_id)
    VALUES (?, ?, 'participant', 'person', ?)
  `);

  const insertCalendarBatch = db.transaction((rows) => {
    let calendarLinks = 0;
    const personIds = [];
    for (const row of rows) {
      let attendees;
      try {
        attendees = JSON.parse(row.attendees);
        if (!Array.isArray(attendees)) continue;
      } catch {
        continue;
      }

      for (const a of attendees) {
        const email = typeof a === 'string' ? a : a?.email;
        if (typeof email !== 'string' || !email.includes('@')) continue;
        const person = lookupByEmail.get(email.toLowerCase());
        if (person) {
          const inserted = insertLink.run(row.event_id, person.person_id, person.person_id);
          if (inserted.changes > 0) {
            personIds.push(person.person_id);
            calendarLinks++;
          }
        }
      }
    }
    return { calendarLinks, personIds };
  });

  const calendarResult = await runWithSqliteBusyRetry(
    'entity-link calendar',
    () => insertCalendarBatch(calendarEventRows),
    log,
  );
  const calendarLinks = calendarResult.calendarLinks || 0;
  for (const personId of calendarResult.personIds || []) linkedPersonIds.add(personId);
  log(`  Pass C (calendar): ${calendarLinks} links (from ${calendarEventRows.length} events)`);

  // ── Pass D: company chunk evidence inherited from resolved people ─────────
  // A company entity should inherit source/RAG evidence from the people resolved
  // to that company. This is deterministic: people.company_id is the resolved
  // affiliation, chunk_entities is the source-backed body evidence.
  let companyChunks = 0;
  if (hasLinkableCompanySchema(db) && tableExists(db, 'chunk_entities')) {
    const result = await runWithSqliteBusyRetry(
      'entity-link company chunks',
      () => linkCompanyChunkEvidence(db, { markNeedsRegen: false }),
      log,
    );
    companyChunks = result.inserted;
    for (const id of result.companyIds) linkedCompanyIds.add(String(id));
  }
  log(`  Pass D (company chunk evidence): ${companyChunks} links`);

  // ── Pass E: company timeline evidence inherited from resolved people ──────
  // timeline_event_entities has a legacy NOT NULL person_id column. For generic
  // company rows we use the existing convention from timeline-schema.js:
  // person_id='company:<id>' and entity_type/entity_id carry the real identity.
  let companyTimeline = 0;
  if (hasLinkableCompanySchema(db) && hasGenericTimelineEntitySchema(db)) {
    const personJoin = hasColumn(db, 'timeline_event_entities', 'entity_id')
      ? `p.id = CASE
          WHEN tee.entity_type = 'person' AND tee.entity_id IS NOT NULL AND tee.entity_id != ''
          THEN CAST(tee.entity_id AS TEXT)
          ELSE tee.person_id
        END`
      : 'p.id = tee.person_id';
    const genericPersonWhere = hasColumn(db, 'timeline_event_entities', 'entity_type')
      ? "AND (tee.entity_type = 'person' OR tee.entity_type IS NULL OR tee.entity_type = '')"
      : '';
    const previousForeignKeys = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
      const rows = await runWithSqliteBusyRetry('entity-link company timeline', () => db.prepare(`
        INSERT OR IGNORE INTO timeline_event_entities (event_id, person_id, role, entity_type, entity_id)
        SELECT DISTINCT tee.event_id, 'company:' || p.company_id, 'affiliated_person', 'company', p.company_id
        FROM timeline_event_entities tee
        JOIN people p ON ${personJoin}
        JOIN companies c ON c.id = p.company_id
        WHERE p.company_id IS NOT NULL
          AND p.company_id != ''
          ${genericPersonWhere}
        RETURNING entity_id
      `).all(), log);
      companyTimeline = rows.length;
      for (const row of rows) linkedCompanyIds.add(String(row.entity_id));
    } finally {
      db.pragma(`foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
    }
  }
  log(`  Pass E (company timeline evidence): ${companyTimeline} links`);

  // ── Pass F: generic timeline → chunk evidence for non-person entities ────
  // If a deterministic timeline event is linked to a company/place and a RAG
  // chunk exists for that same source row, the entity should inherit the chunk
  // as exact source evidence. This is the bridge places were missing.
  let timelineChunks = 0;
  if (hasGenericTimelineEntitySchema(db) && tableExists(db, 'chunk_entities') && tableExists(db, 'chunks')) {
    const result = await runWithSqliteBusyRetry(
      'entity-link generic timeline chunks',
      () => linkTimelineChunkEvidence(db, { entityTypes: ['company', 'place'], markNeedsRegen: false }),
      log,
    );
    timelineChunks = result.inserted;
    for (const id of result.entityIdsByType.company || []) linkedCompanyIds.add(String(id));
    for (const id of result.entityIdsByType.place || []) linkedPlaceIds.add(String(id));
  }
  log(`  Pass F (timeline chunk evidence): ${timelineChunks} links`);

  const total = db.prepare('SELECT COUNT(*) as n FROM timeline_event_entities').get().n;
  log(`  Entity linking complete: ${total} total links in timeline_event_entities`);

  return {
    email: emailRows.length,
    imessage: imessageRows.length,
    calendar: calendarLinks,
    companyChunks,
    companyTimeline,
    timelineChunks,
    total,
    linkedPersonIds: [...linkedPersonIds],
    linkedCompanyIds: [...linkedCompanyIds],
    linkedPlaceIds: [...linkedPlaceIds],
  };
}

function tableExists(db, table) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function hasLinkableCompanySchema(db) {
  return tableExists(db, 'people')
    && tableExists(db, 'companies')
    && hasColumn(db, 'people', 'company_id')
    && hasColumn(db, 'companies', 'id');
}

function hasGenericTimelineEntitySchema(db) {
  return tableExists(db, 'timeline_event_entities')
    && hasColumn(db, 'timeline_event_entities', 'event_id')
    && hasColumn(db, 'timeline_event_entities', 'person_id')
    && hasColumn(db, 'timeline_event_entities', 'role')
    && hasColumn(db, 'timeline_event_entities', 'entity_type')
    && hasColumn(db, 'timeline_event_entities', 'entity_id');
}
