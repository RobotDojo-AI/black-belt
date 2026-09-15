/**
 * Canonical display-name picker — SCORE-BASED, NOT source-hierarchy.
 *
 * Story st_87a0d072 Gap 2 (rewritten 2026-05-13 cleanup): the original picker
 * ranked names by SOURCE (Gmail header > Apple Contacts > nickname > etc.).
 * That's wrong — the user can type their own initials in their own Gmail
 * account display name, so a Gmail header literally reading "ME" beat an
 * Apple Contacts entry of "Marlowe Exampleton" purely on source precedence.
 *
 * The fix: there is NO canonical SOURCE for display names. Collect every
 * candidate name the person carries — across Gmail headers, Apple Contacts,
 * person.display_name itself, person_identifiers of type 'name', LinkedIn —
 * and pick the BEST by intrinsic name quality. A "proper" full name beats
 * initials regardless of which source produced which.
 *
 * `nameQuality(name)` scoring:
 *   0  empty / whitespace
 *   1  email handle (contains @)
 *   2  ≤3 chars OR all-caps initials block ≤6 chars (e.g. "ME", "AGK")
 *   3  family-relation nickname ("Mom", "Dad", "Pop Pop") — meaningful but
 *      not a proper name; we want a real name if any candidate has one
 *   3  single first name only (length 4+)
 *   4  short proper multi-word name (length ≤5, e.g. "B Lee")
 *   5+ proper full name with 2+ tokens (length >5); 5 + min(parts, 4) gives
 *      a small bonus for "First Middle Last" over "First Last"
 *
 * `pickBestDisplayName(candidates)` returns the highest-scoring candidate.
 * Ties broken by length (longer wins — more information). If no candidate
 * scores ≥4 ("proper"), the highest-scoring fallback is still returned so
 * the caller can decide whether to upgrade.
 *
 * Concrete example the rewrite is designed to handle:
 *   Person row "Marlowe Exampleton" with identifiers:
 *     - email: lk@gmail.com  (Gmail header sender = "ME")
 *     - phone: +1...          (Apple Contacts entry = "Marlowe Exampleton")
 *   Old picker: Gmail "ME" wins on source precedence (1 < 2).
 *   New picker: nameQuality("ME")=2, nameQuality("Marlowe Exampleton")=7 → Marlowe wins.
 *
 * WHY db is injected: keeps the function pure-ish for testing. Callers pass a
 * stub db with seeded `emails` rows in unit tests; production passes the real
 * `lib/db.js` default export.
 *
 * WHY contacts are loaded async + cached: the contacts-extractor is ESM and
 * synchronous-via-sqlite. Pre-load once before the resolve transaction so the
 * picker can be called inside the synchronous tx body.
 */

import { APPLE_NICKNAME_TO_RELATION } from './family-nicknames.js';
import humanparser from 'humanparser';

const GENERIC_EMAIL_LOCAL_TOKENS = new Set([
  'admin', 'administrator', 'alert', 'alerts', 'appleid', 'billing', 'calendar',
  'claim', 'claims', 'client', 'concierge', 'contact', 'correspondence',
  'daemon', 'do', 'donotreply', 'email', 'feedback', 'group', 'hello', 'help',
  'account', 'accounts', 'accountstatus', 'ach', 'auth', 'auto', 'assistant',
  'bankruptcy', 'billpay', 'compliance', 'confirm', 'customer', 'donation',
  'confirmation', 'confirmations', 'custserv', 'customerservice', 'econsent',
  'coned', 'discover', 'efile', 'emails', 'etickets', 'events', 'hsbc',
  'jewelersmutual', 'jobs', 'leadership', 'mcinfo', 'message', 'myorder',
  'newuser', 'ninjas', 'notifier', 'onepass', 'owner', 'pay', 'payment',
  'payments', 'printed', 'propertyquotes', 'qbepay',
  'pin', 'quote', 'quotes', 'staircase', 'survey', 'ticket', 'tickets', 'webprod', 'res',
  'info', 'infosec', 'invoice', 'mail', 'mailer', 'marketing', 'news',
  'newsletter', 'no', 'noreply', 'notes', 'notification', 'notifications',
  'office', 'order', 'orders', 'product', 'relay', 'reminder', 'reminders',
  'reply', 'reservation', 'resource', 'receipt', 'receipts', 'sales', 'security',
  'register', 'reservas', 'service', 'services', 'shipping', 'statement',
  'support', 'team', 'transfer', 'travel', 'update', 'updates', 'verify',
  'welcome', 'workspace',
]);

