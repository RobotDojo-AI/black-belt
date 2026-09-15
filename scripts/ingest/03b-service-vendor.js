/**
 * Phase 3b — Service-Vendor Pre-Sort (st_93fddaf0 Phase 5)
 *
 * Hakase's Gordian Knot: service contacts and personal friends are
 * incommensurable by interaction signals. A neighbor whose iMessage thread is
 * "garage door's open" gets the same volume as a lifelong friend. The fix is
 * categorical pre-sort, not score discrimination.
 *
 * Three-tier deterministic predicate (no LLM):
 *   Tier 0 — display_name keyword match (Pool, Lawn, Plumbing, Service, ...)
 *   Tier 1 — contacts-source-only people with high iMessage volume and ZERO
 *            email interaction (logistics-shape: texts only, never email)
 *   Tier 2 — relation_tag IS NULL guard so family / manual tags are never
 *            overridden
 *
 * Output: writes `service_vendor=1` on matching people. Downstream Phase 5
 * (05-score.js) caps service_vendor=1 rows to N2='Acquaintance'.
 *
 * INTELLIGENCE_TIER = 'extraction' (deterministic, no LLM).
 *
 * Idempotent: reset all service_vendor flags at start (clears stale matches),
 * then re-apply predicates. Safe to re-run on every pipeline pass.
 *
 * WHY a new phase between 02-resolve and 04-classify: 02-resolve creates the
 * person rows; 04-classify burns Haiku tokens for entity classification —
 * doing the cheap deterministic discrimination first saves classification
 * spend on rows that don't need it.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { ownerPersonId } from '../../lib/identity.js';

const KEYWORDS_PATH = resolve(process.cwd(), 'config', 'service-vendor-keywords.json');

/**
 * The owner's own half of the vendor lists (st_dd0e19d8 AC1). Gitignored, never
 * shipped, read at runtime — the same shape config/taxonomy.user.json and
 * config/source-topic-routing.user.json already use.
 *
 * MODULE-RELATIVE, deliberately, and NOT resolved from process.cwd() the way
 * KEYWORDS_PATH above is. `isSystemArtifact` is a live classification rule: if
 * this path missed, the owner's own mail would silently classify differently
 * depending on which directory the process started in. A CWD-relative override
 * is a classification bug waiting for a cron job. (KEYWORDS_PATH has the same
 * latent defect and is left alone here — changing it is outside this story.)
 */
const USER_KEYWORDS_PATH = new URL('../../config/service-vendor-keywords.user.json', import.meta.url);

/**
 * The brand names the owner's own inbox taught this classifier, read from his
 * gitignored override.
 *
 * WHY THESE MOVE RATHER THAN BEING REPLACED. AC1 is explicit and the reason is
 * correct: `BRAND_SERVICE_NAMES.has(brand)` is live at two call sites, so
 * swapping his company and the hotel for placeholders would change how his own
 * mail is sorted. A placeholder here is not a redaction, it is a behaviour
 * change. So the tracked file keeps only the genuinely generic brands and his
 * two entries move to a file that never ships. On his machine the union equals
 * the old hardcoded set exactly, which is what makes AC2's identical-
 * classification requirement hold by construction rather than by hope.
 */
function loadUserVendorLists() {
  try {
    const cfg = JSON.parse(readFileSync(USER_KEYWORDS_PATH, 'utf8'));
    const arr = (v) => (Array.isArray(v) ? v : []);
    // ALL THREE lists, not just the brands. Design §6.2: this module carries
    // three owner-inbox-derived lists, and the natural reading of AC1 ("the rest
    // of that list") scopes the move to BRAND_SERVICE_NAMES alone — which would
    // leave the other two silently assumed clean, the exact failure AC1's own
    // wording warns against.
    return { brands: arr(cfg.brands), localTokens: arr(cfg.localTokens), localSubstrings: arr(cfg.localSubstrings) };
  } catch {
    // Absent on a fresh install, in a published copy, and on anyone else's
    // machine. That is the designed state, not an error: the tracked generic
    // sets stand on their own.
    return { brands: [], localTokens: [], localSubstrings: [] };
  }
}

