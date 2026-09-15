/**
 * lib/entity-floor.js — the deterministic turn-1 structured floor (st_c619d929).
 *
 * The never-stale safety net under the prose card. For every recognized
 * non-owner entity, `buildEntityFloor(db, entity)` assembles — from indexed
 * reads only, no model — the entity's current facts (role/employer/location),
 * a ranked+capped first-degree edge set, an owner-connection line, and the
 * AC-10 "as of" cue. It lands in the VOLATILE chat context (query-dependent →
 * never the cached system prefix), rendered under each `### {name}`.
 *
 * Two invariants make this safe on the fast path:
 *   1. Tier 0 — deterministic SQL → string. No LLM ever writes into the floor,
 *      so a floor line is never a hallucination; every name traces to a row.
 *   2. Bounded, index-ordered reads. The weighted top-N read rides the
 *      (entity_id, weight DESC) covering index (migration 139) so a
 *      high-degree person is an index-ordered LIMIT, not a worker-thread sort
 *      — the chat-speed P0 guard (F1). Every read is a bounded indexed slice
 *      (≤3 per entity, cap 12), memoized, best-effort; the source-backed
 *      timeline stays OFF the fast path exactly as before.
 *
 * EDGE FIREWALL (replicates ego-render.js invariant 1 at the per-entity layer):
 * curated person_relations edges are the truth layer (kinship-first); the
 * weighted entity_relationships graph fills the remaining slots but a
 * co-occurrence colleague edge (weight 11.8) can NEVER outrank or mask a
 * curated spouse (weight 10) into "colleague" because (a) any counterparty
 * that already has a curated edge is removed from the weighted list before
 * ranking, and (b) kinship-capable weighted types are dropped entirely, never
 * merely down-ranked. One ranking helper (`rankedFirstDegreeEdges`) is reused
 * by both the floor and the card generator, so both rank edges identically.
 *
 * PROVENANCE WEIGHTING (design-unified-architecture.md §3.3, st_1b2ee2f0 chunk
 * 6): within the weighted layer itself, a counterparty can now carry edges
 * from multiple sources of different trust (e.g. a primary-source
 * company_affiliation edge AND a low-trust email_cc_copresence CC-thread
 * edge for the same pair). Each row's normalized weight is multiplied by
 * `lib/provenance.js`'s `edgeSourceTrust(source)` (1.0 for a structural
 * source, 0.2 for an inferred one) before ranking, and only the
 * highest-scoring row per counterparty survives — so an inferred edge can
 * never outrank, and never masks, a primary-source edge of equal or greater
 * raw weight. Weighting, not deletion.
 */

import { LRUCache } from 'lru-cache';
import { getActiveEdgesForPerson, authorityRank } from './relation-store.js';
import { relationPhrase } from './relation-vocabulary.js';
import { ownerPersonId } from './identity.js';
import { edgeSourceTrust } from './provenance.js';

