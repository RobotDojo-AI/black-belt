/**
 * Network API — people, companies, places, family, search, merge, identifiers.
 *
 * st_bc949e7c Pass B Phase 3.5: post-belt-consolidation. Was: `getBBModule()`
 * returned a dynamically-imported encrypted bundle namespace (or null). Now:
 * BB code is statically imported from `lib/bb/index.js`, gated only by
 * `isBBActive()` at the handler boundary. The semantics are preserved:
 *   - WB mode  → fall back to lib/network-queries.js (teaser shape)
 *   - BB mode  → call the lib/bb/* function and return the rich payload
 *
 * Every handler that previously called `getBBModule()` was rewritten:
 *   - Top-level `GET /` (mounted at `/api/network`): hard 403 with
 *     stale-banner in WB; 200 with people array in BB. Spec contract.
 *   - Other handlers: read `isBBActive()` once, branch on the result. Names
 *     destructured from `lib/bb` exports keep the original call sites
 *     mostly verbatim; the only semantic change is the gate condition.
 */
import { spawn } from 'node:child_process';
import { resolve as pathResolve } from 'node:path';
import { Hono } from 'hono';
import db from '../lib/db.js';
import config from '../lib/config.js';
import { getPlaces, getPlaceDetail, getPlaceStats } from '../lib/timeline-schema.js';
import { getVaultSummary, getVaultByCategory, CATEGORIES } from '../lib/document-vault.js';
import { isBBActive } from '../lib/cohort/active.js';
import * as bb from '../lib/bb/index.js';
import {
  getPeopleTeaser,
  getScoredPeopleCount,
  getPeopleClasses,
  getUnclassifiedPeopleCount,
  getPersonById,
  getPersonUuidById,
  searchPeopleByName,
  searchMeaningfulEntities,
  getPersonRelationshipEdge,
  getRelationshipEdges,
  getPeopleCount,
  getPlaceSubtypeCounts,
  getPlacesAllCount,
  getPlacesAll,
  getPlacePreferences,
  getCities,
  getVenueSubtypes,
  getPersonByUuidOrIdExtended,
  getCompanies,
  prepareCompanyDomainStmt,
  getCompanyWithPeople,
  getEntityConnections,
  getPersonForContext,
  updatePersonField,
  insertPersonIdentifier,
  deletePersonIdentifier,
  getRebuildCounts,
} from '../lib/network-queries.js';
import { setRelationTag } from '../lib/people-write.js';
import { mergePeople, archivePersonWithCleanup } from '../lib/people-merge.js';
import { anchorDeclaredOwner } from '../lib/identity.js';

const routes = new Hono();

const NETWORK_CLASS_CACHE_TTL_MS = Number.parseInt(process.env.ROBOTDOJO_NETWORK_CLASS_CACHE_MS || '60000', 10);
let peopleClassSummaryCache = null;

function stripEntityScores(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripEntityScores);
  const {
    score,
    personal_score,
    business_score,
    consistency_score,
    rank,
    global_rank,
    people,
    items,
    entities,
    ...rest
  } = value;
  if (people) rest.people = stripEntityScores(people);
  if (items) rest.items = stripEntityScores(items);
  if (entities) rest.entities = stripEntityScores(entities);
  return rest;
}

function searchPeopleForNetwork(q, limit) {
  const rows = searchMeaningfulEntities(db, q, limit)
    .filter((e) => e.type === 'person')
    .map((e) => ({
      id: e.id,
      uuid: e.uuid,
      display_name: e.display_name,
      name: e.display_name,
      n1: e.n1,
      n2: e.n2,
      score: e.score,
      matched_name: e.matched_name || null,
    }));
  if (rows.length) return rows;
  return searchPeopleByName(db, `%${q}%`, limit);
}

