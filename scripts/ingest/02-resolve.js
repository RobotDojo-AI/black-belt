/**
 * Phase 2 — Resolve: match candidates to existing people or create new ones.
 *
 * Stage A (seed-per-identifier):
 *   For each candidate (ordered by source_rank ASC):
 *     - Guard 1:   email exact match  → LINK
 *     - Guard 2:   phone exact match  → LINK
 *     - No match → CREATE for any valid observed email or phone source
 *   Contacts now arrive as BUNDLE candidates (one row carrying primary email +
 *   primary phone + raw_location JSON of secondary emails/phones); the
 *   resolver registers every identifier in a single pass.
 *
 * Identifier merge contract:
 *   People merge only through a connected component of normalized email and
 *   phone identifiers. Names, nicknames, LinkedIn URLs/slugs, company, title,
 *   calendar display names, and other evidence never merge people.
 *
 * WHY binary at Stage A: entity-confidence rule. Hard identifiers only.
 * WHY legacy name merge is not in phaseResolve: name matching is search UX,
 *   not identity evidence. A person can be found by a flexible alias without
 *   collapsing two humans who only share a display-name pattern.
 *
 * WHY exported resolveCandidate: enables unit testing with an injected in-memory DB,
 * avoiding any dependency on the real encrypted DB during test runs.
 */

import crypto from 'crypto';
import { pickBestDisplayName, loadContactsIndex, loadEmailsSenderIndex } from '../../lib/canonical-name.js';
import {
  absorbPersonRecords,
  guardOwnerAbsorb,
  auditRefusedOwnerAnchor,
  auditRefused,
  isMergeForbidden,
  shouldMerge,
  writeMergeTriage,
  writeEmailClassificationReview,
  buildPopularIdentifierSet,
  bumpMergedCardCount,
  resolveSurvivor,
} from '../../lib/people-merge.js';
import { isOwner } from '../../lib/identity.js';
import { normalizeCompanyName } from '../../lib/company-name-normalize.js';
// df_cbd30a5a AC-12: the name tokenizers + nameEncode moved to the leaf module
// lib/identity-matching.js (one source of truth; breaks the require-cycle). This
// file imports + RE-EXPORTS them so its dedup passes below and any external
// caller of these symbols are unchanged (behavior-preserving move).
import {
  loadSurnameSet,
  loadNickCanon,
  nameTokens,
  dropMiddleInitialTokens,
  clusterKey,
  nameEncode,
  isRoleOrGenericEmail,
  classifyEmailAddress,
} from '../../lib/identity-matching.js';
export { nameEncode };

const normalizeEmail = (s) => (typeof s === 'string' ? s.toLowerCase().trim() : null);
const normalizePhone = (s) => {
  if (!s) return null;
  const digits = String(s).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return digits.length >= 7 ? `+${digits}` : null;
};
const FREEMAIL_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'msn.com', 'live.com', 'aol.com', 'comcast.net', 'verizon.net']);
const DEFAULT_RESOLVE_BUSY_RETRY_MS = [1000, 2000, 5000, 10000, 15000];

// Every valid observed email or phone is a person. Weak sources rank low later;
// resolution keeps them so the identity graph remains complete.
const CREATE_ALLOWED_RANKS = new Set([1, 2, 3, 4]); // contacts, calendar, imessage, email

// Free-mail domains — never create a company for these.
// Copied here to keep resolveCandidate self-contained for testing.
const FREEMAIL = FREEMAIL_DOMAINS;

const EDUCATIONAL_TLDS = new Set(['.edu', '.ac.uk', '.edu.au', '.edu.sg', '.ac.jp']);
function isEducationalDomain(d) {
  return d.endsWith('.edu') || EDUCATIONAL_TLDS.has('.' + d.split('.').slice(-1)[0]);
}

