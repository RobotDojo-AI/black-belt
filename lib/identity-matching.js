/**
 * lib/identity-matching.js — the pure deterministic identity-matching primitives
 * (df_cbd30a5a Phase 3 / AC-12). A LEAF module: it imports only node:fs / node:path
 * and lib/canonical-name.js (which itself imports nothing), so it breaks the
 * require-cycle that would otherwise form —
 *   people-merge → detect-over-merges → entity-unmerge → people-merge —
 * once the merge gate (lib/people-merge.js shouldMerge) needs the name tokenizers
 * AND the detector's cluster-coherence core.
 *
 * Two bodies of code MOVE here unchanged (behavior-preserving extraction, not a
 * rewrite) so there is ONE source of truth for each:
 *   - the name tokenizers formerly private to scripts/ingest/02-resolve.js
 *     (loadSurnameSet, loadNickCanon, nameTokens, dropMiddleInitialTokens,
 *      clusterKey, nameEncode). 02-resolve.js now imports + re-exports them; its
 *     existing dedup passes and tests are unchanged.
 *   - the detector's structural weld core formerly in
 *     scripts/ingest/detect-over-merges.js (localTokens, analyzeIdentifierGraph,
 *     scoreCandidate). detect-over-merges.js now imports + re-exports them; its
 *     CLI, --grep/--split paths, the maint_detect_over_merges routine, and
 *     tests/detect-over-merges.test.js are unchanged.
 *
 * New (AC-12) merge-decision primitives added here, all Tier-0 deterministic —
 * no LLM anywhere near identity:
 *   - nameAgreement()          maiden-name-aware name-agreement verdict.
 *   - buildPopularIdentifierSet() / isPopularIdentifier()  demote office lines /
 *     shared addresses held by many differently-named cards.
 *
 * INTELLIGENCE_TIER: extraction  (pure structural functions; no getAnthropicClient,
 *   no MODELS. Declared for the Intelligence Tier Protocol even though this is a
 *   lib/ leaf, because callers of these functions decide structured writes.)
 */

export const INTELLIGENCE_TIER = 'extraction';

import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { normalizeNameString } from './canonical-name.js';

// ── Identifier normalizers (match scripts/ingest/02-resolve.js exactly) ───────
// A colliding resolver identifier is stored lowercased (email) / +E.164-ish
// (phone); the popular-set membership test must compare like-for-like.
const normEmail = (s) => (typeof s === 'string' ? s.toLowerCase().trim() : null);
const normPhone = (s) => {
  if (!s) return null;
  const digits = String(s).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return digits.length >= 7 ? `+${digits}` : null;
};

// ── Name tokenizers (moved verbatim from 02-resolve.js) ───────────────────────
// Config loaded lazily + cached so unit tests and non-merge phases don't pay the
// read cost. Both are plain JSON shipped in config/.
let _surnameSet = null;
let _nickCanon = null;

export function loadSurnameSet() {
  if (_surnameSet) return _surnameSet;
  _surnameSet = new Set();
  try {
    const raw = readFileSync(pathResolve(process.cwd(), 'config/surnames-top-25K.json'), 'utf8');
    for (const k of Object.keys(JSON.parse(raw))) _surnameSet.add(k.toLowerCase());
  } catch { /* no config — every surname treated as common (conservative: G2 never fires) */ }
  return _surnameSet;
}

export function loadNickCanon() {
  if (_nickCanon) return _nickCanon;
  const map = new Map();
  try {
    const raw = readFileSync(pathResolve(process.cwd(), 'config/nicknames.json'), 'utf8');
    for (const [name, variants] of Object.entries(JSON.parse(raw))) {
      const cluster = [name, ...(Array.isArray(variants) ? variants : [])].map((v) => String(v).toLowerCase());
      const canon = cluster.slice().sort()[0];
      for (const v of cluster) if (!map.has(v) || map.get(v) > canon) map.set(v, canon);
    }
  } catch { /* identity canonicalization */ }
  _nickCanon = map;
  return _nickCanon;
}

