#!/usr/bin/env node
/**
 * scripts/qa/graph-fact-quiz.js — data-layer fact quiz over the live entity
 * graph (st_df0a8d71 AC-10; REWIRED by st_f67bc2eb D9 for the truth swap).
 *
 * Compute tier: Tier 0 only — deterministic SQL + the deterministic ego
 * render + the deterministic walker. No LLM, no writes (query_only-locked
 * connection).
 *
 * SEQUENCING CONTRACT: this quiz must be GREEN before the chat-layer quiz
 * layer was consulted — a graph that is wrong or unrenderable
 * makes chat-layer results meaningless. The rerun operation enforces the
 * order; this script is also runnable standalone.
 *
 * Truth model under test (st_f67bc2eb): person_relations is the source of
 * truth; people.relation_tag / relation_label / relation_derived_phrase are a
 * WALKER-DERIVED CACHE. The checks that used to live on entity_facts
 * supersede pairs moved onto the edge store:
 *
 *   1. Vocabulary integrity — every cached tag in FAMILY_TAGS; every non-null
 *      label belongs to its tag.
 *   2. Render coverage — the ego render carries one line per family-tagged
 *      person with the exact derived phrase (or tag+label fallback).
 *   3. Edge integrity — at most ONE active edge per unordered pair + domain
 *      (two conflicting kinship claims can never both be active).
 *   4. CACHE COHERENCE (the two-truths killer) — the cache columns must equal
 *      the walker's output exactly. A reader bypassing the cache or a walker
 *      failure makes this loudly red.
 *   5. Provenance ordering on edges — an owner tombstone blocks active
 *      non-owner re-assertions; no owner edge was ever superseded by a
 *      lower-authority edge.
 *
 * CLI:
 *   node scripts/qa/graph-fact-quiz.js                     # all checks
 *   node scripts/qa/graph-fact-quiz.js --render-coverage   # coverage only
 *   node scripts/qa/graph-fact-quiz.js --derived-coverage  # walk-derived phrase render check
 *   node scripts/qa/graph-fact-quiz.js --cross-anchor      # both-truths-active check
 */
export const INTELLIGENCE_TIER = 'extraction';

const args = process.argv.slice(2);
const COVERAGE_ONLY = args.includes('--render-coverage');
const DERIVED_ONLY = args.includes('--derived-coverage');
const CROSS_ANCHOR_ONLY = args.includes('--cross-anchor');
const ALL = !COVERAGE_ONLY && !DERIVED_ONLY && !CROSS_ANCHOR_ONLY;

const { default: db } = await import('../../lib/db.js');
db.pragma('query_only = 1');
const { FAMILY_TAGS } = await import('../../lib/scoring.js');
const { labelInfo, relationPhrase, edgeDomain } = await import('../../lib/relation-vocabulary.js');
const { renderEgoBlock } = await import('../../lib/ego-render.js');
const { walkOwnerView } = await import('../../lib/relation-walk.js');
const { ownerPersonId } = await import('../../lib/identity.js');

const failures = [];
function fail(msg) {
  failures.push(msg);
  console.error(`[graph-fact-quiz] FAIL ${msg}`);
}

const ownerId = ownerPersonId();
if (!ownerId) {
  fail('owner_person_id missing from identity.json — the ego graph has no anchor');
  console.error(`[graph-fact-quiz] ${failures.length} failure(s)`);
  process.exit(1);
}

const firstDegree = db.prepare(`
  SELECT id, display_name, relation_tag, relation_label, relation_derived_phrase
  FROM people
  WHERE relation_tag IS NOT NULL AND COALESCE(archived, 0) = 0 AND id != ?
`).all(String(ownerId));

const activeEdges = db.prepare(`
  SELECT * FROM person_relations WHERE status = 'active'
`).all();

// ── 1. Vocabulary integrity ───────────────────────────────────────────────────
if (ALL) {
  for (const p of firstDegree) {
    if (!FAMILY_TAGS.has(p.relation_tag)) {
      fail(`person ${p.id} (${p.display_name}) carries relation_tag "${p.relation_tag}" outside FAMILY_TAGS`);
    }
    if (p.relation_label) {
      const info = labelInfo(p.relation_label);
      if (!info) {
        fail(`person ${p.id} (${p.display_name}) carries relation_label "${p.relation_label}" outside the closed vocabulary`);
      } else if (info.tag !== p.relation_tag) {
        fail(`person ${p.id} (${p.display_name}) label "${p.relation_label}" belongs to tag "${info.tag}", row has "${p.relation_tag}"`);
      }
    }
  }
  for (const e of activeEdges) {
    if (!edgeDomain(e.rel_type)) {
      fail(`edge ${e.id} carries rel_type "${e.rel_type}" outside the closed edge vocabulary`);
    }
    if (edgeDomain(e.rel_type) && e.domain !== edgeDomain(e.rel_type)) {
      fail(`edge ${e.id} domain "${e.domain}" disagrees with vocabulary domain "${edgeDomain(e.rel_type)}" for ${e.rel_type}`);
    }
  }
}

