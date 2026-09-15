/**
 * link-chunk-entities.js
 *
 * Populates chunk_entities by joining chunks → source tables → person_identifiers → people.
 * Idempotent via INSERT OR IGNORE on the (chunk_id, entity_id) PRIMARY KEY.
 *
 * Strategies per source type:
 *
 *   email: chunks.source_id = emails.id → emails.sender_email → person_identifiers
 *          (people.email column doesn't exist — linkage is via person_identifiers.value)
 *          NOTE: emails has no to_addresses column (only sender_email) so we link
 *          sender only. This is the dominant signal anyway (sender is the person you
 *          received communication from or sent to).
 *
 *   calendar: chunks.source_id = calendar_events.id → parse attendees JSON array
 *             → each email → person_identifiers. json_each() is safe in SQLite.
 *
 *   imessage: chunks.source_id = imessages.source_id → imessages.handle
 *             → person_identifiers.value (handles are phone numbers or emails).
 *
 * Usage: ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/ingest/link-chunk-entities.js
 */

import db from '../../lib/db.js';
import { linkCompanyChunkEvidence } from '../../lib/entity-company-evidence.js';
import { linkTimelineChunkEvidence } from '../../lib/entity-source-evidence.js';
import { refreshLinkedEntitySourceTimelineSections } from './07-context.js';