function buildPeopleClassSummary() {
  const rows = getPeopleClasses(db);
  const summary = { business: { total: 0, by_subcategory: {} },
                    personal: { total: 0, by_subcategory: {} },
                    mixed:    { total: 0 },
                    unclassified: 0 };
  for (const r of rows) {
    if (!summary[r.class]) continue;
    summary[r.class].total += r.count;
    if (r.subcategory && summary[r.class].by_subcategory) {
      summary[r.class].by_subcategory[r.subcategory] = r.count;
    }
  }
  summary.unclassified = getUnclassifiedPeopleCount(db);
  return summary;
}

// --- Network ---

/**
 * GET / (mounted at /api/network) — network root, BB-gated.
 *
 * st_bc949e7c spec (tests/specs/st_bc949e7c.test.js) contract:
 *   - WB mode: 403 with { stale_banner: true, belt: 'white', reason }
 *   - BB mode: 200 with { items: [...], total: N }
 *
 * The teaser surface at /api/network/teaser stays unconditionally 200
 * for the WB upsell UX — only the unprefixed /api/network is BB-gated.
 */
routes.get('/', async (c) => {
  const active = await isBBActive();
  if (!active) {
    return c.json({
      stale_banner: true,
      belt: 'white',
      reason: 'cohort_inactive',
    }, 403);
  }
  // BB mode: return the people array (mirrors the BB-only /api/network/people
  // shape — the root path is the canonical "Black Belt network" endpoint).
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  try {
    const result = bb.getPeople({ limit, offset });
    return c.json(stripEntityScores(result));
  } catch (e) {
    console.warn('[network/] BB getPeople failed:', e.message);
    return c.json({ items: [], total: 0, error: e.message });
  }
});

/**
 * GET /api/network/teaser — White Belt teaser surface.
 *
 * Always returns 200 (never 402) with a top-N entity list. The 402 path
 * is reserved for hard-paywalled Black Belt features; the teaser is the
 * "look but don't see everything" preview that converts a White Belt user
 * to a paid plan. st_42799dbe AC 11.
 *
 * Body: { teaser: true, entities: [{id,name,...}], total }
 */
routes.get('/api/network/teaser', (c) => {
  const TEASER_LIMIT = 10;
  const entities = getPeopleTeaser(db, TEASER_LIMIT, 0);
  const total = getScoredPeopleCount(db);
  return c.json({ teaser: true, entities: stripEntityScores(entities), total });
});

routes.get('/api/network/people', async (c) => {
  const teaser = c.get('teaser');
  const active = await isBBActive();
  const limit = teaser ? 10 : parseInt(c.req.query('limit') || '50');
  const offset = teaser ? 0 : parseInt(c.req.query('offset') || '0');
  // st_93fddaf0 Phase 9 amendment (2026-05-14): default response is a bare
  // array of row objects ordered alphabetically by display_name within each
  // (n1, n2) bucket. The `rank` field has been dropped per scope amendment —
  // tier is the load-bearing signal; intra-tier ordering is alphabetical
  // for determinism, and the UI applies client-side column sort on top.
  // Pass ?wrap=1 to keep the legacy { items, total, teaser } envelope for
  // the SPA frontend's pagination + teaser-banner state.
  const wrap = c.req.query('wrap') === '1';

  if (!active) {
    // WB teaser: alphabetical-within-bucket list, no proprietary scoring filters.
    const items = getPeopleTeaser(db, limit, offset);
    const total = getScoredPeopleCount(db);
    if (wrap) return c.json({ items: stripEntityScores(items), total, teaser: true });
    return c.json(stripEntityScores(items));
  }

  const section = c.req.query('section') || null;
  const tier = c.req.query('tier') || null;
  // Ontology filters (schemas/people.yaml) — primary_class + subcategory
  const klass = c.req.query('class') || null;                // business | personal | mixed
  const subcategory = c.req.query('subcategory') || null;
  // WHY n1/n2 params: new N1/N2 taxonomy takes precedence over legacy class/section.
  // n1 = 'Personal' | 'Professional'; n2 = 'Family' | 'Core' | 'Network' | etc.
  const n1 = c.req.query('n1') || null;
  const n2 = c.req.query('n2') || null;
  const result = bb.getPeople({ section, tier, limit, offset, klass, subcategory, n1, n2 });
  // `bb` is the static import — the call goes directly to lib/bb/index.js.
  if (teaser) result.teaser = true;
  // st_93fddaf0 Phase 9 amendment: alphabetical-within-bucket ordering at
  // the route boundary. BB.getPeople still ranks by score internally (that
  // ordering is correct for the score-DESC paths consumed elsewhere) but
  // for /api/network/people the scope amendment requires alphabetical
  // display order so the UI can compute index from array position.
  // Sort is stable and runs over the page slice (≤ limit rows), O(n log n)
  // on n ≤ 50. Comparator matches LOWER(display_name) COLLATE NOCASE on
  // the SQL side so server-side and client-side defaults agree.
  const items = (result.items || []).slice().sort((a, b) =>
    String(a.display_name || '').toLowerCase().localeCompare(String(b.display_name || '').toLowerCase()),
  );
  const publicItems = stripEntityScores(items);
  if (wrap) return c.json({ ...stripEntityScores(result), items: publicItems });
  return c.json(publicItems);
});

