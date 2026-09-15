/**
 * workbench-promote-entities.js — deterministic entity-creation primitives for
 * promoting researched workbench/app records into the entity graph.
 *
 * Compute tier: Tier 0 (deterministic SQL) for every identity/create/merge
 * decision — NO LLM near identity, ever. The single optional LLM touch is
 * `compactResearchForPromotion`, which is Tier 1 (Haiku) and only fires when a
 * source body exceeds the context cap; it writes MARKDOWN ONLY (the LLM-write
 * boundary holds — no LLM writes a DB row/edge here).
 *
 * Identity ladder (st_483361e2):
 *   - company = real website domain → collision-guarded name-exact fallback.
 *     The domain is the company's unforgeable key (the company equivalent of a
 *     person's email); `uuid = sha1('domain:'+domain)` and the domain lands in
 *     the UNIQUE `company_domains` table, so two real companies can never
 *     collapse into one.
 *   - person = verified email/phone → Asana gid (provisional) → name-only is
 *     skip-by-default (a bare name has no unforgeable key against 36k people).
 *   - place = name (+ optional city) exact — the strongest available place
 *     signal; genuinely ambiguous places skip rather than mis-merge.
 *
 * `status: 'skipped'` is a first-class return (never an exception) so the
 * orchestration collects every skip with its reason into the owner-facing skip
 * report — "named to me, never silently dropped" (AC 5).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import config from './config.js';
import { llmCreate } from './llm-gateway.js';
import { findOrCreateCompany } from './entity-relationships.js';
import { matchPerson, resolvePerson, normalizeEmail, normalizePhone } from './entity-resolve.js';
import { modelFor } from './model-lane.js';

export const INTELLIGENCE_TIER = 'synthesis';

const REPO_ROOT = pathResolve(new URL('..', import.meta.url).pathname);

// --- tunables (config/defaults.json workbenchPromote.*, env-overridable) ------
let _defaults = null;
function promoteDefaults() {
  if (_defaults) return _defaults;
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(pathResolve(REPO_ROOT, 'config', 'defaults.json'), 'utf8')).workbenchPromote || {};
  } catch { /* defaults.json absent — fall back to hardcoded floors */ }
  _defaults = {
    compactMaxChars: Number(process.env.ROBOTDOJO_PROMOTE_COMPACT_MAX_CHARS || raw.compactMaxChars || 2400),
    compactMaxLines: Number(process.env.ROBOTDOJO_PROMOTE_COMPACT_MAX_LINES || raw.compactMaxLines || 78),
    domainLookupConcurrency: Number(process.env.ROBOTDOJO_PROMOTE_DOMAIN_CONCURRENCY || raw.domainLookupConcurrency || 6),
  };
  return _defaults;
}

export function promoteConfig() {
  return { ...promoteDefaults() };
}

// --- pure helpers -------------------------------------------------------------
function sha1(text) {
  return createHash('sha1').update(String(text || '')).digest('hex');
}

export function normalizePromotedName(raw) {
  return String(raw || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Hosts that are directories/aggregators, never a company's own website. A
// company's org page on one of these is NOT its identity — returning it as a
// domain would mass-merge every company sharing the aggregator host into one.
const AGGREGATOR_HOSTS = [
  'crunchbase.com', 'linkedin.com', 'twitter.com', 'x.com', 'facebook.com',
  'youtube.com', 'instagram.com', 'wikipedia.org', 'bloomberg.com',
  'pitchbook.com', 'angel.co', 'wellfound.com', 'medium.com', 'github.com',
  'apple.com', 'apps.apple.com', 'play.google.com', 'goo.gl', 'bit.ly',
];

export function isAggregatorHost(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h) return true;
  return AGGREGATOR_HOSTS.some((agg) => h === agg || h.endsWith(`.${agg}`));
}

/**
 * Normalize any URL or bare host to a canonical registrable domain:
 * lowercase, protocol/path/query stripped, leading `www.` removed. Returns null
 * for an aggregator host or an unparseable value.
 */
export function normalizeDomain(value) {
  let host = String(value || '').trim().toLowerCase();
  if (!host) return null;
  try {
    if (/^https?:\/\//.test(host)) host = new URL(host).hostname;
    else host = new URL(`https://${host}`).hostname;
  } catch {
    host = host.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!host || !host.includes('.') || /\s/.test(host)) return null;
  if (isAggregatorHost(host)) return null;
  return host;
}

// --- domain derivation --------------------------------------------------------
// Parses a Crunchbase-style CSV once into { normalizedOrgName -> Website }.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Legal-entity suffixes stripped ONLY for the CSV join key (never from the
// identity uuid key, which stays on normalizePromotedName). Conservative — only
// true corporate suffixes, never distinctive words like "Technologies"/"Labs".
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp',
  'corporation', 'co', 'gmbh', 'ag', 'sa', 'sas', 'bv', 'nv', 'plc',
  'holdings', 'holding',
]);

