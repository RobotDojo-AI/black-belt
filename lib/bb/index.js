/**
 * BB library exports — Black Belt domain functions (network graph, entity
 * matching, person resolution, family tree).
 *
 * st_bc949e7c (2026-05-15) Pass B Phase 3: merged in from RobotDojo-AI/black-belt
 * `src/lib/bb-exports.js`. Runtime gate is `isBBActive()` from lib/cohort/active.js,
 * checked at every BB call site in routes/scripts.
 *
 * All SQL access is lazy through getXxxStmts() helpers so this module loads
 * cleanly at boot before any tables exist (test envs use ROBOTDOJO_DB=:memory:).
 *
 * Original BB bundle source used a `_db` global injected by injectDb(); we
 * preserve that pattern by aliasing the real db singleton, so the bb-exports
 * code path is unchanged.
 */
import db from '../db.js';

const _db = db;

// ── Constants ──────────────────────────────────────────────────────────────────

export const ENTITY_MATCH_THRESHOLD = 0.85;

export const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me', 'zoho.com', 'mail.com',
  'ymail.com', 'gmx.com', 'gmx.net', 'fastmail.com', 'hey.com',
  'tutanota.com', 'pm.me', 'comcast.net', 'verizon.net', 'att.net',
]);

// ── Utilities ──────────────────────────────────────────────────────────────────

export function normalizeEmail(email) {
  if (!email) return null;
  return email.toLowerCase().trim();
}

export function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return null;
}