// Class + subcategory counts for sidebar (ontology primary_class)
routes.get('/api/network/people/classes', (c) => {
  const now = Date.now();
  const force = c.req.query('refresh') === '1' || c.req.query('cache') === '0';
  if (!force && peopleClassSummaryCache && peopleClassSummaryCache.expiresAt > now) {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-RobotDojo-Cache', 'hit');
    return c.json(peopleClassSummaryCache.payload);
  }
  const payload = buildPeopleClassSummary();
  peopleClassSummaryCache = { payload, expiresAt: now + NETWORK_CLASS_CACHE_TTL_MS };
  c.header('Cache-Control', 'private, no-store');
  c.header('X-RobotDojo-Cache', 'miss');
  return c.json(payload);
});

routes.get('/api/network/person/:id', async (c) => {
  const idParam = c.req.param('id');
  const active = await isBBActive();
  if (!active) {
    const p = getPersonById(db, idParam);
    if (!p) return c.json({ error: 'not_found' }, 404);
    return c.json(stripEntityScores(p));
  }
  // BB getPersonProfile may reference person_edges (dropped by migration
  // 070); fall back to WB on any error so the Network UI never 500s.
  let profile;
  try {
    profile = bb.getPersonProfile(idParam);
  } catch (err) {
    console.warn('[network/person] BB getPersonProfile failed, falling back to WB:', err.message);
    profile = getPersonById(db, idParam);
  }
  if (!profile) return c.json({ error: 'not_found' }, 404);
  const row = getPersonUuidById(db, idParam);
  return c.json(stripEntityScores({ ...profile, uuid: row?.uuid }));
});

routes.get('/api/network/people/search', async (c) => {
  const q = c.req.query('q') || '';
  if (!q) return c.json([]);
  const active = await isBBActive();
  if (!active) {
    return c.json(stripEntityScores(searchPeopleForNetwork(q, 20)));
  }
  try {
    const results = searchPeopleForNetwork(q, 20);
    return c.json(stripEntityScores(results.length ? results : bb.searchPeople(q, 20)));
  } catch (err) {
    console.warn('[network/people/search] BB searchPeople failed, falling back to WB:', err.message);
    return c.json(stripEntityScores(searchPeopleByName(db, `%${q}%`, 20)));
  }
});