// ── Tunables (named consts, env-overridable — no literal buried in logic) ──────
function intEnv(name, dflt) {
  const n = Number.parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function numEnv(name, dflt) {
  const n = Number.parseFloat(String(process.env[name] ?? ''));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// Cap the floor's first-degree set. Zep's production analog caps the ego-net to
// ~10–20 edges; 12 is the "strongest few lead" ceiling the scope names (AC-2).
const FLOOR_EDGE_CAP = intEnv('ROBOTDOJO_FLOOR_EDGE_CAP', 12);
// Per-entity floor memo. Same short-TTL rationale as chat-context's span memo —
// the same entity is enriched twice per turn (query + rolling window) and a
// span can fan out to the same id; a rename/tier change reflects within TTL.
const FLOOR_MEMO_TTL_MS = intEnv('ROBOTDOJO_FLOOR_MEMO_TTL_MS', 60_000);
const FLOOR_MEMO_MAX = intEnv('ROBOTDOJO_FLOOR_MEMO_MAX', 2000);
// Over-fetch the weighted list before the firewall/allowlist filter + MMR so a
// person whose top-weight neighbors are all curated/kinship still yields a full
// cap of professional lines. Bounded by the covering index either way.
const WEIGHTED_FETCH_MULTIPLIER = intEnv('ROBOTDOJO_FLOOR_WEIGHTED_FETCH_MULT', 3);
// Ranking weights for the weighted layer. normalized weight (mention-frequency
// proxy) + recency + an owner-proximity bonus, then MMR type-diversity penalty.
const OWNER_PROXIMITY_BONUS = numEnv('ROBOTDOJO_FLOOR_OWNER_BONUS', 0.5);
const MMR_TYPE_PENALTY = numEnv('ROBOTDOJO_FLOOR_MMR_PENALTY', 0.15);
const RECENCY_HALFLIFE_DAYS = intEnv('ROBOTDOJO_FLOOR_RECENCY_HALFLIFE_DAYS', 730);

// Freshness-health alarm thresholds (AC-9). Past any of these the health body
// flags degradation so a stalled freshness circuit is visible, not silent.
const DIRTY_BACKLOG_ALARM = intEnv('ROBOTDOJO_FRESHNESS_DIRTY_ALARM', 1000);
const STALE_CARD_ALARM_HOURS = numEnv('ROBOTDOJO_FRESHNESS_STALE_HOURS', 72);
const ROUTINE_STALE_ALARM_HOURS = numEnv('ROBOTDOJO_FRESHNESS_ROUTINE_STALE_HOURS', 48);

// Kinship-capable weighted types. These are DROPPED from the weighted layer
// entirely — never down-ranked — so the co-occurrence graph can never speak to
// a kinship/close-personal relationship. Curated person_relations is the ONLY
// source that may render these. (Mirrors ego-render.js invariant 1.)
const WEIGHTED_KINSHIP_TYPES = new Set([
  'spouse', 'former-spouse', 'family', 'former-family',
  'romantic-partner', 'former-romantic-partner',
  'friend', 'former-friend', 'pet',
]);

const CARD_MATERIAL_FACT_TYPES = ['job_title', 'employer', 'location'];
const RICH_FACT_TYPES = [
  'job_title', 'employer', 'location', 'role', 'title',
  'email', 'phone',
  'relationship_label', 'relation_tag',
  'industry', 'website', 'url',
  'birthday', 'born',
  'nickname', 'also_known_as',
  'school', 'education',
  'bio_note',
];
const RICH_FACT_CAP = intEnv('ROBOTDOJO_FLOOR_RICH_FACT_CAP', 12);
const FACT_TYPE_LABELS = {
  job_title: 'Role',
  employer: 'Employer',
  location: 'Location',
  role: 'Role',
  title: 'Title',
  email: 'Email',
  phone: 'Phone',
  relationship_label: 'Relationship',
  relation_tag: 'Relationship',
  industry: 'Industry',
  website: 'Website',
  url: 'Website',
  birthday: 'Birthday',
  born: 'Born',
  nickname: 'Also known as',
  also_known_as: 'Also known as',
  school: 'School',
  education: 'Education',
  bio_note: 'Note',
};

const _floorMemo = new LRUCache({ max: FLOOR_MEMO_MAX, ttl: FLOOR_MEMO_TTL_MS });

// ── Owner first-degree set (memoized; owner is constant per process) ──────────
// Used both for the weighted-layer owner-proximity bonus and the "connected to
// you through {name}" business owner line — computed once from the ranked edges
// already in hand, no extra per-turn query.
let _ownerNeighborCache = { ownerId: null, at: 0, set: new Set() };
function ownerFirstDegreeSet(db, ownerIdOverride) {
  let ownerId;
  try {
    ownerId = ownerIdOverride !== undefined ? ownerIdOverride : ownerPersonId();
  } catch { ownerId = null; }
  if (!ownerId) return new Set();
  ownerId = String(ownerId);
  const now = Date.now();
  if (_ownerNeighborCache.ownerId === ownerId && now - _ownerNeighborCache.at < FLOOR_MEMO_TTL_MS) {
    return _ownerNeighborCache.set;
  }
  const set = new Set();
  try {
    for (const e of getActiveEdgesForPerson(db, ownerId)) {
      const cp = String(e.person_a) === ownerId ? String(e.person_b) : String(e.person_a);
      set.add(cp);
    }
  } catch { /* people/person_relations absent in minimal fixtures — best effort */ }
  _ownerNeighborCache = { ownerId, at: now, set };
  return set;
}

function recencyScore(ts, nowMs) {
  if (!ts) return 0;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return 0;
  const days = (nowMs - t) / 86_400_000;
  // Linear decay: today → 0.5, RECENCY_HALFLIFE_DAYS ago → 0. Bounded [0,0.5].
  return Math.max(0, 0.5 * (1 - days / RECENCY_HALFLIFE_DAYS));
}

// Greedy MMR: pick the highest-scoring edge, then penalize each subsequent edge
// of an already-picked relationship_type so the capped set is not ten
// near-duplicate colleague lines (Zep's MMR reranker, deterministic form).
function mmrDiversify(items, cap) {
  const out = [];
  const typeCount = new Map();
  const pool = [...items];
  while (out.length < cap && pool.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const penalty = (typeCount.get(pool[i].relType) || 0) * MMR_TYPE_PENALTY;
      const val = pool[i].score - penalty;
      if (val > bestVal) { bestVal = val; bestIdx = i; }
    }
    const [chosen] = pool.splice(bestIdx, 1);
    typeCount.set(chosen.relType, (typeCount.get(chosen.relType) || 0) + 1);
    out.push(chosen);
  }
  return out;
}

/**
 * Rank + cap an entity's first-degree edges, firewalled by source.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} entityId
 * @param {{cap?:number, entityType?:string, ownerId?:string|null}} [opts]
 * @returns {Array<{counterpartyId:string, counterpartyName:string|null,
 *   relType:string, source:'curated'|'weighted', domain:string}>}
 */
export function rankedFirstDegreeEdges(db, entityId, { cap = FLOOR_EDGE_CAP, entityType = 'person', ownerId = undefined } = {}) {
  const id = String(entityId);

  // ── Curated layer (person_relations) — the truth layer, kinship-first ──────
  let curated = [];
  if (entityType === 'person') {
    let rows = [];
    try { rows = getActiveEdgesForPerson(db, id); } catch { rows = []; }
    curated = rows.map((r) => ({
      counterpartyId: String(r.person_a) === id ? String(r.person_b) : String(r.person_a),
      relType: r.rel_type,
      domain: r.domain,
      authority: r.authority,
      confidence: Number(r.confidence) || 0,
      statedAt: r.stated_at || '',
      source: 'curated',
    }));
    // kinship first → authority (owner>contact>stated) → confidence → recency.
    curated.sort((a, b) => {
      const ak = a.domain === 'kinship' ? 0 : 1;
      const bk = b.domain === 'kinship' ? 0 : 1;
      if (ak !== bk) return ak - bk;
      const ar = authorityRank(a.authority);
      const br = authorityRank(b.authority);
      if (ar !== br) return br - ar;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return String(b.statedAt).localeCompare(String(a.statedAt));
    });
  }
  // Firewall set: any counterparty with a curated edge is emitted ONLY from the
  // curated layer and struck from the weighted list before it is ranked.
  const curatedCounterparties = new Set(curated.map((e) => e.counterpartyId));

  // ── Weighted layer (entity_relationships) — professional/social only ───────
  const fetch = Math.max(cap * WEIGHTED_FETCH_MULTIPLIER, cap);
  let weightedRows = [];
  try {
    // Both directions, each an index-ordered LIMIT off idx_er_a_weight /
    // idx_er_b_weight (migration 139) — no sort, degree-independent (the P0).
    // `source` rides along with weight — the provenance trust multiplier
    // below (§3.3) needs it to discount a low-trust inferred edge before it
    // competes for a counterparty's rank slot.
    weightedRows = db.prepare(`
      SELECT entity_id_b AS counterparty, relationship_type AS rel_type, weight, last_seen, source
      FROM entity_relationships WHERE entity_id_a = ?
      ORDER BY weight DESC LIMIT ?
    `).all(id, fetch).concat(db.prepare(`
      SELECT entity_id_a AS counterparty, relationship_type AS rel_type, weight, last_seen, source
      FROM entity_relationships WHERE entity_id_b = ?
      ORDER BY weight DESC LIMIT ?
    `).all(id, fetch));
  } catch { weightedRows = []; }

  const maxWeight = weightedRows.reduce((m, r) => Math.max(m, Number(r.weight) || 0), 0) || 1;
  const ownerNeighbors = ownerFirstDegreeSet(db, ownerId);
  const nowMs = Date.now();
  // Provenance-weighted best-per-counterparty pick (design §3.3, st_1b2ee2f0
  // chunk 6). A counterparty can now legitimately carry edges from MULTIPLE
  // sources (e.g. a primary-source company_affiliation edge AND a low-trust
  // email_cc_copresence edge for the same pair, both written by
  // lib/relationship-builder.js) — keep the highest TRUST-WEIGHTED score per
  // counterparty, not the first row encountered in weight order. This is
  // what makes "never outrank, never mask" hold even on a raw-weight TIE:
  // trust 1.0 beats trust 0.2 regardless of which row the SQL scan visits
  // first. (Before this source existed, one row per counterparty per
  // direction was the only case that occurred, so first-seen-wins and
  // best-score-wins were equivalent; that's no longer true.)
  const bestByCounterparty = new Map();
  for (const r of weightedRows) {
    const cp = String(r.counterparty);
    if (cp === id) continue;
    if (curatedCounterparties.has(cp)) continue;      // firewall: curated wins
    if (WEIGHTED_KINSHIP_TYPES.has(r.rel_type)) continue; // firewall: never kinship
    const wNorm = (Number(r.weight) || 0) / maxWeight;
    const trust = edgeSourceTrust(r.source);
    const score = (wNorm * trust) + recencyScore(r.last_seen, nowMs) + (ownerNeighbors.has(cp) ? OWNER_PROXIMITY_BONUS : 0);
    const existing = bestByCounterparty.get(cp);
    if (!existing || score > existing.score) {
      bestByCounterparty.set(cp, {
        counterpartyId: cp,
        relType: r.rel_type,
        source: 'weighted',
        domain: 'professional',
        score,
      });
    }
  }
  let weighted = [...bestByCounterparty.values()];
  weighted.sort((a, b) => b.score - a.score);
  weighted = mmrDiversify(weighted, cap);

  // ── Merge: curated ALWAYS first, weighted fills the remainder ──────────────
  const merged = [];
  for (const e of curated) { if (merged.length >= cap) break; merged.push(e); }
  for (const e of weighted) { if (merged.length >= cap) break; merged.push(e); }
  attachCounterpartyNames(db, merged);
  // Drop any edge whose counterparty resolves to no name — the floor may never
  // render an unnamed connection (it would read as fabricated).
  return merged.filter((e) => e.counterpartyName);
}

// Batch-resolve counterparty display names across people → companies → places
// (a weighted edge like 'employee' points at a company). One IN-list per table.
function attachCounterpartyNames(db, edges) {
  const ids = [...new Set(edges.map((e) => e.counterpartyId))];
  if (!ids.length) return;
  const nameById = new Map();
  const placeholders = ids.map(() => '?').join(',');
  for (const table of ['people', 'companies', 'places']) {
    const remaining = ids.filter((x) => !nameById.has(x));
    if (!remaining.length) break;
    try {
      const rows = db.prepare(
        `SELECT id, display_name AS name FROM ${table} WHERE id IN (${remaining.map(() => '?').join(',')})`,
      ).all(...remaining);
      for (const r of rows) if (r.name) nameById.set(String(r.id), r.name);
    } catch {
      // `companies`/`places` may lack a display_name column — fall back to name.
      try {
        const rows = db.prepare(
          `SELECT id, name FROM ${table} WHERE id IN (${remaining.map(() => '?').join(',')})`,
        ).all(...remaining);
        for (const r of rows) if (r.name) nameById.set(String(r.id), r.name);
      } catch { /* table absent — skip */ }
    }
  }
  void placeholders;
  for (const e of edges) e.counterpartyName = nameById.get(e.counterpartyId) || null;
}

function pickFact(facts, type) {
  const f = facts.find((x) => x.fact_type === type);
  return f ? f.fact_value : null;
}

function humanEdgeLabel(edge) {
  // curated kinship/social/professional rel_types and weighted professional
  // types are already human words ('spouse', 'colleague', 'co-founder').
  return String(edge.relType || '').replace(/-/g, ' ');
}

/**
 * Assemble the deterministic turn-1 floor for one recognized entity.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{id:string, type?:string, name?:string, display_name?:string}} entity
 * @param {{ownerId?:string|null}} [opts]
 * @returns {{rendered:string, facts:Array, edges:Array, jobTitle:string|null,
 *   employer:string|null, location:string|null, ownerLine:string, asOf:string,
 *   cardGeneratedAt:string|null, newestFactAt:string|null, type:string,
 *   displayName:string}}  — `.rendered` is the chat-ready string.
 */
export function buildEntityFloor(db, entity, { ownerId = undefined } = {}) {
  const id = String(entity?.id ?? '');
  const type = entity?.type || 'person';
  const key = `${type}:${id}`;
  const cached = _floorMemo.get(key);
  if (cached !== undefined) return cached;
  const built = buildEntityFloorUncached(db, entity, { ownerId });
  _floorMemo.set(key, built);
  return built;
}

function buildEntityFloorUncached(db, entity, { ownerId }) {
  const id = String(entity?.id ?? '');
  const type = entity?.type || 'person';
  const empty = {
    rendered: '', facts: [], edges: [], jobTitle: null, employer: null,
    location: null, ownerLine: '', asOf: '', cardGeneratedAt: null,
    newestFactAt: null, type, displayName: entity?.name || entity?.display_name || '',
  };
  if (!id) return empty;

  // The owner is never a floor subject — the cached ego block (ego-render.js) is
  // the owner's who-is-who authority; a per-entity "Your …-tier contact" line for
  // the owner would be nonsense. Degrade to empty (the caller shows nothing).
  let ownerResolved = '';
  try { ownerResolved = String((ownerId !== undefined ? ownerId : ownerPersonId()) || ''); } catch { ownerResolved = ''; }
  if (ownerResolved && ownerResolved === id) return empty;

  let facts = [];
  try {
    const placeholders = RICH_FACT_TYPES.map(() => '?').join(',');
    facts = dedupeFactsByType(db.prepare(`
      SELECT fact_type, fact_value, extracted_at, valid_at
      FROM entity_facts
      WHERE entity_id = ? AND entity_type = ? AND invalid_at IS NULL
        AND fact_type IN (${placeholders})
      ORDER BY extracted_at DESC
    `).all(id, type, ...RICH_FACT_TYPES));
  } catch {
    try {
      facts = dedupeFactsByType(db.prepare(`
        SELECT fact_type, fact_value, extracted_at, valid_at
        FROM entity_facts
        WHERE entity_id = ? AND entity_type = ? AND invalid_at IS NULL
          AND fact_type IN ('job_title','employer','location')
        ORDER BY extracted_at DESC
      `).all(id, type));
    } catch { facts = []; }
  }

  const newestFactAt = facts.reduce((mx, f) => {
    const t = f.extracted_at || f.valid_at || '';
    return t && t > mx ? t : mx;
  }, '');

  let edges = [];
  try { edges = rankedFirstDegreeEdges(db, id, { entityType: type, ownerId }); } catch { edges = []; }

  let row = null;
  let ownerLine = '';
  let displayName = entity?.name || entity?.display_name || '';

  if (type === 'person') {
    try {
      row = db.prepare(`
        SELECT p.display_name, p.short_name, p.tier, p.n2, p.first_seen,
               p.relation_tag, p.relation_label, p.relation_derived_phrase,
               p.card_generated_at, p.linkedin_title,
               c.name AS company_name
        FROM people p LEFT JOIN companies c ON c.id = p.company_id
        WHERE p.id = ?
      `).get(id);
    } catch {
      // Minimal schema / mid-migration fixtures may lack optional provenance
      // columns. Still render a useful floor from core people fields.
      try {
        row = db.prepare(`
          SELECT p.display_name, p.tier, p.n2, p.first_seen, p.linkedin_title,
                 c.name AS company_name
          FROM people p LEFT JOIN companies c ON c.id = p.company_id
          WHERE p.id = ?
        `).get(id);
        if (row) {
          row.short_name = row.short_name || null;
          row.relation_tag = null;
          row.relation_label = null;
          row.relation_derived_phrase = null;
          row.card_generated_at = null;
        }
      } catch { row = null; }
    }
    if (row) {
      displayName = row.display_name || displayName;
      if (row.relation_tag) {
        // Kinship keeps the walk-derived phrase — the most precise owner truth.
        ownerLine = `Your ${row.relation_derived_phrase || relationPhrase(row.relation_tag, row.relation_label)} (relationship from your entity graph).`;
      } else {
        // Non-kinship business line, row-derived from fields already read + the
        // strongest owner-first-degree connector already in the ranked set.
        const tierWord = row.tier || row.n2 || 'network';
        const company = pickFact(facts, 'employer') || row.company_name;
        const year = row.first_seen ? String(row.first_seen).slice(0, 4) : '';
        const connector = edges.find((e) => e.source && e.counterpartyName
          && ownerFirstDegreeSet(db, ownerId).has(e.counterpartyId));
        ownerLine = `Your ${String(tierWord).toLowerCase()}-tier contact${company ? ` at ${company}` : ''}${year ? `, in your network since ${year}` : ''}${connector ? `; connected to you through ${connector.counterpartyName}` : ''}.`;
      }
    }
  } else if (type === 'company') {
    try {
      row = db.prepare(`SELECT name, tier, n2, industry, people_count, card_generated_at FROM companies WHERE id = ?`).get(id);
    } catch { row = null; }
    if (row) {
      displayName = row.name || displayName;
      const tierWord = row.n2 || row.tier || 'network';
      ownerLine = `A ${String(tierWord).toLowerCase()}-tier company in your world${row.industry ? ` (${row.industry})` : ''}${row.people_count ? `, ${row.people_count} contact${row.people_count === 1 ? '' : 's'}` : ''}.`;
    }
  } else {
    try {
      row = db.prepare(`SELECT name, place_type, card_generated_at FROM places WHERE id = ?`).get(id);
      if (row) displayName = row.name || displayName;
    } catch { row = null; }
  }

  const cardGeneratedAt = row?.card_generated_at || null;
  // AC-10 as-of cue: only when the card predates the newest LIVE fact. NULL
  // card_generated_at means "no stale claim" (safe default → no cue).
  const asOf = (cardGeneratedAt && newestFactAt && cardGeneratedAt < newestFactAt)
    ? `Summary as of ${String(cardGeneratedAt).slice(0, 10)} — may be out of date; the live facts above are current.`
    : '';

  const jobTitle = pickFact(facts, 'job_title') || (type === 'person' ? row?.linkedin_title : null) || null;
  const employer = pickFact(facts, 'employer') || (type === 'person' ? row?.company_name : null) || null;
  const location = pickFact(facts, 'location') || null;

  const extraFacts = facts.filter((fact) => !CARD_MATERIAL_FACT_TYPES.includes(fact.fact_type));
  const lines = [];
  const roleParts = [];
  if (jobTitle && employer) roleParts.push(`${jobTitle} at ${employer}`);
  else if (jobTitle) roleParts.push(jobTitle);
  else if (employer) roleParts.push(`Works at ${employer}`);
  if (location) roleParts.push(`Based in ${location}`);
  if (roleParts.length) lines.push(`${roleParts.join('. ')}.`);
  if (ownerLine) lines.push(ownerLine);
  for (const fact of extraFacts) {
    const label = FACT_TYPE_LABELS[fact.fact_type] || fact.fact_type.replace(/_/g, ' ');
    const value = String(fact.fact_value || '').trim();
    if (value) lines.push(`${label}: ${value}.`);
  }
  if (edges.length) {
    lines.push(`Top connections: ${edges.map((e) => `${e.counterpartyName} (${humanEdgeLabel(e)})`).join(', ')}.`);
  }
  if (asOf) lines.push(`(${asOf})`);

  return {
    rendered: lines.join('\n'),
    facts, extraFacts, edges, jobTitle, employer, location, ownerLine, asOf,
    cardGeneratedAt, newestFactAt, type, displayName,
  };
}

function dedupeFactsByType(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const type = String(row.fact_type || '');
    const value = String(row.fact_value || '').trim();
    if (!type || !value || seen.has(type)) continue;
    seen.add(type);
    out.push(row);
    if (out.length >= RICH_FACT_CAP) break;
  }
  return out;
}