/**
 * Raw normalized tokens: lowercased, diacritics-stripped, punctuation→space,
 * whitespace-collapsed — WITHOUT the nickname canonicalization. Used where the
 * literal token matters (e.g. email-local-part continuity: the local encodes the
 * name the person actually uses, "jane", not its cluster canon "genevieve").
 */
export function rawNameTokens(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return normalizeNameString(raw)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Tokenize a display name into normalized tokens: lowercased, diacritics-
 * stripped, punctuation→space, whitespace-collapsed. First token is canonical-
 * ized through the nickname table so "Mike"/"Michael" cluster together.
 */
export function nameTokens(raw) {
  const tokens = rawNameTokens(raw);
  if (tokens.length >= 1) tokens[0] = loadNickCanon().get(tokens[0]) || tokens[0];
  return tokens;
}

export function dropMiddleInitialTokens(tokens) {
  if (tokens.length <= 2) return tokens;
  return tokens.filter((token, idx) => idx === 0 || idx === tokens.length - 1 || token.length > 1);
}

/** Cluster key: nickname-canonicalized normalized full name, ≥2 tokens, else null. */
export function clusterKey(raw) {
  const t = dropMiddleInitialTokens(nameTokens(raw));
  return t.length >= 2 ? t.join(' ') : null;
}

/**
 * nameEncode(email, firstTok, lastTok): does the email local-part encode a
 * token of this person's name? local-part lowercased + non-alpha stripped
 * contains: the surname (len≥3), OR first-initial+surname, OR the first-name
 * token (len≥3). Random addresses do not encode a person's name → a positive
 * is strong same-person evidence.
 */
export function nameEncode(email, firstTok, lastTok) {
  if (!email) return false;
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  if (!local) return false;
  if (lastTok && lastTok.length >= 3 && local.includes(lastTok)) return true;
  if (firstTok && lastTok && local.includes(firstTok[0] + lastTok)) return true;
  if (firstTok && firstTok.length >= 3 && local.includes(firstTok)) return true;
  return false;
}

// ── Detector structural core (moved verbatim from detect-over-merges.js) ──────

/** Lowercased ≥3-char alpha tokens of an email local-part. */
export function localTokens(local) {
  return new Set(String(local).toLowerCase().replace(/[^a-z]/g, ' ').split(/\s+/).filter((t) => t.length >= 3));
}

/**
 * Analyze one identifier set. Union-find over email nodes: two link when their
 * local-parts share a ≥3-char name token (the same-person signal). A shared
 * DOMAIN is NOT a link — a corporate domain fuses unrelated people. Phones (no
 * local-part) are isolated singletons and never form a component.
 *
 * `flagged` = ≥2 DENSE disjoint components (each ≥2 identifiers) — dense, disjoint
 * name families, the exact live signal that flags the corporate-domain weld. At
 * merge time (AC-12 cluster-coherence cut) this is run on the UNION of the two
 * candidate records: a union that flags would join two name-disjoint sub-clusters
 * and is CUT (keep-separate + triage). Cost is O(k²) in the union's identifier
 * count k (per-person, k<~20), NOT O(n²) global.
 *
 * @param {{type:string, value:string}[]} idents
 * @returns {object} analysis
 */
export function analyzeIdentifierGraph(idents) {
  const n = idents.length;
  const meta = idents.map((i) => {
    const v = String(i.value).toLowerCase();
    if (i.type !== 'email' || !v.includes('@')) return { tokens: new Set(), domain: null };
    const [local, domain] = v.split('@');
    return { tokens: localTokens(local), domain: domain || null };
  });

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { let r = x; while (parent[r] !== r) r = parent[r]; while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; } return r; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const ma = meta[a];
      const mb = meta[b];
      if (!ma.tokens.size || !mb.tokens.size) continue; // only emails with name tokens link
      let linked = false;
      for (const t of ma.tokens) { if (mb.tokens.has(t)) { linked = true; break; } }
      if (linked) union(a, b);
    }
  }

  const compMap = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!compMap.has(r)) compMap.set(r, []); compMap.get(r).push(i); }
  const components = [...compMap.values()];
  const denseComponents = components.filter((c) => c.length >= 2).sort((x, y) => y.length - x.length);
  const distinctDomains = new Set(meta.map((m) => m.domain).filter(Boolean)).size;
  const flagged = denseComponents.length >= 2;

  return {
    identifierCount: n,
    componentCount: components.length,
    denseComponents,           // arrays of ident indices, size-desc
    denseComponentCount: denseComponents.length,
    minComponentSize: denseComponents.length ? denseComponents[denseComponents.length - 1].length : 0,
    distinctDomains,
    flagged,
    componentTokens: denseComponents.map((c) => {
      const toks = new Set();
      for (const idx of c) for (const t of meta[idx].tokens) toks.add(t);
      return [...toks];
    }),
  };
}

