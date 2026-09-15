/**
 * Family inference — restore from 1c2118d:lib/family-inference.js with the
 * canonical corrections sealed in st_87a0d072 framing:
 *
 *   - Pass 1 (iMessage surname clusters) — TIGHTENED:
 *       Original guard: ≥50% surname share within a 2–8-person group AND ≥3 names.
 *       New guard: ALSO require (uncommon-surname rank > 25K) OR (≥4 matching names
 *       in the group). Common surnames (Patel, Nguyen, Smith) create false-positive
 *       families; the uncommon-or-large-cluster rule blocks them.
 *
 *   - Pass 2 (contacts surname clusters) — DROPPED entirely. Too noisy: a shared
 *     surname in your contacts list does not imply family.
 *
 *   - Pass 3 (spouse-transitive) — UNCHANGED. A known spouse's surname cluster
 *     becomes sibling-in-law (confidence 0.85).
 *
 * Miyagi manual override beats inference — confidence 1.0 from set-relation-tag
 * is written directly to people.relation_tag and is never overwritten here (the
 * Apply loop checks `!byId.get(pid)?.relation_tag` before writing).
 *
 * Sets `relation_tag` only — never touches `tier`, `score`, or `n2`.
 *
 * WHY relation_tag-only writes: tier and score are score-derived (Phase 5).
 * Manual tags should affect tier via Phase 5 FAMILY_TAGS lookup, not by direct
 * write here.
 */
import db from './db.js';
import { ownerPersonId, ownerDisplayNameMatch } from './identity.js';
import { isSurnameRare } from './nickname-resolver.js';
import { setRelationTag } from './people-write.js';

const stmts = {
  allPeople: db.prepare(`SELECT id, display_name, relation_tag, primary_source FROM people WHERE archived = 0`),
  // st_df0a8d71 QA round 2 — relationship writes go through setRelationTag
  // (the ONE write path: authority + weak-evidence floors, supersede facts,
  // graph-change). Kept as a thin adapter so call sites stay one-line.
  setRelation: { run: (relation, pid) => setRelationTag(db, pid, relation, null, { source: 'family-inference' }) },
  imessageGroups: db.prepare(`
    SELECT pg.group_identifier, GROUP_CONCAT(p.display_name, '|') as names, GROUP_CONCAT(pg.person_id, '|') as ids, COUNT(*) as n
    FROM person_groups pg JOIN people p ON p.id = pg.person_id
    WHERE pg.group_type = 'imessage' AND p.archived = 0 GROUP BY pg.group_identifier HAVING n BETWEEN 2 AND 8
  `),
};

const lastName = (n) => {
  if (!n) return null;
  const p = n.trim().split(/\s+/);
  return p.length >= 2 ? p[p.length - 1].toLowerCase() : null;
};

/**
 * Build a map of every existing spouse → their last name, so Pass 3 can walk
 * surname clusters built from contacts only via the people table (not a
 * separate clusters table). We rebuild the surname index inside this function
 * to avoid Pass 2's drift — only people-table rows are inspected.
 */
function buildSurnameClusters(people) {
  const clusters = new Map();
  for (const p of people) {
    const ln = lastName(p.display_name);
    if (!ln || ln.length < 3) continue;
    if (!clusters.has(ln)) clusters.set(ln, []);
    clusters.get(ln).push({ person_id: p.id, display_name: p.display_name });
  }
  return clusters;
}