const COMPANY_CREATION_SOURCES = new Set(['contacts', 'google_contacts', 'calendar', 'email']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isSqliteBusyError(err) {
  const message = String(err?.message || err?.code || err || '');
  return err?.code === 'SQLITE_BUSY'
    || err?.code === 'SQLITE_LOCKED'
    || /SQLITE_(BUSY|LOCKED)|database is locked|database locked/i.test(message);
}

export async function runWithSqliteBusyRetry(label, fn, log = () => {}, {
  retryMs = DEFAULT_RESOLVE_BUSY_RETRY_MS,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt >= retryMs.length) throw err;
      const waitMs = retryMs[attempt];
      log(`  SQLITE_BUSY during ${label}; retry ${attempt + 1}/${retryMs.length} in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}

/**
 * Resolve a single candidate against the people/identifiers tables.
 *
 * WHY takes `db` as a parameter: allows unit tests to inject an in-memory DB.
 * Production callers pass the real db. This is dependency injection, not optional.
 *
 * st_87a0d072 picker-inline (2026-05-13): accepts `opts.emailsSenderIndex` +
 * `opts.contactsIndex` so pickBestDisplayName can run inline on every CREATE
 * and LINK without per-candidate DB queries against the 350K-row emails table.
 * Without these indexes, the picker is still called but uses the slow per-call
 * DB path (so unit tests without indexes still work). Production callers
 * (phaseResolve below) always pass them.
 *
 * @param {{ id, raw_name, raw_email, raw_phone, source, source_rank }} candidate
 * @param {import('better-sqlite3').Database} db - SQLite db instance
 * @param {{
 *   emailsSenderIndex?: Map<string,string>,
 *   contactsIndex?: { byEmail: Map, byPhone: Map }
 * }} [opts]
 * @returns {{ decision: 'link'|'create'|'discard', guard: string|null, personId: string|null, confidence: number }}
 */
export function resolveCandidate(candidate, db, opts = {}) {
  const email = normalizeEmail(candidate.raw_email);
  const phone = normalizePhone(candidate.raw_phone);
  const name = candidate.raw_name?.trim() || null;
  const source = candidate.source || 'unknown';
  const sourceRank = candidate.source_rank ?? 4;
  // st_87a0d072 Phase 4: contacts source emits a BUNDLE candidate carrying
  // secondary emails + phones in raw_location as JSON. Decode here so the
  // resolver can attach every identifier to the resolved person row.
  let extraEmails = [];
  let extraPhones = [];
  // E6 (st_f1a40461): google_contacts emits the same bundle shape as contacts
  // (secondary emails/phones packed into raw_location as JSON). Decode both.
  if ((source === 'contacts' || source === 'google_contacts') && candidate.raw_location) {
    try {
      const extras = JSON.parse(candidate.raw_location);
      extraEmails = (extras.emails || []).map(normalizeEmail).filter(Boolean);
      extraPhones = (extras.phones || []).map(normalizePhone).filter(Boolean);
    } catch { /* malformed bundle — ignore, primary still attaches */ }
  }

  // Role/generic email guard (resolver hardening): a role/generic email (info@,
  // investors@, no-reply@, an ESP/notification-domain address, or a machine-
  // generated local) is NEVER a person's identifier. Compute the USABLE (personal)
  // email set so a role email can neither bridge a LINK (Guard 1) nor stand alone
  // as the reason to CREATE a person. attachIdentifierOrMerge refuses the physical
  // attach EVEN WHEN it collides with an existing holder (the "EVEN IF matched"
  // rule), so a role email is never inserted on any path.
  const emailIsRole = email ? isRoleOrGenericEmail(email) : false;
  const usableEmail = emailIsRole ? null : email;
  const usableExtraEmails = extraEmails.filter((e) => !isRoleOrGenericEmail(e));
  // The candidate's only/primary identifier is a role email and it carries no
  // other real identifier → it is not a person; do not create a row for it.
  const onlySignalIsRoleEmail =
    emailIsRole && !phone && usableExtraEmails.length === 0 && extraPhones.length === 0;

  // df_cbd30a5a AC-12: the candidate's full normalized identifier set. Threaded
  // into the merge gate so a bundle bridging A→B via TWO distinct values is
  // recognised as an independent second corroborating link (global identifier
  // uniqueness means two active records never share a STORED value, so the
  // corroboration lives on the incoming candidate, not the two records). Role
  // emails are excluded — they are never a bridge nor corroboration.
  const candidateValues = [usableEmail, phone, ...usableExtraEmails, ...extraPhones]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());
  const attachOpts = { ...opts, candidateValues };

  let decision = null;
  let guard = null;
  let personId = null;
  let confidence = 0;
  let evidence = null;

  // Guard 1: Email exact match — a role/generic email is never a bridge, so match
  // only on the usable (personal) email.
  if (!decision && usableEmail) {
    const row = db.prepare(`
      SELECT pi.person_id
      FROM person_identifiers pi
      JOIN people p ON p.id = pi.person_id
      WHERE pi.type='email' AND pi.value=? AND COALESCE(p.archived, 0) = 0
      LIMIT 1
    `).get(usableEmail);
    if (row) {
      decision = 'link';
      guard = '1-email';
      personId = row.person_id;
      confidence = 1.0;
      evidence = usableEmail;
    }
  }

  // Guard 2: Phone exact match
  if (!decision && phone) {
    const row = db.prepare(`
      SELECT pi.person_id
      FROM person_identifiers pi
      JOIN people p ON p.id = pi.person_id
      WHERE pi.type='phone' AND pi.value=? AND COALESCE(p.archived, 0) = 0
      LIMIT 1
    `).get(phone);
    if (row) {
      decision = 'link';
      guard = '2-phone';
      personId = row.person_id;
      confidence = 1.0;
      evidence = phone;
    }
  }

  // Guard 2b: ARCHIVED-HOLDER RECOVERY (df_19c11899).
  //
  // THE BUG THIS FIXES. Guards 1 and 2 above filter `COALESCE(p.archived,0)=0`,
  // but the uniqueness constraint behind them — idx_pid_unique_non_name on
  // (type, value) — is GLOBAL and does not. So an identifier held by an ARCHIVED
  // person is invisible to the guards yet still reserved. The old flow was:
  // guard misses -> create branch fires -> attachIdentifierOrMerge's
  // `INSERT OR IGNORE` silently drops the identifier against the global index ->
  // the new person is left with ZERO identifiers -> 06-archive.js archives it on
  // the same run -> 01-extract.js re-emits the same candidate 15 minutes later
  // and the whole thing repeats. Measured: 610,967 of 646,223 people rows had
  // zero identifiers, sharing only 20,476 distinct names (~30 copies each), with
  // 34,789 fresh ghosts forecast per completed run.
  //
  // THE FIX. Before conceding to create, look the identifier up WITHOUT the
  // archived filter. If an archived holder exists it is the rightful owner:
  // follow any merge forwarding (the holder may itself be a merge loser), then
  // un-archive and link instead of minting a duplicate that cannot keep its own
  // identifier. This closes the loop at its source — the create branch is no
  // longer reachable for an identifier that is already spoken for.
  if (!decision && (usableEmail || phone)) {
    // Email before phone, matching the precedence guards 1 and 2 establish.
    // A single OR'd lookup with LIMIT 1 would let SQLite's plan decide which
    // holder wins when a candidate's email and phone belong to two different
    // archived people -- and that choice also decides which row gets revived.
    const findArchivedHolder = db.prepare(`
      SELECT pi.person_id, pi.type
      FROM person_identifiers pi
      JOIN people p ON p.id = pi.person_id
      WHERE pi.type = ? AND pi.value = ?
        AND COALESCE(p.archived, 0) = 1
      LIMIT 1
    `);
    const archivedHolder = (usableEmail ? findArchivedHolder.get('email', usableEmail) : null)
      || (phone ? findArchivedHolder.get('phone', phone) : null);

    if (archivedHolder?.person_id) {
      // The archived holder may itself have been merged away; forward to the
      // surviving record so we never resurrect a loser.
      let survivor = archivedHolder.person_id;
      try {
        const forwarded = resolveSurvivor(db, archivedHolder.person_id);
        if (forwarded) survivor = forwarded;
      } catch { /* forwarding unavailable — fall back to the holder itself */ }

      // Owner-decided bound (df_19c11899). LINKING is unconditional -- that is
      // what stops the duplicate, and it must happen for every archived holder.
      // REVIVING is not: only a record with real standing returns to the active
      // graph, mirroring the archive passes' own contract (anyone with ANY
      // interaction survives, a verified person is kept, an owner tier pin is
      // kept). Without this split, recovery would un-archive all ~30,524 archived
      // email holders when only 13,123 have any interaction history -- silently
      // returning ~17,400 empty records to the graph.
      //
      // The standing check runs on the SURVIVOR, not the holder we matched:
      // resolveSurvivor may forward to a different row, and that row is the one
      // that would become visible.
      const survivorRow = db.prepare(
        'SELECT COALESCE(archived,0) AS a, COALESCE(interaction_count,0) AS ic, COALESCE(verified,0) AS v, tier_override AS t FROM people WHERE id = ?',
      ).get(survivor);
      if (survivorRow?.a === 1 && (survivorRow.ic > 0 || survivorRow.v === 1 || survivorRow.t !== null)) {
        db.prepare("UPDATE people SET archived = 0, updated_at = datetime('now') WHERE id = ?").run(survivor);
      }

      decision = 'link';
      guard = archivedHolder.type === 'phone' ? '2b-phone-archived' : '2b-email-archived';
      personId = survivor;
      confidence = 1.0;
      evidence = archivedHolder.type === 'phone' ? phone : usableEmail;
    }
  }

  // No match — CREATE (high-trust sources) or DISCARD (email headers / role email)
  if (!decision) {
    if (source === 'linkedin' || !CREATE_ALLOWED_RANKS.has(sourceRank)) {
      decision = 'discard';
      guard = null;
      confidence = 0;
    } else if (onlySignalIsRoleEmail) {
      // The candidate's only/primary identifier is a role/generic email — it is
      // not a person. Do not create a row for it (mirrors the legacy resolver's
      // isBlocklistedEmail early-return). Audited via the discard row below.
      decision = 'discard';
      guard = 'role-generic-email';
      confidence = 0;
    } else {
      // Create a new person record
      const newId = crypto.randomUUID();
      const displayName = (name && !name.includes('@')) ? name : (usableEmail || phone || 'Unknown');
      const sourceConf = { contacts: 1.0, google_contacts: 1.0, calendar: 0.9, imessage: 0.85, email: 0.6, unknown: 0.5 }[source] || 0.5;

      // Resolve company from email domain (contacts/calendar sources only) — a
      // role email's domain is never used to seed the person's company here.
      let companyId = null;
      if (usableEmail && COMPANY_CREATION_SOURCES.has(source)) {
        const domain = usableEmail.split('@')[1]?.toLowerCase();
        if (domain && !FREEMAIL.has(domain)) {
          companyId = resolveCompany(domain, source, db);
        }
      }

      db.prepare(`
        INSERT INTO people (id, display_name, company_id, tier, confidence, source_count, primary_source, created_at, updated_at)
        VALUES (?, ?, ?, 'acquaintance', ?, 1, ?, datetime('now'), datetime('now'))
      `).run(newId, displayName, companyId, sourceConf, source);

      if (email) attachIdentifierOrMerge(db, newId, 'email', email, source, 1, attachOpts);
      if (phone) attachIdentifierOrMerge(db, newId, 'phone', phone, source, 0, attachOpts);
      if (name) db.prepare("INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source, is_primary) VALUES (?, 'name', ?, ?, 0)").run(newId, name.toLowerCase(), source);
      for (const e of extraEmails) attachIdentifierOrMerge(db, newId, 'email', e, source, 0, attachOpts);
      for (const p of extraPhones) attachIdentifierOrMerge(db, newId, 'phone', p, source, 0, attachOpts);

      decision = 'create';
      personId = newId;
      confidence = sourceConf;
    }
  } else if (decision === 'link') {
    // Add new identifiers to the matched person
    try {
      if (email) attachIdentifierOrMerge(db, personId, 'email', email, source, 0, attachOpts);
      if (phone) attachIdentifierOrMerge(db, personId, 'phone', phone, source, 0, attachOpts);
      if (name) db.prepare("INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source, is_primary) VALUES (?, 'name', ?, ?, 0)").run(personId, name.toLowerCase(), source);
      for (const e of extraEmails) attachIdentifierOrMerge(db, personId, 'email', e, source, 0, attachOpts);
      for (const p of extraPhones) attachIdentifierOrMerge(db, personId, 'phone', p, source, 0, attachOpts);
    } catch { /* ignore duplicate identifier errors */ }
    // Bump source count + confidence
    const sourceConf = { contacts: 1.0, google_contacts: 1.0, calendar: 0.9, imessage: 0.85, email: 0.6, unknown: 0.5 }[source] || 0.5;
    try {
      db.prepare("UPDATE people SET source_count = source_count + 1, confidence = MAX(confidence, ?), updated_at = datetime('now') WHERE id = ?").run(sourceConf, personId);
    } catch { /* ignore if column doesn't exist */ }
  }

  // st_87a0d072 picker-inline (2026-05-13): after every CREATE or LINK, the
  // surviving person row's identifier set may have changed. Re-pick the best
  // display name across ALL identifiers using the score-based picker, so the
  // canonical-name upgrade happens IN the live pipeline — not as a slow
  // standalone backfill afterwards.
  //
  // WHY here (after both branches): runs once per candidate regardless of
  // CREATE vs LINK. Cost per call is O(identifiers × Map lookups) — typically
  // microseconds because emailsSenderIndex + contactsIndex are pre-loaded
  // Maps passed via opts. Total Phase 2 cost increases by single-digit
  // seconds for ~10K candidates.
  //
  // WHY skip on discard: no person row to update.
  //
  // WHY non-fatal try/catch: a picker failure must not break candidate
  // resolution (the CREATE/LINK has already committed identifiers + audit
  // is about to write).
  //
  // Owner name-lock (df_cbd30a5a): the declared owner's display name is pinned
  // and never overwritten by the token-count picker — the picker is
  // owner-blind and once scored a friend's full name over the owner's on the
  // welded record.
  if (decision !== 'discard' && personId && !isOwner(personId)) {
    try {
      const allIdentifiers = db.prepare(
        "SELECT type, value FROM person_identifiers WHERE person_id = ?"
      ).all(personId);
      const personRow = db.prepare(
        "SELECT id, display_name, linkedin_url FROM people WHERE id = ?"
      ).get(personId);
      if (personRow) {
        const bestName = pickBestDisplayName(personRow, allIdentifiers, db, {
          emailsSenderIndex: opts.emailsSenderIndex,
          contactsIndex: opts.contactsIndex,
        });
        if (bestName && bestName !== personRow.display_name) {
          db.prepare("UPDATE people SET display_name = ?, updated_at = datetime('now') WHERE id = ?")
            .run(bestName, personId);
        }
      }
    } catch { /* canonical-name failure is non-fatal — candidate already resolved */ }
  }

  // Write audit record
  try {
    db.prepare(`
      INSERT INTO resolve_audit (candidate_id, entity_type, decision, guard, confidence, evidence, source, person_id)
      VALUES (?, 'person', ?, ?, ?, ?, ?, ?)
    `).run(candidate.id || null, decision, guard, confidence, evidence, source, personId);
  } catch { /* audit table may not exist in test environments that skip it */ }

  // Update resolved_id on candidate
  if (candidate.id) {
    try {
      db.prepare("UPDATE entity_candidates SET resolved_id=? WHERE id=?").run(personId, candidate.id);
    } catch { /* ignore */ }
  }

  return { decision, guard, personId, confidence, evidence };
}

/**
 * Resolve or create a company for a given domain.
 * WHY inline here: avoids importing person-resolver which has side-effect DB prep.
 */
function resolveCompany(domain, source, db) {
  const existing = db.prepare("SELECT company_id FROM company_domains WHERE domain=? LIMIT 1").get(domain);
  if (existing) return existing.company_id;

  const companyId = crypto.randomUUID();
  // st_93fddaf0 Phase 8: normalize the domain-derived name through the
  // Openprise pipeline + brand-alias lookup at creation time. The previous
  // logic produced ugly compound names — domain-stripped, single-token,
  // title-cased only at position 0. normalizeCompanyName handles the alias
  // map first then the 9-rule pipeline.
  const rawName = domain.replace(/\.(com|org|net|io|co|ai|xyz|dev|edu)$/i, '')
    .split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const name = normalizeCompanyName(rawName) || rawName;
  const companyType = isEducationalDomain(domain) ? 'school' : 'company';

  db.prepare("INSERT OR IGNORE INTO companies (id, name, company_type, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))").run(companyId, name, companyType);
  db.prepare("INSERT OR IGNORE INTO company_domains (company_id, domain) VALUES (?, ?)").run(companyId, domain);
  return companyId;
}

/**
 * Attach an identifier to a person. If that normalized email/phone is already
 * owned by another active person, merge that owner into this person instead.
 *
 * WHY this is the transitive merge point: contacts can arrive as bundles
 * (primary email + extra phones/emails). A bundle may link by one identifier
 * while another identifier belongs to a second existing row. That is exactly
 * the A shares email with B, B shares phone with C case, and email/phone
 * connected components are the only allowed merge evidence.
 */
// df_19c11899: exported for the same reason resolveCandidate is (see this file's
// header) — it lets tests inject an in-memory DB and assert the reserved-identifier
// audit path directly. The silent INSERT OR IGNORE inside this function is what
// hid the ghost loop for six weeks; it needs a test that calls it, not a grep.
export function attachIdentifierOrMerge(db, personId, type, value, source, isPrimary = 0, opts = {}) {
  const normalized = type === 'email' ? normalizeEmail(value) : type === 'phone' ? normalizePhone(value) : value;
  if (!normalized) return personId;

  // Email classifier (resolver hardening) — THE "EVEN IF matched" site. Three-way:
  //   'role'      → never a person's identifier; refuse to attach it to ANY person,
  //                 even when it collides with an existing holder (the collision is
  //                 itself the data error the owner flagged). Audited, no attach.
  //   'uncertain' → the deterministic rules can't settle it; ALLOW the attach but
  //                 enqueue it for the later LLM adjudication tier (no LLM here).
  //   'person'    → normal personal email; attach normally (no behavior change).
  if (type === 'email') {
    const verdict = classifyEmailAddress(normalized);
    if (verdict === 'role') {
      auditRefused(db, personId, '', 'role-generic-email', normalized, 'role-generic-email');
      return personId;
    }
    if (verdict === 'uncertain') {
      writeEmailClassificationReview(db, personId, normalized, { reason: 'uncertain-email', source: 'resolve' });
      // fall through — uncertain is allowed to attach.
    }
  }

  if (type === 'email' || type === 'phone') {
    const owner = db.prepare(`
      SELECT pi.person_id
      FROM person_identifiers pi
      JOIN people p ON p.id = pi.person_id
      WHERE pi.type = ? AND pi.value = ? AND COALESCE(p.archived, 0) = 0
      LIMIT 1
    `).get(type, normalized);
    if (owner?.person_id && owner.person_id !== personId) {
      // Owner-anchor guard (df_cbd30a5a) — THE exact site the transitive-email
      // bridge fired. When the record being attached to (personId) is
      // owner-identified and the current holder of this identifier is a FOREIGN
      // established person, refuse: do not merge, do not attach the foreign
      // identifier to the owner. The colliding value is passed so the guard can
      // still allow owner SELF-dedup (an owner's own address as the bridge).
      const refusal = guardOwnerAbsorb(db, personId, owner.person_id, {
        collidingValue: normalized,
        collidingType: type,
      });
      if (refusal.refuse && refusal.reason === 'refused-owner-anchor') {
        auditRefusedOwnerAnchor(db, personId, owner.person_id, normalized);
        return personId; // foreign identifier is NOT attached to the owner
      }
      // Durable must-not-merge veto (df_cbd30a5a AC-10) — THE same site the
      // owner guard hooks, so a general (non-owner) split cannot re-weld here
      // via this shared identifier. Refuse: do not attach, do not merge; write
      // a must-not-merge audit row (the durable negative assertion is auditable).
      if (isMergeForbidden(db, personId, owner.person_id)) {
        auditRefused(db, personId, owner.person_id, 'must-not-merge', normalized, 'must-not-merge');
        return personId;
      }
      // Precision merge gate (df_cbd30a5a AC-12) — THE born-here site. The
      // unconditional transitive merge was the bug: any shared hard identifier
      // fused two people. shouldMerge requires a shared NON-popular identifier
      // AND corroboration (maiden-aware name agreement or an independent 2nd
      // shared identifier) AND union name-coherence, and diverts every uncertain
      // case to the async triage queue instead of guessing on the critical path.
      const guardToken = type === 'email' ? 'A-transitive-email' : 'A-transitive-phone';
      const verdict = shouldMerge(db, personId, owner.person_id, {
        bridgeType: type,
        bridgeValue: normalized,
        popularSet: opts.popularSet,
        mergedCardCounts: opts.mergedCardCounts,
        candidateValues: opts.candidateValues,
      });
      if (verdict.decision === 'merge') {
        mergeInto(db, personId, owner.person_id, guardToken, opts);
        bumpMergedCardCount(opts.mergedCardCounts, personId);
        return personId;
      }
      // keep-separate / triage: the colliding hard identifier physically stays on
      // its current holder (person_identifiers has UNIQUE(type,value) for
      // email/phone), so the candidate simply does not receive it. On a triage
      // verdict, record the reviewable pair; always leave an audit trail.
      if (verdict.triage) {
        writeMergeTriage(db, personId, owner.person_id, { ...verdict.triage, bridgeType: type, bridgeValue: normalized });
      }
      auditRefused(db, personId, owner.person_id, verdict.guard, normalized, 'should-merge');
      return personId;
    }
  }

  // df_19c11899 — this INSERT OR IGNORE was the silent half of the ghost loop.
  // idx_pid_unique_non_name is global over (type, value) and does NOT exclude
  // archived holders, so an identifier already reserved by an archived person
  // was dropped here with no error, no audit and no log — leaving the person we
  // just created with zero identifiers and guaranteeing it would be archived and
  // re-created on the next run. Guard 2b now prevents that create from happening
  // at all, but a silent drop must never be possible again: if the row did not
  // land, say so. Audited (not thrown) because a genuine benign duplicate — the
  // same identifier attached twice in one pass — also lands here.
  const ins = db.prepare(`
    INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source, is_primary)
    VALUES (?, ?, ?, ?, ?)
  `).run(personId, type, normalized, source, isPrimary);

  if (ins.changes === 0 && type !== 'name') {
    const holder = db.prepare(
      'SELECT person_id FROM person_identifiers WHERE type = ? AND value = ? LIMIT 1',
    ).get(type, normalized);
    if (holder?.person_id && holder.person_id !== personId) {
      try {
        db.prepare(`
          INSERT INTO resolve_audit (candidate_id, entity_type, decision, guard, confidence, evidence, source, person_id, created_at)
          VALUES (?, 'person', 'skip', 'identifier-reserved', 0, ?, ?, ?, datetime('now'))
        `).run(personId, normalized, source, holder.person_id);
      } catch { /* audit is best-effort; never fail resolution on a log write */ }
    }
  }
  return personId;
}

// ── Dedup helpers (st_f1a40461) ───────────────────────────────────────────
// loadSurnameSet, loadNickCanon, nameTokens, dropMiddleInitialTokens, clusterKey,
// and nameEncode moved to lib/identity-matching.js (df_cbd30a5a AC-12) and are
// imported + re-exported at the top of this file. The dedup passes below call
// the imported names unchanged.

const AMBIGUOUS_SINGLE_TOKEN_NAMES = new Set([
  'alex', 'alexander', 'alice', 'alison', 'allison', 'amanda', 'amelia',
  'andrew', 'andy', 'anna', 'anne', 'anthony', 'ashley', 'ben', 'beth', 'bill',
  'bob', 'brad', 'brian', 'bruce', 'carol', 'charlie', 'chris', 'christian',
  'christopher', 'dan', 'dave', 'david', 'debbie', 'derek', 'ed', 'eric',
  'erin', 'frank', 'george', 'greg', 'hani', 'james', 'jane', 'jason', 'jeff',
  'jennifer', 'jenny', 'jeremy', 'jesse', 'jim', 'joe', 'john', 'jon',
  'jonathan', 'jordan', 'joseph', 'josh', 'julia', 'justin', 'kasia', 'kate',
  'katie', 'kevin', 'lauren', 'leanna', 'lisa', 'mark', 'matt', 'matthew',
  'michael', 'mike', 'nick', 'nicole', 'oren', 'paul', 'peter', 'pin', 'rich',
  'rob', 'robert', 'roman', 'ryan', 'sam', 'sarah', 'scott', 'steve', 'tom',
  'will', 'william',
]);

const GENERIC_SINGLE_TOKEN_NAMES = new Set([
  'account', 'accounts', 'admin', 'alert', 'appleid', 'billing', 'calendar',
  'claim', 'client', 'concierge', 'contact', 'customer', 'customerservice',
  'discover', 'donotreply', 'email', 'events', 'feedback', 'hello', 'help',
  'info', 'invoice', 'leadership', 'marketing', 'news', 'notification',
  'office', 'orders', 'payment', 'pin', 'qbepay', 'receipt', 'sales',
  'security', 'service', 'support', 'team', 'ticket', 'travel', 'updates',
  'welcome', 'workspace',
]);

function compactEmailLocalKey(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim();
  if (!/^[A-Z][A-Za-z]{4,}$/.test(cleaned)) return null;
  const key = cleaned.toLowerCase();
  if (AMBIGUOUS_SINGLE_TOKEN_NAMES.has(key)) return null;
  if (GENERIC_SINGLE_TOKEN_NAMES.has(key)) return null;
  return key;
}

function emailLocalCompactKey(email) {
  const raw = String(email || '').toLowerCase();
  if (!raw.includes('@')) return null;
  const local = raw.split('@')[0].split('+')[0];
  const compact = local
    .replace(/^\d+/, '')
    .replace(/\d+$/, '')
    .replace(/[^a-z]/g, '');
  return compact || null;
}

// nameEncode moved to lib/identity-matching.js (df_cbd30a5a AC-12); imported +
// re-exported at the top of this file.

function emailStronglyEncodesFullName(email, firstTok, lastTok) {
  if (!email || !firstTok || !lastTok || lastTok.length < 3) return false;
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  if (!local) return false;
  return local.includes(lastTok) || local.includes(firstTok[0] + lastTok);
}

/**
 * firstNameCommonness(firstTok, db): COUNT(DISTINCT surname) among all people
 * (active OR archived) whose first token = firstTok. "John" pairs with ~100
 * surnames (common); "Sam" with ~2 (distinctive). Computed from the live graph
 * — no config. Cached per pass via the passed Map.
 */
function buildFirstNameCommonness(db) {
  const m = new Map(); // first → Set(surname)
  const rows = db.prepare('SELECT display_name FROM people WHERE display_name IS NOT NULL').all();
  for (const r of rows) {
    const t = nameTokens(r.display_name);
    if (t.length < 2) continue;
    const f = t[0], last = t[t.length - 1];
    if (!m.has(f)) m.set(f, new Set());
    m.get(f).add(last);
  }
  const out = new Map();
  for (const [f, set] of m) out.set(f, set.size);
  return out;
}

/**
 * mergePeoplePass — legacy guarded same-named-person dedup (st_f1a40461).
 *
 * Not called by phaseResolve. The live resolver's identity contract is hard-ID
 * connected components only: normalized email + phone.
 *
 * Clusters people by exact nickname-canonicalized normalized full name (≥2
 * tokens). For each cluster, picks the richest anchor and merges each member
 * into it IFF a STRONG guard holds and no VETO fires:
 *
 *   STRONG (any one):
 *     G1 shared identifier (already an identifier-connected component)
 *     G2 uncommon surname (not in config/surnames-top-25K.json)
 *     G3 BOTH member and anchor emails nameEncode the shared full name
 *     G4 member & anchor share ≥1 calendar_event or email thread_id
 *   DOWNGRADE: surname common AND firstNameCommonness(first) ≥ 40 → G3 alone
 *     is NOT enough; require G1 or G4.
 *   VETO: the two rows carry DIFFERENT phone numbers → never merge.
 *   AMBIGUOUS: name matches but no STRONG guard (or downgraded w/o G1/G4) →
 *     keep separate, log decision='skip', guard='ambiguous'.
 *
 * The Cluster key alone keeps distinct same-FIRST-name people (Sam Rivera vs
 * Sam Okafor) in separate clusters — they never compare.
 */
export function mergePeoplePass(db, log = () => {}, opts = {}) {
  const stats = { merged: 0, clusters: 0, skipped: 0, vetoed: 0,
                  byGuard: { G1: 0, G2: 0, G3: 0, G4: 0 } };

  // Guard against a missing audit/people table in minimal test DBs.
  let people;
  try {
    people = db.prepare(`
      SELECT id, display_name, COALESCE(archived, 0) AS archived
      FROM people WHERE display_name IS NOT NULL
    `).all();
  } catch {
    return { merged: 0, identifier: 0, fullName: 0, nickname: 0 };
  }

  const surnames = loadSurnameSet();
  const commonness = buildFirstNameCommonness(db);

  // Group rows by cluster key.
  const clusters = new Map();
  for (const p of people) {
    const key = clusterKey(p.display_name);
    if (!key) continue;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(p);
  }

  // Per-person feature loaders (memoized).
  const featCache = new Map();
  const features = (id) => {
    if (featCache.has(id)) return featCache.get(id);
    const emails = db.prepare("SELECT value FROM person_identifiers WHERE person_id=? AND type='email'").all(id).map(r => r.value);
    const phones = db.prepare("SELECT value FROM person_identifiers WHERE person_id=? AND type='phone'").all(id).map(r => r.value);
    let chunks = 0;
    try { chunks = db.prepare("SELECT COUNT(*) n FROM chunk_entities WHERE entity_id=? AND entity_type='person'").get(id).n; } catch { /* table absent */ }
    const idCount = emails.length + phones.length;
    const f = { emails, phones: new Set(phones), chunks, idCount };
    featCache.set(id, f);
    return f;
  };

  // Co-occurrence (G4): shared email thread_id or calendar_event.
  // PERF (st_f1a40461): precompute membership maps ONCE rather than running an
  // emails self-join + unindexed calendar LIKE scan per candidate pair (which
  // was the same O(n^2) shape as the E2 hang and stalled the run for minutes on
  // large common-surname clusters). One pass each, then in-memory set intersection.
  const threadsByEmail = new Map(); // lowerEmail -> Set(thread_id)
  try {
    for (const r of db.prepare("SELECT LOWER(sender_email) e, thread_id t FROM emails WHERE sender_email IS NOT NULL AND thread_id IS NOT NULL").all()) {
      let s = threadsByEmail.get(r.e); if (!s) { s = new Set(); threadsByEmail.set(r.e, s); }
      s.add(r.t);
    }
  } catch { /* emails table absent */ }
  const eventsByEmail = new Map(); // lowerEmail -> Set(event_id)
  try {
    const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g;
    for (const r of db.prepare("SELECT id, attendees FROM calendar_events WHERE attendees IS NOT NULL").all()) {
      const found = String(r.attendees).toLowerCase().match(EMAIL_RE);
      if (!found) continue;
      for (const e of new Set(found)) {
        let s = eventsByEmail.get(e); if (!s) { s = new Set(); eventsByEmail.set(e, s); }
        s.add(r.id);
      }
    }
  } catch { /* table absent */ }
  const anyShared = (aSets, bSets) => {
    if (!aSets.length || !bSets.length) return false;
    const bAll = new Set();
    for (const s of bSets) for (const x of s) bAll.add(x);
    for (const s of aSets) for (const x of s) if (bAll.has(x)) return true;
    return false;
  };
  const sharesThreadOrEvent = (aEmails, bEmails) => {
    if (aEmails.length === 0 || bEmails.length === 0) return false;
    const aT = aEmails.map(e => threadsByEmail.get(e.toLowerCase())).filter(Boolean);
    const bT = bEmails.map(e => threadsByEmail.get(e.toLowerCase())).filter(Boolean);
    if (anyShared(aT, bT)) return true;
    const aE = aEmails.map(e => eventsByEmail.get(e.toLowerCase())).filter(Boolean);
    const bE = bEmails.map(e => eventsByEmail.get(e.toLowerCase())).filter(Boolean);
    return anyShared(aE, bE);
  };

  for (const [key, members] of clusters) {
    if (members.length < 2) continue;
    // Guard against id artifacts: require distinct real ids.
    const ids = new Set(members.map(m => m.id));
    if (ids.size < 2) continue;
    stats.clusters++;

    const tokens = key.split(' ');
    const firstTok = tokens[0];
    const lastTok = tokens[tokens.length - 1];
    const surnameCommon = surnames.has(lastTok);
    const firstCommonness = commonness.get(firstTok) || 0;
    const downgrade = surnameCommon && firstCommonness >= 40;

    // Anchor = richest: chunk_entities DESC, identifier count DESC, has-phone DESC.
    const ranked = members.slice().sort((a, b) => {
      const fa = features(a.id), fb = features(b.id);
      if (fb.chunks !== fa.chunks) return fb.chunks - fa.chunks;
      if (fb.idCount !== fa.idCount) return fb.idCount - fa.idCount;
      return (fb.phones.size > 0 ? 1 : 0) - (fa.phones.size > 0 ? 1 : 0);
    });
    const anchor = ranked[0];
    const fAnchor = features(anchor.id);

    for (let i = 1; i < ranked.length; i++) {
      const member = ranked[i];
      const fMember = features(member.id);

      // VETO: different phone numbers on the two rows → never merge.
      let phoneConflict = false;
      for (const ap of fAnchor.phones) {
        for (const mp of fMember.phones) {
          if (ap !== mp) phoneConflict = true;
        }
      }
      if (phoneConflict) {
        stats.vetoed++;
        try {
          db.prepare(`INSERT INTO resolve_audit (candidate_id, entity_type, decision, guard, confidence, evidence, source, person_id)
                      VALUES (NULL, 'person', 'skip', 'veto-phone', 0, ?, 'merge-pass', ?)`)
            .run(`${member.id}|phone-conflict`, anchor.id);
        } catch { /* audit absent */ }
        continue;
      }

      // Evaluate guards.
      let guard = null;
      let evidence = null;

      // G1: shared identifier (email or phone in common).
      const sharedEmail = fMember.emails.find(e => fAnchor.emails.includes(e));
      const sharedPhone = [...fMember.phones].find(p => fAnchor.phones.has(p));
      if (sharedEmail || sharedPhone) { guard = 'G1'; evidence = `shared:${sharedEmail || sharedPhone}`; }

      // G2: uncommon surname.
      if (!guard && !surnameCommon) { guard = 'G2'; evidence = `rare-surname:${lastTok}`; }

      // G3: BOTH member & anchor emails nameEncode the shared full name.
      const memberEncodes = fMember.emails.some(e => nameEncode(e, firstTok, lastTok));
      const anchorEncodes = fAnchor.emails.some(e => nameEncode(e, firstTok, lastTok));
      const g3 = memberEncodes && anchorEncodes;

      // G4: calendar/thread co-occurrence.
      let g4 = false;
      if (!guard) g4 = sharesThreadOrEvent(fAnchor.emails, fMember.emails);

      if (!guard) {
        if (g3 && !downgrade) {
          guard = 'G3'; evidence = `nameEncode:${firstTok} ${lastTok}`;
        } else if (g4) {
          guard = 'G4'; evidence = 'co-occurrence';
        } else if (g3 && downgrade) {
          // Downgraded: G3 alone insufficient (common surname + common first
          // name). Need G1/G4 — neither held → ambiguous.
          guard = null;
        }
      }

      if (!guard) {
        stats.skipped++;
        try {
          db.prepare(`INSERT INTO resolve_audit (candidate_id, entity_type, decision, guard, confidence, evidence, source, person_id)
                      VALUES (NULL, 'person', 'skip', 'ambiguous', 0, ?, 'merge-pass', ?)`)
            .run(`${member.id}|cluster:${key}${downgrade ? '|downgraded' : ''}`, anchor.id);
        } catch { /* audit absent */ }
        continue;
      }

      // Merge member → anchor. mergeInto re-parents identifiers + interactions
      // + groups + chunk_entities, archives the loser, and writes the merge
      // audit row with this guard + evidence.
      mergeInto(db, anchor.id, member.id, guard, { ...opts, evidence });
      stats.merged++;
      stats.byGuard[guard] = (stats.byGuard[guard] || 0) + 1;
      // Anchor inherited member's identifiers → refresh its feature cache so a
      // subsequent member in the same cluster sees the union (G1 transitivity).
      featCache.delete(anchor.id);
      Object.assign(fAnchor, features(anchor.id));
    }
  }

  log(`  Dedup merge pass: ${stats.merged} merged across ${stats.clusters} multi-row clusters ` +
      `(G1=${stats.byGuard.G1} G2=${stats.byGuard.G2} G3=${stats.byGuard.G3} G4=${stats.byGuard.G4}; ` +
      `${stats.skipped} ambiguous skipped, ${stats.vetoed} vetoed)`);

  return { merged: stats.merged, identifier: stats.byGuard.G1, fullName: stats.byGuard.G3, nickname: 0, stats };
}

/**
 * Final cleanup for exact duplicate humans after company assignment.
 *
 * This is narrower than legacy name-only merging: it requires the same
 * normalized multi-word name and the same company_id, excludes service vendors
 * and raw-email display rows, and vetoes phone conflicts. Its job is to repair
 * duplicate person rows left behind when two source slices saw the same human
 * with different hard identifiers that were not bridged until enrichment.
 */
export function mergeExactDuplicatePeoplePass(db, log = () => {}, opts = {}) {
  const stats = { merged: 0, groups: 0, skipped: 0, vetoed: 0, compactGroups: 0, encodedGroups: 0, ghostGroups: 0, distinctiveGroups: 0 };
  let people;
  try {
    people = db.prepare(`
      SELECT id, display_name, company_id,
             COALESCE(interaction_count, 0) AS interaction_count,
             COALESCE(source_count, 0) AS source_count,
             COALESCE(score, 0) AS score,
             context_file_path
      FROM people
      WHERE COALESCE(archived, 0) = 0
        AND COALESCE(service_vendor, 0) = 0
        AND display_name IS NOT NULL
        AND display_name NOT LIKE '%@%'
        AND company_id IS NOT NULL
    `).all();
  } catch {
    return stats;
  }

  const groups = new Map();
  for (const p of people) {
    let nameKey = clusterKey(p.display_name);
    let kind = 'full';
    if (!nameKey) {
      nameKey = compactEmailLocalKey(p.display_name);
      kind = 'compact';
    }
    if (!nameKey) continue;
    const key = `${kind}|${nameKey}|${p.company_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...p, nameKey, kind });
  }

  const featCache = new Map();
  const features = (id) => {
    if (featCache.has(id)) return featCache.get(id);
    const emails = db.prepare("SELECT value FROM person_identifiers WHERE person_id=? AND type='email'").all(id).map(r => r.value);
    const phones = db.prepare("SELECT value FROM person_identifiers WHERE person_id=? AND type='phone'").all(id).map(r => r.value);
    let chunks = 0;
    try { chunks = db.prepare("SELECT COUNT(*) n FROM chunk_entities WHERE entity_id=? AND entity_type='person'").get(id).n; } catch { /* table absent */ }
    const f = { emails, phones: new Set(phones), chunks, idCount: emails.length + phones.length };
    featCache.set(id, f);
    return f;
  };

  const phoneConflict = (aPhones, bPhones) => {
    if (!aPhones.size || !bPhones.size) return false;
    for (const ap of aPhones) {
      for (const bp of bPhones) {
        if (ap !== bp) return true;
      }
    }
    return false;
  };

  const rankMembers = (members) => members.slice().sort((a, b) => {
    const fa = features(a.id), fb = features(b.id);
    const aHasContext = a.context_file_path ? 1 : 0;
    const bHasContext = b.context_file_path ? 1 : 0;
    if (bHasContext !== aHasContext) return bHasContext - aHasContext;
    if (fb.chunks !== fa.chunks) return fb.chunks - fa.chunks;
    if (b.interaction_count !== a.interaction_count) return b.interaction_count - a.interaction_count;
    if (b.score !== a.score) return b.score - a.score;
    if (b.source_count !== a.source_count) return b.source_count - a.source_count;
    return fb.idCount - fa.idCount;
  });

  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    stats.groups++;
    if (members[0]?.kind === 'compact') stats.compactGroups++;
    const ranked = rankMembers(members);

    const anchor = ranked[0];
    let anchorFeatures = features(anchor.id);
    const compactGroup = anchor.kind === 'compact';
    if (compactGroup && !anchorFeatures.emails.some((email) => emailLocalCompactKey(email) === anchor.nameKey)) {
      stats.skipped += ranked.length - 1;
      continue;
    }
    for (let i = 1; i < ranked.length; i++) {
      const member = ranked[i];
      const memberFeatures = features(member.id);
      if (compactGroup && !memberFeatures.emails.some((email) => emailLocalCompactKey(email) === member.nameKey)) {
        stats.skipped++;
        try {
          db.prepare(`INSERT INTO resolve_audit (candidate_id, entity_type, decision, guard, confidence, evidence, source, person_id)
                      VALUES (NULL, 'person', 'skip', 'compact-local-missing-email-evidence', 0, ?, 'exact-duplicate-pass', ?)`)
            .run(`${member.id}|exact-name-company:${key}`, anchor.id);
        } catch { /* audit absent */ }
        continue;
      }
      if (phoneConflict(anchorFeatures.phones, memberFeatures.phones)) {
        stats.vetoed++;
        try {
          db.prepare(`INSERT INTO resolve_audit (candidate_id, entity_type, decision, guard, confidence, evidence, source, person_id)
                      VALUES (NULL, 'person', 'skip', 'veto-phone', 0, ?, 'exact-duplicate-pass', ?)`)
            .run(`${member.id}|exact-name-company:${key}|phone-conflict`, anchor.id);
        } catch { /* audit absent */ }
        continue;
      }
      mergeInto(db, anchor.id, member.id, compactGroup ? 'G5-exact-compact-local-company' : 'G5-exact-name-company', {
        ...opts,
        evidence: `exact-name-company:${key}`,
      });
      stats.merged++;
      featCache.delete(anchor.id);
      anchorFeatures = features(anchor.id);
    }
  }

  const encodedPeople = (() => {
    try {
      return db.prepare(`
        SELECT id, display_name, company_id,
               COALESCE(interaction_count, 0) AS interaction_count,
               COALESCE(source_count, 0) AS source_count,
               COALESCE(score, 0) AS score,
               context_file_path
        FROM people
        WHERE COALESCE(archived, 0) = 0
          AND COALESCE(service_vendor, 0) = 0
          AND display_name IS NOT NULL
          AND display_name NOT LIKE '%@%'
      `).all();
    } catch {
      return [];
    }
  })();

  const encodedGroups = new Map();
  for (const p of encodedPeople) {
    const nameKey = clusterKey(p.display_name);
    if (!nameKey) continue;
    if (!encodedGroups.has(nameKey)) encodedGroups.set(nameKey, []);
    encodedGroups.get(nameKey).push({ ...p, nameKey, kind: 'encoded' });
  }

  for (const [nameKey, members] of encodedGroups) {
    if (members.length < 2) continue;
    const tokens = nameKey.split(' ');
    const firstTok = tokens[0];
    const lastTok = tokens[tokens.length - 1];
    const candidates = members.filter((member) => {
      const memberFeatures = features(member.id);
      return memberFeatures.emails.some((email) => emailStronglyEncodesFullName(email, firstTok, lastTok));
    });
    if (candidates.length < 2) continue;

    stats.encodedGroups++;
    const ranked = rankMembers(candidates);
    const anchor = ranked[0];
    let anchorFeatures = features(anchor.id);
    for (let i = 1; i < ranked.length; i++) {
      const member = ranked[i];
      const memberFeatures = features(member.id);
      if (phoneConflict(anchorFeatures.phones, memberFeatures.phones)) {
        stats.vetoed++;
        try {
          db.prepare(`INSERT INTO resolve_audit (candidate_id, entity_type, decision, guard, confidence, evidence, source, person_id)
                      VALUES (NULL, 'person', 'skip', 'veto-phone', 0, ?, 'exact-duplicate-pass', ?)`)
            .run(`${member.id}|encoded-name:${nameKey}|phone-conflict`, anchor.id);
        } catch { /* audit absent */ }
        continue;
      }
      mergeInto(db, anchor.id, member.id, 'G6-encoded-name-email-local', {
        ...opts,
        evidence: `encoded-name-email-local:${nameKey}`,
      });
      stats.merged++;
      featCache.delete(anchor.id);
      anchorFeatures = features(anchor.id);
    }
  }

  const ghostGroups = new Map();
  for (const p of encodedPeople) {
    const nameKey = clusterKey(p.display_name);
    if (!nameKey) continue;
    if (!ghostGroups.has(nameKey)) ghostGroups.set(nameKey, []);
    ghostGroups.get(nameKey).push({ ...p, nameKey, kind: 'zero-signal-ghost' });
  }

  for (const [nameKey, members] of ghostGroups) {
    if (members.length < 2) continue;
    const ranked = rankMembers(members);
    const anchor = ranked[0];
    let anchorFeatures = features(anchor.id);
    const anchorHasSignal =
      anchorFeatures.idCount > 0
      || anchorFeatures.chunks > 0
      || anchor.interaction_count > 0
      || !!anchor.context_file_path
      || anchor.source_count > 1;
    if (!anchorHasSignal) continue;

    let mergedGhost = false;
    for (let i = 1; i < ranked.length; i++) {
      const member = ranked[i];
      const memberFeatures = features(member.id);
      const memberIsZeroSignal =
        memberFeatures.idCount === 0
        && memberFeatures.chunks === 0
        && member.interaction_count === 0
        && !member.context_file_path
        && member.source_count <= 1;
      if (!memberIsZeroSignal) continue;
      if (phoneConflict(anchorFeatures.phones, memberFeatures.phones)) {
        stats.vetoed++;
        continue;
      }
      mergeInto(db, anchor.id, member.id, 'G7-zero-signal-name-ghost', {
        ...opts,
        evidence: `zero-signal-name-ghost:${nameKey}`,
      });
      stats.merged++;
      mergedGhost = true;
      featCache.delete(anchor.id);
      anchorFeatures = features(anchor.id);
    }
    if (mergedGhost) stats.ghostGroups++;
  }

  // ── Distinctive-surname name-alone dedup (df_cbd30a5a follow-up, FIX 1) ──────
  // Records with NO shared identifier on DIFFERENT companies never meet any pass
  // above: the name+company pass keys on company, and the encoded pass requires
  // an email local-part that encodes the full name. So the owner fragmented into
  // several same-name records on several different-company emails (one address
  // per company, none shared) and stayed several distinct people.
  //
  // A DISTINCTIVE (rare) surname — one ABSENT from config/surnames-top-25K.json —
  // is itself strong same-person evidence: a personal name that rare, on two
  // records whose first names also agree, is one human across companies. So
  // group those by the ≥2-token cluster-key NAME ALONE, across companies. A
  // COMMON surname (Smith, Lee, …) carries no such signal and is skipped here —
  // it keeps the stricter name+company grouping above, still needing a shared
  // identifier or corroboration.
  //
  // Precision is preserved two ways, so this never re-fuses the corporate/friend
  // welds the merge rule was built to prevent:
  //   1. Every merge still routes through mergeInto → absorbPersonRecords →
  //      shouldMerge(coherenceOnly). A union that forms ≥2 dense DISJOINT
  //      name-token clusters (the weld shape) is CUT and diverted to triage. The
  //      the corporate/foreign-person welds are DIFFERENT names and never group here in the first
  //      place, so the cut is a second guard, not the only one.
  //   2. A phone conflict between the two rows vetoes (different number →
  //      different person).
  // Runs LAST on a FRESH active set so it groups the G5/G6/G7 survivors, not
  // stale pre-merge rows; a member archived above is simply absent here.
  const distinctiveSurnames = loadSurnameSet();
  featCache.clear(); // survivors' identifier sets changed above — reread fresh
  let distinctivePeople;
  try {
    distinctivePeople = db.prepare(`
      SELECT id, display_name, company_id,
             COALESCE(interaction_count, 0) AS interaction_count,
             COALESCE(source_count, 0) AS source_count,
             COALESCE(score, 0) AS score,
             context_file_path
      FROM people
      WHERE COALESCE(archived, 0) = 0
        AND COALESCE(service_vendor, 0) = 0
        AND display_name IS NOT NULL
        AND display_name NOT LIKE '%@%'
    `).all();
  } catch {
    distinctivePeople = [];
  }
  const distinctiveGroups = new Map();
  for (const p of distinctivePeople) {
    const nameKey = clusterKey(p.display_name);
    if (!nameKey) continue;                             // needs ≥2 name tokens (agreeing first + surname)
    const lastTok = nameKey.split(' ').pop();
    if (distinctiveSurnames.has(lastTok)) continue;     // common surname → no rare-name signal
    if (!distinctiveGroups.has(nameKey)) distinctiveGroups.set(nameKey, []);
    distinctiveGroups.get(nameKey).push({ ...p, nameKey, kind: 'distinctive' });
  }
  for (const [nameKey, members] of distinctiveGroups) {
    if (members.length < 2) continue;
    stats.distinctiveGroups++;
    const ranked = rankMembers(members);
    const anchor = ranked[0];
    let anchorFeatures = features(anchor.id);
    for (let i = 1; i < ranked.length; i++) {
      const member = ranked[i];
      const memberFeatures = features(member.id);
      if (phoneConflict(anchorFeatures.phones, memberFeatures.phones)) {
        stats.vetoed++;
        try {
          db.prepare(`INSERT INTO resolve_audit (candidate_id, entity_type, decision, guard, confidence, evidence, source, person_id)
                      VALUES (NULL, 'person', 'skip', 'veto-phone', 0, ?, 'exact-duplicate-pass', ?)`)
            .run(`${member.id}|distinctive-name:${nameKey}|phone-conflict`, anchor.id);
        } catch { /* audit absent */ }
        continue;
      }
      // The coherence cut inside absorbPersonRecords guards this merge: if the
      // union welds two name-disjoint sub-clusters it is refused + triaged, so a
      // rare-name COLLISION between two genuinely different people cannot fuse.
      mergeInto(db, anchor.id, member.id, 'G8-distinctive-name', {
        ...opts,
        evidence: `distinctive-name:${nameKey}`,
      });
      // mergeInto is a no-op when the coherence cut refuses — count only the
      // real archives so stats.merged stays truthful.
      const archived = (() => {
        try { return db.prepare('SELECT COALESCE(archived,0) AS a FROM people WHERE id = ?').get(member.id)?.a === 1; }
        catch { return false; }
      })();
      if (archived) {
        stats.merged++;
        featCache.delete(anchor.id);
        anchorFeatures = features(anchor.id);
      }
    }
  }

  log(`  Exact duplicate cleanup: ${stats.merged} merged across ${stats.groups} exact name+company groups ` +
      `(${stats.compactGroups} compact-local groups, ${stats.encodedGroups} encoded-name groups, ${stats.ghostGroups} zero-signal ghost groups, ` +
      `${stats.distinctiveGroups} distinctive-surname groups, ${stats.vetoed} phone-conflict vetoes)`);
  return stats;
}