export function formatEntityFactBullets(floor, { max = 10 } = {}) {
  if (!floor) return [];
  const bullets = [];
  const name = String(floor.displayName || '').trim();
  const role = [floor.jobTitle, floor.employer ? `at ${floor.employer}` : ''].filter(Boolean).join(' ');
  if (name && role) bullets.push(`${name} is ${role}${floor.location ? `, based in ${floor.location}` : ''}`);
  else if (role) bullets.push(role);
  else if (floor.location) bullets.push(name ? `${name} is based in ${floor.location}` : `Based in ${floor.location}`);
  if (floor.ownerLine) bullets.push(floor.ownerLine.replace(/\.$/, ''));
  for (const fact of floor.extraFacts || []) {
    const label = FACT_TYPE_LABELS[fact.fact_type] || fact.fact_type.replace(/_/g, ' ');
    const value = String(fact.fact_value || '').trim();
    if (value) bullets.push(`${label}: ${value}`);
  }
  if (floor.edges?.length) {
    bullets.push(`Top connections: ${floor.edges.map((e) => `${e.counterpartyName} (${humanEdgeLabel(e)})`).join(', ')}`);
  }
  return bullets.filter(Boolean).slice(0, max);
}

// ── Freshness health (AC-9) ───────────────────────────────────────────────────