// Plural form + uuid column lookup for deep links.
// Looks up by uuid column first, falls back to id column for backward compat.
routes.get('/api/network/people/:id', async (c) => {
  const idParam = c.req.param('id');
  const active = await isBBActive();

  // Try uuid column first, fall back to id column
  const p = getPersonByUuidOrIdExtended(db, idParam);
  if (!p) return c.json({ error: 'not_found' }, 404);

  if (!active) return c.json(stripEntityScores({ ...p }));
  // Same BB person_edges fallback as the /api/network/person/:id route.
  let profile;
  try {
    profile = bb.getPersonProfile(p.id);
  } catch (err) {
    console.warn('[network/people] BB getPersonProfile failed, falling back to WB:', err.message);
    profile = p;
  }
  if (!profile) return c.json({ error: 'not_found' }, 404);
  return c.json(stripEntityScores({ ...profile, uuid: p.uuid, id: p.id }));
});

routes.get('/api/network/search', async (c) => {
  const q = c.req.query('q') || '';
  const limit = parseInt(c.req.query('limit') || '20');
  if (!q) return c.json([]);
  const active = await isBBActive();
  let results;
  // Try BB's enriched searchPeople first; on any error fall back to the WB
  // path. Today's failure: BB bundle (built 2026-04-25) references the
  // person_edges table that migration 070 dropped (st_87a0d072 retired the
  // co-occurrence step). Without this fallback Black Belt people search returns
  // 500 and passive recognition has no visual result. Until the BB bundle is
  // rebuilt, the WB path is safe + functional.
  if (active) {
    try {
      results = searchPeopleForNetwork(q, limit);
      if (!results.length) results = bb.searchPeople(q, limit);
    } catch (err) {
      console.warn('[network/search] BB searchPeople failed, falling back to WB:', err.message);
      results = searchPeopleForNetwork(q, limit);
    }
  } else {
    results = searchPeopleForNetwork(q, limit);
  }

  // Augment with relationship_type — source priority: relation_tag > company_affiliation > co_occurrence,
  // then weight descending within source so spouse/family always win over colleague
  const augmented = results.map(p => {
    try {
      const edge = getPersonRelationshipEdge(db, p.id);
      return edge ? { ...p, relationship_type: edge.relationship_type } : p;
    } catch { return p; }
  });

  // Entities with relationship edges rank above pure-score entities
  augmented.sort(
    (a, b) => (b.relationship_type ? 1 : 0) - (a.relationship_type ? 1 : 0)
           || (b.score || 0) - (a.score || 0)
  );

  return c.json(stripEntityScores(augmented));
});

// GET /api/network/relationships?entity_id=X
// Returns all typed relationship edges for an entity with real-time decayed strength.
// Black Belt gated — returns 403 teaser for White Belt.
routes.get('/api/network/relationships', async (c) => {
  const entityId = c.req.query('entity_id');
  if (!entityId) return c.json({ error: 'entity_id_required' }, 400);
  const active = await isBBActive();
  if (!active) return c.json({ error: 'requires_black_belt', teaser: true }, 403);
  const edges = getRelationshipEdges(db, entityId);
  return c.json({ entity_id: entityId, edges });
});

routes.get('/api/network/stats', async (c) => {
  const active = await isBBActive();
  if (!active) {
    return c.json({ people: getPeopleCount(db) });
  }
  return c.json(bb.getNetworkStats());
});

routes.get('/api/network/family', async (c) => {
  const active = await isBBActive();
  if (!active) return c.json({ teaser: true, nodes: [], edges: [] });
  return c.json(bb.getFamilyTree());
});

// --- Places ---

routes.get('/api/network/places', (c) => {
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const placeType = c.req.query('type') || null;
  const placeSubtype = c.req.query('place_subtype') || null;
  const showAll = c.req.query('all') === '1';
  const places = getPlaces({ placeType, placeSubtype, limit, offset, useful: showAll ? null : 1 });
  return c.json({ items: places, total: places.length });
});

// --- Places (ontology-aligned) ---
// Sidebar-visible places only. Cities, countries, airports, residential are
// filtered out via `hidden_in_sidebar`. Grouped by ontology place_subtype.

