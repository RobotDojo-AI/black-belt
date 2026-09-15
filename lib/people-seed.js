/**
 * people-seed.js — universal people interchange + seeding (st_fd14cdd4 AC5/AC6).
 *
 * One deterministic (Tier 0, no LLM) module every people-bearing sync path
 * shares: gmail-sync, outlook-sync, graph-calendar-sync, granola-sync,
 * drop-folder email imports, apple-mail-reader, apple-calls-reader. Email
 * addresses and phone numbers are seeds — they create new people or link
 * known ones via lib/entity-resolve.js resolvePerson (owner directive, AC6).
 *
 * Semantics (gmail-exact, generalized):
 *   - Participants (sender/to/cc/bcc) are ALWAYS recorded into
 *     email_participants — including newsletters and role accounts. The
 *     interchange is evidence; filtering happens at resolution time.
 *   - Seeding (person creation/linking) is guarded:
 *       newsletters never seed          (Gmail's rule, generalized)
 *       role accounts never seed        (entity-resolve blocklist)
 *       short codes never seed          (normalizePhone ≥7-digit guard)
 *       identifier-less records never seed (no email AND no phone → null;
 *         resolvePerson would otherwise create an unmatchable person row)
 *   - Sync-time seeding resolves the strongest identifier (email sender /
 *     calendar attendee / call phone). To/Cc/Bcc reach the graph through the
 *     batch extractor (scripts/ingest/01-extract.js rank 4 reads
 *     email_participants) — that is WHY recording participants for every
 *     source is the load-bearing half of this module.
 *
 * WHY db is a parameter: thin-facade convention `(db, ...params)`. NOTE:
 * lib/entity-resolve.js operates on the singleton lib/db.js connection; in
 * production and in tests (NODE_TEST_CONTEXT → :memory:) the passed db IS
 * that singleton. The parameter keeps statement preparation explicit and
 * testable; it does not redirect entity resolution to a second database.
 */
import { isBlocklistedEmail, normalizeEmail, normalizePhone, resolvePerson } from './entity-resolve.js';

// Prepared-statement cache per database connection. WeakMap so a closed test
// DB does not pin statements.
const stmtCache = new WeakMap();

function stmts(db) {
  let cached = stmtCache.get(db);
  if (cached) return cached;
  // The partial unique index on person_interactions(source_id) is created by
  // lib/imessage.js at import time on the live DB; ensure it here too so
  // INSERT OR IGNORE idempotency never depends on module import order.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_source_unique
      ON person_interactions(source_id)
      WHERE source_id IS NOT NULL
  `);
  cached = {
    insertParticipant: db.prepare(`
      INSERT OR IGNORE INTO email_participants (email_id, participant_email, role)
      VALUES (?, ?, ?)
    `),
    insertInteraction: db.prepare(`
      INSERT OR IGNORE INTO person_interactions
        (person_id, channel, direction, date, source_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
  };
  stmtCache.set(db, cached);
  return cached;
}

/**
 * Seed one person from an email identifier. Returns the resolvePerson result
 * ({ id, personId, created }) or null when guarded out.
 */
export function seedEmailContact(db, { email, name }, { source = 'email', isNewsletter = false } = {}) {
  const normEmail = normalizeEmail(email);
  if (!normEmail || isNewsletter || isBlocklistedEmail(normEmail)) return null;
  return resolvePerson({ name: name || '', email: normEmail, source });
}

/**
 * Seed one person from a phone identifier. normalizePhone rejects <7-digit
 * short codes (2FA senders, carrier codes) — those return null and create
 * nothing. Returns the resolvePerson result or null.
 */
export function seedPhoneContact(db, { phone, name }, { source = 'phone' } = {}) {
  const normPhone = normalizePhone(phone);
  if (!normPhone) return null;
  // Display-name fallback is the phone number itself — honest, and matchable
  // when a named source (contacts) later links the same identifier.
  return resolvePerson({ name: name || normPhone, phone: normPhone, source });
}

/**
 * Record an email's participants into the universal interchange and seed the
 * sender. The single write path for Gmail, Outlook/Graph, drop-folder
 * imports, and the Apple Mail reader.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} emailId — emails.id
 * @param {{ sender?: {email?: string, name?: string}, to?: string[], cc?: string[], bcc?: string[] }} roles
 *   to/cc/bcc are already-parsed address arrays (lib/email.js parseAddressList)
 * @param {{ isNewsletter?: boolean, source?: string }} opts
 * @returns {{ participants: number, seeded: object|null }}
 */