/**
 * Merge `loser` into `winner`. Re-parent identifiers + interactions, archive
 * the loser row. Idempotent: safe to call on an already-merged loser.
 *
 * Audit: writes a resolve_audit row with the supplied guard name.
 */
export function mergeInto(db, winnerId, loserId, guard, opts = {}) {
  // st_f67bc2eb AC-11 — the record-absorption body moved to
  // lib/people-merge.js (absorbPersonRecords) so the ingest pipeline and the
  // product merge (routes/network.js) share ONE implementation and cannot
  // drift. The score-based display-name picker stays pipeline-side and rides
  // in as a callback: pickBestDisplayName includes the winner's current
  // display_name as a candidate, so it only returns a different value when
  // that value scores STRICTLY HIGHER; opts carries the pre-loaded indexes
  // (st_87a0d072 picker-inline) so the post-merge pick stays O(1) Map lookups
  // instead of a per-merge SELECT against the 350K-row emails table.
  absorbPersonRecords(db, winnerId, loserId, guard, {
    evidence: opts.evidence,
    pickBestDisplayName: (winner, idents, database) => pickBestDisplayName(winner, idents, database, {
      emailsSenderIndex: opts.emailsSenderIndex,
      contactsIndex: opts.contactsIndex,
    }),
  });
}