const ONTOLOGY_PLACE_SUBTYPES = ['restaurant', 'bar', 'hotel', 'concert_hall', 'museum', 'library', 'salon_spa', 'gym_fitness', 'wellness', 'park'];

routes.get('/api/network/places/subtypes', (c) => {
  // Counts per ontology place subtype, for sidebar sections.
  // Belt-and-suspenders: hidden_in_sidebar=0 AND sub_type IS NOT 'travel' —
  // travel places (hotels on trips, Airbnbs) must never surface here even if
  // the hidden flag drifts. Travel feeds the travel history surface.
  return c.json(getPlaceSubtypeCounts(db, ONTOLOGY_PLACE_SUBTYPES));
});

routes.get('/api/network/places/all', (c) => {
  const placeSubtype = c.req.query('place_subtype') || null;
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  // Reject unknown place_subtype rather than silently falling back to all results.
  if (placeSubtype && !ONTOLOGY_PLACE_SUBTYPES.includes(placeSubtype)) {
    return c.json({ items: [], total: 0 });
  }

  const params = [];
  let where = `hidden_in_sidebar = 0 AND (sub_type IS NULL OR sub_type != 'travel') AND place_subtype IN (${ONTOLOGY_PLACE_SUBTYPES.map(() => '?').join(',')})`;
  params.push(...ONTOLOGY_PLACE_SUBTYPES);
  if (placeSubtype) {
    where += ' AND place_subtype = ?';
    params.push(placeSubtype);
  }

  const total = getPlacesAllCount(db, where, params);
  const items = getPlacesAll(db, where, params, limit, offset);
  return c.json({ items, total });
});

routes.get('/api/network/places/preferences', (c) => {
  const types = ['restaurant', 'bar', 'hotel', 'cafe'];
  const result = {};
  for (const t of types) {
    result[t + 's'] = getPlacePreferences(db, t);
  }
  return c.json(result);
});

routes.get('/api/network/places/cities', (c) => {
  return c.json(getCities(db));
});

routes.get('/api/network/places/types', (c) => {
  return c.json(getVenueSubtypes(db));
});

routes.get('/api/network/places/stats', (c) => {
  const stats = getPlaceStats();
  return c.json(stats);
});

routes.get('/api/network/places/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  const detail = getPlaceDetail(id);
  if (!detail) return c.json({ error: 'not_found' }, 404);
  return c.json(detail);
});

// --- Network extended endpoints ---

routes.get('/api/network/companies', (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const n2 = c.req.query('n2') || null;

  // WHY n2: pipeline writes n2 (Employer/Customers/Core/Network/Acquaintance) on companies.
  // Legacy tier column is always 'peripheral' and is not used for filtering.
  let where = "n2 IS NOT NULL AND n2 != ''";
  const params = [];
  if (n2) { where += ' AND n2 = ?'; params.push(n2); }

  const { total, rows } = getCompanies(db, where, params, limit, offset);

  // Enrich with domains
  const domainStmt = prepareCompanyDomainStmt(db);
  const items = rows.map(co => ({
    ...co,
    domains: domainStmt.all(co.id).map(d => d.domain),
  }));

  return c.json({ items: stripEntityScores(items), total });
});

routes.get('/api/network/companies/:id', (c) => {
  const id = c.req.param('id');
  const company = getCompanyWithPeople(db, id);
  if (!company) return c.json({ error: 'not_found' }, 404);
  // Fetch all typed relationship edges connected to this company so the
  // detail pane can display its known connections (investors, board members,
  // founders, advisors, employees from manual/backfill records).
  const connections = getEntityConnections(db, id, 'company');
  return c.json(stripEntityScores({ ...company, connections }));
});

// --- Person context narrative (for chat injection) ---

