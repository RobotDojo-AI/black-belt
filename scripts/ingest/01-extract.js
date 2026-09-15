/**
 * Phase 1 — Extract: snapshot derived data and gather entity candidates.
 *
 * Writes to entity_candidates table. Does NOT resolve — resolve is Phase 2.
 * Sources in priority order: contacts(1), calendar(2), imessage(3), email(4).
 *
 * Email participants are kept even when they are low-information, freemail, or
 * list-mail sourced. Ranking/spend decides whether they receive attention later;
 * extraction does not suppress valid observed email identities.
 *
 * st_87a0d072 Phase 4 changes:
 *   - LinkedIn REMOVED as an extraction source. Now enrichment-only via
 *     lib/entity-enrich.js. parseLinkedInCsv() still exported for that consumer.
 *   - Contacts emit ONE bundle candidate per record (all emails + phones).
 *     Replaces the per-email candidate pattern that thrashed the resolver.
 *   - Email iterates email_participants (sender + To + Cc + Bcc). Replaces
 *     sender-only iteration that threw away every CC/BCC signal.
 *
 * WHY separate phase: separation of concerns — extraction is pure data gathering,
 * resolution is identity matching. Keeping them separate enables auditing and replay.
 */

import crypto from 'crypto';

// LinkedIn CSV path — consumed by lib/entity-enrich.js as profile-overlay
// context during Phase 7/8. NOT used here in Phase 1 Extract (removed as
// extraction source by st_87a0d072 Phase 4). Re-exported so the enrichment
// consumer can read it without re-deriving the path.
import { resolve } from 'path';
import { homedir } from 'os';
export const LINKEDIN_CSV_PATH = resolve(homedir(), 'robotdojo', 'imports', 'linkedin-connections.csv');

/**
 * Parse a LinkedIn connections CSV export into structured records.
 *
 * LinkedIn export format (post-2019):
 *   First Name,Last Name,URL,Email Address,Company,Position,Connected On
 *
 * WHY hand-rolled parser instead of a dep: LinkedIn CSVs are RFC 4180 compliant
 * with quoted fields for names containing commas (e.g. "Narasin, Benjamin").
 * A simple state-machine parser handles this without adding a dependency.
 */
export function parseLinkedInCsv(csvText) {
  const lines = csvText.split('\n');
  // Skip LinkedIn's 3-line preamble ("Notes:...", blank line, "...")
  // The real header row contains "First Name"
  let headerIdx = lines.findIndex(l => l.includes('First Name'));
  if (headerIdx === -1) return [];

  const headers = splitCsvRow(lines[headerIdx]).map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const results = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = splitCsvRow(line);
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx]?.trim() || ''; });
    const firstName = row['first_name'] || '';
    const lastName = row['last_name'] || '';
    if (!firstName && !lastName) continue;
    results.push({
      display_name: [firstName, lastName].filter(Boolean).join(' '),
      email: row['email_address'] || null,
      linkedin_url: row['url'] || null,
      company: row['company'] || null,
      position: row['position'] || null,
      connected_on: row['connected_on'] || null,
    });
  }
  return results;
}

/** Split one CSV row respecting RFC 4180 quoted fields. */
function splitCsvRow(line) {
  const cols = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      cols.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

// WHY lazy imports: calendar-extractor and contacts-extractor prepare SQLite statements
// at module load time. In test environments with :memory: DB those tables don't exist.
// Importing lazily (inside phaseExtract) lets shouldExcludeEmailSender be tested in isolation.
// The lazy pattern is intentional — do NOT move these back to the top level.

export function buildGoogleContactBundle(gc, seenIdentifiers, { normalizeEmail, normalizePhone }) {
  let rawEmails = [];
  let rawPhones = [];
  try { rawEmails = JSON.parse(gc.emails || '[]'); } catch { /* malformed source row */ }
  try { rawPhones = JSON.parse(gc.phones || '[]'); } catch { /* malformed source row */ }

  const emails = [];
  for (const e of rawEmails) {
    const norm = normalizeEmail(e);
    if (norm && !emails.includes(norm)) emails.push(norm);
  }
  const phones = [];
  for (const p of rawPhones) {
    const norm = normalizePhone(p);
    if (norm && !phones.includes(norm)) phones.push(norm);
  }

  const name = gc.display_name?.trim() || null;
  if (emails.length === 0 && phones.length === 0) return null;

  const hasFreshIdentifier = emails.some((e) => !seenIdentifiers.has(`email:${e}`))
    || phones.some((p) => !seenIdentifiers.has(`phone:${p}`));
  if (!hasFreshIdentifier) return null;

  const primaryEmail = emails.find((e) => seenIdentifiers.has(`email:${e}`)) || emails[0] || null;
  const primaryPhone = phones.find((p) => seenIdentifiers.has(`phone:${p}`)) || phones[0] || null;
  const orderedEmails = primaryEmail
    ? [primaryEmail, ...emails.filter((e) => e !== primaryEmail)]
    : emails;
  const orderedPhones = primaryPhone
    ? [primaryPhone, ...phones.filter((p) => p !== primaryPhone)]
    : phones;
  const extras = {};
  if (orderedEmails.length > 1) extras.emails = orderedEmails.slice(1);
  if (orderedPhones.length > 1) extras.phones = orderedPhones.slice(1);

  return {
    name,
    primaryEmail: orderedEmails[0] || null,
    primaryPhone: orderedPhones[0] || null,
    rawLocation: Object.keys(extras).length > 0 ? JSON.stringify(extras) : null,
    emails: orderedEmails,
    phones: orderedPhones,
  };
}

/**
 * Determine whether an email sender row from the emails table should be excluded.
 *
 * WHY exported: tested in isolation by pipeline-extract.test.js. Pure function —
 * no DB calls, no side effects. Takes a row object to keep tests simple.
 *
 * The current entity contract keeps every valid observed email identity.
 * Newsletter/list/freemail signals may rank low later, but extraction should not
 * discard them. This helper now answers only "is this not a valid email row?"
 *
 * @param {{ sender_email: string, is_newsletter: number, list_unsubscribe: string|null }} row
 * @returns {boolean} true = exclude
 */
export function shouldExcludeEmailSender(row) {
  if (!row.sender_email) return true;
  return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(row.sender_email).trim());
}