/**
 * Phase 2 main: read all non-excluded candidates, resolve each, write audit.
 * @param {Function} log
 * @returns {{ created: number, linked: number, discarded: number }}
 */
export async function phaseResolve(log) {
  log('\n=== Phase 2: Resolve (match or create) ===');

  const { default: db } = await import('../../lib/db.js');
  try { db.pragma('busy_timeout = 120000'); } catch { /* test/read-only DBs may reject pragma */ }

  // st_87a0d072 picker-inline (2026-05-13): pre-load both canonical-name
  // indexes ONCE before the candidate loop. The emails-sender index is the
  // big one — a single indexed scan over the ~350K-row emails table replaces
  // ~30K per-person SELECTs that the slow standalone backfill ran. Apple
  // Contacts index is already cached at module level; we call here so the
  // log line shows its size and so it's loaded synchronously before the
  // chunked tx loop (no async dynamic-import surprises mid-loop).
  const emailsSenderIndex = loadEmailsSenderIndex(db);
  const contactsIndex = await loadContactsIndex();
  log(`  Pre-loaded canonical-name indexes: emails ${emailsSenderIndex.size}, contacts ${contactsIndex.byEmail.size + contactsIndex.byPhone.size}`);

  // df_cbd30a5a AC-12: compute the popular-identifier set ONCE before the
  // candidate loop (mirrors the emailsSenderIndex / contactsIndex pattern) and
  // carry an in-run tally of distinct-content cards collapsed into each surviving
  // person. Both thread through resolveCandidate → attachIdentifierOrMerge into
  // the shouldMerge gate. popularSet demotes office lines / shared addresses;
  // mergedCardCounts drives the >4-distinct-card triage tripwire.
  const popularSet = buildPopularIdentifierSet(db, {});
  const mergedCardCounts = new Map();
  log(`  Precision merge gate armed: ${popularSet.size} popular identifier(s) demoted (min-names ${process.env.ROBOTDOJO_POPULAR_IDENTIFIER_MIN_NAMES || 4})`);

  const candidates = db.prepare(`
    SELECT * FROM entity_candidates
    WHERE excluded = 0 AND candidate_type = 'person'
    ORDER BY source_rank ASC
  `).all();

  log(`  Resolving ${candidates.length} person candidates`);

  const stats = { created: 0, linked: 0, discarded: 0 };

  // Process in chunks of 500 inside transactions for performance.
  // WHY chunked: avoid holding a single mega-transaction for 50K+ rows.
  const CHUNK = 500;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const chunkStats = await runWithSqliteBusyRetry(`person candidates ${i + 1}-${i + chunk.length}`, () => {
      const attemptStats = { created: 0, linked: 0, discarded: 0 };
      db.transaction(() => {
        for (const c of chunk) {
          // Pass pre-loaded indexes so resolveCandidate can run inline canonical
          // name picking without per-candidate DB queries against emails (350K rows).
          // popularSet + mergedCardCounts feed the AC-12 precision merge gate.
          const result = resolveCandidate(c, db, { emailsSenderIndex, contactsIndex, popularSet, mergedCardCounts });
          if (result.decision === 'create') attemptStats.created++;
          else if (result.decision === 'link') attemptStats.linked++;
          else attemptStats.discarded++;
        }
      })();
      return attemptStats;
    }, log);
    stats.created += chunkStats.created;
    stats.linked += chunkStats.linked;
    stats.discarded += chunkStats.discarded;
  }

  log(`  Created: ${stats.created}, Linked: ${stats.linked}, Discarded: ${stats.discarded}`);

  // ── Stage B compatibility hook ─────────────────────────────────────────────
  // Legacy name/co-occurrence merging is not part of the ingest resolver.
  // Actual identity resolution is the connected component of hard identifiers
  // (email + phone), and those merges happen inline in attachIdentifierOrMerge.
  log('  Stage B legacy name/co-occurrence merge pass skipped; hard-ID merges run inline');
  stats.merged = 0;

  // Place candidates — create places from raw_location (candidate_type='venue' is the DB value)
  const placeCandidates = db.prepare(`
    SELECT * FROM entity_candidates WHERE excluded = 0 AND candidate_type = 'venue'
  `).all();

  if (placeCandidates.length > 0) {
    log(`  Processing ${placeCandidates.length} place candidates`);
    const { findOrCreatePlace } = await import('../../lib/timeline-schema.js');
    const placesCreated = await runWithSqliteBusyRetry('place candidates', () => {
      let created = 0;
      db.transaction(() => {
        for (const vc of placeCandidates) {
          if (!vc.raw_location) continue;
          try {
            findOrCreatePlace({ name: vc.raw_location, placeType: 'venue' });
            created++;
          } catch { /* ignore duplicates */ }
        }
      })();
      return created;
    }, log);
    log(`  Place candidates processed: ${placesCreated}`);
  }

  return stats;
}