export function linkChunkEntities() {
  let totalInserted = 0;
  const sourceTimelineIds = { person: [], company: [], place: [] };

  // --- Email entity linking ---
  // emails.sender_email → person_identifiers(type='email', value=sender_email)
  // person_identifiers.person_id is the people.id (UUID string)
  // WHY: people table has no direct email column; person_identifiers is the
  // canonical multi-value identity store for all identifier types.
  try {
    const rows = db.prepare(`
      INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, entity_type)
      SELECT DISTINCT
        c.id       AS chunk_id,
        pi.person_id AS entity_id,
        'person'   AS entity_type
      FROM chunks c
      JOIN emails e ON e.id = c.source_id
      JOIN person_identifiers pi
        ON pi.value = e.sender_email
       AND pi.type = 'email'
      WHERE c.source_type = 'email'
        AND e.sender_email IS NOT NULL
        AND e.sender_email != ''
      RETURNING entity_id
    `).all();
    const emailInserted = rows.length;
    sourceTimelineIds.person.push(...rows.map((row) => row.entity_id));
    totalInserted += emailInserted;
    console.log(`[link-chunk-entities] email: ${emailInserted} rows inserted`);
  } catch (err) {
    console.error('[link-chunk-entities] email linking failed:', err.message);
    console.log('[link-chunk-entities] email entity linking skipped');
  }

  // --- Calendar entity linking ---
  // calendar_events.attendees is a JSON array of email strings.
  // json_each() explodes the array; each email maps to a person via person_identifiers.
  try {
    const rows = db.prepare(`
      INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, entity_type)
      SELECT DISTINCT
        c.id         AS chunk_id,
        pi.person_id AS entity_id,
        'person'     AS entity_type
      FROM chunks c
      JOIN calendar_events ce ON ce.id = c.source_id
      JOIN json_each(
        CASE
          WHEN ce.attendees IS NULL OR ce.attendees = '' THEN '[]'
          ELSE ce.attendees
        END
      ) attendee_email
      JOIN person_identifiers pi
        ON pi.value = attendee_email.value
       AND pi.type = 'email'
      WHERE c.source_type = 'calendar'
      RETURNING entity_id
    `).all();
    const calInserted = rows.length;
    sourceTimelineIds.person.push(...rows.map((row) => row.entity_id));
    totalInserted += calInserted;
    console.log(`[link-chunk-entities] calendar: ${calInserted} rows inserted`);
  } catch (err) {
    console.error('[link-chunk-entities] calendar linking failed:', err.message);
    console.log('[link-chunk-entities] calendar entity linking skipped');
  }

  // --- iMessage entity linking ---
  // imessages.source_id matches chunks.source_id exactly.
  // imessages.handle is a phone number (+E.164) or email address.
  // person_identifiers stores both types under type='phone' or type='email'.
  try {
    const rows = db.prepare(`
      INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, entity_type)
      SELECT DISTINCT
        c.id         AS chunk_id,
        pi.person_id AS entity_id,
        'person'     AS entity_type
      FROM chunks c
      JOIN imessages im ON im.source_id = c.source_id
      JOIN person_identifiers pi
        ON pi.value = im.handle
       AND pi.type IN ('phone', 'email')
      WHERE c.source_type = 'imessage'
        AND im.handle IS NOT NULL
        AND im.handle != ''
      RETURNING entity_id
    `).all();
    const imInserted = rows.length;
    sourceTimelineIds.person.push(...rows.map((row) => row.entity_id));
    totalInserted += imInserted;
    console.log(`[link-chunk-entities] imessage: ${imInserted} rows inserted`);
  } catch (err) {
    console.error('[link-chunk-entities] iMessage linking failed:', err.message);
    console.log('[link-chunk-entities] iMessage entity linking skipped');
  }

  // --- FTS phrase-match linking (Partners/Core/Family only) ---
  // WHY: emails table has no to/cc columns (only sender_email). FTS body-text matching
  // is the only mechanism to link email chunks to recipients by full name.
  // Only runs on entities with at least 2-word display names (needs a phrase to match).
  // Uses chunks_fts virtual table (FTS5) rowid → chunks.rowid mapping.
  // INSERT OR IGNORE on (chunk_id, entity_id) PRIMARY KEY keeps it idempotent.
  // Visibility contract — ALL Network-visible people get FTS-linked.
  // st_8c7b7a6b (2026-05-14) widening: original n2 IN ('Partners','Core',
  // 'Family') excluded Network/Acquaintance tiers, leaving 95%+ of
  // entities unlinked. "Find me an email about X with [acquaintance]"
  // came back thin because the entity-linked RAG layer had nothing for
  // anyone outside the inner three tiers. Now everyone with score>0 is
  // linked — matches the visibility rule used across chat-context,
  // network-queries, and the @ picker.
  const ftsEntities = db.prepare(`
    SELECT id, display_name
    FROM people
    WHERE archived = 0
      AND score > 0
      AND display_name LIKE '% %'
      AND display_name NOT LIKE '%@%'
      AND display_name != 'Unknown'
  `).all();

  console.log(`[link-chunk-entities] FTS pass: ${ftsEntities.length} eligible entities`);

  // st_483361e2 — the FTS full-name pass has NO same-name collision guard: it
  // links a chunk to EVERY person sharing a matched name (all three "Paul
  // Hurst"). For casual chat prose that mislinks constantly. Chat chunks
  // (llm_export = imported transcript history, conversation = in-app chat) are
  // therefore excluded here and owned instead by the guarded sweep
  // (lib/chat-entity-linking.js), which routes chat linking through the precise
  // resolveEntitiesFromText recognizer (word-boundary + best-ranked-per-name),
  // so no chat chunk is ever linked to two same-named people. Non-chat sources
  // keep the existing FTS behavior unchanged.
  const chunkLookup = db.prepare(`
    SELECT c.id AS chunk_id
    FROM chunks c
    WHERE c.rowid IN (
      SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?
    )
      AND c.source_type NOT IN ('llm_export', 'conversation')
  `);

  const insertChunkEntity = db.prepare(`
    INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, entity_type)
    VALUES (?, ?, 'person')
  `);

  const newlyLinked = new Set();
  let ftsInserted = 0;

  for (const entity of ftsEntities) {
    try {
      const quoted = `"${entity.display_name.replace(/"/g, '')}"`;
      const hits = chunkLookup.all(quoted);
      if (hits.length === 0) continue;

      const insertTx = db.transaction(() => {
        let count = 0;
        for (const hit of hits) {
          const info = insertChunkEntity.run(hit.chunk_id, entity.id);
          if (info.changes > 0) {
            count++;
            newlyLinked.add(entity.id);
          }
        }
        return count;
      });
      ftsInserted += insertTx();
    } catch (err) {
      // Log and continue — FTS errors on individual entities must not abort the run
      console.error(`[link-chunk-entities] FTS error for ${entity.display_name}: ${err.message}`);
    }
  }

  console.log(`[link-chunk-entities] FTS: ${ftsInserted} rows inserted for ${newlyLinked.size} entities`);

  // Mark entities that received new chunk links as needing context regen
  if (newlyLinked.size > 0) {
    const ids = [...newlyLinked];
    sourceTimelineIds.person.push(...ids);
    console.log(`[link-chunk-entities] person source timelines queued for ${ids.length} FTS-linked entities`);
  }

  totalInserted += ftsInserted;

  try {
    const companies = linkCompanyChunkEvidence(db, { markNeedsRegen: false });
    totalInserted += companies.inserted;
    sourceTimelineIds.company.push(...companies.companyIds);
    console.log(`[link-chunk-entities] company evidence: ${companies.inserted} rows inserted for ${companies.companyIds.length} companies`);
  } catch (err) {
    console.error('[link-chunk-entities] company evidence linking failed:', err.message);
    console.log('[link-chunk-entities] company evidence linking skipped');
  }

  try {
    const generic = linkTimelineChunkEvidence(db, {
      entityTypes: ['company', 'place'],
      markNeedsRegen: false,
    });
    totalInserted += generic.inserted;
    const companyCount = generic.entityIdsByType.company?.length || 0;
    const placeCount = generic.entityIdsByType.place?.length || 0;
    sourceTimelineIds.company.push(...(generic.entityIdsByType.company || []));
    sourceTimelineIds.place.push(...(generic.entityIdsByType.place || []));
    console.log(`[link-chunk-entities] timeline chunk evidence: ${generic.inserted} rows inserted for ${companyCount} companies and ${placeCount} places`);
  } catch (err) {
    console.error('[link-chunk-entities] timeline evidence linking failed:', err.message);
    console.log('[link-chunk-entities] timeline evidence linking skipped');
  }

  const refreshed = refreshLinkedEntitySourceTimelineSections(db, {
    entityIdsByType: sourceTimelineIds,
    markFailures: true,
    log: (message) => console.warn(`[link-chunk-entities] ${message}`),
  });
  const personRefreshed = refreshed.person.updated + refreshed.person.unchanged;
  const companyRefreshed = refreshed.company.updated + refreshed.company.unchanged;
  const placeRefreshed = refreshed.place.updated + refreshed.place.unchanged;
  if (sourceTimelineIds.person.length || sourceTimelineIds.company.length || sourceTimelineIds.place.length) {
    console.log(`[link-chunk-entities] source timelines refreshed for ${personRefreshed} people, ${companyRefreshed} companies, and ${placeRefreshed} places`);
    const marked = refreshed.person.markedFailures + refreshed.company.markedFailures + refreshed.place.markedFailures;
    if (marked) console.log(`[link-chunk-entities] needs_regen=1 set for ${marked} source timeline refresh failures`);
  }

  console.log(`[link-chunk-entities] total: ${totalInserted} rows inserted`);
  return totalInserted;
}

// Run when executed directly (not when imported by run-all.js)
// WHY: import.meta.url is the canonical ESM "is this the entry point?" check
if (process.argv[1] === new URL(import.meta.url).pathname) {
  linkChunkEntities();
}
