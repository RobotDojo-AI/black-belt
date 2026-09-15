/**
 * Entity helpers and DB query wrappers for the followup sweep pipeline.
 *
 * Extracted from lib/followup-sweep.js so that file contains zero db.prepare
 * calls and satisfies the thin-facade check (st_9edac1e6 AC-7 done criterion).
 *
 * All functions here accept `db` as a parameter and handle their own retries.
 */
import { randomBytes } from 'node:crypto';
import { resolvePerson as resolvePersonWB } from './entity-resolve.js';

// ── SQLite busy-retry helper ───────────────────────────────────────────────────

export function withBusyRetry(fn, label) {
  const backoffMs = [50, 150, 400, 1000];
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      const busy = err && (err.code === 'SQLITE_BUSY'
        || (typeof err.message === 'string' && err.message.includes('database is locked')));
      if (!busy || attempt >= backoffMs.length) throw err;
      const waitMs = backoffMs[attempt];
      console.warn(`[followup-entities] SQLITE_BUSY on ${label}, retry ${attempt + 1}/${backoffMs.length} after ${waitMs}ms`);
      Atomics.wait(sleepBuf, 0, 0, waitMs);
    }
  }
}

// ── Entity resolution helpers ──────────────────────────────────────────────────

/**
 * Create or resolve a person entity from transcript extraction output.
 *
 * - With email or phone: delegates to entity-resolve.js resolvePerson (WB path).
 * - Name-only: direct INSERT with p_{timestamp}_{hex} ID.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ name?: string, email?: string, phone?: string }} entity
 * @returns {{ id: string, created: boolean } | null}
 */
export function createOrResolvePerson(db, entity) {
  const { name, email, phone } = entity;
  if (email || phone) {
    const result = resolvePersonWB({ name, email, phone, source: 'transcript' });
    if (result) return { id: result.id || result.personId, created: result.created };
  }
  if (name) {
    const existing = db.prepare(
      `SELECT id FROM people WHERE LOWER(display_name) = LOWER(?) AND archived = 0 LIMIT 1`
    ).get(name);
    if (existing) return { id: existing.id, created: false };
    const id = `p_${Date.now()}_${randomBytes(3).toString('hex')}`;
    withBusyRetry(() => db.prepare(
      `INSERT OR IGNORE INTO people (id, display_name, source_count) VALUES (?, ?, 1)`
    ).run(id, name), `insert person ${id}`);
    return { id, created: true };
  }
  return null;
}

/**
 * Create or resolve a company entity from transcript extraction output.
 *
 * WHY direct INSERT instead of bb/index.js resolveCompany:
 *   _COMPANY_CREATION_SOURCES is Set(['contacts', 'calendar']).
 *   'transcript' is not in the set, so resolveCompany returns null. Direct INSERT
 *   is the defined fallback per the followup-sweep plan failure manifest.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ name?: string, domain?: string }} entity
 * @returns {{ id: string, created: boolean }}
 */