/**
 * A relaxed join key for matching a company name against the Crunchbase universe
 * CSV: normalized name with a leading "the" and trailing legal suffixes removed.
 * Used ONLY for the CSV website join — not as an identity key.
 */
export function csvJoinKey(raw) {
  let toks = normalizePromotedName(raw).replace(/^the /, '').split(' ').filter(Boolean);
  while (toks.length > 1 && LEGAL_SUFFIXES.has(toks[toks.length - 1])) toks.pop();
  return toks.join(' ');
}

/**
 * Load a company-name→Website map from one OR MORE Crunchbase-style CSVs (each
 * with an "Organization Name" + "Website" column). Later CSVs fill gaps; an
 * earlier positive website is never overwritten. Both an exact normalized key
 * and a legal-suffix-stripped relaxed key are indexed (exact wins on read).
 */
export function loadCsvDomainMap(csvRelPaths, { repoRoot = REPO_ROOT } = {}) {
  const paths = Array.isArray(csvRelPaths) ? csvRelPaths : [csvRelPaths];
  const map = new Map();
  for (const csvRelPath of paths) {
    if (!csvRelPath) continue;
    const abs = pathResolve(repoRoot, csvRelPath);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/).filter(Boolean);
    if (!lines.length) continue;
    const header = parseCsvLine(lines[0]);
    const nameIdx = header.indexOf('Organization Name');
    const webIdx = header.indexOf('Website');
    if (nameIdx < 0 || webIdx < 0) continue;
    for (let i = 1; i < lines.length; i++) {
      const f = parseCsvLine(lines[i]);
      const website = (f[webIdx] || '').trim();
      if (!website) continue;
      const exact = normalizePromotedName(f[nameIdx]);
      if (exact && !map.has(exact)) map.set(exact, website);
      const jk = `jk:${csvJoinKey(f[nameIdx])}`;
      if (jk !== 'jk:' && !map.has(jk)) map.set(jk, website);
    }
  }
  return map;
}