const USER_VENDOR_LISTS = loadUserVendorLists();
const SYSTEM_LOCAL_RE = /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|admin|administrator|support|help|info|contact|team|office|feedback|notification|notifications|alert|alerts|news|newsletter|marketing|sales|billing|invoice|receipts?|orders?|order_update|product-reservation|clientstatement|claimcorrespondence|concierge|appleid|workspace|security|infosec|notes)$/i;
// EXPORTED for the AC5 sweep (st_dd0e19d8). These three lists —
// SYSTEM_LOCAL_TOKENS, SYSTEM_LOCAL_SUBSTRINGS and BRAND_SERVICE_NAMES — were
// each built by reading the owner's own inbox, so every entry is an owner-review
// candidate by provenance rather than by any property a detector could measure.
// The sweep enumerates them from here rather than parsing this file, because a
// parser is a second definition of the list and the two drift the first time an
// entry is added.
export const SYSTEM_LOCAL_TOKENS = new Set([
  'account', 'accounts', 'accountstatus', 'admin', 'administrator', 'alert',
  'alerts', 'appleid', 'assistant', 'auto', 'billing', 'billpay', 'calendar',
  'claim', 'claims', 'client', 'concierge',
  'confirm', 'confirmation', 'confirmations', 'coned', 'contact',
  'correspondence', 'custserv', 'customer', 'customerservice', 'daemon',
  'discover', 'donotreply', 'econsent', 'efile', 'email', 'emailrelay', 'emails',
  'etickets', 'events', 'feedback', 'group', 'hello', 'help', 'hsbc', 'info',
  'infosec', 'invoice',
  'jewelersmutual', 'jobs', 'leadership', 'mailer', 'marketing', 'mba', 'mcinfo',
  'message', 'myorder', 'news', 'newsletter', 'newuser', 'ninjas', 'notification',
  'notifications', 'notifier', 'office', 'onepass', 'order', 'orders', 'owner',
  'payment', 'payments', 'pin', 'postmaster', 'printed', 'product', 'products', 'qbepay',
  'receipt', 'receipts', 'register', 'relay', 'reminder', 'reminders', 'reply',
  'reservas', 'reservation', 'resource', 'sales', 'security', 'service',
  'services', 'shipping', 'statement', 'support', 'system', 'team', 'ticket', 'tickets',
  'transfer', 'travel', 'update', 'updates', 'verify', 'welcome', 'workspace',
  ...USER_VENDOR_LISTS.localTokens,
]);
export const SYSTEM_LOCAL_SUBSTRINGS = [
  'a2atransfer',
  'aatransfer',
  'accountsreceivable',
  'arcompliancecontact',
  'bankruptcynoticing',
  'billingservices',
  'ayrheads',
  'claimcorrespondence',
  'clientstatement',
  'ciber',
  'customersatisfaction',
  'customerservice',
  'donotreply',
  'emailrelay',
  'electronicfilingcenter',
  'electronicticketreceipt',
  'hertztollprocessing',
  'coned',
  'jewelersmutual',
  'productreservation',
  'productmanagement',
  'propertyquotes',
  'qbepay',
  'recruitingannouncements',
  'siliconvalleybankcommercial',
  'surveymonkey',
  'webprod',
  'street',
  ...USER_VENDOR_LISTS.localSubstrings,
];
const SYSTEM_NAME_RE = /\b(?:support|help|feedback|notification|notifications|newsletter|billing|invoice|receipt|receipts|order|orders|reservation|statement|claims?|correspondence|workspace|security|infosec|calendar|resource|travel|casa|contact\s+center)\b/i;
const SYSTEM_ORG_NAME_RE = /\b(?:system|systems|team|services?|support|concierge|airlines?|bank|banking|insurance|alerts?|confirmations?|notifications?|newsletters?|billing|invoices?|receipts?|orders?|reservations?|security|customers?|customersupport|documents?\s+to\s+sign|division\s+of|technology\s+system|mortgage\s+banking|commercial\s+banking|tax\s+team|store\s+#?\d+)\b/i;
const COMPANY_SUFFIX_RE = /\b(?:inc|llc|ltd|llp|corp|corporation|company|co|group|holdings?|partners(?:hips?)?|ventures?|capital|strategies|solutions|technologies|technology|media|agency|foundation|association|university|school|bank|airlines?|insurance)\b/i;
const HUMAN_NAME_PARTICLE_RE = /^(?:da|de|del|der|di|du|la|le|van|von|st|st\.|mc|mac)$/i;
const HUMAN_NAME_SUFFIX_RE = /^(?:jr|jr\.|sr|sr\.|ii|iii|iv|phd|md|esq)$/i;
/**
 * The generic half — brands anyone's inbox produces. The owner's own two
 * entries live in config/service-vendor-keywords.user.json and are merged in
 * below; see loadUserBrands() for why they move rather than being replaced.
 *
 * Computed once at module load, exactly as the keyword regex is: this is a hot
 * predicate over every person row, and a per-call file read would show up.
 */
const GENERIC_BRAND_SERVICE_NAMES = [
  'affirm', 'airbnb', 'apple', 'eventbrite', 'facebook', 'figma', 'geico',
  'godaddy', 'linkedin', 'mercury', 'openai', 'orbitz', 'slack', 'tesla',
  'vanguard', 'zillow',
  'affinity real estate and mortgage services', 'angellist', 'asana personal',
  'mysql', 'numberfire',
  'printer', 'rhapsody', 'scout from bark', 'travelzoo', 'u s postal service',
  'untuckit',
];
export const BRAND_SERVICE_NAMES = new Set([
  ...GENERIC_BRAND_SERVICE_NAMES,
  ...USER_VENDOR_LISTS.brands.map(normalizeBrandName),
]);
const COMMON_DOMAIN_TLDS = new Set([
  'ai', 'app', 'au', 'biz', 'ca', 'cloud', 'co', 'com', 'de', 'dev', 'edu',
  'fr', 'gov', 'info', 'io', 'me', 'net', 'online', 'org', 'site', 'tech',
  'uk', 'us', 'xyz',
]);

function normalizeBrandName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokens(value) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9'#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function hasPersonNameShape(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.includes('@') || raw.includes('|')) return false;
  if (/[#0-9]/.test(raw)) return false;
  if (SYSTEM_ORG_NAME_RE.test(raw) || COMPANY_SUFFIX_RE.test(raw)) return false;
  const tokens = nameTokens(raw).filter((token) => !HUMAN_NAME_SUFFIX_RE.test(token));
  if (tokens.length < 2 || tokens.length > 5) return false;
  const nameLike = tokens.filter((token) => {
    if (HUMAN_NAME_PARTICLE_RE.test(token)) return true;
    if (token.length < 2) return false;
    if (!/^[A-Z][A-Za-z'’-]+$/.test(token)) return false;
    return !/^[A-Z]{2,}$/.test(token);
  });
  return nameLike.length === tokens.length;
}

function hasOrganizationNameShape(value) {
  const display = String(value || '').trim();
  if (!display) return false;
  if (display.includes('|')) return true;
  if (/\b\d{3}[- .]?\d{3}[- .]?\d{4}\b/.test(display)) return true;
  if (/\b\d{3,}\s*[-–]\s*\d{3,}\b/.test(display)) return true;
  if (/\b(?:store|dept|department)\s+#?\d+\b/i.test(display)) return true;
  if (SYSTEM_ORG_NAME_RE.test(display)) return true;
  if (!hasPersonNameShape(display) && COMPANY_SUFFIX_RE.test(display)) return true;
  if (/^[A-Z0-9& ]{4,}$/.test(display) && COMPANY_SUFFIX_RE.test(display)) return true;
  return false;
}

function hasBareDomainShape(value) {
  const display = String(value || '').trim();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(display)) return false;
  const tld = display.toLowerCase().split('.').pop();
  return COMMON_DOMAIN_TLDS.has(tld);
}

function isRandomCalendarAddress(email) {
  const raw = String(email || '').toLowerCase();
  if (/@(?:group|resource)\.calendar\.google\.com$/.test(raw)) return true;
  const local = raw.split('@')[0] || '';
  return /[a-f0-9]{16,}/i.test(local) && /calendar\.google\.com$/.test(raw);
}

export function isSystemEmailLocal(local) {
  const raw = String(local || '').toLowerCase();
  if (!raw) return false;
  if (/^\d{6,}$/.test(raw)) return true;
  if (SYSTEM_LOCAL_RE.test(raw)) return true;
  const tokens = raw
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const collapsed = tokens.join('');
  if (!collapsed) return false;
  if (/^class(?:of)?\d{2,4}$/.test(collapsed)) return true;
  if (tokens.some((token) => SYSTEM_LOCAL_TOKENS.has(token))) return true;
  if (SYSTEM_LOCAL_TOKENS.has(collapsed)) return true;
  if (collapsed.length > 4 && collapsed.startsWith('team')) return true;
  return SYSTEM_LOCAL_SUBSTRINGS.some((needle) => collapsed.includes(needle));
}

export function isSystemArtifact(person, identifiers = []) {
  if (person?.primary_source === 'qa_data_plane_proof') return true;
  const display = String(person?.display_name || '');
  const brand = normalizeBrandName(display);
  if (display.includes('@')) {
    const displayEmail = display.replace(/[<>]/g, '').toLowerCase();
    if (isRandomCalendarAddress(displayEmail)) return true;
    const displayLocal = displayEmail.split('@')[0] || '';
    const displayDomain = displayEmail.split('@')[1] || '';
    if (isSystemEmailLocal(displayLocal)) return true;
    if (displayDomain.includes('gtempaccount.com')) return true;
  }
  if (SYSTEM_NAME_RE.test(display)) return true;
  if (hasBareDomainShape(display)) return true;
  if (hasOrganizationNameShape(display)) return true;
  if (BRAND_SERVICE_NAMES.has(brand)) return true;

  for (const ident of identifiers) {
    if (ident.type !== 'email') continue;
    const email = String(ident.value || '').toLowerCase();
    if (isRandomCalendarAddress(email)) return true;
    const local = email.split('@')[0] || '';
    if (isSystemEmailLocal(local)) return true;
    if (BRAND_SERVICE_NAMES.has(brand)) {
      const domainRoot = (email.split('@')[1] || '').split('.').slice(-2, -1)[0] || '';
      if (domainRoot && BRAND_SERVICE_NAMES.has(domainRoot)) return true;
    }
  }
  return false;
}

/**
 * Load the keyword list from disk. Returns a {RegExp, sources} pair.
 * Falls back to a small built-in default if the config file is missing
 * (e.g. fresh install before vendor-keywords ships).
 */
function loadKeywords() {
  const fallback = ['Pool','Lawn','Plumbing','Electric','Cleaning','HVAC','Roofing','Salon','Spa','Repair'];
  if (!existsSync(KEYWORDS_PATH)) {
    return { keywords: fallback, source: 'fallback' };
  }
  try {
    const cfg = JSON.parse(readFileSync(KEYWORDS_PATH, 'utf8'));
    const all = [...(cfg.general || []), ...(cfg.audited || [])];
    return { keywords: all.length > 0 ? all : fallback, source: 'config' };
  } catch {
    return { keywords: fallback, source: 'fallback' };
  }
}

/**
 * Build a single OR-joined regex from the keyword list.
 * Word-boundary on both sides so "Pool" doesn't match "Pooley".
 * Multi-word phrases (e.g. "Down to Earth") use \b at the literal boundaries
 * — internal whitespace stays literal.
 *
 * WHY a single regex: O(N) display_name walk with one regex test() per row.
 * Sum-of-individual-tests is O(N*K).
 */
function buildServiceRegex(keywords) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = keywords.map(escape).join('|');
  return new RegExp(`\\b(?:${alternatives})\\b`, 'i');
}

/**
 * Phase 3b entry. Apply tiered service-vendor detection.
 *
 * @param {Function} log
 * @returns {{ flagged: number, byTier: {keyword: number, contactsOnly: number} }}
 */
export async function phaseServiceVendor(log) {
  log('\n=== Phase 3b: Service-Vendor Pre-Sort ===');

  const { default: db } = await import('../../lib/db.js');

  const { keywords, source } = loadKeywords();
  const re = buildServiceRegex(keywords);
  log(`  Keywords loaded from ${source}: ${keywords.length} terms`);

  // Pre-fetch all visible people once (5K rows is well under memory budget).
  const people = db.prepare(`
    SELECT id, display_name, primary_source, imessage_msg_count, relation_tag,
           COALESCE(service_vendor, 0) AS service_vendor
    FROM people
    WHERE archived = 0 AND relation_tag IS NULL
  `).all();

  const identifiersByPerson = new Map();
  try {
    for (const r of db.prepare(`
      SELECT pi.person_id, pi.type, pi.value
      FROM person_identifiers pi
      JOIN people p ON p.id = pi.person_id
      WHERE COALESCE(p.archived, 0) = 0
    `).all()) {
      if (!identifiersByPerson.has(r.person_id)) identifiersByPerson.set(r.person_id, []);
      identifiersByPerson.get(r.person_id).push(r);
    }
  } catch { /* person_identifiers absent in small test DBs */ }

  // Pre-fetch email interaction counts for Tier 1.
  // Map person_id → count. One indexed scan instead of N per-person SELECTs.
  const emailCounts = new Map();
  try {
    const rows = db.prepare(
      "SELECT person_id, COUNT(*) AS c FROM person_interactions WHERE channel='email' GROUP BY person_id"
    ).all();
    for (const r of rows) emailCounts.set(r.person_id, r.c);
  } catch { /* table absent in some test DBs */ }

  const flagged = new Set();
  let viaKeyword = 0;
  let viaContactsOnly = 0;

  // Tier 0: display_name keyword match
  for (const p of people) {
    if (!p.display_name) continue;
    if (re.test(p.display_name)) {
      flagged.add(p.id);
      viaKeyword++;
    }
  }

  // Tier 0b: deterministic service/system artifacts. These are not humans and
  // should never enter the person-search pool, even if they have many email or
  // calendar interactions.
  let viaSystemArtifact = 0;
  for (const p of people) {
    if (flagged.has(p.id)) continue;
    if (isSystemArtifact(p, identifiersByPerson.get(p.id) || [])) {
      flagged.add(p.id);
      viaSystemArtifact++;
    }
  }

  // Tier 1: contacts-sourced, high iMessage volume, zero email
  // (the "logistics-shape" signature: texts only, never email).
  // Threshold: imessage_msg_count > 20 — below this the signal is too thin.
  for (const p of people) {
    if (flagged.has(p.id)) continue;  // already flagged
    if (p.primary_source !== 'contacts') continue;
    if ((p.imessage_msg_count || 0) <= 20) continue;
    if ((emailCounts.get(p.id) || 0) > 0) continue;
    flagged.add(p.id);
    viaContactsOnly++;
  }

  // st_f67bc2eb — the OWNER's row is never a service vendor. The role-token
  // heuristic fired on the owner's own identifier set (role-looking
  // local-parts among his addresses), flagged the identity anchor
  // service_vendor=1, and 06-archive's vendor pass then buried it — every
  // owner relationship edge read as touching an archived person. Removing
  // the id from `flagged` makes the fixed-point write CLEAR a previously
  // mis-flagged owner row, so the graph anchor self-heals on the next run.
  const ownerId = String(ownerPersonId() || '');
  if (ownerId) flagged.delete(ownerId);

  // Apply fixed-point writes. relation_tag IS NULL guard (already in SELECT)
  // means family is never demoted. Only rows whose flag changes get updated.
  const setFlag = db.prepare("UPDATE people SET service_vendor=1, updated_at=datetime('now') WHERE id=? AND COALESCE(service_vendor,0) != 1");
  const clearFlag = db.prepare("UPDATE people SET service_vendor=0, updated_at=datetime('now') WHERE id=? AND COALESCE(service_vendor,0) != 0");
  let flagChanges = 0;
  let clearChanges = 0;
  db.transaction(() => {
    for (const p of people) {
      if (flagged.has(p.id)) flagChanges += setFlag.run(p.id).changes;
      else if (p.service_vendor) clearChanges += clearFlag.run(p.id).changes;
    }
  })();

  log(`  Service-vendor flagged: ${flagged.size} (${flagChanges} set, ${clearChanges} cleared; keyword=${viaKeyword}, system=${viaSystemArtifact}, contacts-only=${viaContactsOnly})`);

  return {
    flagged: flagged.size,
    changed: flagChanges + clearChanges,
    set: flagChanges,
    cleared: clearChanges,
    byTier: { keyword: viaKeyword, system: viaSystemArtifact, contactsOnly: viaContactsOnly },
  };
}
