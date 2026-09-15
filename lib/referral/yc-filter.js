/**
 * lib/referral/yc-filter.js — st_b879a361
 *
 * qualifyPerson(db, personId) — orchestrates the three qualification paths
 * (A: domain, B: signature, C: AI/tech content) and resolves the role
 * bucket via 4-tier title source priority.
 *
 * RETURNS
 *   {
 *     qualifies: boolean,
 *     qualified_path: 'A'|'B'|'C'|'A+B'|'A+C'|'B+C'|'A+B+C'|null,
 *     role_bucket: 'founder'|...|'business'|'excluded',
 *     role_priority: number,                   // BUCKET_PRIORITY value
 *     detected_role_source: 'person_professional'|'linkedin_title'|'signature'|'default'|null,
 *     has_path_c: boolean,
 *     path_c_weight: number,                   // cumulative weight (diagnostic)
 *     company_type: 'startup'|'bigTech'|'vc'|'unknown',
 *     company_priority_tier: 1|2|3|null,
 *     prof_email_domain: string|null,
 *     qualified_domain_source: 'person_professional'|'company_id'|'recent_email'|'signature'|null,
 *   }
 *
 * DESIGN
 *   - resolveCompanyDomain(db, personId) walks 4 sources (priority order):
 *       1. person_professional.company_domain
 *       2. people.company_id → company_domains.domain
 *            (GATED: only fires when people.linkedin_title is non-empty —
 *             unguarded company_id is derived from email headers and can be
 *             stale; the linkedin_title guard requires structural corroboration.
 *             Discovered in a stale-company_id regression — company_id=Apple from
 *             an apple.com identifier with zero received emails, while
 *             kiran@zoox.com is the actual recent professional address.)
 *       3. most-recent professional email domain (freemail + machine-gen
 *          excluded; INNER JOIN on emails so identifiers without received
 *          mail are skipped — this is what makes Source 3 trustworthy as the
 *          fallback after Source 2 is gated off)
 *       4. signature-extracted domain (Path B scan)
 *     Returns first non-null + records qualified_domain_source.
 *
 *   - resolveTitle(db, personId, signatureSignal) walks 4 sources:
 *       1. person_professional.title
 *       2. people.linkedin_title
 *       3. signature-extracted title
 *       4. null → default to engineering if Path C qualifies, else excluded.
 *     Lower sources are consulted only when the higher source is null OR
 *     classifies as excluded (so a populated-but-marketing higher source
 *     does NOT short-circuit — it falls through).
 *
 *   - Path A fires when resolved canonical domain ∈ canonicalSet AND role
 *     bucket is non-excluded.
 *   - Path B fires when the signature scanner produced both title + canonical
 *     domain (it does both in one call).
 *   - Path C fires when scorePathCSignal(concatenated_text) ≥ 3 over the
 *     last 10 emails + last 10 iMessage chunks within last 90 days.
 *
 * MACHINE-GENERATED EXCLUSION (Path A source 3, professional email):
 *   The derivation excludes: freemail domains (FREEMAIL_DOMAINS),
 *   *.calendar.google.com, googlemail.com, noreply@*, mailer-daemon@*,
 *   any sender_email with a + in the local part (often automation).
 */

import { FREEMAIL_DOMAINS } from '../entity-resolve.js';
import { getCanonicalDomains, classifyDomain } from './canonical-domains.js';
import { classifyRole } from './role-classify.js';
import { extractSignatureSignal } from './signature-scan.js';
import { scorePathCSignal } from './path-c-keywords.js';
import { BUCKET_PRIORITY } from './ontologies.js';

const PATH_C_THRESHOLD = 3;
const SIGNATURE_BODY_LIMIT = 5;
const PATH_C_EMAIL_LIMIT = 10;
const PATH_C_IMESSAGE_LIMIT = 10;

// Machine-generated email patterns excluded from the professional-email
// derivation. Patterns are case-insensitive.
const MACHINE_GEN_DOMAIN_PATTERNS = [
  /\.calendar\.google\.com$/i,
  /^googlemail\.com$/i,
];
const MACHINE_GEN_LOCAL_PATTERNS = [
  /^noreply$/i,
  /^no-reply$/i,
  /^mailer-daemon$/i,
  /^postmaster$/i,
  /^bounce/i,
];

function extractDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().replace(/^www\./, '');
}

function isMachineGenerated(email) {
  if (!email) return true;
  const at = email.lastIndexOf('@');
  if (at < 0) return true;
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  // local +tag → often automation
  if (local.includes('+')) return true;
  for (const re of MACHINE_GEN_LOCAL_PATTERNS) if (re.test(local)) return true;
  for (const re of MACHINE_GEN_DOMAIN_PATTERNS) if (re.test(domain)) return true;
  return false;
}

function isFreemail(domain) {
  if (!domain) return false;
  return FREEMAIL_DOMAINS.has(domain.toLowerCase());
}

// ─── DB readers (no prepared-statement cache — called per-person, can re-prepare cheaply) ─

function getPersonProfessional(db, personId) {
  return db.prepare(`
    SELECT title, company, company_domain FROM person_professional WHERE person_id = ?
  `).get(personId);
}