// ── 2. Render coverage + curated-source guard ────────────────────────────────
if (ALL || COVERAGE_ONLY) {
  const family = firstDegree.filter((p) => FAMILY_TAGS.has(p.relation_tag) && String(p.display_name || '').trim());
  const rendered = renderEgoBlock(db, { ownerId });
  if (!rendered && family.length) {
    fail(`ego render is EMPTY while ${family.length} family-tagged people exist`);
  } else {
    for (const p of family) {
      const phrase = p.relation_derived_phrase || relationPhrase(p.relation_tag, p.relation_label);
      const expectedLine = `- ${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}: ${String(p.display_name).trim()}`;
      if (!rendered.includes(expectedLine)) {
        fail(`render missing line for ${p.display_name}: expected "${expectedLine}"`);
      }
    }
  }
  console.log(`[graph-fact-quiz] render coverage: ${family.length} family-tagged people checked against ${rendered.length} rendered chars`);
}

// ── 3. Edge integrity — one active edge per unordered pair + domain ─────────
if (ALL) {
  const seen = new Map();
  for (const e of activeEdges) {
    const [a, b] = [String(e.person_a), String(e.person_b)].sort();
    const key = `${a}|${b}|${e.domain}`;
    if (seen.has(key)) {
      fail(`pair (${a}, ${b}) holds TWO active ${e.domain} edges (ids ${seen.get(key)}, ${e.id}) — conflicting claims are both active`);
    } else {
      seen.set(key, e.id);
    }
  }
  // Active edges must not touch archived people (AC-11 belt-and-braces) —
  // INCLUDING the owner: the identity anchor must never be archived (the
  // vendor-classifier misfire that buried it is guarded in
  // 03b-service-vendor and 06-archive; a red here means a guard regressed).
  const archivedStmt = db.prepare('SELECT COALESCE(archived, 0) AS archived FROM people WHERE id = ?');
  for (const e of activeEdges) {
    for (const end of [e.person_a, e.person_b]) {
      const row = archivedStmt.get(String(end));
      if (row && Number(row.archived) === 1) {
        fail(`active edge ${e.id} touches archived person ${end} — archive cleanup missed it${String(end) === String(ownerId) ? ' (this is the OWNER identity anchor: repair archived=0; never deprecate the owner edges)' : ''}`);
      }
    }
  }
}

// ── 4. Cache coherence — the two-truths killer ───────────────────────────────
if (ALL) {
  try {
    const view = walkOwnerView(db, { ownerId });
    const viewById = new Map(view.map((r) => [String(r.person_id), r]));
    for (const p of firstDegree) {
      const derived = viewById.get(String(p.id));
      if (!derived) {
        // A cached tag with no walk derivation is legal ONLY in the
        // pre-backfill grace window (empty edge table).
        if (activeEdges.length > 0) {
          fail(`person ${p.id} (${p.display_name}) carries cached tag "${p.relation_tag}" but the walker derives nothing — stale cache (two truths)`);
        }
        continue;
      }
      if (derived.relation_tag !== p.relation_tag
        || (derived.relation_label || null) !== (p.relation_label || null)
        || (derived.relation_derived_phrase || null) !== (p.relation_derived_phrase || null)) {
        fail(`person ${p.id} (${p.display_name}) cache (${p.relation_tag}/${p.relation_label}/${p.relation_derived_phrase}) drifted from walker output (${derived.relation_tag}/${derived.relation_label}/${derived.relation_derived_phrase})`);
      }
    }
    for (const r of view) {
      if (!firstDegree.some((p) => String(p.id) === String(r.person_id))) {
        const row = db.prepare('SELECT relation_tag, COALESCE(archived,0) AS archived, display_name FROM people WHERE id = ?').get(String(r.person_id));
        if (row && Number(row.archived) === 0 && row.relation_tag !== r.relation_tag) {
          fail(`walker derives ${r.relation_tag} for ${r.person_id} (${row.display_name}) but the cache holds "${row.relation_tag}" — cache refresh missed a write`);
        }
      }
    }
    console.log(`[graph-fact-quiz] cache coherence: ${firstDegree.length} cached rows vs ${view.length} walked derivations`);
  } catch (err) {
    fail(`cache-coherence check failed to run: ${err.message}`);
  }
}