function buildPersonContext(profile) {
  const parts = [`${profile.display_name}`];
  if (profile.company_name) parts.push(`Works at ${profile.company_name}`);
  if (profile.linkedin_title) parts.push(profile.linkedin_title);
  if (profile.tier) parts.push(`Relationship tier: ${profile.tier}`);
  if (profile.years_known) parts.push(`Known for ${Math.round(profile.years_known)} years`);
  const channels = [];
  if (profile.interactions) {
    const totals = {};
    for (const i of profile.interactions) totals[i.channel] = (totals[i.channel] || 0) + i.count;
    if (totals.email) channels.push(`${totals.email} emails`);
    if (totals.calendar) channels.push(`${totals.calendar} calendar events`);
    if (totals.imessage) channels.push(`${totals.imessage} messages`);
  }
  if (channels.length) parts.push(`Communication: ${channels.join(', ')}`);
  const emails = (profile.identifiers || []).filter(i => i.type === 'email').map(i => i.value);
  if (emails.length) parts.push(`Email: ${emails.join(', ')}`);
  const topics = (profile.topics || []).slice(0, 5).map(t => t.topic);
  if (topics.length) parts.push(`Topics: ${topics.join(', ')}`);
  return parts.join('\n');
}

routes.get('/api/network/person/:id/context', async (c) => {
  const active = await isBBActive();
  if (!active) {
    const p = getPersonForContext(db, c.req.param('id'));
    if (!p) return c.json({ error: 'not_found' }, 404);
    return c.json({ context: buildPersonContext(p), profile: stripEntityScores(p) });
  }
  const profile = bb.getPersonProfile(c.req.param('id'));
  if (!profile) return c.json({ error: 'not_found' }, 404);
  return c.json({ context: buildPersonContext(profile), profile: stripEntityScores(profile) });
});

// Support both PUT and PATCH for person updates
for (const method of ['put', 'patch']) {
  routes[method]('/api/network/people/:id', async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
    const id = c.req.param('id');
    // st_f67bc2eb — relation_tag and archived are no longer raw column writes:
    //   relation_tag → the ONE relationship write path (adapter → edge store,
    //     owner authority 'manual'); a bare column write would drift from the
    //     walker-derived cache and fail the coherence quiz.
    //   archived → archivePersonWithCleanup so the person's active edges are
    //     deprecated with them (AC-11); un-archiving stays a plain flag.
    const fields = ['display_name', 'tier', 'notes', 'relationship_origin'];
    for (const field of fields) {
      if (body[field] !== undefined) {
        const val = body[field] === '' ? null : body[field];
        updatePersonField(db, field, val, id);
      }
    }
    if (body.relation_tag !== undefined) {
      const val = body.relation_tag === '' ? null : body.relation_tag;
      try {
        setRelationTag(db, id, val, null, { source: 'manual' });
      } catch (err) {
        return c.json({ error: err.message }, 400);
      }
    }
    if (body.archived !== undefined) {
      if (body.archived) archivePersonWithCleanup(db, id);
      else updatePersonField(db, 'archived', 0, id);
    }
    return c.json({ ok: true });
  });
}

// st_f67bc2eb AC-11 — duplicate-person merge as a PRODUCT operation (the
// header has promised "merge" since st_bc949e7c; the two live duplicate
// pairs of 2026-07-08 had to be repaired with one-off writes because no
// endpoint existed). Thin facade: parse, delegate to lib/people-merge.js,
// respond. Idempotent — re-merging an absorbed loser is a clean no-op.
routes.post('/api/network/people/merge', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const winnerId = body.winner_id || body.winnerId;
  const loserId = body.loser_id || body.loserId;
  if (!winnerId || !loserId) return c.json({ error: 'winner_id and loser_id are required' }, 400);
  const result = mergePeople(db, String(winnerId), String(loserId), { evidence: 'api-merge' });
  if (!result.ok) return c.json({ error: result.reason }, 400);
  return c.json(result);
});

// Identifiers
routes.post('/api/network/people/:personId/identifiers', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const personId = c.req.param('personId');
  insertPersonIdentifier(db, personId, body.type, body.value);
  return c.json({ ok: true });
});