export function jaroWinkler(s1, s2) {
  if (!s1 || !s2) return 0;
  const a = s1.toLowerCase();
  const b = s2.toLowerCase();
  if (a === b) return 1;
  const aLen = a.length, bLen = b.length;
  const matchWindow = Math.max(0, Math.floor(Math.max(aLen, bLen) / 2) - 1);
  const aMatches = new Array(aLen).fill(false);
  const bMatches = new Array(bLen).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < aLen; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(bLen - 1, i + matchWindow);
    for (let j = lo; j <= hi; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true; bMatches[j] = true; matches++; break;
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  for (let i = 0; i < aLen; i++) {
    if (!aMatches[i]) continue;
    while (k < bLen && !bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / aLen + matches / bLen + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, aLen, bLen); i++) {
    if (a[i] === b[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function domainFromEmail(email) {
  if (!email || !email.includes('@')) return null;
  return email.split('@')[1].toLowerCase();
}

// ── Entity matching (lazy stmts) ───────────────────────────────────────────────

let _matcherStmts = null;
function getMatcherStmts() {
  if (!_matcherStmts) {
    _matcherStmts = {
      byEmail: _db.prepare(`SELECT pi.person_id FROM person_identifiers pi WHERE pi.type='email' AND pi.value=? LIMIT 1`),
      byPhone: _db.prepare(`SELECT pi.person_id FROM person_identifiers pi WHERE pi.type='phone' AND pi.value=? LIMIT 1`),
      byNameAndDomain: _db.prepare(`
        SELECT p.id FROM people p
        JOIN companies c ON p.company_id = c.id
        JOIN company_domains cd ON cd.company_id = c.id
        WHERE p.display_name = ? COLLATE NOCASE AND cd.domain = ?
        LIMIT 1
      `),
      byCompanyId: _db.prepare(`SELECT id, display_name FROM people WHERE company_id=? AND archived=0`),
      allPeopleByName: _db.prepare(`SELECT id, display_name, company_id FROM people WHERE display_name LIKE ? AND archived=0 LIMIT 50`),
    };
  }
  return _matcherStmts;
}

export function matchPerson(candidate, options = {}) {
  const { name, email, phone } = candidate;
  const ms = getMatcherStmts();

  if (email) {
    const norm = normalizeEmail(email);
    const row = ms.byEmail.get(norm);
    if (row) return { personId: row.person_id, confidence: 1.0, method: 'email-exact' };
  }
  if (phone) {
    const norm = normalizePhone(phone);
    if (norm) {
      const row = ms.byPhone.get(norm);
      if (row) return { personId: row.person_id, confidence: 1.0, method: 'phone-exact' };
    }
  }
  if (!name) return null;

  if (email) {
    const domain = domainFromEmail(email);
    if (domain) {
      const row = ms.byNameAndDomain.get(name, domain);
      if (row) return { personId: row.id, confidence: 0.9, method: 'name-domain' };
    }
  }

  const companyId = options.companyId || null;
  if (companyId) {
    const colleagues = ms.byCompanyId.all(companyId);
    for (const col of colleagues) {
      if (jaroWinkler(name, col.display_name) >= 0.92) {
        return { personId: col.id, confidence: 0.85, method: 'name-jw-company' };
      }
    }
  }

  const tokens = name.split(/\s+/);
  if (tokens.length < 2) return null;
  const prefix = tokens[0].slice(0, 3);
  if (prefix.length >= 2) {
    const candidates = ms.allPeopleByName.all(`${prefix}%`);
    for (const row of candidates) {
      if (jaroWinkler(name, row.display_name) >= 0.95) {
        return { personId: row.id, confidence: 0.75, method: 'name-jw-alone' };
      }
    }
  }
  return null;
}

// ── Person resolver (lazy stmts) ───────────────────────────────────────────────

const _EDUCATIONAL_TLDS = new Set(['.edu', '.ac.uk', '.edu.au', '.edu.sg', '.ac.jp']);
const _COMPANY_CREATION_SOURCES = new Set(['contacts', 'calendar']);
const _SOURCE_CONFIDENCE = { contacts: 1.0, calendar: 0.9, imessage: 0.85, transcript: 0.75, email: 0.6, unknown: 0.5 };

function _isEducationalDomain(d) {
  return _EDUCATIONAL_TLDS.has('.' + d.split('.').slice(-1)[0]) || d.endsWith('.edu') || d.includes('.edu.');
}

let _resolverStmts = null;
function getResolverStmts() {
  if (!_resolverStmts) {
    _resolverStmts = {
      insertPerson: _db.prepare(`
        INSERT INTO people (id, display_name, company_id, tier, confidence, source_count, primary_source, created_at, updated_at)
        VALUES (?, ?, ?, 'acquaintance', ?, 1, ?, datetime('now'), datetime('now'))
      `),
      bumpSourceCount: _db.prepare(`
        UPDATE people SET source_count=source_count+1, confidence=MAX(confidence,?), updated_at=datetime('now') WHERE id=?
      `),
      insertIdentifier: _db.prepare(`
        INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source, is_primary) VALUES (?, ?, ?, ?, ?)
      `),
      companyByDomain: _db.prepare(`SELECT company_id FROM company_domains WHERE domain=? LIMIT 1`),
      insertCompany: _db.prepare(`
        INSERT INTO companies (id, name, company_type, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `),
      insertDomain: _db.prepare(`INSERT OR IGNORE INTO company_domains (company_id, domain) VALUES (?, ?)`),
    };
  }
  return _resolverStmts;
}

export function resolveCompany(domain, source = 'unknown') {
  if (!domain) return null;
  const d = domain.toLowerCase();
  if (FREEMAIL_DOMAINS.has(d)) return null;
  const rs = getResolverStmts();
  const existing = rs.companyByDomain.get(d);
  if (existing) return existing.company_id;
  if (!_COMPANY_CREATION_SOURCES.has(source)) return null;
  const companyType = _isEducationalDomain(d) ? 'school' : 'company';
  const companyId = crypto.randomUUID();
  const name = d.replace(/\.(com|org|net|io|co|ai|xyz|dev|edu)$/i, '')
    .split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  rs.insertCompany.run(companyId, name, companyType);
  rs.insertDomain.run(companyId, d);
  return companyId;
}

function _addIdentifiers(personId, email, phone, source) {
  const rs = getResolverStmts();
  if (email) rs.insertIdentifier.run(personId, 'email', email, source, 0);
  if (phone) rs.insertIdentifier.run(personId, 'phone', phone, source, 0);
}

export function linkPerson(candidate) {
  const email = normalizeEmail(candidate.email);
  const phone = normalizePhone(candidate.phone);
  const name = candidate.name?.trim() || null;
  const source = candidate.source || 'unknown';
  const domain = domainFromEmail(email);
  const companyId = domain ? resolveCompany(domain, source) : null;
  const match = matchPerson({ name, email, phone }, { companyId });
  if (!match || match.confidence < 0.85) return null;
  _addIdentifiers(match.personId, email, phone, source);
  const conf = _SOURCE_CONFIDENCE[source] || 0.5;
  getResolverStmts().bumpSourceCount.run(conf, match.personId);
  return { personId: match.personId, confidence: match.confidence };
}

export function resolvePerson(candidate) {
  const email = normalizeEmail(candidate.email);
  const phone = normalizePhone(candidate.phone);
  const name = candidate.name?.trim() || null;
  const source = candidate.source || 'unknown';
  const domain = domainFromEmail(email);
  const companyId = domain ? resolveCompany(domain, source) : null;
  const conf = _SOURCE_CONFIDENCE[source] || 0.5;
  const match = matchPerson({ name, email, phone }, { companyId });
  const rs = getResolverStmts();

  if (match && match.confidence >= 0.85) {
    _addIdentifiers(match.personId, email, phone, source);
    rs.bumpSourceCount.run(conf, match.personId);
    return { personId: match.personId, created: false, confidence: match.confidence };
  }

  const personId = crypto.randomUUID();
  const displayName = name || email || phone || 'Unknown';
  rs.insertPerson.run(personId, displayName, companyId, conf, source);
  if (email) rs.insertIdentifier.run(personId, 'email', email, source, 1);
  if (phone) rs.insertIdentifier.run(personId, 'phone', phone, source, 1);
  if (name) rs.insertIdentifier.run(personId, 'name', name.toLowerCase(), source, 0);
  return { personId, created: true, confidence: conf };
}

// ── Network scoring (lazy stmts) ───────────────────────────────────────────────

let _scoringStmts = null;
function getScoringStmts() {
  if (!_scoringStmts) {
    _scoringStmts = {
      personById: _db.prepare(`
        SELECT p.*, c.name as company_name,
               p.class as ontology_class, p.subcategory as ontology_subcategory,
               p.class_confidence as ontology_confidence, p.class_sources as ontology_sources
        FROM people p LEFT JOIN companies c ON p.company_id=c.id WHERE p.id=?
      `),
      personIdentifiers: _db.prepare(`SELECT id, type, value, is_primary FROM person_identifiers WHERE person_id=?`),
      personEdges: _db.prepare(`
        SELECT pe.*, CASE WHEN pe.person_a=? THEN pe.person_b ELSE pe.person_a END as other_id
        FROM person_edges pe WHERE pe.person_a=? OR pe.person_b=? ORDER BY pe.weight DESC LIMIT 20
      `),
      personTopics: _db.prepare(`SELECT topic, weight FROM person_topics WHERE person_id=? ORDER BY weight DESC`),
      interactionBreakdown: _db.prepare(`
        SELECT channel, direction, COUNT(*) as count, MIN(date) as first_date, MAX(date) as last_date
        FROM person_interactions WHERE person_id=? GROUP BY channel, direction
      `),
      searchPeople: _db.prepare(`
        SELECT p.id, p.display_name, p.short_name, p.tier, p.score, p.company_id, c.name as company_name
        FROM people p LEFT JOIN companies c ON p.company_id=c.id
        WHERE p.archived=0 AND (p.display_name LIKE ? OR p.short_name LIKE ?)
        ORDER BY p.score DESC LIMIT ?
      `),
    };
  }
  return _scoringStmts;
}

function _personSection(tier, origin, relationTag) {
  if (relationTag) return 'personal';
  return origin === 'personal' ? 'personal' : 'professional';
}

function _yearsKnown(firstSeen) {
  if (!firstSeen) return null;
  return (Date.now() - new Date(firstSeen).getTime()) / (365.25 * 86400000);
}

function _getChannelCounts(personId) {
  try {
    const rows = _db.prepare(`SELECT channel, COUNT(*) as count FROM person_interactions WHERE person_id=? GROUP BY channel`).all(personId);
    const counts = {};
    for (const r of rows) counts[r.channel] = r.count;
    return counts;
  } catch { return {}; }
}

export function getPeople({ section, tier, limit = 50, offset = 0, klass = null, subcategory = null, n1 = null, n2 = null } = {}) {
  const sectionConditions = ['p.archived=0', 'p.score>0'];
  const ontologyParams = [];

  if (n1) {
    sectionConditions.push('p.n1=?'); ontologyParams.push(n1);
  } else if (klass) {
    sectionConditions.push('p.class=?'); ontologyParams.push(klass);
  } else if (section === 'personal') {
    sectionConditions.push("(p.n1='Personal' OR p.class='personal' OR (p.n1 IS NULL AND p.class IS NULL AND (p.relation_tag IS NOT NULL OR p.relationship_origin='personal')))");
  } else if (section === 'professional' || section === 'business') {
    sectionConditions.push("(p.n1='Professional' OR p.class='business' OR (p.n1 IS NULL AND p.class IS NULL AND p.relation_tag IS NULL AND (p.relationship_origin IS NULL OR p.relationship_origin!='personal')))");
  }

  if (n2) {
    sectionConditions.push('p.n2=?'); ontologyParams.push(n2);
  } else if (subcategory) {
    sectionConditions.push('p.subcategory=?'); ontologyParams.push(subcategory);
  }

  const sectionWhere = sectionConditions.join(' AND ');
  const outerConditions = [];
  const outerParams = [];
  if (tier) { outerConditions.push('ranked.tier=?'); outerParams.push(tier); }
  const outerWhere = outerConditions.length ? 'WHERE ' + outerConditions.join(' AND ') : '';

  const countSql = tier
    ? `SELECT COUNT(*) as total FROM people p WHERE ${sectionWhere} AND p.tier=?`
    : `SELECT COUNT(*) as total FROM people p WHERE ${sectionWhere}`;
  const countParams = [...ontologyParams, ...(tier ? [tier] : [])];
  const countRow = _db.prepare(countSql).get(...countParams);
  const total = countRow?.total || 0;

  const rows = _db.prepare(`
    SELECT * FROM (
      SELECT p.id, p.display_name, p.short_name, p.tier, p.score, p.personal_score, p.business_score,
             p.interaction_count, p.first_seen, p.last_seen, p.company_id, p.linkedin_title,
             p.imessage_msg_count, p.relationship_origin, p.consistency_score, p.archived,
             p.class, p.subcategory, p.class_confidence, p.class_sources, p.n1, p.n2, p.context_file_path,
             c.name as company_name,
             ROW_NUMBER() OVER (ORDER BY p.score DESC) as global_rank
      FROM people p LEFT JOIN companies c ON p.company_id=c.id
      WHERE ${sectionWhere}
    ) ranked ${outerWhere}
    ORDER BY ranked.global_rank LIMIT ? OFFSET ?
  `).all(...ontologyParams, ...outerParams, limit, offset);

  const items = rows.map(p => ({
    ...p,
    email_count: 0, cal_count: 0,
    imsg_count: p.imessage_msg_count || 0,
    years_known: _yearsKnown(p.first_seen),
    rank: p.global_rank,
  }));

  return { items, total };
}

export function getTopPeople(limit = 50) {
  return getPeople({ limit }).items;
}

export function getCoOccurrences(personId) {
  try {
    const rows = _db.prepare(`
      SELECT ce2.entity_id as id, COUNT(*) as score
      FROM chunk_entities ce1
      JOIN chunk_entities ce2 ON ce1.chunk_id=ce2.chunk_id AND ce2.entity_type='person' AND ce2.entity_id!=?
      WHERE ce1.entity_id=? AND ce1.entity_type='person'
      GROUP BY ce2.entity_id ORDER BY score DESC LIMIT 10
    `).all(personId, personId);
    if (rows.length === 0) return [];
    const ids = rows.map(r => r.id);
    const people = _db.prepare(`SELECT id, display_name FROM people WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const nameMap = Object.fromEntries(people.map(p => [p.id, p.display_name]));
    return rows.map(r => ({ id: r.id, name: nameMap[r.id] || null, score: r.score })).filter(r => r.name !== null);
  } catch { return []; }
}

export function getPersonProfile(personId) {
  const ss = getScoringStmts();
  const person = ss.personById.get(personId);
  if (!person) return null;
  return {
    ...person,
    years_known: _yearsKnown(person.first_seen),
    identifiers: ss.personIdentifiers.all(personId),
    edges: ss.personEdges.all(personId, personId, personId),
    topics: ss.personTopics.all(personId),
    interactions: ss.interactionBreakdown.all(personId),
    coOccurrences: getCoOccurrences(personId),
  };
}

export function searchPeople(query, limit = 20) {
  const pattern = `%${query}%`;
  return getScoringStmts().searchPeople.all(pattern, pattern, limit);
}

export function getNetworkStats() {
  const tierRows = _db.prepare(`
    SELECT tier, relationship_origin, relation_tag IS NOT NULL as has_tag, COUNT(*) as count
    FROM people WHERE archived=0 AND score>0
    GROUP BY tier, relationship_origin, has_tag
  `).all();

  const sections = { personal: {}, professional: {}, companies: {} };
  const peopleTierCounts = {};
  let total = 0;

  for (const row of tierRows) {
    total += row.count;
    peopleTierCounts[row.tier] = (peopleTierCounts[row.tier] || 0) + row.count;
    const sec = _personSection(row.tier, row.relationship_origin, row.has_tag);
    sections[sec][row.tier] = (sections[sec][row.tier] || 0) + row.count;
  }

  const companyRows = _db.prepare(`SELECT n2, COUNT(*) as count FROM companies WHERE n2 IS NOT NULL AND n2!='' GROUP BY n2`).all();
  for (const row of companyRows) sections.companies[row.n2] = row.count;

  try {
    const placeRows = _db.prepare("SELECT place_type, COUNT(*) as count FROM places GROUP BY place_type").all();
    sections.places = {};
    for (const row of placeRows) sections.places[row.place_type] = row.count;
  } catch { sections.places = {}; }

  try {
    const n1n2Rows = _db.prepare(`
      SELECT n1, n2, COUNT(*) as count FROM people
      WHERE archived=0 AND score>0 AND n1 IS NOT NULL AND n2 IS NOT NULL
      GROUP BY n1, n2
    `).all();
    sections.n1n2 = {};
    for (const row of n1n2Rows) {
      if (!sections.n1n2[row.n1]) sections.n1n2[row.n1] = {};
      sections.n1n2[row.n1][row.n2] = row.count;
    }
    sections.n1n2['Company'] = {};
    for (const [label, count] of Object.entries(sections.companies)) sections.n1n2['Company'][label] = count;
  } catch { sections.n1n2 = {}; }

  return { total, sections, peopleTierCounts };
}

// ── Family tree (lazy stmts) ───────────────────────────────────────────────────

let _familyStmts = null;
function getFamilyStmts() {
  if (!_familyStmts) {
    _familyStmts = {
      personsByRelationTag: _db.prepare(`
        SELECT p.id, p.display_name, p.relation_tag, p.tier, p.score, c.name as company_name
        FROM people p LEFT JOIN companies c ON p.company_id=c.id
        WHERE p.relation_tag IS NOT NULL AND p.archived=0 ORDER BY p.score DESC
      `),
      sharedLastName: _db.prepare(`SELECT id, display_name, tier, score FROM people WHERE archived=0 AND display_name LIKE ? ORDER BY score DESC LIMIT 20`),
    };
  }
  return _familyStmts;
}

const _FAMILY_ORDER = ['spouse','child','parent','sibling','sibling-in-law','parent-in-law','niece-nephew','aunt-uncle','cousin','grandparent'];

function _normalizeRelation(tag) {
  if (!tag) return 'unknown';
  const t = tag.toLowerCase().trim();
  if (['wife','husband','partner','spouse'].includes(t)) return 'spouse';
  if (['son','daughter','child'].includes(t)) return 'child';
  if (['mother','father','mom','dad','parent'].includes(t)) return 'parent';
  if (['brother','sister','sibling'].includes(t)) return 'sibling';
  if (['brother-in-law','sister-in-law','bil','sil'].includes(t)) return 'sibling-in-law';
  if (['mother-in-law','father-in-law','mil','fil'].includes(t)) return 'parent-in-law';
  if (['niece','nephew'].includes(t)) return 'niece-nephew';
  if (['aunt','uncle'].includes(t)) return 'aunt-uncle';
  if (['cousin'].includes(t)) return 'cousin';
  if (['grandmother','grandfather','grandparent'].includes(t)) return 'grandparent';
  return 'other';
}

export function getFamilyTree() {
  const people = getFamilyStmts().personsByRelationTag.all();
  const grouped = {};
  for (const p of people) {
    const category = _normalizeRelation(p.relation_tag);
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(p);
  }
  const ordered = [];
  for (const cat of _FAMILY_ORDER) {
    if (grouped[cat]) { ordered.push({ category: cat, members: grouped[cat] }); delete grouped[cat]; }
  }
  for (const [cat, members] of Object.entries(grouped)) ordered.push({ category: cat, members });
  return ordered;
}

export function findNameClusters(lastName) {
  return getFamilyStmts().sharedLastName.all(`% ${lastName}`);
}

export function getFamilyStats() {
  const tree = getFamilyTree();
  return { total: tree.reduce((s, g) => s + g.members.length, 0), categories: tree.map(g => ({ category: g.category, count: g.members.length })) };
}

// ── Address timeline ───────────────────────────────────────────────────────────

/**
 * Read residence periods from timeline_events. Source of truth lives in the
 * BB address-timeline pipeline (scripts/rebuild/phase-*) which writes
 * `source_type='address'` rows. The reader is in this module so routes can
 * call `bb.getAddressHistory()` directly post-consolidation.
 */
export function getAddressHistory() {
  try {
    return _db.prepare(`
      SELECT id, event_date, summary, metadata FROM timeline_events
      WHERE source_type = 'address' ORDER BY event_date ASC
    `).all().map(e => {
      const m = JSON.parse(e.metadata || '{}');
      return { address: m.address, city: m.city, state: m.state, zip: m.zip,
        from_date: m.from_date, to_date: m.to_date, total_hits: m.total_hits };
    });
  } catch { return []; }
}

// ── Pipeline stubs ─────────────────────────────────────────────────────────────
//
// The address-timeline / entity-extraction / professional-extraction pipelines
// are heavy multi-file modules whose full source lives in the BB repo's
// `scripts/build.js`-concatenated bundle. The runtime entrypoints below are
// safe-degraded stubs so direct imports succeed in the post-consolidation
// repo; the actual implementations will land as future BB code drops (the
// surface is preserved verbatim so call sites do not change).
//
// WHY stubs not implementations: each pipeline depends on auxiliary modules
// (address-extract.js, anthropic-client tier-1 calls, etc.) that need a
// dedicated story to merge. This story (st_bc949e7c) ships the runtime gate
// and direct-import contract; pipeline depth is a separate scope.

export function rebuildAllAddressTimelines() {
  return { people_processed: 0, rows_written: 0, note: 'bb pipeline stub — see lib/bb/index.js' };
}

export async function extractBatch(_personIds = [], _options = {}) {
  return { extracted: 0, domainOnly: 0, skipped: 0, costUsd: 0, note: 'bb pipeline stub — see lib/bb/index.js' };
}

export function classifyPlace(_placeId) { return null; }
export function classifyVenue(_placeId) { return null; }

export async function backfillClassifications(_opts = {}) {
  return { people: 0, places: 0, note: 'bb pipeline stub — see lib/bb/index.js' };
}