function titleToken(token) {
  if (!token) return '';
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

function isGenericEmailLocalPart(part) {
  if (GENERIC_EMAIL_LOCAL_TOKENS.has(part)) return true;
  return part.length > 4 && part.startsWith('team');
}

/**
 * Derive a human-looking fallback from an email local-part when no proper
 * display name exists. This is deliberately conservative: service accounts,
 * random calendar resources, and generic mailbox names are rejected.
 */
export function displayNameFromEmailLocal(email) {
  const rawInput = String(email || '').trim();
  if (/[<>"]/.test(rawInput)) return null;
  const rawMatch = rawInput.match(/^([^@]+)@([^@]+)$/);
  const raw = rawInput.toLowerCase();
  const m = raw.match(/^([^@]+)@([^@]+)$/);
  if (!m) return null;
  const originalLocal = rawMatch?.[1]?.split('+')[0] || '';
  const local = m[1].split('+')[0];
  const domain = m[2];
  if (!local || local.length > 48) return null;
  if (/(^|\.)((group|resource)\.)?calendar\.google\.com$/.test(domain)) return null;
  if (/[a-f0-9]{16,}/i.test(local)) return null;

  let candidateLocal = local.replace(/^\d+/, '').replace(/\d+$/, '');
  if (!candidateLocal) return null;
  const embeddedDigitsInSinglePart = !/[._,\-]/.test(candidateLocal) && /[a-z]\d+[a-z]/i.test(candidateLocal);
  if (embeddedDigitsInSinglePart) return null;
  const parts = candidateLocal
    .split(/[._,\-]+/)
    .map((p) => p.replace(/[^a-z]/g, ''))
    .filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  if (parts.some((p) => isGenericEmailLocalPart(p))) return null;
  if (parts.length > 1 && parts.every((p) => p.length === 1)) return null;
  if (parts.some((p) => p.length > 24)) return null;
  if (parts.length === 1) {
    if (parts[0].length <= 2) return parts[0].toUpperCase();
    if (parts[0].length < 3 || parts[0].length > 8) return null;
    const acronymSurname = originalLocal.match(/^([A-Z]{1,3})([A-Z][a-z]{2,})$/);
    if (acronymSurname) {
      return `${acronymSurname[1].split('').join(' ')} ${titleToken(acronymSurname[2])}`;
    }
  }
  return parts.map(titleToken).join(' ');
}

/**
 * Strip Gmail "(via Service)" parentheticals and reorder "Last, First" to
 * "First Last" before scoring or merge-keying.
 *
 * Two pre-normalizations needed (st_93fddaf0 Phase 2):
 *
 *   1. Gmail Workspace notifications send `From: "Chris Exampleton (via Google
 *      Docs) <addr>"`. The "(via X)" suffix inflates nameQuality token count
 *      from 2→5 and produces score 9 vs clean-name 7, so the polluted name
 *      wins on score. Strip it via regex before scoring.
 *
 *   2. ~300 rows in the live DB carry "Last, First" formatted display_names
 *      from Apple Contacts (some users prefer that storage). humanparser
 *      handles the reorder cleanly (and also strips salutations like Dr./Mr.
 *      and recognizes suffixes like Jr./Sr. — both useful side-benefits).
 *
 * WHY humanparser-only-for-reorder: humanparser is conservative — it leaves
 * already-correctly-ordered names alone. We only call it when we see a comma
 * pattern, to avoid surprising mutations on clean names.
 *
 * WHY non-throwing: humanparser can fail on edge cases. A failure in name
 * normalization must not break the picker — fall back to the input.
 *
 * @param {string} raw
 * @returns {string} normalized name string
 */
// Common credential / title / suffix tokens that follow a comma after a name.
// We strip these so the underlying name is clean. Order matters slightly — we
// match longest first so "Ed.D" wins over "MD". Combined into one regex.
// st_93fddaf0 Phase 2 expansion: VC3a's GLOB '[A-Z]*, [A-Z]*' catches a name
// followed by any uppercase-letter token after a comma, including legitimate
// credentials like "MD", "JD", "Jr", "MBA'97". Strip these so the name passes.
// Two passes — case-sensitive, so "John" (Capital-then-lowercase) doesn't false-match the
// 2-5 caps acronym class.
//   Pass A: known credential tokens, case-insensitive ("MD" / "md" / "Md" all strip).
//   Pass B: all-caps acronyms / org names, case-sensitive (must be UPPERCASE).
const NAME_SUFFIX_KNOWN_RE = /,\s*(?:Jr\.?|Sr\.?|III|II|IV|MD|M\.D\.?|DDS|DO|JD|J\.D\.?|PhD|Ph\.D\.?|CPA|MBA(?:\s*'\d{2,4})?|MS|MA|RN|Esq\.?|Ed\.?\s*D\.?|VP|CTO|CEO|CFO|COO|CMO|CIO|CHRO|CSO|GP|MP|LLC|Inc\.?|Corp\.?)\.?\s*$/i;
const NAME_SUFFIX_ALLCAPS_RE = /,\s*(?:[A-Z]{2,5}\d{0,4}|[A-Z]{2,}\s+[A-Z]{2,}(?:\s+(?:AND|&)\s+[A-Z]{2,})?)\.?\s*$/;

export function normalizeNameString(raw) {
  if (!raw || typeof raw !== 'string') return raw || '';
  // Strip parentheticals "(via X)" and bracket annotations "[CPB]".
  let s = raw.replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').trim();
  // Strip dangling transport/parse artifacts. A trailing "\" from a quoted
  // sender should never make clean and artifact-bearing names separate.
  s = s.replace(/[\s\\/|]+$/g, '').trim();
  // Calendar and sender displays often use "Person @ Company". The left side
  // is the person; the right side is company context, not the display name.
  if (/\s@\s/.test(s)) s = s.replace(/\s+@\s+.*$/, '').trim();
  // Mail senders often use "First - Company Last" when the address is still
  // the real identity signal (e.g. michael_clear@company.com). The spaced dash
  // segment is company context, not a middle name.
  s = s.replace(
    /^([A-Z][A-Za-z'’-]{1,})\s+-\s+[A-Za-z0-9&.'’ -]{2,}\s+([A-Z][A-Za-z'’-]{1,})$/,
    '$1 $2',
  ).trim();
  // Strip trailing credentials / suffixes that follow a comma (MD, Jr, MBA'97,
  // CPA, VP, etc.). VC3a treats any "Last, First" or "Name, Title" as polluted.
  // Iterate to handle multi-suffix forms like "Ryan S. Curran, CPA, JD".
  let prev;
  do {
    prev = s;
    s = s.replace(NAME_SUFFIX_KNOWN_RE, '').trim();
    s = s.replace(NAME_SUFFIX_ALLCAPS_RE, '').trim();
  } while (s !== prev && s.length > 0);

  // "Last, First" pattern: starts with one or more capitalized tokens (allows
  // "Di Caprio, Vincent" style multi-word surnames, optional digit suffixes for
  // joke/test contacts like "Minion 2, Feeble"), comma, then a capitalized
  // first name. humanparser parses; we reorder First+Middle+Last.
  if (/^[A-Z][a-zA-Z0-9'\-]*(?:\s+[A-Za-z0-9'\-]+)*,\s+[A-Z]/.test(s)) {
    try {
      // humanparser handles "Last, First" natively. For multi-word surnames
      // it correctly captures lastName.
      const parsed = humanparser.parseName(s);
      const parts = [
        parsed.firstName,
        parsed.middleName,
        parsed.lastName,
        parsed.suffix,
      ].filter(Boolean);
      if (parts.length >= 2 && parsed.firstName && parsed.lastName) {
        s = parts.join(' ');
      } else if (s.includes(',')) {
        // humanparser couldn't parse — manual swap if comma format.
        const m = s.match(/^(.+?),\s*(.+)$/);
        if (m) s = `${m[2].trim()} ${m[1].trim()}`;
      }
    } catch {
      // humanparser failure → manual comma reorder as fallback.
      const m = s.match(/^(.+?),\s*(.+)$/);
      if (m) s = `${m[2].trim()} ${m[1].trim()}`;
    }
  }
  return s.trim();
}

/**
 * Parse "First Last <email@domain>" → { name, email }. Mirrors parseSender
 * from lib/gmail-sync.js — duplicated here to avoid pulling sync infrastructure
 * into the people-write path. The implementation is identical and trivial
 * enough that duplication is preferable to coupling.
 */
function parseSender(from) {
  if (!from) return { name: '', email: '' };
  const m = from.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);
  return {
    name: m?.[1]?.trim() || from,
    email: m?.[2]?.trim() || from,
  };
}

/**
 * Score a candidate name. Higher = better. See module header for the rules.
 *
 * WHY a numeric score not a precedence list: precedence forces an ordering
 * across SOURCES even when a lower-priority source has a structurally better
 * name. Scoring lets "Marlowe Exampleton" from Apple Contacts beat "ME" from a
 * Gmail header because the score is intrinsic to the name string.
 *
 * WHY family-relation nicknames score 3 (between initials and proper names):
 * "Mom" carries semantic meaning a user may want to keep — but a real name
 * is always preferable. If the candidate set is just {"Mom"}, "Mom" wins.
 * If the set is {"Mom", "Laurel Exampleton"}, the real name wins.
 *
 * WHY all-caps short blocks score the same as ≤3-char names: "ME" and "AGK"
 * are both initials in practice. Treating them identically simplifies the
 * tiebreak (which falls back to length).
 *
 * WHY a small bonus for more parts: "First Middle Last" carries more info
 * than "First Last". Capped at 4 parts so absurd 6-token contact strings
 * don't unfairly beat clean 2-token names.
 *
 * @param {string|null|undefined} name
 * @returns {number}
 */
export function nameQuality(name) {
  if (!name || typeof name !== 'string') return 0;
  // st_93fddaf0 Phase 2: strip "(via X)" and reorder "Last, First" BEFORE
  // scoring so polluted variants of the same canonical name score equivalently.
  // Without this, "Chris Exampleton (via Google Docs)" (5 tokens, score 9)
  // beats "Chris Exampleton" (2 tokens, score 7) on token-count bonus.
  const t = normalizeNameString(name);
  if (!t) return 0;
  if (t.includes('@')) return 1;                            // email handle
  // Family-relation nickname check FIRST so "Mom" (3 chars) scores 3, not 2.
  if (APPLE_NICKNAME_TO_RELATION[t.toLowerCase()]) return 3; // "Mom", "Dad", "Pop Pop"
  if (t.length <= 3) return 2;                              // "ME", "JK"
  const noSpace = t.replace(/\s+/g, '');
  if (/^[A-Z]+$/.test(noSpace) && noSpace.length <= 6) return 2;  // "ME", "AGK", "JFKJR"
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && t.length > 5) {
    return 5 + Math.min(parts.length, 4);                   // proper full name (more parts = better)
  }
  if (parts.length >= 2) return 4;                          // short proper multi-word ("B Lee")
  return 3;                                                  // single first name only
}

/**
 * Predicate: is this name "proper" enough to use as a display name?
 *
 * A name is "proper" if its quality score is ≥ 4 — i.e. it has multiple
 * tokens with reasonable length. Single first names ("Mike"), nicknames
 * ("Mom"), and initials ("ME") all return false.
 *
 * Used by the backfill script as a filter (only upgrade rows whose current
 * name is NOT proper) and by Phase 2 mergeInto() to decide whether to
 * overwrite the winner's display_name with the picker's result.
 */
export function isProperName(name) {
  return nameQuality(name) >= 4;
}

/**
 * Pick the best name from a set of candidates by intrinsic quality.
 *
 * Returns the highest-scoring candidate. Ties broken by length (longer wins).
 * Returns null only if the array is empty or every candidate scores 0.
 *
 * Exported for direct use by callers that have already collected candidates
 * from arbitrary sources — the unit tests in particular use this to bypass
 * the DB-walking pickBestDisplayName().
 *
 * @param {Array<string|null|undefined>} candidates
 * @returns {string|null}
 */
/**
 * Predicate: name is properly cased (at least one uppercase letter present).
 * Used as a tiebreak in pickBestByScore — between equal-quality candidates,
 * the properly-cased form wins over the lowercased identifier-row form.
 */
function isProperlyCased(name) {
  return /[A-Z]/.test(name);
}

export function pickBestByScore(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue;
    // st_93fddaf0 Phase 2: normalize BEFORE comparison so we both score and
    // store the clean form. The "(via X)" and "Last, First" variants are
    // pollutants; we never want to win with them.
    const normalized = normalizeNameString(c);
    if (!normalized) continue;
    const score = nameQuality(normalized);
    if (score === 0) continue;
    // Tiebreak order at same score: (1) properly-cased beats all-lowercase
    // (lowercased identifier-row variants); (2) longer beats shorter (more
    // information). The "name" identifier source stores names lowercased
    // (see 02-resolve.js INSERT), so without this gate the canonical pick
    // can land on the lowercase form when an Apple Contacts variant is
    // unavailable.
    if (best === null || score > bestScore) {
      best = normalized;
      bestScore = score;
      continue;
    }
    if (score === bestScore) {
      const bestProper = isProperlyCased(best);
      const candProper = isProperlyCased(normalized);
      if (candProper && !bestProper) {
        best = normalized;
        continue;
      }
      if (!candProper && bestProper) continue;
      // Both same case-class: longer wins (more info).
      if (normalized.length > best.length) best = normalized;
    }
  }
  return best;
}

// Module-level Apple Contacts index. Lazily populated by loadContactsIndex.
// WHY module-level: backfill iterates thousands of person rows; opening
// AddressBook-v22.abcddb per call would be tens of seconds wasted. Load once,
// index, reuse.
let _contactsCache = null;

/**
 * Pre-load `emails.sender_email → best display name` mapping into a Map.
 *
 * st_87a0d072 picker-inline (2026-05-13): the standalone backfill ran one
 * `SELECT sender FROM emails WHERE sender_email = ?` per person identifier.
 * With ~9500 people × ~3 emails each, that's ~30K queries against a 350K-row
 * table — multi-minute. Even though `sender_email` is indexed, statement
 * preparation + per-row marshalling dominates.
 *
 * The fix: ONE indexed scan over the entire emails table at the start of
 * Phase 2 Resolve. Group by sender_email, keep the highest-quality candidate
 * sender display name per address. Per-person lookup is then O(1) Map.get().
 *
 * WHY return a Map of email→best-name (not email→[all names]): the picker
 * already includes the row's current display_name and Apple Contacts entry
 * as candidates. The marginal value of seeing 50 sender variants per email
 * vs the one best one is zero — `nameQuality` is order-independent and
 * picks the best regardless. Pre-reducing here saves memory + downstream
 * work in the picker.
 *
 * WHY accept the cost of scanning the full emails table once: a 350K-row
 * indexed scan completes in ~2s on the live DB. Compare to 30K parameterized
 * SELECTs at ~2ms each = 60s. Net speedup is ~30x for the canonical-name
 * upgrade phase, and the cost is paid ONCE per Phase 2 invocation regardless
 * of how many candidates resolve.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<string,string>} lowercased sender_email → best parsed name
 */
export function loadEmailsSenderIndex(db) {
  const map = new Map();
  if (!db) return map;
  let rows;
  try {
    // WHY DISTINCT: the same sender:address pair often appears in tens of
    // thousands of rows (newsletter, common correspondent). DISTINCT lets
    // SQLite collapse them at the index level, dramatically reducing the
    // row count crossing the JS boundary.
    rows = db.prepare(`
      SELECT DISTINCT sender_email, sender FROM emails
      WHERE sender IS NOT NULL AND sender_email IS NOT NULL
    `).all();
  } catch {
    // emails table may not exist in test DBs that skip the email schema —
    // empty index is fine, picker degrades gracefully.
    return map;
  }
  for (const r of rows) {
    const email = String(r.sender_email).toLowerCase();
    // parseSender extracts the "First Last" part out of "First Last <addr>".
    // Falls back to the raw sender string if the From: header has no display
    // name component.
    const parsed = parseSender(r.sender);
    const rawCandidate = parsed.name || r.sender;
    if (!rawCandidate) continue;
    // st_93fddaf0 Phase 2: store the normalized form in the index so the
    // downstream picker can never see the "(via X)" or "Last, First"
    // pollutants. nameQuality() also normalizes, but storing-clean keeps
    // the picker's input clean and the merge guards' input clean.
    const candidate = normalizeNameString(rawCandidate);
    if (!candidate) continue;
    const existing = map.get(email);
    if (!existing || nameQuality(candidate) > nameQuality(existing)) {
      map.set(email, candidate);
    }
  }
  return map;
}

/**
 * Load and index Apple Contacts. Idempotent — subsequent calls reuse the
 * cached maps. Returns { byEmail, byPhone } where values are full names from
 * contacts (ZFIRSTNAME + ZLASTNAME concatenated).
 *
 * WHY async: the contacts-extractor is ESM. Dynamic import is the only way to
 * defer the AddressBook open until callers explicitly need it.
 *
 * WHY graceful empty on failure: not every machine has an AddressBook DB
 * (CI / Linux / headless). The picker must still return a result from the
 * other sources.
 *
 * @returns {Promise<{ byEmail: Map<string,string>, byPhone: Map<string,string> }>}
 */
export async function loadContactsIndex() {
  if (_contactsCache) return _contactsCache;
  const cache = { byEmail: new Map(), byPhone: new Map() };
  try {
    const { extractContacts } = await import('./contacts-extractor.js');
    const contacts = extractContacts();
    for (const c of contacts) {
      const fullName = (c.name || '').trim();
      if (!fullName) continue;
      for (const e of (c.emails || [])) {
        cache.byEmail.set(String(e).toLowerCase(), fullName);
      }
      for (const p of (c.phones || [])) {
        cache.byPhone.set(String(p), fullName);
      }
    }
  } catch { /* AddressBook unavailable; empty maps are fine */ }
  _contactsCache = cache;
  return _contactsCache;
}

/**
 * Test hook: reset the contacts cache so a unit test can stub or skip the
 * AddressBook read. Not for production use.
 */
export function _resetCanonicalNameCache() {
  _contactsCache = null;
}

/**
 * Pick the best display name for a person across all available sources.
 *
 * Collects candidates from:
 *   - Gmail "From:" header sender names (across all emails for any of the
 *     person's email identifiers — up to 50 per address)
 *   - Apple Contacts (ZFIRSTNAME + ZLASTNAME) by email and phone match
 *   - person.display_name (the row's current value)
 *   - person_identifiers of type 'name' (raw names captured at seed time)
 *   - person.linkedin_url-derived name (placeholder — not yet wired)
 *
 * Returns the highest-scoring candidate by `nameQuality()`. Source no longer
 * influences the pick — only the structural quality of the name string.
 *
 * @param {{ id: string, display_name: string|null, linkedin_url: string|null }} person
 * @param {Array<{ type: 'email'|'phone'|'linkedin_url'|'name', value: string }>} identifiers
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   contactsIndex?: { byEmail: Map, byPhone: Map },
 *   emailsSenderIndex?: Map<string,string>
 * }} [opts]
 * @returns {string|null}
 */
export function pickBestDisplayName(person, identifiers, db, opts = {}) {
  const ids = identifiers || [];
  const contactsIdx = opts.contactsIndex || _contactsCache || { byEmail: new Map(), byPhone: new Map() };
  // st_87a0d072 picker-inline (2026-05-13): if the caller pre-loaded the
  // emails sender index (via loadEmailsSenderIndex), use the O(1) Map lookup.
  // Otherwise fall back to the per-call DB query path (legacy: still used by
  // standalone backfill invocation that doesn't pre-load).
  const emailsIdx = opts.emailsSenderIndex || null;
  const candidates = [];

  // Current display_name on the row — counts as a candidate. WHY: if no
  // other source produces something better, we keep what's there.
  if (person && person.display_name) {
    candidates.push(person.display_name);
    if (person.display_name.includes('@')) {
      const localName = displayNameFromEmailLocal(String(person.display_name).replace(/[<>"]/g, ''));
      if (localName) candidates.push(localName);
    }
  }

  // Gmail header sender display names. Across every email row matching any
  // of the person's email identifiers, parse "First Last <addr>" and add
  // the parsed name to candidates.
  //
  // FAST PATH (Phase 2 Resolve, st_87a0d072 picker-inline): caller pre-loaded
  // the emails-sender index, so we just Map.get() per email identifier.
  // No per-call DB query, no statement prep.
  if (emailsIdx) {
    for (const id of ids) {
      if (id.type !== 'email') continue;
      const found = emailsIdx.get(String(id.value).toLowerCase());
      if (found) candidates.push(found);
    }
  } else if (db) {
    // SLOW PATH (legacy callers without pre-load — kept so the function
    // still works in isolation, e.g. unit tests with stub DBs or one-off
    // invocations from other scripts). WHY all rows up to 50: pathological
    // From: variants exist (e.g. one row spelling "J. Smith", 50 rows
    // spelling "Jane Smith"). We want the best of the lot, not the first.
    let senderStmt;
    try {
      senderStmt = db.prepare(
        "SELECT DISTINCT sender FROM emails WHERE LOWER(sender_email) = LOWER(?) AND sender IS NOT NULL LIMIT 50"
      );
    } catch { senderStmt = null; }
    if (senderStmt) {
      for (const id of ids) {
        if (id.type !== 'email') continue;
        let rows;
        try { rows = senderStmt.all(id.value); } catch { rows = []; }
        for (const r of rows) {
          const parsed = parseSender(r.sender);
          if (parsed.name) candidates.push(parsed.name);
        }
      }
    }
  }

  // Apple Contacts by email and phone — both proper-name and nickname
  // entries. Scoring sorts them out: "Marlowe Exampleton" beats "Mom" beats "ME".
  for (const id of ids) {
    if (id.type === 'email') {
      const localName = displayNameFromEmailLocal(id.value);
      if (localName) candidates.push(localName);
      const found = contactsIdx.byEmail.get(String(id.value).toLowerCase());
      if (found) candidates.push(found);
    } else if (id.type === 'phone') {
      const found = contactsIdx.byPhone.get(String(id.value));
      if (found) candidates.push(found);
    } else if (id.type === 'name') {
      // Raw 'name' identifier rows (e.g. "lk", "andrew exampleton") captured
      // at resolve-time. Add them — scoring decides if any beat what we have.
      candidates.push(id.value);
    }
  }

  // LinkedIn display name (placeholder — wired when surfaced in a queryable
  // column; today the CSV overlay populates linkedin_title separately).

  const picked = pickBestByScore(candidates);
  if (!picked || !person?.display_name) return picked;

  const current = normalizeNameString(person.display_name);
  if (!current || current.includes('@')) return picked;

  const currentScore = nameQuality(current);
  const pickedScore = nameQuality(picked);
  if (pickedScore > currentScore) return picked;
  if (pickedScore < currentScore) return current;
  if (!isProperlyCased(current) && isProperlyCased(picked)) return picked;
  return current;
}