routes.delete('/api/network/people/:personId/identifiers/:id', (c) => {
  deletePersonIdentifier(db, c.req.param('id'), c.req.param('personId'));
  return c.json({ ok: true });
});

// --- Document Vault ---

routes.get('/api/network/vault', (c) => {
  const accountType = c.req.query('type'); // 'personal' | 'business' | omit for all
  const summary = getVaultSummary(accountType);
  const categories = Object.entries(CATEGORIES).map(([key, def]) => ({
    key, label: def.label, subcategories: def.subcategories,
  }));
  return c.json({ summary, categories });
});

routes.get('/api/network/vault/:category', (c) => {
  const accountType = c.req.query('type') || 'personal';
  const docs = getVaultByCategory(c.req.param('category'), accountType);
  return c.json({ items: docs, total: docs.length });
});

routes.get('/api/network/address-history', async (c) => {
  const active = await isBBActive();
  if (!active) return c.json([]);
  return c.json(bb.getAddressHistory());
});

// ---------------------------------------------------------------------------
// ADMIN: Rebuild endpoint
// ---------------------------------------------------------------------------
// Drops every entity (people/companies/places/person_* junctions) in a single
// transaction, re-runs the onboarding extraction pipeline (scripts/onboard.js),
// and re-classifies every person and place against the locked ontology.
//
// Safety: bearer token + explicit `X-Confirm-Rebuild: yes` header. Never wired
// into end-user UI. The rebuild runs in a subprocess so one bad extractor
// never crashes the server.
// ---------------------------------------------------------------------------

let _rebuildInFlight = null; // Promise reference while a rebuild is running
let _lastRebuildAt = 0;     // ms timestamp of last completed/failed rebuild
const REBUILD_COOLDOWN_MS = 5 * 60 * 1000;

routes.post('/api/network/rebuild', async (c) => {
  // Auth is already enforced by requireAuth() on /api/*, but we re-check the
  // token here so the endpoint is explicit about its admin contract.
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!config.authToken || token !== config.authToken) {
    return c.json({ error: 'admin_token_required' }, 403);
  }

  if (c.req.header('X-Confirm-Rebuild') !== 'yes') {
    return c.json({ error: 'confirmation_required', hint: 'send header X-Confirm-Rebuild: yes' }, 400);
  }

  if (_rebuildInFlight) {
    return c.json({ status: 'in_progress', started_at: _rebuildInFlight.startedAt }, 202);
  }

  const msSinceLast = Date.now() - _lastRebuildAt;
  if (_lastRebuildAt > 0 && msSinceLast < REBUILD_COOLDOWN_MS) {
    const waitSec = Math.ceil((REBUILD_COOLDOWN_MS - msSinceLast) / 1000);
    return c.json({ error: 'cooldown', retry_after_seconds: waitSec }, 429);
  }

  const startedAt = new Date().toISOString();
  console.info(`[network/rebuild] ${startedAt} — DROP + re-extract + re-classify`);

  const promise = runRebuild().finally(() => { _rebuildInFlight = null; _lastRebuildAt = Date.now(); });
  _rebuildInFlight = { promise, startedAt };

  try {
    const summary = await promise;
    return c.json({ status: 'ok', started_at: startedAt, finished_at: new Date().toISOString(), ...summary });
  } catch (err) {
    console.error('[network/rebuild] failed:', err);
    return c.json({ status: 'error', error: err.message }, 500);
  }
});

/**
 * Rebuild sequence:
 *   1. Wipe entity tables in one transaction.
 *   2. Spawn `node scripts/onboard.js` — contacts → calendar → iMessage → email → score.
 *   3. Classify every person + place against the ontology.
 *   4. Return counts by class.
 */