/**
 * Run Phase 1: snapshot + candidate extraction.
 * @param {Function} log - log callback
 * @returns {{ counts: object }} snapshot counts and candidate counts by source
 */
/**
 * @param {Function} log
 * @param {{ skipSnapshot?: boolean }} opts - skipSnapshot=true when orchestrator already
 *   snapshotted before a hard delete (--reset mode). Avoids overwriting the pre-delete snapshot.
 */
export async function phaseExtract(log, { skipSnapshot = false } = {}) {
  log('\n=== Phase 1: Extract (snapshot + candidates) ===');

  // Lazy-import DB-dependent modules to avoid breaking test environments.
  const [
    { default: db },
    { extractContacts },
    { extractCalendarEntities },
    { snapshot },
  ] = await Promise.all([
    import('../../lib/db.js'),
    import('../../lib/contacts-extractor.js'),
    import('../../lib/calendar-extractor.js'),
    import('../rebuild/phase-00-snapshot.js'),
  ]);

  // 1. Snapshot derived data before any wipe so Phase 3 can restore interactions.
  //    In --reset mode the orchestrator snapshots BEFORE the hard delete and passes
  //    skipSnapshot=true so we don't overwrite the pre-delete snapshot with zeros.
  const snapCounts = skipSnapshot
    ? { interactions: 0, groups: 0, topics: 0, edges: 0 } // already done by orchestrator
    : snapshot(log);

  // 2. Clear stale candidates from previous runs.
  db.exec('DELETE FROM entity_candidates');
  log('  Cleared stale entity_candidates');

  const insertCandidate = db.prepare(`
    INSERT OR IGNORE INTO entity_candidates
      (id, source, source_rank, candidate_type, raw_name, raw_email, raw_phone, raw_location, excluded, exclude_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const counts = { contacts: 0, google_contacts: 0, linkedin: 0, calendar: 0, imessage: 0, email: 0, places: 0, excluded: 0 };

  // E6 (st_f1a40461): track every normalized identifier emitted by the
  // AddressBook source this run so the Google Contacts source can dedupe
  // against it (avoid a second candidate for the same email/phone).
  const addressBookIdentifiers = new Set();

  // ── Source 1: Contacts (rank 1) ──
  // Highest trust — user-provided raw signal (Apple Contacts).
  // st_87a0d072 Phase 4: emit ONE bundle candidate per contact record carrying
  // all of its emails + phones. The resolver (Phase 2) bundles identifiers per
  // person; emitting one-per-email caused thrash where the first email-row
  // created a person and subsequent rows had to re-LINK via email guard.
  // The bundle pattern lets the resolver attach every identifier in a single
  // pass — fewer transactions, deterministic person row.
  try {
    const contacts = extractContacts();
    db.transaction(() => {
      for (const c of contacts) {
        const emails = c.emails || (c.email ? [c.email] : []);
        const phones = c.phones || (c.phone ? [c.phone] : []);

        if (!c.name && emails.length === 0 && phones.length === 0) continue;

        // Pack secondary emails + all phones into raw_location as JSON.
        // raw_email holds the primary email; raw_phone holds the primary
        // phone. WHY repurpose raw_location: entity_candidates schema has no
        // dedicated bundle column; raw_location is unused for person rows.
        // The resolver decodes the JSON and registers each identifier.
        const primaryEmail = emails[0] || null;
        const primaryPhone = phones[0] || null;
        const extras = {};
        if (emails.length > 1) extras.emails = emails.slice(1);
        if (phones.length > 1) extras.phones = phones.slice(1);
        const rawLocation = Object.keys(extras).length > 0 ? JSON.stringify(extras) : null;

        insertCandidate.run(
          crypto.randomUUID(), 'contacts', 1, 'person',
          c.name || null, primaryEmail, primaryPhone, rawLocation, 0, null
        );
        // Record AddressBook identifiers (already normalized by the extractor)
        // so Google Contacts can dedupe against them (E6).
        for (const e of emails) if (e) addressBookIdentifiers.add(`email:${e}`);
        for (const p of phones) if (p) addressBookIdentifiers.add(`phone:${p}`);
        counts.contacts++;
      }
    })();
    log(`  Contacts: ${counts.contacts} bundle candidates`);
  } catch (err) {
    log(`  Contacts: skipped (${err.message})`);
  }

  // ── Source 1a: Google Contacts (rank 1) ──
  // E6 (st_f1a40461): the People-API-synced `google_contacts` table is a
  // user-curated contact source on par with macOS AddressBook. Emit one bundle
  // candidate per row (primary email + primary phone + JSON extras), tagged
  // source='google_contacts' so its contribution is distinct from AddressBook's
  // source='contacts' (AC4 needs a provable, separately-tagged delta). Dedupe
  // each identifier against AddressBook identifiers emitted above so the same
  // person isn't double-extracted; identifier-connected-component merge in
  // Phase 2 still unifies any that DO overlap on a hard identifier.
  try {
    const { normalizeEmail, normalizePhone } = await import('../../lib/entity-resolve.js');
    const gcRows = db.prepare(`
      SELECT display_name, emails, phones FROM google_contacts
    `).all();
    db.transaction(() => {
      for (const gc of gcRows) {
        const bundle = buildGoogleContactBundle(gc, addressBookIdentifiers, { normalizeEmail, normalizePhone });
        if (!bundle) continue;

        insertCandidate.run(
          crypto.randomUUID(), 'google_contacts', 1, 'person',
          bundle.name, bundle.primaryEmail, bundle.primaryPhone, bundle.rawLocation, 0, null
        );
        // Track every identifier after emission so later duplicate Google rows
        // do not re-emit. Do not remove bridge identifiers before resolve:
        // the bridge is what lets Phase 2 attach fresh identifiers to the
        // existing person through hard email/phone evidence.
        for (const e of bundle.emails) addressBookIdentifiers.add(`email:${e}`);
        for (const p of bundle.phones) addressBookIdentifiers.add(`phone:${p}`);
        counts.google_contacts++;
      }
    })();
    log(`  Google Contacts: ${counts.google_contacts} bundle candidates (deduped vs AddressBook)`);
  } catch (err) {
    log(`  Google Contacts: skipped (${err.message})`);
  }

  // ── Source 1b: LinkedIn — REMOVED ──
  // st_87a0d072 Phase 4: LinkedIn is no longer an extraction source. A
  // LinkedIn-only contact (no email, calendar, or iMessage signal) does NOT
  // create a person row. The LinkedIn CSV at LINKEDIN_CSV_PATH is now
  // consumed by lib/entity-enrich.js during context-file generation, where
  // it overlays profile metadata onto an already-resolved person.
  //
  // WHY: people exist in the network because we've actually communicated
  // with them. A LinkedIn connection accepted years ago is not a
  // relationship signal; treating it as one inflated the network with
  // dormant connections. parseLinkedInCsv() and LINKEDIN_CSV_PATH are still
  // exported for the enrichment consumer.

  // ── Source 2: Calendar attendees (rank 2) ──
  // Time allocation = revealed preference. Always included.
  try {
    const calEvents = extractCalendarEntities();
    const seenEmails = new Set();
    db.transaction(() => {
      for (const ev of calEvents) {
        for (const email of ev.attendeeEmails) {
          if (!email || seenEmails.has(email)) continue;
          seenEmails.add(email);
          insertCandidate.run(
            crypto.randomUUID(), 'calendar', 2, 'person',
            null, email, null, null, 0, null
          );
          counts.calendar++;
        }
      }
    })();
    log(`  Calendar: ${counts.calendar} candidates`);
  } catch (err) {
    log(`  Calendar: skipped (${err.message})`);
  }

  // ── Source 2b: Calendar places (place candidates) ──
  // Stored as place candidates (candidate_type='venue' is the DB value), not person candidates.
  try {
    const placeRows = db.prepare(`
      SELECT DISTINCT location FROM calendar_events
      WHERE location IS NOT NULL AND location != '' AND status != 'cancelled'
      LIMIT 5000
    `).all();
    db.transaction(() => {
      for (const row of placeRows) {
        const loc = row.location?.trim();
        if (!loc) continue;
        insertCandidate.run(
          crypto.randomUUID(), 'calendar', 2, 'venue',
          null, null, null, loc, 0, null
        );
        counts.places++;
      }
    })();
    log(`  Calendar places: ${counts.places} place candidates`);
  } catch (err) {
    log(`  Calendar places: skipped (${err.message})`);
  }

  // ── Source 3: iMessage participants (rank 3) — REMOVED ──
  // E5 (st_f1a40461): the chunk-metadata iMessage candidate source is dead —
  // iMessage chunks carry metadata='{}', so json_extract(metadata,'$.participant')
  // is always NULL and this block emitted zero candidates. iMessage identity is
  // now sourced set-based in 03-timeline.js directly from the `imessages` table
  // (handle/handle_kind) joined to person_identifiers. Removing the dead block
  // keeps extraction honest.

  // ── Source 4: Email participants (rank 4) ──
  // st_87a0d072 Phase 4: iterate email_participants (sender + to + cc + bcc)
  // instead of just sender_email. A person you've only CC'd is captured
  // equally with someone who's emailed you directly — both are weak signals
  // but they're real, and the scoring pass weights them differently downstream.
  //
  // Newsletter/list/freemail participants are intentionally included. They are
  // weak signals, but every valid observed email is still a person candidate.
  try {
    // E1 (st_f1a40461): the old form grouped on participant_email while joining
    // email_participants (444K rows) to emails (152K rows) with MAX(e.*) per
    // group. Each of the 444K rows did a by-PK lookup into the 2.3 GB encrypted
    // emails table — 444K random page-faults + decrypts — and never returned
    // in 10+ min. Decompose: scan emails ONCE (sequential, ~5s) into a TEMP
    // TABLE of per-email flags keyed by email_id, then group email_participants
    // joined to that small in-memory table. EXPLAIN: `SCAN ep USING INDEX
    // idx_ep_participant` + PK search on the temp flags (no SCAN of emails).
    // Measured on the live DB: ~5s build + ~2.6s group = ~8s, 16,697 rows.
    // Output columns are identical to the prior query, so the insert loop below
    // is unchanged.
    db.exec('DROP TABLE IF EXISTS _ep_email_flags');
    db.exec(`
      CREATE TEMP TABLE _ep_email_flags (
        email_id      TEXT PRIMARY KEY,
        is_newsletter INTEGER,
        has_unsub     INTEGER,
        sender        TEXT
      )
    `);
    db.exec(`
      INSERT INTO _ep_email_flags (email_id, is_newsletter, has_unsub, sender)
      SELECT id,
             COALESCE(is_newsletter, 0),
             CASE WHEN list_unsubscribe IS NOT NULL THEN 1 ELSE 0 END,
             sender
      FROM emails
    `);
    const participantRows = db.prepare(`
      SELECT
        ep.participant_email,
        MIN(ep.role) AS role,
        MAX(f.is_newsletter) AS is_newsletter,
        MAX(f.has_unsub) AS has_unsub,
        MAX(CASE WHEN ep.role = 'sender' THEN f.sender END) AS sender_display
      FROM email_participants ep
      JOIN _ep_email_flags f ON f.email_id = ep.email_id
      WHERE ep.participant_email IS NOT NULL AND ep.participant_email != ''
      GROUP BY ep.participant_email
    `).all();
    db.exec('DROP TABLE IF EXISTS _ep_email_flags');

    db.transaction(() => {
      for (const row of participantRows) {
        const synthetic = {
          sender_email: row.participant_email,
          is_newsletter: row.is_newsletter,
          list_unsubscribe: row.has_unsub ? '1' : null,
        };
        if (shouldExcludeEmailSender(synthetic)) {
          insertCandidate.run(
            crypto.randomUUID(), 'email', 4, 'person',
            // Display-name is only known for sender; To/Cc/Bcc are raw addresses.
            row.role === 'sender' ? (row.sender_display || null) : null,
            row.participant_email, null, null, 1,
            'invalid_email'
          );
          counts.excluded++;
        } else {
          insertCandidate.run(
            crypto.randomUUID(), 'email', 4, 'person',
            row.role === 'sender' ? (row.sender_display || null) : null,
            row.participant_email, null, null, 0, null
          );
          counts.email++;
        }
      }
    })();
    log(`  Email participants: ${counts.email} included, ${counts.excluded} excluded`);
  } catch (err) {
    log(`  Email: skipped (${err.message})`);
  }

  const total = counts.contacts + counts.calendar + counts.imessage + counts.email + counts.places;
  log(`  Total candidates: ${total} (+ ${counts.excluded} excluded)`);
  return { snap: snapCounts, counts };
}