// Extracts the most-frequent non-aggregator host from a company's own
// deep-research HTML page (each page embeds the real company site). Slug is the
// same slugify the dashboard used to name the file.
function slugForHtml(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// News / PR / data-broker hosts a research page links heavily but which are
// never the company's own site. Rejected so extraction can't return them.
const NEWS_HOSTS = /investing\.com|stocktitan|prnewswire|businesswire|globenewswire|spacenews|nasaspaceflight|reuters|bloomberg|techcrunch|forbes|yahoo|marketwatch|sec\.gov|prweb|newswire|geekwire|axios|theverge|wsj\.com|nytimes|cnbc|fiercebiotech|statnews|endpts|biospace|pitchbook|govtribe|usaspending|sam\.gov|medium\.com|substack|prewswire|defensenews|breakingdefense|spaceflightnow|via\.tt|streetinsider|benzinga|seekingalpha|fool\.com|marketscreener|simplywall/i;
const GENERIC_NAME_WORDS = new Set(['space', 'energy', 'bio', 'labs', 'tech', 'technologies', 'technology', 'systems', 'industries', 'therapeutics', 'sciences', 'science', 'materials', 'robotics', 'motors', 'power', 'health', 'digital', 'global', 'group', 'the', 'and', 'company']);

function compact(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

// STRICT: a research page links many hosts; accept one as the company's own site
// ONLY when its registrable label strongly matches the company name — one
// contains the other (≥5 chars), or the name's first distinctive word (≥4 chars,
// non-generic) is in the label. This is what keeps "Sierra Space" from binding
// to nasaspaceflight.com. A wrong domain is worse than none (it is the identity
// key), so the bar is high.
function domainMatchesName(host, name) {
  const label = compact(String(host).split('.')[0]);
  const nm = compact(name);
  if (!label || !nm) return false;
  if (label.length >= 5 && nm.includes(label)) return true;
  if (nm.length >= 5 && label.includes(nm)) return true;
  const firstWord = String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).find((w) => w.length >= 4 && !GENERIC_NAME_WORDS.has(w));
  if (firstWord && label.includes(compact(firstWord))) return true;
  return false;
}

/**
 * Extract a company's real domain from its deep-research HTML page. The page is
 * named by the manifest record's own id (`pageId` → `{pageId}.html`); a slug
 * fallback covers older slug-named pages. Only a host that STRICTLY matches the
 * company name is accepted (news/PR hosts and generic-token false matches are
 * rejected) — an unmatched page returns null and the company falls through to
 * Hunter / the skip report.
 */
export function domainFromResearchPage(name, htmlDirRelPath, { repoRoot = REPO_ROOT, pageId = null } = {}) {
  if (!htmlDirRelPath) return null;
  const candidates = [];
  if (pageId) candidates.push(pathResolve(repoRoot, htmlDirRelPath, `${pageId}.html`));
  candidates.push(pathResolve(repoRoot, htmlDirRelPath, `${slugForHtml(name)}.html`));
  const abs = candidates.find((p) => existsSync(p));
  if (!abs) return null;
  let text = '';
  try { text = readFileSync(abs, 'utf8'); } catch { return null; }
  const urls = text.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^"'<> )]*/gi) || [];
  const counts = new Map();
  for (const u of urls) {
    if (NEWS_HOSTS.test(u)) continue;
    const d = normalizeDomain(u);
    if (!d || NEWS_HOSTS.test(d)) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  if (!counts.size) return null;
  // Prefer a name-matched host (most-frequent first); accept ONLY a name match.
  for (const [host] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (domainMatchesName(host, name)) return host;
  }
  return null;
}

async function domainFromHunter(name, hunterKey) {
  if (!hunterKey || !name) return null;
  try {
    const url = `https://api.hunter.io/v2/domain-search?company=${encodeURIComponent(name)}&limit=1&api_key=${hunterKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    return normalizeDomain(json?.data?.domain);
  } catch {
    return null; // network/timeout — graceful degradation, company goes to skip report
  }
}

// Brave web-search domain resolver — the primary lookup fallback (Hunter's free
// quota is tiny and exhausts; Brave has no such wall). Accepts a result host ONLY
// when it STRICTLY name-matches the company AND is not an aggregator/news host —
// the same "a wrong domain is worse than none" bar the HTML extractor uses, since
// the domain is the identity key. Returns null (→ next tier / skip) otherwise.
async function domainFromBrave(name, braveKey) {
  if (!braveKey || !name) return null;
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(`${name} official website`)}&count=10`;
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': braveKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const results = json?.web?.results || [];
    for (const r of results) {
      const d = normalizeDomain(r?.url); // normalizeDomain already rejects aggregator hosts
      if (!d || NEWS_HOSTS.test(d)) continue;
      if (domainMatchesName(d, name)) return d;
    }
    return null;
  } catch {
    return null; // network/timeout — graceful degradation
  }
}

/**
 * Derive a company's real website domain, in priority order:
 *   1. Crunchbase universe CSV `Website` column (exact org-name join).
 *   2. The company's own deep-research HTML page (embedded real site).
 *   3. Hunter domain-search API (the ≤N% remainder), when a key is provided.
 * Aggregator/directory hosts are rejected at every tier. Returns null when no
 * source can produce a real domain — the caller names that company to the owner.
 *
 * Sources are passed in (pre-loaded once) so a bulk run never re-reads the CSV.
 */
export async function deriveCompanyDomain(name, { csvMap, htmlDir, hunterKey, braveKey, pageId = null, repoRoot = REPO_ROOT } = {}) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  if (csvMap) {
    // Exact normalized name first; relaxed legal-suffix-stripped key second.
    const csv = normalizeDomain(csvMap.get(normalizePromotedName(clean)) || csvMap.get(`jk:${csvJoinKey(clean)}`));
    if (csv) return csv;
  }
  const html = domainFromResearchPage(clean, htmlDir, { repoRoot, pageId });
  if (html) return html;
  // Brave web search is the primary lookup fallback; Hunter is a last resort (its
  // free quota exhausts, so it usually contributes nothing) but kept for parity.
  const brave = await domainFromBrave(clean, braveKey);
  if (brave) return brave;
  return domainFromHunter(clean, hunterKey);
}

// --- uuid marking -------------------------------------------------------------
// The promoted-entity marker is the natural-key `uuid` (virgin UNIQUE column).
// Set only when absent so re-projection is idempotent and a pre-existing key is
// never clobbered. A UNIQUE conflict (two distinct rows deriving one key — which
// the derivation rules forbid) leaves the row untouched: fail-loud-safe.
function ensurePromotedUuid(db, table, id, keySeed) {
  const row = db.prepare(`SELECT uuid FROM ${table} WHERE id = ?`).get(id);
  if (!row) return false;
  if (row.uuid !== null && row.uuid !== undefined && row.uuid !== '') return false;
  try {
    db.prepare(`UPDATE ${table} SET uuid = ? WHERE id = ?`).run(sha1(keySeed), id);
    return true;
  } catch {
    return false; // UNIQUE conflict — leave the existing key in place
  }
}

function reload(db, table, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

/**
 * Deterministic company-merge decision, modeled on lib/people-merge.js
 * `shouldMerge` — returns merge / keep-separate / triage. Domain is the decider:
 * a shared domain merges; a candidate domain against an existing company's
 * DIFFERENT domains keeps them separate; a bare same-name collision with no
 * decisive domain signal is genuinely ambiguous → triage (surfaced, never
 * auto-merged). No LLM near identity.
 */
export function shouldMergeCompany(db, existingRow, { name, domain } = {}) {
  const normDomain = domain ? normalizeDomain(domain) : null;
  if (normDomain) {
    const owns = db.prepare('SELECT 1 FROM company_domains WHERE company_id = ? AND domain = ?').get(existingRow.id, normDomain);
    if (owns) return { decision: 'merge', guard: 'domain-exact' };
    const existingDomains = db.prepare('SELECT COUNT(*) n FROM company_domains WHERE company_id = ?').get(existingRow.id).n;
    if (existingDomains > 0) return { decision: 'keep-separate', guard: 'domain-mismatch' };
  }
  if (normalizePromotedName(existingRow.name) === normalizePromotedName(name)) {
    return {
      decision: 'triage',
      guard: 'ambiguous-name',
      triage: { reason: 'ambiguous-name-collision', name, existing_id: existingRow.id, existing_name: existingRow.name },
    };
  }
  return { decision: 'keep-separate', guard: 'distinct' };
}

/**
 * Find-or-create a company keyed on its real domain (strong key) with a
 * collision-guarded name-exact fallback. Dashboard-visible on creation (n1/n2
 * set by findOrCreateCompany). Never throws on ambiguity — returns
 * status:'skipped'.
 */
export function findOrCreatePromotedCompany(db, { name, domain, sourceRef } = {}) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw new Error('findOrCreatePromotedCompany: name required');
  const normDomain = domain ? normalizeDomain(domain) : null;

  if (normDomain) {
    // 1. Resolve by domain — the authoritative key.
    const byDomain = db.prepare(
      'SELECT c.* FROM companies c JOIN company_domains d ON d.company_id = c.id WHERE d.domain = ? LIMIT 1',
    ).get(normDomain);
    if (byDomain) {
      const created = ensurePromotedUuid(db, 'companies', byDomain.id, `domain:${normDomain}`);
      return { row: reload(db, 'companies', byDomain.id), status: created ? 'created_verified' : 'linked_existing_verified' };
    }
    // 2. Domain has no owner yet → get-or-create by name and attach it. The
    // uuid is stamped ONLY on the row that actually OWNS the domain after the
    // attach, so a name-created duplicate that loses the domain (the global
    // UNIQUE was claimed by another company — e.g. the live organic pipeline
    // running concurrently) never becomes a domainless "promoted" row. This is
    // the invariant AC 5 keys on: every uuid-marked company owns a domain.
    const preExisting = db.prepare('SELECT id FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1').get(trimmedName);
    const company = findOrCreateCompany(db, trimmedName);
    db.prepare(
      "INSERT OR IGNORE INTO company_domains (company_id, domain, created_at) VALUES (?, ?, datetime('now'))",
    ).run(company.id, normDomain);
    let owner = db.prepare(
      'SELECT c.* FROM companies c JOIN company_domains d ON d.company_id = c.id WHERE d.domain = ? LIMIT 1',
    ).get(normDomain);
    if (!owner) {
      // The INSERT was ignored yet no live company owns the domain → the
      // company_domains row is ORPHANED (its company_id points at a company a
      // prior wipe deleted without cascading — e.g. maintenance-phases'
      // DELETE FROM companies). Re-point the orphan to this company so the real
      // company reclaims its own domain instead of being wrongly skipped.
      const orphan = db.prepare('SELECT company_id FROM company_domains WHERE domain = ?').get(normDomain);
      if (orphan) {
        db.prepare('UPDATE company_domains SET company_id = ? WHERE domain = ?').run(company.id, normDomain);
        owner = db.prepare(
          'SELECT c.* FROM companies c JOIN company_domains d ON d.company_id = c.id WHERE d.domain = ? LIMIT 1',
        ).get(normDomain);
      }
    }
    if (!owner) {
      // Still no live owner — never stamp a domainless uuid; name it instead.
      return { row: reload(db, 'companies', company.id), status: 'skipped', reason: 'domain_attach_failed' };
    }
    const isNewOwner = String(owner.id) === String(company.id) && !preExisting;
    const created = ensurePromotedUuid(db, 'companies', owner.id, `domain:${normDomain}`);
    return { row: reload(db, 'companies', owner.id), status: (created && isNewOwner) ? 'created_verified' : 'linked_existing_verified' };
  }

  // No domain — name-exact with a collision guard (borrowed people-merge logic).
  const existingByName = db.prepare('SELECT * FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1').get(trimmedName);
  if (existingByName) {
    if (existingByName.uuid) {
      return { row: existingByName, status: 'linked_existing_name' }; // already promoted — idempotent
    }
    const verdict = shouldMergeCompany(db, existingByName, { name: trimmedName, domain: null });
    if (verdict.decision === 'merge') {
      ensurePromotedUuid(db, 'companies', existingByName.id, `corpus:${sourceRef?.source_file || ''}:${normalizePromotedName(trimmedName)}`);
      return { row: reload(db, 'companies', existingByName.id), status: 'linked_existing_name', reason: verdict.guard };
    }
    return {
      row: existingByName,
      status: 'skipped',
      reason: 'ambiguous_name_collision_with_existing_company',
      triage: verdict.triage || null,
    };
  }
  const company = findOrCreateCompany(db, trimmedName);
  ensurePromotedUuid(db, 'companies', company.id, `corpus:${sourceRef?.source_file || ''}:${normalizePromotedName(trimmedName)}`);
  return { row: reload(db, 'companies', company.id), status: 'created_name' };
}

/**
 * Find-or-create a person on a STRONG key only: verified email/phone → Asana
 * gid (provisional) → name-only is skip-by-default. A guessed email is NEVER an
 * identity input (the orchestration passes it as prose only), so a guessed key
 * can never mint or merge an identity row.
 */
export function findOrCreatePromotedPerson(db, { displayName, email, phone, linkedinUrl, asanaGid, sourceRef } = {}) {
  const name = String(displayName || '').trim();
  const normEmail = email ? normalizeEmail(email) : null;
  const normPhone = phone ? normalizePhone(phone) : null;

  // 1. Verified email/phone — a real, unforgeable key.
  if (normEmail || normPhone) {
    const match = matchPerson({ name, email: normEmail, phone: normPhone });
    if (match?.personId) {
      return { row: reload(db, 'people', match.personId), status: 'linked_existing_verified' };
    }
    const created = resolvePerson({ name, email: normEmail, phone: normPhone, source: 'workbench-promote' });
    if (created?.id) {
      ensurePromotedUuid(db, 'people', created.id, `email:${normEmail || ''}|phone:${normPhone || ''}`);
      return { row: reload(db, 'people', created.id), status: created.created ? 'created_verified' : 'linked_existing_verified' };
    }
    // resolvePerson returned null (blocklisted role account) → skip.
    return { row: null, status: 'skipped', reason: 'blocklisted_or_role_email' };
  }

  // 2. Asana gid — provisional identity (a real external id, not a guess).
  if (asanaGid) {
    const key = sha1(`asana:${asanaGid}`);
    const existing = db.prepare('SELECT * FROM people WHERE uuid = ? LIMIT 1').get(key);
    if (existing) return { row: existing, status: 'linked_existing_verified' };
    const id = `p_${Date.now()}_${sha1(`asana:${asanaGid}`).slice(0, 6)}`;
    db.prepare('INSERT OR IGNORE INTO people (id, display_name, source_count, uuid, created_at, updated_at) VALUES (?, ?, 1, ?, datetime(\'now\'), datetime(\'now\'))')
      .run(id, name || 'Unknown', key);
    const row = db.prepare('SELECT * FROM people WHERE uuid = ? LIMIT 1').get(key);
    return { row, status: 'created_provisional' };
  }

  // 3. Name-only — no unforgeable key against 36k people. Skip, name to owner.
  return { row: null, status: 'skipped', reason: 'no_strong_key_name_only' };
}

/**
 * Find-or-create a place on the strongest available signal (name, optionally
 * scoped by city). Places have no domain-equivalent, so a same-name collision
 * against a DIFFERENT city skips rather than mis-merge.
 */
export function findOrCreatePromotedPlace(db, { name, city, placeSubtype, sourceRef } = {}) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('findOrCreatePromotedPlace: name required');
  const subtype = String(placeSubtype || 'other').trim() || 'other';
  const existing = db.prepare('SELECT * FROM places WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1').get(clean);
  if (existing) {
    if (city && existing.address && !String(existing.address).toLowerCase().includes(String(city).toLowerCase())) {
      return { row: existing, status: 'skipped', reason: 'ambiguous_place_name_different_city' };
    }
    ensurePromotedUuid(db, 'places', existing.id, `place:${normalizePromotedName(clean)}:${normalizePromotedName(city || '')}`);
    return { row: reload(db, 'places', existing.id), status: 'linked_existing' };
  }
  const info = db.prepare(
    "INSERT INTO places (name, n1, n2, place_subtype, address, archived, created_at) VALUES (?, 'Place', 'World', ?, ?, 0, datetime('now'))",
  ).run(clean, subtype, city || null);
  const id = info.lastInsertRowid;
  ensurePromotedUuid(db, 'places', id, `place:${normalizePromotedName(clean)}:${normalizePromotedName(city || '')}`);
  return { row: reload(db, 'places', id), status: 'created' };
}