export function createOrResolveCompany(db, entity) {
  const { name, domain } = entity;
  if (domain) {
    const byDomain = db.prepare(
      `SELECT c.id FROM companies c
       JOIN company_domains cd ON cd.company_id = c.id
       WHERE cd.domain = ? LIMIT 1`
    ).get(domain.toLowerCase());
    if (byDomain) return { id: byDomain.id, created: false };
  }
  if (name) {
    const byName = db.prepare(
      `SELECT id FROM companies WHERE LOWER(name) = LOWER(?) LIMIT 1`
    ).get(name);
    if (byName) return { id: byName.id, created: false };
  }
  const id = `co_${Date.now()}_${randomBytes(3).toString('hex')}`;
  withBusyRetry(() => db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, company_type, created_at, updated_at)
     VALUES (?, ?, 'company', datetime('now'), datetime('now'))`
  ).run(id, name || domain || 'Unknown Company'), `insert company ${id}`);
  if (domain) {
    withBusyRetry(() => db.prepare(
      `INSERT OR IGNORE INTO company_domains (company_id, domain) VALUES (?, ?)`
    ).run(id, domain.toLowerCase()), `insert company_domain ${id}`);
  }
  return { id, created: true };
}

// ── Context loaders for runFollowupSweep ──────────────────────────────────────

/**
 * Load all DB context needed for a followup sweep.
 * Returns { skipped, reason } if the person or transcript is not found,
 * or { skipped: false, person, personId, personEmails, transcript, emailContext, iMessageContext }.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} personName
 * @returns {object}
 */
export function loadFollowupContext(db, personName) {
  const person = db.prepare(
    `SELECT p.id, p.display_name
     FROM people p
     WHERE LOWER(p.display_name) = LOWER(?) AND p.archived = 0
     LIMIT 1`
  ).get(personName);
  if (!person) return { skipped: true, reason: `person not found: ${personName}` };

  const personId = person.id;
  const personEmails = db.prepare(
    `SELECT value FROM person_identifiers WHERE person_id = ? AND type = 'email'`
  ).all(personId).map(r => r.value);

  let transcript = null;
  for (const email of personEmails) {
    transcript = db.prepare(
      `SELECT * FROM transcripts
       WHERE attendee_emails LIKE ?
       ORDER BY meeting_date DESC LIMIT 1`
    ).get(`%${email}%`);
    if (transcript) break;
  }
  if (!transcript) {
    transcript = db.prepare(
      `SELECT * FROM transcripts
       WHERE title LIKE ?
       ORDER BY meeting_date DESC LIMIT 1`
    ).get(`%${personName}%`);
  }
  if (!transcript) return { skipped: true, reason: 'no transcript found' };

  let emailContext = '';
  if (personEmails.length > 0) {
    const emailRows = db.prepare(
      `SELECT subject, sender, received_at, snippet
       FROM emails
       WHERE sender_email IN (${personEmails.map(() => '?').join(',')})
         AND is_newsletter = 0
       ORDER BY received_at DESC LIMIT 10`
    ).all(...personEmails);
    if (emailRows.length > 0) {
      emailContext = emailRows.map(e =>
        `${e.received_at}: ${e.subject} — ${e.snippet || ''}`.slice(0, 200)
      ).join('\n');
    }
  }

  let iMessageContext = '';
  const imRows = db.prepare(
    `SELECT handle, date, sent_count, received_count
     FROM imessages WHERE person_id = ? AND is_group = 0
     ORDER BY date DESC LIMIT 20`
  ).all(personId);
  if (imRows.length > 0) {
    const total = imRows.reduce((s, r) => s + (r.sent_count || 0) + (r.received_count || 0), 0);
    iMessageContext = `${imRows.length} iMessage sessions, ${total} total messages.`;
  }

  return { skipped: false, person, personId, personEmails, transcript, emailContext, iMessageContext };
}

/**
 * Load all DB context needed for a company followup sweep.
 * Finds people linked to the company, then the most recent transcript with any of them.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyName
 * @returns {object}
 */
export function loadCompanyFollowupContext(db, companyName) {
  const company = db.prepare(
    `SELECT id, name FROM companies WHERE LOWER(name) = LOWER(?) AND (archived = 0 OR archived IS NULL) LIMIT 1`
  ).get(companyName);
  if (!company) return { skipped: true, reason: `company not found: ${companyName}` };

  const companyId = company.id;

  // Find people linked to this company
  const linkedPeople = db.prepare(
    `SELECT p.id, p.display_name FROM people p WHERE p.company_id = ? AND p.archived = 0`
  ).all(companyId);

  // Also find by work_email_domain if we can derive it from company_domains
  const domainRows = db.prepare(
    `SELECT domain FROM company_domains WHERE company_id = ?`
  ).all(companyId);
  const domains = domainRows.map(r => r.domain);

  let domainPeople = [];
  if (domains.length > 0) {
    domainPeople = db.prepare(
      `SELECT p.id, p.display_name FROM people p
       WHERE p.work_email_domain IN (${domains.map(() => '?').join(',')}) AND p.archived = 0`
    ).all(...domains);
  }

  const allPeopleIds = [...new Set([...linkedPeople, ...domainPeople].map(p => p.id))];
  if (allPeopleIds.length === 0) return { skipped: true, reason: `no people linked to company: ${companyName}` };

  // Collect all known emails for these people
  const allEmails = [];
  for (const pid of allPeopleIds) {
    const emails = db.prepare(
      `SELECT value FROM person_identifiers WHERE person_id = ? AND type = 'email'`
    ).all(pid).map(r => r.value);
    allEmails.push(...emails);
  }

  // Find most recent transcript with any of these attendees
  let transcript = null;
  for (const email of allEmails) {
    transcript = db.prepare(
      `SELECT * FROM transcripts WHERE attendee_emails LIKE ? ORDER BY meeting_date DESC LIMIT 1`
    ).get(`%${email}%`);
    if (transcript) break;
  }
  if (!transcript) return { skipped: true, reason: `no transcript found for company: ${companyName}` };

  // Email context: recent emails from any linked person
  let emailContext = '';
  if (allEmails.length > 0) {
    const emailRows = db.prepare(
      `SELECT subject, sender, received_at, snippet FROM emails
       WHERE sender_email IN (${allEmails.map(() => '?').join(',')}) AND is_newsletter = 0
       ORDER BY received_at DESC LIMIT 10`
    ).all(...allEmails);
    if (emailRows.length > 0) {
      emailContext = emailRows.map(e =>
        `${e.received_at}: ${e.subject} — ${e.snippet || ''}`.slice(0, 200)
      ).join('\n');
    }
  }

  return {
    skipped: false,
    entity: company,
    entityId: companyId,
    entityEmails: allEmails,
    transcript,
    emailContext,
    iMessageContext: '',
  };
}

/**
 * Look up a person's LinkedIn URL by entity ID.
 * @param {import('better-sqlite3').Database} db
 * @param {string} personId
 * @returns {string|null}
 */
export function getPersonLinkedinUrl(db, personId) {
  return db.prepare(`SELECT linkedin_url FROM people WHERE id = ?`).get(personId)?.linkedin_url || null;
}