function lastRoutineRunHours(db, jobType) {
  try {
    const row = db.prepare(`
      SELECT MAX(COALESCE(finished_at, updated_at)) AS last
      FROM passive_jobs WHERE job_type = ? AND status = 'done'
    `).get(jobType);
    if (!row?.last) return null;
    const t = Date.parse(row.last);
    return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : null;
  } catch { return null; }
}

/**
 * Entity-freshness health for the served /api/server-health body (AC-9). Returns
 * dirty-backlog depth, oldest-dirty-card age, stale-card lag, miner/resolver
 * last-run age, and a degradation flag so a stalled freshness circuit is visible
 * on the health surface the user already checks — never silently rotting.
 *
 * All reads are bounded/best-effort; a failure returns a degraded:false stub so
 * the health endpoint never crashes on a freshness read.
 */
export function getEntityFreshnessHealth(db) {
  try {
    const dirtyBacklog = db.prepare(
      `SELECT COUNT(*) AS n FROM people WHERE needs_regen = 1 AND archived = 0`,
    ).get().n;
    const staleCardBacklog = db.prepare(
      `SELECT COUNT(*) AS n FROM people
       WHERE needs_regen = 1 AND archived = 0 AND context_file_path IS NOT NULL`,
    ).get().n;
    const oldest = db.prepare(
      `SELECT MIN(card_generated_at) AS g FROM people
       WHERE needs_regen = 1 AND archived = 0
         AND context_file_path IS NOT NULL AND card_generated_at IS NOT NULL`,
    ).get().g;
    const oldestDirtyCardHours = oldest
      ? Math.max(0, (Date.now() - Date.parse(oldest)) / 3_600_000)
      : null;
    const minerLastRunHours = lastRoutineRunHours(db, 'maint_mine_relations');
    const resolverLastRunHours = lastRoutineRunHours(db, 'maint_resolve_relations');

    const degraded = dirtyBacklog > DIRTY_BACKLOG_ALARM
      || (oldestDirtyCardHours != null && oldestDirtyCardHours > STALE_CARD_ALARM_HOURS)
      || (minerLastRunHours != null && minerLastRunHours > ROUTINE_STALE_ALARM_HOURS)
      || (resolverLastRunHours != null && resolverLastRunHours > ROUTINE_STALE_ALARM_HOURS);

    return {
      dirty_backlog: dirtyBacklog,
      stale_card_backlog: staleCardBacklog,
      oldest_dirty_card_hours: oldestDirtyCardHours == null ? null : Math.round(oldestDirtyCardHours * 10) / 10,
      miner_last_run_hours: minerLastRunHours == null ? null : Math.round(minerLastRunHours * 10) / 10,
      resolver_last_run_hours: resolverLastRunHours == null ? null : Math.round(resolverLastRunHours * 10) / 10,
      degraded,
      thresholds: {
        dirty_backlog: DIRTY_BACKLOG_ALARM,
        stale_card_hours: STALE_CARD_ALARM_HOURS,
        routine_stale_hours: ROUTINE_STALE_ALARM_HOURS,
      },
    };
  } catch (err) {
    return { dirty_backlog: null, degraded: false, error: err.message };
  }
}

// Test-only: clear the per-entity + owner memo so a fixture's mutation is seen.
export function _resetFloorMemoForTests() {
  _floorMemo.clear();
  _ownerNeighborCache = { ownerId: null, at: 0, set: new Set() };
}