// --- research compaction (the only optional LLM touch) ------------------------
function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function deterministicCompact(text, maxChars, maxLines) {
  let out = stripMarkdown(text);
  const lines = out.split('\n');
  if (lines.length > maxLines) out = lines.slice(0, maxLines).join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars - 1).trimEnd() + '…';
  return out;
}

/**
 * Compact research prose to fit `promoteWorkbenchFinding`'s 2500-char/80-line
 * cap. Tier 0 (deterministic strip + truncate) is the default and the fallback;
 * Tier 1 (Haiku) only fires when the source exceeds the cap AND a key is
 * configured — it summarizes to preserve meaning instead of a blunt cut. Output
 * is MARKDOWN ONLY — no DB write (LLM-write boundary).
 */
export async function compactResearchForPromotion(sourceText, options = {}) {
  const cfg = promoteDefaults();
  const maxChars = Number(options.maxChars || cfg.compactMaxChars);
  const maxLines = Number(options.maxLines || cfg.compactMaxLines);
  const stripped = stripMarkdown(sourceText);
  const changeSummary = stripped.split('\n')[0].slice(0, 200) || 'Promoted workbench research.';

  if (stripped.length <= maxChars && stripped.split('\n').length <= maxLines) {
    return { changeSummary, body: stripped };
  }
  // Over cap: prefer a Haiku summary; degrade gracefully to truncation.
  if (config.anthropicKey) {
    try {
      const msg = await llmCreate({
        model: modelFor('fast'),
        max_tokens: 900,
        messages: [{
          role: 'user',
          content: `Compress the following research into dense factual markdown under ${maxChars} characters and ${maxLines} lines. Keep concrete facts (funding, HQ, founders, what the company does); drop filler. Output only the compressed markdown, no preamble.\n\n${stripped.slice(0, 12000)}`,
        }],
      }, 'workbench-promote-compact');
      const body = (msg?.content?.[0]?.text || '').trim();
      if (body) return { changeSummary, body: deterministicCompact(body, maxChars, maxLines) };
    } catch { /* fall through to deterministic truncation */ }
  }
  return { changeSummary, body: deterministicCompact(stripped, maxChars, maxLines) };
}