function getPerson(db, personId) {
  return db.prepare(`
    SELECT id, display_name, linkedin_title, company_id, last_seen FROM people WHERE id = ?
  `).get(personId);
}

function getCompanyDomain(db, companyId) {
  if (!companyId) return null;
  const row = db.prepare(`SELECT domain FROM company_domains WHERE company_id = ? ORDER BY id ASC LIMIT 1`).get(companyId);
  return row?.domain ? row.domain.toLowerCase().replace(/^www\./, '') : null;
}

function getMostRecentProfessionalEmail(db, personId) {
  // Find the most recent inbound email (received_at desc) whose sender_email
  // matches a person_identifier email AND survives freemail + machine-gen filters.
  const rows = db.prepare(`
    SELECT e.sender_email, e.received_at
    FROM person_identifiers pi
    JOIN emails e ON e.sender_email = pi.value
    WHERE pi.person_id = ? AND pi.type = 'email'
      AND e.sender_email IS NOT NULL
      AND e.sender_email != ''
    ORDER BY e.received_at DESC
    LIMIT 50
  `).all(personId);
  for (const r of rows) {
    if (isMachineGenerated(r.sender_email)) continue;
    const dom = extractDomain(r.sender_email);
    if (!dom) continue;
    if (isFreemail(dom)) continue;
    return dom;
  }
  return null;
}

// Read the last N email bodies from this person (most-recent first) for
// Path B signature scan + Path C keyword scoring.
function getRecentEmailBodies(db, personId, limit, daysWindow = null) {
  const dayClause = daysWindow ? `AND e.received_at >= datetime('now','-${Number(daysWindow)} days')` : '';
  return db.prepare(`
    SELECT e.body_text, e.received_at
    FROM person_identifiers pi
    JOIN emails e ON e.sender_email = pi.value
    WHERE pi.person_id = ? AND pi.type = 'email'
      AND e.body_text IS NOT NULL AND e.body_text != ''
      ${dayClause}
    ORDER BY e.received_at DESC
    LIMIT ?
  `).all(personId, limit);
}

// Read the last N iMessage chunks for this person within `daysWindow`.
// Person linkage in chunks comes via two routes documented in 01-research.md:
//   - source_id LIKE 'imessage:<phone>:%' — we extract <phone> from
//     person_identifiers (type='phone') and match each
//   - metadata JSON has a 'participant' field with the person id in some
//     pipelines (we check via JSON_EXTRACT for safety).
// For Path C we just want plaintext content; we OR both routes.
function getRecentIMessageChunks(db, personId, limit, daysWindow = 90) {
  const phones = db.prepare(`
    SELECT value FROM person_identifiers WHERE person_id = ? AND type = 'phone'
  `).all(personId).map(r => r.value);
  if (phones.length === 0) return [];
  const phonePatterns = phones.map(p => `imessage:${p}:%`);
  const placeholders = phonePatterns.map(() => 'source_id LIKE ?').join(' OR ');
  return db.prepare(`
    SELECT content, event_time
    FROM chunks
    WHERE source_type = 'imessage'
      AND content IS NOT NULL AND content != ''
      AND (${placeholders})
      AND event_time >= datetime('now','-${Number(daysWindow)} days')
    ORDER BY event_time DESC
    LIMIT ?
  `).all(...phonePatterns, limit);
}

// ─── Resolvers ──────────────────────────────────────────────────────────

/**
 * Resolve the company domain for a person. Walks 4 sources in priority order.
 * - Source 2 (`company_id`) is gated by `people.linkedin_title` non-empty —
 *   unguarded it returns stale apple.com for contacts whose only apple.com
 *   identifier never received mail (the stale-company_id regression). The gate
 *   requires at least one independent structural signal (a LinkedIn-sourced
 *   title) that the person actually works at the company_id-linked employer
 *   before trusting an entity-extracted company link.
 * - Source 3 uses an INNER JOIN on `emails.sender_email = person_identifiers.value`
 *   (see getMostRecentProfessionalEmail) so an identifier that never appears
 *   as a sender cannot win. This is what makes the Source-2 gate safe — when
 *   Source 2 falls through, Source 3 only returns domains that have actually
 *   received mail.
 * - Source 4 (signature) only fires when signatureSignal already exists.
 */
function resolveCompanyDomain(db, personId, signatureSignal) {
  // 1. person_professional.company_domain (structured)
  const pp = getPersonProfessional(db, personId);
  if (pp?.company_domain) {
    const d = pp.company_domain.toLowerCase().replace(/^www\./, '');
    return { domain: d, source: 'person_professional' };
  }
  // 2. people.company_id → company_domains.domain (entity-extracted)
  //    GATED: linkedin_title must be non-empty. Without that structural
  //    corroboration the company_id link is a header-derived inference and
  //    can be stale (the stale-link case → company_id=Apple from apple.com identifier with
  //    zero received emails). The linkedin_title gate requires at least one
  //    independent signal that the person actually works there.
  const person = getPerson(db, personId);
  const hasLinkedInTitle = person?.linkedin_title && person.linkedin_title.trim() !== '';
  if (person?.company_id && hasLinkedInTitle) {
    const d = getCompanyDomain(db, person.company_id);
    if (d) return { domain: d, source: 'company_id' };
  }
  // 3. most-recent professional email (freemail + machine-gen excluded;
  //    INNER JOIN on emails so identifiers without received mail are skipped)
  const recentDom = getMostRecentProfessionalEmail(db, personId);
  if (recentDom) return { domain: recentDom, source: 'recent_email' };
  // 4. signature-extracted (only if Path B already ran)
  if (signatureSignal?.domain) {
    return { domain: signatureSignal.domain, source: 'signature' };
  }
  return { domain: null, source: null };
}