export function recordEmailParticipants(db, emailId, roles = {}, { isNewsletter = false, source = 'email' } = {}) {
  if (!emailId) return { participants: 0, seeded: null };
  const { insertParticipant } = stmts(db);
  let participants = 0;

  const senderEmail = normalizeEmail(roles.sender?.email);
  if (senderEmail) {
    participants += insertParticipant.run(emailId, senderEmail, 'sender').changes;
  }
  for (const [role, list] of [['to', roles.to], ['cc', roles.cc], ['bcc', roles.bcc]]) {
    for (const addr of list || []) {
      const normalized = normalizeEmail(addr);
      if (normalized) participants += insertParticipant.run(emailId, normalized, role).changes;
    }
  }

  const seeded = seedEmailContact(db, { email: senderEmail, name: roles.sender?.name }, { source, isNewsletter });
  return { participants, seeded };
}

/**
 * Seed calendar attendees — parity for every calendar source (Google live
 * since launch at lib/calendar-sync.js:135; Graph gains it via this module).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{email?: string, name?: string, self?: boolean}>} attendees
 * @param {{ source?: string, selfEmail?: string|null }} opts — selfEmail is the
 *   synced mailbox; Graph attendees carry no `self` flag, so the owner's own
 *   address is excluded by comparison (Google rows use the self flag).
 * @returns {{ seeded: number, created: number }}
 */
export function seedCalendarAttendees(db, attendees = [], { source = 'calendar', selfEmail = null } = {}) {
  const normalizedSelf = normalizeEmail(selfEmail);
  let seeded = 0;
  let created = 0;
  for (const attendee of attendees) {
    if (attendee?.self) continue;
    const email = normalizeEmail(attendee?.email);
    if (!email || email === normalizedSelf) continue;
    const result = seedEmailContact(db, { email, name: attendee.name || '' }, { source });
    if (result) {
      seeded++;
      if (result.created) created++;
    }
  }
  return { seeded, created };
}

/**
 * Seed transcript attendees and write one person_interactions row per
 * resolved attendee (channel 'meeting'). Idempotent via the unique
 * source_id `granola:{meetingId}:{email}`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ meetingId: string, date?: string, attendees: Array<{email?: string, name?: string}> }} meeting
 * @param {{ source?: string }} opts
 * @returns {{ seeded: number, created: number, interactions: number }}
 */
export function seedTranscriptAttendees(db, { meetingId, date, attendees = [] }, { source = 'transcript' } = {}) {
  const { insertInteraction } = stmts(db);
  const day = String(date || new Date().toISOString()).slice(0, 10);
  let seeded = 0;
  let created = 0;
  let interactions = 0;
  for (const attendee of attendees) {
    const email = normalizeEmail(attendee?.email);
    if (!email) continue;
    const person = seedEmailContact(db, { email, name: attendee.name || '' }, { source });
    if (!person) continue;
    seeded++;
    if (person.created) created++;
    interactions += insertInteraction.run(
      person.personId,
      'meeting',
      'unknown',
      day,
      `granola:${meetingId}:${email}`,
      JSON.stringify({ source }),
    ).changes;
  }
  return { seeded, created, interactions };
}

/**
 * Seed a call participant and write one person_interactions row (channel
 * 'call'). Idempotent via the unique source_id `call:{callId}`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ callId: string, phone: string, name?: string, direction?: 'incoming'|'outgoing', dateIso?: string }} call
 * @returns {{ personId: string|null, created: boolean, interactions: number }}
 */
export function recordCallInteraction(db, { callId, phone, name, direction, dateIso }) {
  const person = seedPhoneContact(db, { phone, name }, { source: 'call' });
  if (!person) return { personId: null, created: false, interactions: 0 };
  const { insertInteraction } = stmts(db);
  const interactions = insertInteraction.run(
    person.personId,
    'call',
    direction === 'outgoing' ? 'outbound' : 'inbound',
    String(dateIso || new Date().toISOString()).slice(0, 10),
    `call:${callId}`,
    JSON.stringify({ phone: normalizePhone(phone) }),
  ).changes;
  return { personId: person.personId, created: !!person.created, interactions };
}