async function runRebuild() {
  // Step 1: wipe everything in a single transaction
  const wipe = db.transaction(() => {
    // Junctions first (foreign-key safety even though FKs may be off).
    // person_edges is DROPPED by st_87a0d072 migration 070 — omit from wipe.
    db.exec(`
      DELETE FROM person_identifiers;
      DELETE FROM person_groups;
      DELETE FROM person_topics;
      DELETE FROM person_interactions;
      DELETE FROM people;
      DELETE FROM companies;
      DELETE FROM company_domains;
      DELETE FROM places;
    `);
  });
  wipe();
  console.info('[network/rebuild] entity tables wiped');

  // Step 2: run scripts/onboard.js (phases 1-5) in a subprocess
  const scriptPath = pathResolve(import.meta.dirname, '..', 'scripts', 'onboard.js');
  await new Promise((resolveProc, rejectProc) => {
    const proc = spawn('node', [scriptPath], {
      cwd: pathResolve(import.meta.dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    });
    proc.on('exit', (code) => {
      code === 0 ? resolveProc() : rejectProc(new Error(`onboard.js exited with code ${code}`));
    });
    proc.on('error', rejectProc);
  });
  console.info('[network/rebuild] onboard.js completed');

  // df_cbd30a5a — the rebuild WIPES people then re-runs onboard, minting fresh
  // person ids, so the old owner_person_id is stale. Re-anchor the declared
  // owner from identity.json before classify/summary. Idempotent Tier-0.
  try {
    const r = anchorDeclaredOwner(db);
    console.info(`[network/rebuild] owner anchored: owner_person_id=${r.owner_person_id || 'none'}${r.created ? ' (created)' : ''} (${r.reason || 'ok'})`);
  } catch (err) {
    console.warn('[network/rebuild] owner anchor skipped:', err.message);
  }

  // Step 3: classify (BB-only — gated by isBBActive). When WB, the
  // bb.backfillClassifications stub returns { people: 0, places: 0 }; we
  // skip the call to make the WB path explicit and avoid the stub log line.
  const active = await isBBActive();
  const classifyCounts = active
    ? await bb.backfillClassifications({ verbose: true })
    : { people: 0, places: 0 };
  console.info('[network/rebuild] classifications:', JSON.stringify(classifyCounts));

  // Step 5 (st_483361e2): re-project promoted workbench research back into the
  // graph. A rebuild wipes every entity (Step 1), so a research-sourced entity
  // with no organic footprint would be erased forever. Re-running the idempotent
  // promote path per workbench re-creates them, keyed on the natural-key uuid —
  // one explicit call site instead of a fragile preserve-on-delete flag every
  // future editor of the wipe transaction must remember. Non-blocking child
  // (guarded-child): the rebuild endpoint returns immediately; the promote runs
  // detached and re-attaches durable research without blocking the response.
  try {
    const promoteScript = pathResolve(import.meta.dirname, '..', 'scripts', 'promote-workbench-corpus.js');
    const promotable = db.prepare(
      'SELECT DISTINCT workbench_id FROM workbench_promotions',
    ).all().map((r) => r.workbench_id).filter(Boolean);
    for (const wbId of promotable) {
      spawn(process.execPath, [promoteScript, '--workbench', wbId], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ROBOTDOJO_ALLOW_PLAINTEXT: '1' },
      }).unref();
    }
    console.info(`[network/rebuild] re-projection spawned for ${promotable.length} workbench(es)`);
  } catch (err) {
    console.warn('[network/rebuild] promote re-projection spawn skipped:', err.message);
  }

  // Step 4: summary
  const counts = getRebuildCounts(db);
  const summary = {
    ...counts,
    classified: classifyCounts.people,
    places: classifyCounts.places,
  };
  return summary;
}

// Idempotent status peek — lets dev tools poll without triggering another run.
routes.get('/api/network/rebuild/status', (c) => {
  return c.json({
    in_progress: !!_rebuildInFlight,
    started_at: _rebuildInFlight?.startedAt || null,
  });
});

export default routes;