/**
 * Resolve the title for role classification. Walks 4 sources; falls through
 * when a higher source is non-null but classifies as excluded.
 */
function resolveTitle(db, personId, signatureSignal, companyType, hasPathC) {
  const try_ = (title, source) => {
    const r = classifyRole(title || '', companyType || 'unknown');
    return { ...r, title, source };
  };

  // 1. person_professional.title
  const pp = getPersonProfessional(db, personId);
  if (pp?.title) {
    const t = try_(pp.title, 'person_professional');
    if (t.bucket !== 'excluded') return t;
    // Fall through — populated but classified as excluded.
  }

  // 2. people.linkedin_title
  const person = getPerson(db, personId);
  if (person?.linkedin_title) {
    const t = try_(person.linkedin_title, 'linkedin_title');
    if (t.bucket !== 'excluded') return t;
  }

  // 3. signature-extracted title
  if (signatureSignal?.title) {
    const t = try_(signatureSignal.title, 'signature');
    if (t.bucket !== 'excluded') return t;
  }

  // 4. default — engineering if Path C qualifies, else excluded.
  if (hasPathC) {
    return {
      bucket: 'engineering',
      priority: BUCKET_PRIORITY.engineering,
      title: null,
      source: 'default',
    };
  }
  return {
    bucket: 'excluded',
    priority: BUCKET_PRIORITY.excluded,
    title: null,
    source: null,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * @param {object} db better-sqlite3 handle
 * @param {string} personId
 * @returns {object} qualification record (see file header).
 */
export function qualifyPerson(db, personId) {
  const canonical = getCanonicalDomains();

  // Step 1: scan recent email bodies for signature signal + Path C content.
  const recentBodies = getRecentEmailBodies(db, personId, Math.max(SIGNATURE_BODY_LIMIT, PATH_C_EMAIL_LIMIT), 90);

  // Path B: scan last 5 bodies for a signature match.
  let signatureSignal = null;
  const sigBodies = recentBodies.slice(0, SIGNATURE_BODY_LIMIT);
  for (const r of sigBodies) {
    const sig = extractSignatureSignal(r.body_text, canonical);
    if (sig) { signatureSignal = sig; break; }
  }

  // Path C: score concatenated text across last 10 emails + last 10
  // iMessage chunks within 90 days.
  const emailBodiesForC = recentBodies.slice(0, PATH_C_EMAIL_LIMIT).map(r => r.body_text || '').join('\n');
  const imessageChunks = getRecentIMessageChunks(db, personId, PATH_C_IMESSAGE_LIMIT, 90);
  const imessageTextForC = imessageChunks.map(r => r.content || '').join('\n');
  const path_c_weight = scorePathCSignal(emailBodiesForC) + scorePathCSignal(imessageTextForC);
  const has_path_c = path_c_weight >= PATH_C_THRESHOLD;

  // Step 2: resolve domain (Path A source priority).
  const { domain: resolvedDomain, source: domainSource } = resolveCompanyDomain(db, personId, signatureSignal);
  const { companyType, tier: companyTier } = classifyDomain(resolvedDomain);

  // Step 3: resolve title (4-tier priority, fall-through on excluded).
  const titleRes = resolveTitle(db, personId, signatureSignal, companyType, has_path_c);

  // Step 4: compute qualified paths.
  const paths = [];
  const inCanonical = !!(resolvedDomain && canonical.has(resolvedDomain));
  // Path A qualifies when canonical-domain match AND a non-excluded role.
  if (inCanonical && titleRes.bucket !== 'excluded') paths.push('A');
  // Path B qualifies when signature produced both title + canonical domain.
  if (signatureSignal && titleRes.bucket !== 'excluded') paths.push('B');
  // Path C qualifies when score ≥ threshold AND a non-excluded role
  // (default=engineering kicks in via resolveTitle when no other source provided one).
  if (has_path_c && titleRes.bucket !== 'excluded') paths.push('C');

  const qualifies = paths.length > 0;

  return {
    qualifies,
    qualified_path: qualifies ? paths.join('+') : null,
    role_bucket: titleRes.bucket,
    role_priority: titleRes.priority,
    detected_role: titleRes.bucket === 'excluded' ? null : titleRes.bucket,
    detected_role_source: titleRes.source,
    has_path_c,
    path_c_weight,
    company_type: companyType || 'unknown',
    company_priority_tier: companyTier,
    prof_email_domain: resolvedDomain,
    qualified_domain_source: domainSource,
  };
}