export function inferFamilyRelationships({ dryRun = false, verbose = false } = {}) {
  const log = verbose ? console.log.bind(console) : () => {};
  // Resolve owner identity from ~/robotdojo/config/identity.json. Prefer the
  // explicit owner_person_id; fall back to a display_name_match string.
  // Returns null if identity is not yet configured (family inference
  // still runs, just without owner-as-anchor for sibling detection).
  let owner = null;
  const pid = ownerPersonId();
  if (pid) {
    owner = db.prepare(`SELECT id, display_name FROM people WHERE id = ? AND archived = 0`).get(pid);
  } else {
    const nameMatch = ownerDisplayNameMatch();
    if (nameMatch) {
      owner = db.prepare(`SELECT id, display_name FROM people WHERE LOWER(display_name) LIKE ? AND archived = 0 LIMIT 1`)
        .get(`%${nameMatch}%`);
    }
  }
  const ownerLn = owner ? lastName(owner.display_name) : null;

  const people = stmts.allPeople.all();
  const byId = new Map(people.map(p => [p.id, p]));
  const inferred = new Map(); // personId → { relation, confidence, signal }

  const add = (id, rel, conf, sig) => {
    const ex = inferred.get(id);
    if (!ex || conf > ex.confidence) inferred.set(id, { relation: rel, confidence: conf, signal: sig });
  };

  // ── Pass 1 (TIGHTENED): iMessage groups with shared surnames ──────────────
  // Original guard: ≥50% same surname AND ≥3 total members.
  // st_87a0d072 tighten: ALSO require (uncommon surname OR ≥4 matches).
  // Reason: a 3-person iMessage group with 2 Patels is not a family signal —
  // Patel is common enough to fire on a colleague + their referral.
  log('Pass 1: iMessage family groups (uncommon-surname OR ≥4-matches guard)');
  for (const g of stmts.imessageGroups.all()) {
    const names = g.names.split('|'), ids = g.ids.split('|');
    const lns = names.map(lastName).filter(Boolean);
    const counts = {};
    for (const ln of lns) counts[ln] = (counts[ln] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (!top || top[1] < Math.ceil(names.length * 0.5) || names.length < 3) continue;
    const [topSurname, matchCount] = top;
    // NEW guard — surname must be uncommon (rank > 25K) OR at least 4 members share it.
    if (!isSurnameRare(topSurname) && matchCount < 4) continue;
    for (let i = 0; i < ids.length; i++) {
      const ln = lastName(names[i]);
      if (ln === topSurname) add(ids[i], ownerLn && ln === ownerLn ? 'sibling' : 'family', 0.7, 'family-group-sms');
    }
  }

  // ── Pass 2 (DROPPED): contacts surname clusters ───────────────────────────
  // The 1c2118d baseline tagged people whose surname was shared with ≥2 other
  // contacts and either matched the owner's surname or appeared alongside a
  // known-relation anchor. In practice this fired on co-workers with shared
  // names; manual review showed ~40% false positives. st_87a0d072 drops it
  // entirely in favour of explicit config/family.json + Pass 1 + Pass 3.

  // ── Pass 3 (UNCHANGED): Transitive spouse → sibling-in-law surname cluster ─
  // A person tagged 'spouse' implies their surname-cluster contacts are
  // siblings-in-law. We build clusters here (not Pass 2) since Pass 2 is gone.
  log('Pass 3: Spouse transitives');
  const clusters = buildSurnameClusters(people);
  for (const sp of people.filter(p => p.relation_tag === 'spouse')) {
    const spLn = lastName(sp.display_name);
    if (!spLn || spLn === ownerLn) continue;
    for (const c of (clusters.get(spLn) || [])) {
      if (c.person_id === sp.id || byId.get(c.person_id)?.relation_tag) continue;
      add(c.person_id, 'sibling-in-law', 0.85, 'spouse-name-cluster');
    }
  }

  // Apply
  if (dryRun) {
    console.log(`[DRY RUN] Would apply ${inferred.size} family inferences`);
    return { applied: 0, skipped: 0, total: inferred.size };
  }

  // st_f67bc2eb AC-3 — inference NEVER writes an edge. Every call below goes
  // through the setRelationTag adapter with source 'family-inference', which
  // the store REFUSES and converts into a queue question. This pass therefore
  // promotes candidates into questions; "applied" would be a lie — count
  // queued honestly.
  let queued = 0, skipped = 0;
  db.transaction(() => {
    for (const [pid, inf] of inferred) {
      // Never touch an already-related row — the graph (and the owner) won.
      if (inf.confidence >= 0.5 && !byId.get(pid)?.relation_tag) { stmts.setRelation.run(inf.relation, pid); queued++; }
      else skipped++;
    }
  })();
  console.log(`Family inference: ${queued} candidates queued as questions, ${skipped} skipped (of ${inferred.size} candidates) — inference never writes edges`);
  return { applied: 0, queued, skipped, total: inferred.size };
}