/** Structural weld score — higher = more weld-like. Rank descending. */
export function scoreCandidate(a) {
  return a.denseComponentCount * 3 + a.minComponentSize * 2 + a.identifierCount * 0.1 + a.distinctDomains * 0.5;
}

// ── (a) Name agreement — maiden-name-aware (AC-12 §(a)) ───────────────────────

/**
 * Parse a display name into { first, surnames } for agreement testing. A
 * parenthetical or `nee`/`née` surname is captured as an ALIAS surname so a name
 * like `First Married (Maiden)` or `First Maiden-Married` contributes surname set
 * {married, maiden} and agreement tests EACH surname. Middle initials are dropped;
 * every non-first token is a candidate surname (covers hyphenated + middle names).
 */
function parseNameForAgreement(name) {
  const raw = String(name || '');
  const aliasSurnames = new Set();
  // Parenthetical alias: "First Married (Maiden)".
  for (const m of raw.matchAll(/\(([^)]+)\)/g)) {
    for (const t of nameTokens(m[1])) if (t.length >= 2) aliasSurnames.add(t);
  }
  // nee / née alias: "First Married nee Maiden".
  const nee = raw.match(/\b(?:nee|n[eé]e)\s+([A-Za-z][A-Za-z'\-]+)/i);
  if (nee) for (const t of nameTokens(nee[1])) if (t.length >= 2) aliasSurnames.add(t);
  // Base tokens with the parenthetical/nee segment stripped so it doesn't skew
  // the first/last split.
  const stripped = raw.replace(/\([^)]*\)/g, ' ').replace(/\b(?:nee|n[eé]e)\s+[A-Za-z][A-Za-z'\-]+/gi, ' ');
  const base = dropMiddleInitialTokens(nameTokens(stripped));
  const first = base[0] || null;
  // The RAW first token (pre-nick-canon) is what an email local-part encodes.
  const firstRaw = dropMiddleInitialTokens(rawNameTokens(stripped))[0] || null;
  const surnames = new Set([...base.slice(1), ...aliasSurnames]);
  return { first, firstRaw, surnames, hasAlias: aliasSurnames.size > 0 };
}

/** Are two first-name tokens compatible (equal after nick-canon, or one is the
 * single initial of the other)? */
function firstCompatible(fA, fB) {
  if (!fA || !fB) return false;
  if (fA === fB) return true;
  if (fA.length === 1 && fB.startsWith(fA)) return true;
  if (fB.length === 1 && fA.startsWith(fB)) return true;
  return false;
}

/** Does any email in `idents` encode the first-name token (len≥3) in its local-part? */
function someEmailEncodesFirst(idents, firstTok) {
  if (!firstTok || firstTok.length < 3) return false;
  for (const i of (idents || [])) {
    if (i.type !== 'email') continue;
    const local = String(i.value).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
    if (local.includes(firstTok)) return true;
  }
  return false;
}

/**
 * Maiden-aware name-agreement verdict for a candidate merge.
 *   'agree'            → first-name compatible AND (a shared surname OR the same
 *                        first-name local-part appears on BOTH sides across a
 *                        surname change — unambiguous email-local continuity).
 *   'suspected-maiden' → first-names agree, surnames differ, no alias, and only
 *                        PARTIAL local continuity (one side encodes the first
 *                        name) → likely-but-unproven surname change → triage.
 *   'borderline'       → first-names agree, surnames differ, no alias, no
 *                        continuity signal at all.
 *   'disagree'         → first-names differ and no alias bridges them.
 *
 * @param {string} nameA
 * @param {string} nameB
 * @param {{type:string,value:string}[]} [identsA]
 * @param {{type:string,value:string}[]} [identsB]
 */
export function nameAgreement(nameA, nameB, identsA = [], identsB = []) {
  const A = parseNameForAgreement(nameA);
  const B = parseNameForAgreement(nameB);
  // No usable first token on a side → cannot confirm agreement; conservative
  // 'borderline' (routes to triage, never a silent auto-merge).
  if (!A.first || !B.first) return 'borderline';

  if (!firstCompatible(A.first, B.first)) return 'disagree';

  // Shared surname (including a parsed maiden/parenthetical alias) → agree.
  for (const s of A.surnames) if (B.surnames.has(s)) return 'agree';

  // Surnames differ. Email-local continuity across the surname change:
  //   full    → the shared first name appears in a local-part on BOTH sides.
  //   partial → only one side's local-part encodes the first name.
  // Uses each side's RAW first token — the local-part encodes the name the
  // person actually uses ("jane"), not its nickname cluster canon.
  const encA = someEmailEncodesFirst(identsA, A.firstRaw);
  const encB = someEmailEncodesFirst(identsB, B.firstRaw);
  if (encA && encB) return 'agree';
  if (encA || encB) return 'suspected-maiden';
  return 'borderline';
}

// ── (b) Popular-identifier frequency (AC-12 §(b)) ─────────────────────────────

/** The popular-identifier threshold: an identifier on ≥ this many differently-
 * named cards is an office line / shared address, never a personal identity. */
export function popularMinNames({ minNames } = {}) {
  const v = Number(minNames ?? process.env.ROBOTDOJO_POPULAR_IDENTIFIER_MIN_NAMES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 4;
}

/** A name-key for popular counting: the ≥2-token cluster key, else the single
 * normalized token (so "info" vs "support" still count as distinct names). */
function popularNameKey(rawName) {
  const ck = clusterKey(rawName);
  if (ck) return ck;
  const t = nameTokens(rawName);
  return t.length ? t.join(' ') : null;
}

/**
 * One Tier-0 pass over entity_candidates (the materialized bundle set for the
 * run). For each candidate's normalized email/phone identifiers, tally the
 * DISTINCT card-name keys carrying that value. An identifier whose distinct
 * name-key count ≥ minNames is popular (an office line / info@ / shared line held
 * by that many differently-named cards). Returns a Set<value>; membership is O(1)
 * at merge time. Linear in the candidate set — never O(n²).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{minNames?:number}} [opts]
 * @returns {Set<string>}
 */
export function buildPopularIdentifierSet(db, opts = {}) {
  const threshold = popularMinNames(opts);
  const byValue = new Map(); // value -> Set(nameKey)
  let rows;
  try {
    rows = db.prepare(
      "SELECT raw_name, raw_email, raw_phone, raw_location FROM entity_candidates WHERE candidate_type = 'person'",
    ).all();
  } catch {
    return new Set(); // entity_candidates absent (minimal test DB) → nothing popular
  }
  for (const r of rows) {
    const nameKey = popularNameKey(r.raw_name);
    if (!nameKey) continue;
    const values = [];
    const e = normEmail(r.raw_email); if (e) values.push(e);
    const p = normPhone(r.raw_phone); if (p) values.push(p);
    if (r.raw_location) {
      try {
        const extras = JSON.parse(r.raw_location);
        for (const ee of (extras.emails || [])) { const v = normEmail(ee); if (v) values.push(v); }
        for (const pp of (extras.phones || [])) { const v = normPhone(pp); if (v) values.push(v); }
      } catch { /* malformed bundle — primary values already counted */ }
    }
    for (const v of values) {
      let s = byValue.get(v);
      if (!s) { s = new Set(); byValue.set(v, s); }
      s.add(nameKey);
    }
  }
  const popular = new Set();
  for (const [v, names] of byValue) if (names.size >= threshold) popular.add(v);
  return popular;
}

/** Is this identifier value in the popular set? Safe on an absent/empty set. */
export function isPopularIdentifier(value, popularSet) {
  if (!value || !popularSet || typeof popularSet.has !== 'function') return false;
  return popularSet.has(String(value));
}

// ── Email-address classifier (single source of truth) ─────────────────────────
//
// A role/generic email (info@, investors@, no-reply@, an ESP/notification-domain
// address, or a machine-generated local part) is NOT an individual's identifier —
// attaching it to a PERSON is a data error ~100% of the time (owner-confirmed;
// ~2,479 role-local-part + ~537 system-domain emails were found on people in the
// live graph). This is the ONE robust classifier, imported by both the live
// pipeline (scripts/ingest/02-resolve.js) and the legacy resolver
// (lib/entity-resolve.js isBlocklistedEmail delegates here) so there is no drift.
//
// classifyEmailAddress() returns a THREE-WAY verdict — the seam a later offline
// LLM tier plugs into (this build stays deterministic Tier-0, no LLM):
//   'role'      — confident non-person: a blocklist local-part, a system/notification
//                 domain, or a strong machine-generated-local pattern → refuse/detach.
//   'person'    — confident individual: normal personal local-part structure
//                 (first.last, flast, first, …) on a normal domain → allow.
//   'uncertain' — the rules can't settle it (an unusual local on an unusual domain)
//                 → allow BUT flag for later adjudication.
//
// roleEmailReason() names WHICH of the three role layers fired (for by-reason
// reporting), evaluated in order:
//   (a) local-part blocklist  — role/department/automation word. Seeded from the
//       maintained upstream forwardemail reserved-usernames list (vendored at
//       config/reserved-email-local-parts.json) ∪ RFC 2142 role mailboxes ∪ a
//       curated set. The vendored list is local-part only and misses (b)/(c).
//   (b) system/notification DOMAIN — the whole domain is transactional/ESP/notification.
//   (c) pattern heuristics    — no-reply variants, timestamp/id-dominated locals,
//                               and long vowel-starved random locals.
// Precision floor: a normal personal local (`first.last`, `flast`, `first`, `casey`)
// classifies as 'person', and the 2-label freemail domains `mail.com` / `email.com`
// classify as 'person' despite the subdomain rule. Deterministic Tier-0.

// (a) Curated local-part seed. WHY local-part only: the same role word appears on
// every domain (info@acme.com, info@globex.com) — the local is the universal
// signal. Personal first/last names are deliberately EXCLUDED (see the ambiguous
// name set in 02-resolve.js). Unioned at load with the vendored upstream list and
// RFC 2142; the carve-out allowlist below is the escape hatch for a real person
// who legitimately uses a blocklist-looking address.
const CURATED_ROLE_LOCAL_PARTS = new Set([
  // no-reply / do-not-reply variants
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply',
  // info / contact / support
  'info', 'information', 'contact', 'contacts', 'hello', 'hallo', 'support',
  'helpdesk', 'help', 'care', 'customercare', 'customerservice', 'clientservices',
  'service', 'services', 'concierge', 'reception', 'frontdesk', 'front-desk',
  'enquiries', 'enquiry', 'inquiries', 'inquiry', 'questions', 'feedback',
  // admin / ops / infrastructure / automation
  'admin', 'administrator', 'sysadmin', 'root', 'webmaster', 'postmaster',
  'hostmaster', 'mailer', 'mailer-daemon', 'mailerdaemon', 'daemon', 'abuse',
  'noc', 'ops', 'operations', 'it', 'dev', 'devops', 'api', 'system', 'automated',
  'automation', 'robot', 'bot', 'svc', 'cron', 'monitor', 'monitoring', 'oncall',
  'pagerduty', 'status', 'dmarc', 'security',
  // sales / marketing / comms / press
  'sales', 'presales', 'marketing', 'media', 'press', 'pr', 'comms',
  'communications', 'news', 'newsletter', 'newsletters', 'digest', 'updates',
  'update', 'notifications', 'notification', 'notify', 'notices', 'notice',
  'alerts', 'alert', 'announce', 'announcements', 'social', 'community',
  'events', 'event', 'webinar', 'webinars', 'team', 'teams',
  // finance / billing / orders
  'billing', 'invoice', 'invoices', 'payment', 'payments', 'accounts', 'account',
  'accounting', 'finance', 'payroll', 'receipt', 'receipts', 'qbepay',
  'orders', 'order',
  // transactional reply lines
  'reply', 'replies',
  // HR / careers / org
  'hr', 'humanresources', 'careers', 'career', 'jobs', 'job', 'recruiting',
  'recruitment', 'recruiter', 'legal', 'leadership', 'office', 'office365',
  'workspace',
  // investors
  'investors', 'investor',
  // onboarding / lifecycle / auth
  'onboarding', 'welcome', 'subscribe', 'unsubscribe', 'unsub', 'verify',
  'verification', 'confirm', 'confirmation', 'register', 'registration', 'signup',
  'rsvp', 'claim', 'claims', 'ticket', 'tickets', 'membership', 'member', 'members',
  'subscription', 'subscriptions',
  // mail infrastructure locals
  'mail', 'email', 'e-mail', 'mailbox', 'bounce', 'bounces', 'listserv',
  'majordomo', 'distribution',
  // brand / product role addresses seen in the live data
  'appleid', 'calendar', 'travel', 'discover', 'donate', 'donations', 'giving',
  'partnerships',
]);

// RFC 2142 role mailboxes — the internet-standard reserved local parts every host
// is expected to accept for operational/business roles. Kept explicit even though
// the vendored list covers most, so the standard set holds even if the vendored
// file is ever absent.
const RFC2142_MAILBOXES = new Set([
  'postmaster', 'abuse', 'noc', 'security', 'hostmaster', 'webmaster', 'www',
  'ftp', 'usenet', 'news', 'info', 'marketing', 'sales', 'support',
]);

// Vendored upstream reserved-usernames list — forwardemail/reserved-email-addresses-list
// (https://github.com/forwardemail/reserved-email-addresses-list). Maintained,
// open-source, ~980 generic/admin/mailer-daemon/no-reply usernames incl. Unicode
// homoglyph variants. Vendored at config/reserved-email-local-parts.json.
// REFRESH: re-fetch the raw index.json from that repo and overwrite the vendored
// file — the loader below picks up the new entries with no code change.
let _reservedSet = null;
function reservedLocalPartSet() {
  if (_reservedSet) return _reservedSet;
  const set = new Set([...CURATED_ROLE_LOCAL_PARTS, ...RFC2142_MAILBOXES]);
  try {
    const raw = readFileSync(pathResolve(process.cwd(), 'config/reserved-email-local-parts.json'), 'utf8');
    for (const w of JSON.parse(raw)) {
      const v = String(w).toLowerCase().trim();
      if (v) set.add(v);
    }
  } catch { /* vendored file absent → curated ∪ RFC 2142 still holds */ }
  _reservedSet = set;
  return _reservedSet;
}

// (b) System / notification domains. Exact-or-suffix known transactional/ESP/
// notification domains — the WHOLE address is non-personal regardless of local.
const SYSTEM_DOMAIN_SUFFIXES = new Set([
  'messaging.microsoft.com',   // Microsoft 365 system notifications (office365@…)
  'theresumator.com',          // Jobvite/Resumator applicant-tracking automail (*.theresumator.com)
  'voice.google.com',          // Google Voice SMS→email forwarding (txt.voice.google.com)
  'sendgrid.net', 'sendgrid.com',
  'mailgun.org', 'mailgun.net',
  'amazonses.com',
  'sparkpostmail.com', 'sparkpostmail1.com',
  'mandrillapp.com',
  'mailjet.com',
  'sendinblue.com',
  'postmarkapp.com',
  'mcsv.net', 'mcdlv.net', 'rsgsv.net',   // Mailchimp delivery infra
  'createsend.com', 'cmail19.com', 'cmail20.com', // Campaign Monitor
  'mailer-daemon',
]);

// (b) Subdomain-prefix ESP/notification labels. The domain's FIRST label being one
// of these + the domain having ≥3 labels ⇒ a delivery/notification subdomain
// (bounce.acme.com, em.acme.com). The ≥3-label guard alone is NOT enough:
// bare `mail.`/`email.`/`e.` are DELIBERATELY EXCLUDED because institutional mail
// hosts (mail.university.edu, mail.<university>.edu, mail.<org>.<tld>) are REAL personal
// mailboxes, not notification senders. `mail.<esp>` is still caught by the explicit
// SYSTEM_DOMAIN_SUFFIXES list (mail.sendgrid.net ends with .sendgrid.net), never by
// a bare `mail.<anything>`. Only UNAMBIGUOUS delivery/notification prefixes stay here.
const SUBDOMAIN_PREFIXES = new Set([
  'bounce', 'bounces', 'mail-bounces', 'notifications', 'notification', 'mailer',
  'reply', 'replies', 'em', 'mg', 'smtp', 'sendgrid', 'mailgun', 'amazonses',
  'sparkpostmail',
]);

function isSystemDomain(domain) {
  if (!domain) return false;
  for (const d of SYSTEM_DOMAIN_SUFFIXES) {
    if (domain === d || domain.endsWith('.' + d)) return true;
  }
  // Subdomain-prefix rule — ≥3 labels so `mail.com`/`email.com` (2 labels) are safe.
  const labels = domain.split('.');
  if (labels.length >= 3 && SUBDOMAIN_PREFIXES.has(labels[0])) return true;
  return false;
}

// (c) Pattern heuristics — high precision. A normal `first.last`/`flast`/`first`
// local never matches any branch here.
function isNonPersonalLocalPattern(local) {
  if (!local) return false;
  // no-reply / do-not-reply variants not caught by the exact blocklist
  // (noreply2@, no-reply-billing@, donotreply1@…).
  if (/^(?:no[._-]?reply|do[._-]?not[._-]?reply)/.test(local)) return true;
  // A run of ≥10 consecutive digits (timestamp / message id) never appears in a
  // person's name-based local part → machine-generated (comm_20150106140714_…).
  if (/\d{10,}/.test(local)) return true;
  // Digit-dominant: ≥8 digits AND ≥40% of the local is digits → generated id.
  const digitCount = (local.match(/\d/g) || []).length;
  if (digitCount >= 8 && digitCount / local.length >= 0.4) return true;
  // Very long local (≥25 chars) whose longest alpha token is long and vowel-
  // starved → random hash (…_vypfbpz9044wdaxf). Real long personal locals
  // ("maria.fernanda.rodriguez") keep a normal vowel structure and pass.
  if (local.length >= 25 && looksRandomLocal(local)) return true;
  return false;
}

/** True when the local part's longest alpha-only token is ≥12 chars with a vowel
 * ratio < 0.2 — the signature of a random/opaque token, not a human name. */
function looksRandomLocal(local) {
  const tokens = local.split(/[^a-z]+/i).filter(Boolean);
  let longest = '';
  for (const t of tokens) if (t.length > longest.length) longest = t;
  if (longest.length < 12) return false;
  const vowels = (longest.match(/[aeiou]/gi) || []).length;
  return vowels / longest.length < 0.2;
}

// Carve-out allowlist: a real person who legitimately uses a blocklist-looking
// address (e.g. a founder who really is `hello@theirname.com`). Comma-separated
// full addresses in ROBOTDOJO_ROLE_EMAIL_ALLOW. Default empty ⇒ block. Memoized
// on the raw env value so the hot pipeline path never re-parses per identifier.
let _roleAllowRaw;
let _roleAllowSet = new Set();
function roleEmailAllowSet() {
  const raw = process.env.ROBOTDOJO_ROLE_EMAIL_ALLOW || '';
  if (raw !== _roleAllowRaw) {
    _roleAllowRaw = raw;
    _roleAllowSet = new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  }
  return _roleAllowSet;
}

/** Parse a raw email into { full, local, domain } lowercased, with plus-addressing
 * stripped from the local part (support+ticket9@… → support). null if malformed. */
function parseEmailParts(email) {
  if (!email || typeof email !== 'string') return null;
  const e = email.toLowerCase().trim();
  const at = e.lastIndexOf('@');
  if (at <= 0 || at === e.length - 1) return null; // not a well-formed address
  return { full: e, local: e.slice(0, at).replace(/\+.*$/, ''), domain: e.slice(at + 1) };
}

/**
 * Which role layer flags this email as non-personal, or null if none does.
 * Returns 'local-part' | 'domain' | 'pattern' | null. Used for by-reason reporting
 * and as the 'role' branch of classifyEmailAddress.
 */
export function roleEmailReason(email) {
  const p = parseEmailParts(email);
  if (!p) return null;
  if (roleEmailAllowSet().has(p.full)) return null;         // owner-carved real person
  if (reservedLocalPartSet().has(p.local)) return 'local-part';
  if (isSystemDomain(p.domain)) return 'domain';
  if (isNonPersonalLocalPattern(p.local)) return 'pattern';
  return null;
}

/**
 * Does the local part have a confident personal-name structure? 1–4 name-ish
 * tokens (dot/underscore/hyphen separated) of letters (with optional bounded
 * digits), at least one vowel, no long vowel-starved random token. High precision:
 * this is what separates a confident 'person' from an 'uncertain' address.
 */
function looksPersonalLocal(local) {
  if (!local) return false;
  if (!/^[a-z0-9._'-]+$/.test(local)) return false;         // personal charset only
  const alpha = local.replace(/[^a-z]/g, '');
  if (alpha.length < 2) return false;                       // 'x', '1' → not confidently a name
  if (!/[aeiou]/.test(alpha)) return false;                 // consonant-only → not a name
  const tokens = local.split(/[._'-]+/).filter(Boolean);
  if (tokens.length > 4) return false;                      // too many segments for a name
  for (const t of tokens) {
    const a = t.replace(/[^a-z]/g, '');
    if (a.length >= 12) {                                   // one very long token → check it's not random
      const vowels = (a.match(/[aeiou]/g) || []).length;
      if (vowels / a.length < 0.25) return false;
    }
  }
  return true;
}

/**
 * THREE-WAY email verdict — the deterministic seam for a later LLM adjudication
 * tier (no LLM in this build):
 *   'role'      → matched a reserved local part, a system/notification domain, or a
 *                 strong machine-generated-local pattern. Refuse/detach.
 *   'person'    → normal personal local-part structure on a normal domain. Allow.
 *   'uncertain' → neither confidently. Allow BUT flag for later adjudication.
 * Deterministic Tier-0 — no LLM.
 */
export function classifyEmailAddress(email) {
  const p = parseEmailParts(email);
  if (!p) return 'uncertain';                 // unparseable → cannot settle
  if (roleEmailReason(email)) return 'role';  // (honors the carve-out allowlist)
  if (looksPersonalLocal(p.local)) return 'person';
  return 'uncertain';
}

/**
 * Boolean convenience wrapper: true only for the confident 'role' verdict (the
 * robust "EVEN IF matched" rule). 'person' and 'uncertain' both return false —
 * uncertain is allowed, then flagged separately by the caller.
 */
export function isRoleOrGenericEmail(email) {
  return classifyEmailAddress(email) === 'role';
}