// ── 5. Provenance ordering on edges ──────────────────────────────────────────
// The Caroline pattern on the new store: after the owner speaks, no
// lower-authority write may stand over it.
if (ALL) {
  try {
    // (a) An owner tombstone (owner-cleared / owner-declined) permanently
    // blocks non-owner re-assertion of that (pair, rel_type).
    const tombs = db.prepare(`
      SELECT * FROM person_relations
      WHERE status = 'deprecated' AND deprecated_reason IN ('owner-cleared','owner-declined')
    `).all();
    for (const t of tombs) {
      const reasserted = activeEdges.find((e) => e.rel_type === t.rel_type
        && e.authority !== 'owner'
        && ((e.person_a === t.person_a && e.person_b === t.person_b) || (e.person_a === t.person_b && e.person_b === t.person_a))
        && e.id > t.id);
      if (reasserted) {
        fail(`edge ${reasserted.id} (${reasserted.authority}) re-asserts (${t.person_a}, ${t.person_b}, ${t.rel_type}) over owner tombstone ${t.id} — the pipeline overrode the owner`);
      }
    }
    // (b) No owner-authority edge was ever superseded by a lower authority.
    const supersededOwner = db.prepare(`
      SELECT o.id AS old_id, o.authority AS old_auth, n.id AS new_id, n.authority AS new_auth
      FROM person_relations o JOIN person_relations n ON o.superseded_by = n.id
      WHERE o.authority = 'owner' AND n.authority != 'owner'
    `).all();
    for (const s of supersededOwner) {
      fail(`owner edge ${s.old_id} was superseded by ${s.new_auth} edge ${s.new_id} — lower authority overwrote the owner`);
    }
    console.log(`[graph-fact-quiz] provenance ordering: ${tombs.length} owner tombstones, ${activeEdges.length} active edges checked`);
  } catch (err) {
    fail(`provenance-ordering check failed to run: ${err.message}`);
  }
}

// ── 6. Derived coverage (--derived-coverage) ─────────────────────────────────
// Every walk-derived person renders their derived phrase in the ego block and
// the coarse tag matches the cache.
if (ALL || DERIVED_ONLY) {
  try {
    const view = walkOwnerView(db, { ownerId });
    const rendered = renderEgoBlock(db, { ownerId });
    let derivedCount = 0;
    for (const r of view) {
      const row = db.prepare('SELECT relation_tag, relation_derived_phrase, display_name, COALESCE(archived,0) AS archived FROM people WHERE id = ?').get(String(r.person_id));
      if (!row || Number(row.archived) === 1 || !String(row.display_name || '').trim()) continue;
      if (row.relation_tag !== r.relation_tag) {
        fail(`derived-coverage: ${r.person_id} (${row.display_name}) coarse tag "${row.relation_tag}" does not match walk tag "${r.relation_tag}"`);
      }
      if (!r.relation_derived_phrase) continue;
      derivedCount++;
      const phrase = r.relation_derived_phrase;
      const expectedLine = `- ${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}: ${String(row.display_name).trim()}`;
      if (!rendered.includes(expectedLine)) {
        fail(`derived-coverage: render missing derived line for ${row.display_name}: expected "${expectedLine}"`);
      }
    }
    console.log(`[graph-fact-quiz] derived coverage: ${derivedCount} walk-derived phrases checked in the ego render`);
  } catch (err) {
    fail(`derived-coverage check failed to run: ${err.message}`);
  }
}

// ── 7. Cross-anchor integrity (--cross-anchor, AC-10) ────────────────────────
// No person may hold BOTH an active owner-anchored kinship edge and an active
// same-class spouse-side kinship edge without an owner answer on record.
if (ALL || CROSS_ANCHOR_ONLY) {
  try {
    const owner = String(ownerId);
    const kinship = activeEdges.filter((e) => e.domain === 'kinship');
    const spouseIds = kinship
      .filter((e) => e.rel_type === 'spouse' && (e.person_a === owner || e.person_b === owner))
      .map((e) => (e.person_a === owner ? e.person_b : e.person_a));
    let checked = 0;
    for (const e of kinship) {
      if (e.rel_type === 'spouse' || e.rel_type === 'pet') continue;
      if (e.person_a === owner || e.person_b === owner) continue;
      const spouseEnd = [e.person_a, e.person_b].find((id) => spouseIds.includes(id));
      if (!spouseEnd) continue;
      const x = e.person_a === spouseEnd ? e.person_b : e.person_a;
      const ownerEdge = kinship.find((o) => o.rel_type === e.rel_type
        && ((o.person_a === owner && o.person_b === x) || (o.person_a === x && o.person_b === owner)));
      if (!ownerEdge) continue;
      checked++;
      const answered = db.prepare(`
        SELECT 1 FROM relation_questions
        WHERE kind = 'cross-anchor' AND subject_person_id = ? AND rel_type = ?
          AND status IN ('confirmed','declined')
        LIMIT 1
      `).get(String(x), e.rel_type);
      if (!answered) {
        fail(`cross-anchor: person ${x} is active as the owner's ${e.rel_type} AND as a spouse-side ${e.rel_type} with no owner answer on record`);
      }
    }
    console.log(`[graph-fact-quiz] cross-anchor: ${checked} dual-truth pairs checked`);
  } catch (err) {
    fail(`cross-anchor check failed to run: ${err.message}`);
  }
}

if (failures.length) {
  console.error(`[graph-fact-quiz] ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('[graph-fact-quiz] OK — graph passes the data-layer fact quiz');
process.exit(0);
