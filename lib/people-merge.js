/**
 * lib/people-merge.js — person merge + archive cleanup as PRODUCT operations
 * (st_f67bc2eb AC-11).
 *
 * Before this story the only merge lived inside the ingest pipeline
 * (scripts/ingest/02-resolve.js mergeInto) and the two live duplicate pairs
 * had to be repaired with one-off writes. This module extracts the record
 * absorption into lib/ so the product (routes/network.js) and the pipeline
 * share ONE merge implementation, and adds the edge-store semantics the
 * remodel requires:
 *
 *   - the winner absorbs the loser's ACTIVE person_relations edges through
 *     lib/relation-store.js (authority rules hold — a stated loser edge can
 *     never displace an owner winner edge);
 *   - the loser's edges are deprecated with reason 'merged' (never deleted);
 *   - archiving a person deprecates their active edges (shared cleanup used
 *     by merge, the archive path, and the rerun sweep);
 *   - idempotent: re-merging an already-archived loser is a no-op.
 *
 * Tier 0 — deterministic SQL. No LLM near identity, ever.
 */

import {
  assertRelation,
  deprecateEdgesForPerson,
  getActiveEdgesForPerson,
} from './relation-store.js';
import { refreshDerivedRelationCache } from './people-write.js';
import {
  ownerPersonId,
  isOwner,
  declaredOwnerName,
  declaredOwnerIdentifierSet,
} from './identity.js';
// df_cbd30a5a AC-12 — the precision merge gate reuses the pure identity-matching
// primitives from the leaf module (one source of truth; breaks the require-cycle).
import {
  analyzeIdentifierGraph,
  nameAgreement,
  buildPopularIdentifierSet,
  isPopularIdentifier,
} from './identity-matching.js';

// Re-export so the merge-gate home exposes buildPopularIdentifierSet alongside
// shouldMerge / writeMergeTriage (02-resolve.js phaseResolve imports it here).
export { buildPopularIdentifierSet };

// ── Owner-anchor guard (df_cbd30a5a) ─────────────────────────────────────────
//
// The owner is the ONE protected node. A Google Contact in the owner's own data
// co-listed a friend's forwarded emails, and the transitive-email merge welded
// that friend's separate record into the owner — the assistant then answered as
// the friend. The durable fix is a declared owner identity (lib/identity.js)
// plus this guard at the exact merge site: resolution will not absorb a FOREIGN
// ESTABLISHED person into the owner, and cannot rename the owner.
//
// ONE shared predicate (guardOwnerAbsorb), two call sites (02-resolve.js
// attachIdentifierOrMerge and absorbPersonRecords below) so pipeline and product
// merge can never drift — mirrors how absorbPersonRecords is already the single
// merge body.
//
// The union is load-bearing (failure manifest #2): the owner row holds ~47 live
// email identifiers while the declared block names only ~3. Keying foreignness
// on the declared set alone would misread an owner DUPLICATE (carrying an
// undeclared owner email like owner-alias@work-a.example plus chunks) as foreign
// and BLOCK the owner's own self-dedup. Unioning the declared set with the owner
// record's CURRENT identifiers, plus an owner-name match, makes an owner
// duplicate never foreign.

const normEmailForGuard = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : null);
const normPhoneForGuard = (s) => {
  if (!s) return null;
  const d = String(s).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return d.length >= 7 ? `+${d}` : null;
};
const normIdentForGuard = (type, value) => (type === 'phone' ? normPhoneForGuard(value) : normEmailForGuard(value));

/**
 * The owner-controlled identifier set: DECLARED emails/phones UNION the current
 * email/phone identifiers on the owner_person_id record. Normalized to match
 * person_identifiers.value so a colliding resolver identifier compares
 * like-for-like. An identifier in this set is the owner's OWN — never a foreign
 * bridge.
 */
export function ownerControlledIdentifierSet(db) {
  const set = declaredOwnerIdentifierSet(); // already normalized
  const owner = ownerPersonId();
  if (owner) {
    try {
      const rows = db.prepare(
        "SELECT type, value FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')",
      ).all(String(owner));
      for (const r of rows) {
        const v = normIdentForGuard(r.type, r.value);
        if (v) set.add(v);
      }
    } catch { /* person_identifiers absent in a minimal test DB — declared set stands */ }
  }
  return set;
}

/**
 * Is `personId` an ACTIVE, non-owner, established person who holds a hard
 * identifier that is NOT owner-controlled and whose name does not match the
 * declared owner? A foreign person passes; an owner duplicate fails
 * (owner-controlled identifier and/or the owner name), so owner self-dedup is
 * never blocked.
 *
 * "Established" = real substance (chunks > 0 OR interaction_count > 0 OR
 * source_count > 1). A pure ghost row carries no data to blend and is admitted
 * intentionally (failure manifest #3).
 */
export function isForeignEstablishedPerson(db, personId) {
  const owner = ownerPersonId();
  if (owner && String(personId) === String(owner)) return false; // the owner is never foreign
  let p;
  try {
    p = db.prepare(
      'SELECT display_name, COALESCE(archived,0) AS archived, COALESCE(interaction_count,0) AS ic, COALESCE(source_count,0) AS sc FROM people WHERE id = ?',
    ).get(String(personId));
  } catch { return false; }
  if (!p || Number(p.archived) === 1) return false;

  // Name match → an owner duplicate, not a foreign person.
  const declared = declaredOwnerName();
  if (declared && String(p.display_name || '').trim().toLowerCase() === declared) return false;

  const ownerSet = ownerControlledIdentifierSet(db);
  let idents = [];
  try {
    idents = db.prepare(
      "SELECT type, value FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')",
    ).all(String(personId));
  } catch { idents = []; }
  const hasForeignIdent = idents.some((r) => {
    const v = normIdentForGuard(r.type, r.value);
    return v && !ownerSet.has(v);
  });
  if (!hasForeignIdent) return false; // every hard identifier is owner-controlled → owner dup

  let chunks = 0;
  try { chunks = db.prepare("SELECT COUNT(*) AS n FROM chunk_entities WHERE entity_id = ? AND entity_type = 'person'").get(String(personId)).n; } catch { chunks = 0; }
  return chunks > 0 || Number(p.ic) > 0 || Number(p.sc) > 1;
}

/**
 * Is `personId` owner-identified for the guard's WINNER test? True when it is
 * the anchored owner_person_id, OR its name matches the declared owner, OR it
 * holds a DECLARED owner identifier. Keyed on declared membership (not the
 * union) so the guard is armed the moment the installer writes the declared
 * block — before owner_person_id is anchored on the first ingest.
 */
function isWinnerOwnerIdentified(db, winnerId) {
  if (isOwner(winnerId)) return true;
  const declared = declaredOwnerName();
  let p;
  try { p = db.prepare('SELECT display_name FROM people WHERE id = ?').get(String(winnerId)); } catch { p = null; }
  if (declared && p && String(p.display_name || '').trim().toLowerCase() === declared) return true;
  const declaredSet = declaredOwnerIdentifierSet();
  if (!declaredSet.size) return false;
  let idents = [];
  try {
    idents = db.prepare(
      "SELECT type, value FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')",
    ).all(String(winnerId));
  } catch { idents = []; }
  return idents.some((r) => {
    const v = normIdentForGuard(r.type, r.value);
    return v && declaredSet.has(v);
  });
}

/**
 * The single owner-anchor predicate. Refuses two merges:
 *   - the owner as merge LOSER (identity anchor buried) — the pre-existing rule.
 *   - a FOREIGN ESTABLISHED person absorbed into the owner as WINNER — the
 *     owner-as-winner hole this defect closed.
 *
 * Self-dedup exception: when the bridge identifier is itself owner-controlled,
 * the "loser" carries the owner's OWN address, so it is an owner duplicate and
 * the merge is allowed (belt-and-braces with the name-match in
 * isForeignEstablishedPerson).
 *
 * @returns {{ refuse: boolean, reason?: string }}
 */
export function guardOwnerAbsorb(db, winnerId, loserId, opts = {}) {
  const owner = String(ownerPersonId() || '');
  if (owner && String(loserId) === owner) {
    return { refuse: true, reason: 'owner-is-loser' };
  }
  if (isWinnerOwnerIdentified(db, winnerId) && isForeignEstablishedPerson(db, loserId)) {
    const bridge = opts.collidingValue != null
      ? normIdentForGuard(opts.collidingType || 'email', opts.collidingValue)
      : null;
    if (bridge && ownerControlledIdentifierSet(db).has(bridge)) {
      return { refuse: false }; // owner's own identifier → an owner duplicate; allow self-dedup
    }
    return { refuse: true, reason: 'refused-owner-anchor' };
  }
  return { refuse: false };
}

/**
 * Persist a refused-merge decision to resolve_audit — a refused merge is a
 * durable NEGATIVE ASSERTION (auditable, never a silent no-op). decision='skip',
 * `guard` names the rule that fired, evidence carries the refused loser + the
 * bridge identifier, person_id = the winner the loser was refused into.
 */
function auditRefused(db, winnerId, loserId, guard, bridgeValue, source = 'owner-anchor-guard') {
  try {
    db.prepare(`
      INSERT INTO resolve_audit (candidate_id, entity_type, decision, guard, confidence, evidence, source, person_id)
      VALUES (NULL, 'person', 'skip', ?, 1.0, ?, ?, ?)
    `).run(String(guard), `${loserId}|bridge:${bridgeValue || ''}`, String(source), String(winnerId));
  } catch { /* audit table absent in minimal test DBs */ }
}
/** Back-compat wrapper — the owner-anchor refusal is one guard token. */
function auditRefusedOwnerAnchor(db, winnerId, loserId, bridgeValue) {
  auditRefused(db, winnerId, loserId, 'refused-owner-anchor', bridgeValue);
}
export { auditRefused, auditRefusedOwnerAnchor };

// ── Durable must-not-merge constraint (df_cbd30a5a AC-10) ─────────────────────
//
// The declared-owner anchor (guardOwnerAbsorb) is the OWNER's durable negative
// assertion. A general non-owner split (lib/entity-unmerge.js, the over-merge
// detector) has NO declared anchor to key on, so the split records the pair in
// the must_not_merge table or the next 02-resolve pass re-welds via the same
// shared/forwarded identifier (the re-weld loop). Order-independent pair:
// person_id_a = min id, person_id_b = max id, so UNIQUE(a,b) is one row per
// unordered pair. Written ONLY by this deterministic code (LLM-write boundary).

/** Canonical (min,max) ordering of a pair so a reversed write dedups. */
function canonicalPair(idX, idY) {
  const a = String(idX);
  const b = String(idY);
  return a <= b ? [a, b] : [b, a];
}

/** True if the pair is recorded as must-not-merge (either argument order). */
export function isMergeForbidden(db, idX, idY) {
  if (!idX || !idY || String(idX) === String(idY)) return false;
  const [a, b] = canonicalPair(idX, idY);
  try {
    return !!db.prepare('SELECT 1 FROM must_not_merge WHERE person_id_a = ? AND person_id_b = ? LIMIT 1').get(a, b);
  } catch {
    return false; // table absent in a minimal test DB → no constraint
  }
}

// ── Merge-forwarding: from any id to its current active survivor ──────────────
//
// A merge archives the loser (absorbPersonRecords: `UPDATE people SET archived=1`)
// and records the forwarding in resolve_audit — one row with decision='merge',
// person_id = the WINNER (survivor), and evidence naming the LOSER as its first
// token (`<loserId>` or `<loserId>|<detail>`). There is no merged_into column on
// people; resolve_audit IS the authoritative loser→winner map, and every merge
// path (product mergePeople, pipeline mergeInto, the G-passes) writes it through
// the one shared absorbPersonRecords body.
//
// WHY resolveSurvivor exists (df / merge-triage stale-dismissal bug): when one
// real person is over-split into 3+ records, the triage queue holds several pairs
// among them. Resolving one pair archives a record AND can change which id is the
// survivor; a later pair still names the now-archived id. Without forwarding, the
// resolver reads that id as "gone / nothing to merge" and drops a still-mergeable
// fragment (live incident: two people each kept a silent unmerged fragment). This
// helper answers "given an id that a merge may have archived, what is its current
// active survivor?" so no live-mergeable pair is ever dismissed as stale.

/** Escape LIKE wildcards so an id containing % or _ still matches literally. */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The winner a merged loser forwarded to: the most recent resolve_audit merge row
 * whose evidence names `loserId` (evidence = `loserId` exactly, or `loserId|…`).
 * decision='skip' refusal rows carry the loser id too but are excluded by
 * decision='merge'. Returns the winner id, or null when nothing forwards it.
 */
function forwardingWinner(db, loserId) {
  try {
    const row = db.prepare(`
      SELECT person_id
        FROM resolve_audit
       WHERE decision = 'merge'
         AND entity_type = 'person'
         AND person_id IS NOT NULL
         AND person_id != ?
         AND (evidence = ? OR evidence LIKE ? ESCAPE '\\')
       ORDER BY id DESC
       LIMIT 1
    `).get(String(loserId), String(loserId), escapeLike(loserId) + '|%');
    return row?.person_id != null ? String(row.person_id) : null;
  } catch {
    return null; // resolve_audit absent in a minimal test DB
  }
}

/**
 * Follow the merge-forwarding chain from a person id to its CURRENT active
 * survivor. Walks archived→winner until it reaches an ACTIVE (archived=0) record.
 * Guards against a cycle (a corrupt back-reference in resolve_audit) with a seen
 * set and a hop cap — a real chain is only a few hops deep.
 *
 * @returns {string|null} the active survivor id, or null when the id is genuinely
 *   gone (archived/absent with no onward merge forwarding — e.g. hard-deleted, or
 *   plain-archived and never merged). The caller treats null as "nothing to merge".
 */
export function resolveSurvivor(db, personId) {
  if (personId == null) return null;
  let current = String(personId);
  const seen = new Set();
  for (let hops = 0; hops < 128; hops++) {
    if (seen.has(current)) return null; // cycle → refuse to loop; treat as gone
    seen.add(current);
    let row;
    try {
      row = db.prepare('SELECT COALESCE(archived,0) AS archived FROM people WHERE id = ?').get(current);
    } catch {
      return null; // people table absent in a minimal test DB
    }
    if (row && Number(row.archived) === 0) return current; // reached an active survivor
    const next = forwardingWinner(db, current);
    if (!next || next === current || seen.has(next)) return null; // dead end → genuinely gone
    current = next;
  }
  return null; // exceeded the hop cap → treat as gone rather than spin
}

/** Record a durable must-not-merge constraint for the pair (INSERT OR IGNORE). */
export function writeMustNotMerge(db, idX, idY, { reason = 'unmerge-split', source = 'entity-unmerge' } = {}) {
  if (!idX || !idY || String(idX) === String(idY)) return false;
  const [a, b] = canonicalPair(idX, idY);
  try {
    const r = db.prepare(
      'INSERT OR IGNORE INTO must_not_merge (person_id_a, person_id_b, reason, source) VALUES (?, ?, ?, ?)',
    ).run(a, b, String(reason), String(source));
    return r.changes > 0;
  } catch (err) {
    console.warn('[people-merge] writeMustNotMerge failed:', err?.message || err);
    return false;
  }
}

// ── The precision merge gate (df_cbd30a5a AC-12) ──────────────────────────────
//
// The unconditional transitive merge at 02-resolve.js attachIdentifierOrMerge was
// the true root of the over-welds: ANY shared hard identifier fused two people, so
// one forwarded/shared address welded 13 distinct BCG colleagues (record 168f0369)
// and a friend into the owner. shouldMerge replaces that with a deterministic
// Tier-0 decision table: a shared NON-popular identifier fuses only WITH
// corroboration and only if the union stays name-coherent; every uncertain case is
// diverted to the async triage queue (merge_triage) instead of being guessed on
// the critical path. Routed through BOTH merge sites — attachIdentifierOrMerge
// (full gate, bridge present) and absorbPersonRecords (coherence-only,
// belt-and-braces) — so pipeline and product cannot drift. No LLM near identity.

const TRIAGE_REASONS = new Set(['borderline-name', 'over-4-cards', 'suspected-maiden-name', 'ambiguous-bridge']);
const CONTACT_SOURCES = new Set(['contacts', 'google_contacts']);

/** Read a person's email/phone identifiers with their source (for the gate). */
function identifierRowsForGate(db, personId) {
  try {
    return db.prepare(
      "SELECT type, value, source FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')",
    ).all(String(personId));
  } catch {
    return [];
  }
}

function displayNameForGate(db, personId) {
  try {
    return db.prepare('SELECT display_name FROM people WHERE id = ?').get(String(personId))?.display_name || '';
  } catch {
    return '';
  }
}

/** The current in-run distinct-content card tally for a surviving person. */
function mergedCardCount(mergedCardCounts, personId) {
  if (!mergedCardCounts || typeof mergedCardCounts.get !== 'function') return 0;
  return mergedCardCounts.get(String(personId)) || 0;
}

/**
 * Increment the in-run distinct-content card tally for a surviving person after a
 * NON-sync merge. Sync-dupes are de-duped first and never counted, so a person
 * with many synced copies of one card never trips the >4-card tripwire.
 */
export function bumpMergedCardCount(mergedCardCounts, personId) {
  if (!mergedCardCounts || typeof mergedCardCounts.set !== 'function') return;
  const key = String(personId);
  mergedCardCounts.set(key, (mergedCardCounts.get(key) || 0) + 1);
}

/**
 * The deterministic merge decision for a proposed fusion of `winnerId` + `loserId`.
 * Evaluated in order; the owner-guard + must-not-merge veto have already passed
 * upstream. Returns:
 *   { decision: 'merge' | 'keep-separate' | 'triage', guard, triage? }
 *   - 'merge'         → fuse.
 *   - 'keep-separate' → leave separate, audit only, NO triage row.
 *   - 'triage'        → leave separate AND write a merge_triage row (triage present).
 *
 * ctx:
 *   bridgeType/bridgeValue  the colliding identifier (absent in coherence-only mode).
 *   popularSet              precomputed popular-identifier Set (buildPopularIdentifierSet).
 *   mergedCardCounts        in-run distinct-card tally Map.
 *   coherenceOnly           true at the absorbPersonRecords belt-and-braces site:
 *                           run ONLY the union-coherence cut (+ owner escape), never
 *                           the popularity/corroboration gate (the G-passes supply
 *                           name agreement by construction).
 *
 * Deterministic Tier-0 — no LLM.
 */
export function shouldMerge(db, winnerId, loserId, ctx = {}) {
  // Owner self-dedup is governed by guardOwnerAbsorb upstream (it allows an owner
  // DUPLICATE and refuses a FOREIGN person). The owner row is legitimately broad
  // (many addresses, many name clusters) and would false-positive the coherence
  // cut, so the gate never blocks a merge whose winner is the owner.
  if (isOwner(winnerId) || isWinnerOwnerIdentified(db, winnerId)) {
    return { decision: 'merge', guard: 'owner-self-dedup' };
  }

  const identsA = identifierRowsForGate(db, winnerId);
  const identsB = identifierRowsForGate(db, loserId);
  const nameA = displayNameForGate(db, winnerId);
  const nameB = displayNameForGate(db, loserId);
  const union = [...identsA, ...identsB];

  // Row 1 — sync-dupe fast-path: identical identifier SET + names agree + both
  // from a contact source → merge immediately (identical iCloud+Google cards).
  const setA = new Set(identsA.map((r) => `${r.type}:${String(r.value).toLowerCase()}`));
  const setB = new Set(identsB.map((r) => `${r.type}:${String(r.value).toLowerCase()}`));
  const setsEqual = setA.size > 0 && setA.size === setB.size && [...setA].every((v) => setB.has(v));
  const bothContactSourced = union.length > 0 && union.every((r) => CONTACT_SOURCES.has(r.source));
  const nameAg = nameAgreement(nameA, nameB, identsA, identsB);
  if (setsEqual && bothContactSourced && nameAg === 'agree') {
    return { decision: 'merge', guard: 'sync-dupe' };
  }

  // Row 2 — cluster-coherence cut (both modes): a union that forms ≥2 DENSE
  // disjoint name-token clusters would join two distinct people → triage.
  if (analyzeIdentifierGraph(union).flagged) {
    return {
      decision: 'triage',
      guard: 'ambiguous-bridge',
      triage: buildTriage('ambiguous-bridge', ctx, nameA, nameB, { nameAgreement: nameAg, flagged: true }),
    };
  }

  // Coherence-only mode (absorbPersonRecords belt-and-braces): the union is
  // name-coherent and no bridge context is supplied — allow the merge. The
  // popularity/corroboration gate belongs to the born-here site only.
  if (ctx.coherenceOnly) return { decision: 'merge', guard: 'coherent' };

  const bridgeValue = ctx.bridgeValue ? String(ctx.bridgeValue).toLowerCase() : null;
  const bridgePopular = bridgeValue ? isPopularIdentifier(bridgeValue, ctx.popularSet) : false;

  // A second, INDEPENDENT, non-popular shared identifier — corroborating evidence
  // that A and B are the same person. person_identifiers has a global
  // UNIQUE(type,value) for hard identifiers, so two ACTIVE records can never share
  // a STORED value; the real corroboration is the candidate BUNDLE carrying a
  // SECOND identifier (besides the bridge) that the loser B also holds — the
  // bundle links A→B via two distinct values. (The stored-intersection check is
  // kept as defensive belt-and-braces; it is empty under the uniqueness index.)
  const loserValues = new Set(identsB.map((r) => String(r.value).toLowerCase()));
  const candidateValues = (ctx.candidateValues || []).map((v) => String(v).toLowerCase());
  const secondViaCandidate = candidateValues.some(
    (v) => v !== bridgeValue && loserValues.has(v) && !isPopularIdentifier(v, ctx.popularSet),
  );
  const secondViaStored = (() => {
    for (const key of setA) {
      if (!setB.has(key)) continue;
      const value = key.slice(key.indexOf(':') + 1);
      if (bridgeValue && value === bridgeValue) continue;
      if (!isPopularIdentifier(value, ctx.popularSet)) return true;
    }
    return false;
  })();
  const secondSharedNonPopular = secondViaCandidate || secondViaStored;

  // Row 3 — popular bridge, no independent corroboration, names don't agree →
  // keep separate (an office line / shared address; low review value, no triage).
  if (bridgePopular && !secondSharedNonPopular && nameAg !== 'agree') {
    return { decision: 'keep-separate', guard: 'popular-identifier' };
  }

  // Row 4 — corroborated → merge (≤4 distinct cards) or triage (over-4). Name
  // agreement corroborates regardless of the second link; an independent 2nd
  // shared non-popular identifier corroborates ONLY when the names do not
  // actively DISAGREE (Bunshin-caught: a household landline + a shared family
  // email across two DIFFERENT people must not fuse — it routes to triage).
  const corroborated = nameAg === 'agree' || (secondSharedNonPopular && nameAg !== 'disagree');
  if (corroborated) {
    if (mergedCardCount(ctx.mergedCardCounts, winnerId) + 1 > 4) {
      return {
        decision: 'triage',
        guard: 'over-4-cards',
        triage: buildTriage('over-4-cards', ctx, nameA, nameB, { nameAgreement: nameAg, cards: mergedCardCount(ctx.mergedCardCounts, winnerId) + 1 }),
      };
    }
    return { decision: 'merge', guard: 'corroborated-merge' };
  }

  // Row 5 — suspected maiden-name change → triage (likely-but-unproven).
  if (nameAg === 'suspected-maiden') {
    return {
      decision: 'triage',
      guard: 'suspected-maiden-name',
      triage: buildTriage('suspected-maiden-name', ctx, nameA, nameB, { nameAgreement: nameAg }),
    };
  }

  // Row 6 — borderline name (first agrees, surname differs, no continuity) → triage.
  if (nameAg === 'borderline') {
    return {
      decision: 'triage',
      guard: 'borderline-name',
      triage: buildTriage('borderline-name', ctx, nameA, nameB, { nameAgreement: nameAg }),
    };
  }

  // Row 7 — else (disagree / uncorroborated / non-popular personal bridge, incl.
  // the disagreeing-names + two-thin-shared-identifiers case) → triage.
  return {
    decision: 'triage',
    guard: 'ambiguous-bridge',
    triage: buildTriage('ambiguous-bridge', ctx, nameA, nameB, { nameAgreement: nameAg, secondSharedNonPopular }),
  };
}

/** Assemble the triage payload writeMergeTriage consumes. */
function buildTriage(reason, ctx, nameA, nameB, detail = {}) {
  return {
    reason,
    bridgeType: ctx.bridgeType || null,
    bridgeValue: ctx.bridgeValue || null,
    nameA,
    nameB,
    detail,
  };
}

/**
 * Write a merge_triage row for a pair the gate could not decide (df_cbd30a5a
 * AC-13). Canonical (min,max) pair so a re-resolve never spams duplicates;
 * INSERT OR IGNORE on UNIQUE(person_id_a, person_id_b, reason). name_a / name_b
 * are stored aligned to the canonical id order. Written ONLY by deterministic
 * code — no LLM writes a triage row (LLM-write boundary holds).
 *
 * @returns {boolean} true when a new row was inserted
 */
export function writeMergeTriage(db, idX, idY, opts = {}) {
  if (!idX || !idY || String(idX) === String(idY)) return false;
  const reason = String(opts.reason || 'ambiguous-bridge');
  if (!TRIAGE_REASONS.has(reason)) return false;
  const [a, b] = canonicalPair(idX, idY);
  // Align the supplied names to the canonical (a,b) order.
  const aIsX = a === String(idX);
  const nameA = aIsX ? opts.nameA : opts.nameB;
  const nameB = aIsX ? opts.nameB : opts.nameA;
  let detail = null;
  if (opts.detail != null) {
    try { detail = typeof opts.detail === 'string' ? opts.detail : JSON.stringify(opts.detail); }
    catch { detail = null; }
  }
  try {
    const r = db.prepare(`
      INSERT OR IGNORE INTO merge_triage
        (person_id_a, person_id_b, reason, bridge_type, bridge_value, name_a, name_b, detail, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(a, b, reason, opts.bridgeType || null, opts.bridgeValue || null,
      nameA || null, nameB || null, detail, String(opts.source || 'resolve'));
    return r.changes > 0;
  } catch (err) {
    console.warn('[people-merge] writeMergeTriage failed:', err?.message || err);
    return false;
  }
}

/**
 * Enqueue an 'uncertain' email for later LLM adjudication (resolver hardening).
 * The deterministic classifier could settle neither 'role' nor 'person', so the
 * email is ALLOWED to attach but recorded here. Written ONLY by deterministic
 * code — no LLM writes a row (LLM-write boundary). INSERT OR IGNORE on
 * UNIQUE(person_id, value) so a re-resolve never spams duplicates.
 *
 * @returns {boolean} true when a new row was inserted
 */
export function writeEmailClassificationReview(db, personId, value, { reason = 'uncertain-email', source = 'resolve' } = {}) {
  if (!personId || !value) return false;
  try {
    const r = db.prepare(`
      INSERT OR IGNORE INTO email_classification_review (person_id, value, reason, source)
      VALUES (?, ?, ?, ?)
    `).run(String(personId), String(value).toLowerCase(), String(reason), String(source));
    return r.changes > 0;
  } catch {
    return false; // table absent in a minimal test DB
  }
}

/**
 * Absorb the loser's records into the winner — identifiers, interactions,
 * groups, chunk coverage, derived-state cleanup, archive, audit. This is the
 * exact ingest-time merge body (scripts/ingest/02-resolve.js mergeInto
 * delegates here) so pipeline and product cannot drift.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} winnerId
 * @param {string} loserId
 * @param {string} guard - audit token naming the merge rule that fired
 * @param {object} [opts]
 * @param {string} [opts.evidence] - guard-specific audit evidence
 * @param {Function} [opts.pickBestDisplayName] - optional post-merge display
 *   name picker (the ingest pipeline passes its score-based picker; the
 *   product path keeps the winner's current name)
 */
export function absorbPersonRecords(db, winnerId, loserId, guard, opts = {}) {
  if (winnerId === loserId) return;
  // Owner-anchor guard (df_cbd30a5a) — belt-and-braces for EVERY merge pass
  // (G-passes, product merge, and the pipeline mergeInto). Refuses when the
  // owner would be the loser (identity anchor buried — the pre-existing rule)
  // OR when a foreign established person would be absorbed into the owner as
  // winner. Owner self-dedup is unaffected: an owner duplicate is never a
  // foreign established person (owner-controlled identifier / owner-name match).
  const refusal = guardOwnerAbsorb(db, winnerId, loserId);
  if (refusal.refuse) {
    if (refusal.reason === 'refused-owner-anchor') {
      console.warn(`[people-merge] REFUSED merge: loser ${loserId} is a foreign established person — will not absorb into the owner (${winnerId})`);
      auditRefusedOwnerAnchor(db, winnerId, loserId, opts.evidence || '');
    } else {
      console.warn(`[people-merge] REFUSED merge: loser ${loserId} is the owner identity anchor — merge the duplicate into the owner instead`);
    }
    return;
  }
  // Durable must-not-merge veto (df_cbd30a5a AC-10) — belt-and-braces for EVERY
  // merge pass (G-passes, product merge, pipeline mergeInto). A pair split by
  // lib/entity-unmerge.js (or an owner-confirmed detector split) may never
  // re-weld here; the refusal writes a must-not-merge audit row (never silent).
  if (isMergeForbidden(db, winnerId, loserId)) {
    console.warn(`[people-merge] REFUSED merge: pair (${winnerId}, ${loserId}) is recorded must-not-merge`);
    auditRefused(db, winnerId, loserId, 'must-not-merge', opts.evidence || '', 'merge-pass');
    return;
  }
  // Precision merge gate (df_cbd30a5a AC-12) — coherence-only belt-and-braces for
  // EVERY merge pass that flows through here (pipeline mergeInto + the G-passes).
  // Runs only the union-coherence cut: a merge whose union forms ≥2 dense disjoint
  // name clusters is refused (it would weld two distinct people) and diverted to
  // triage. The G5/G6/G7 exact-name passes are name-coherent by construction so
  // they never flag. Bypassed by opts.force / opts.viaTriage — an owner-initiated
  // merge (product merge, triage --merge) was already decided by the owner.
  if (!opts.force && !opts.viaTriage) {
    const verdict = shouldMerge(db, winnerId, loserId, { coherenceOnly: true });
    if (verdict.decision !== 'merge') {
      console.warn(`[people-merge] REFUSED merge: pair (${winnerId}, ${loserId}) fails the coherence cut (${verdict.guard})`);
      if (verdict.triage) writeMergeTriage(db, winnerId, loserId, { ...verdict.triage, source: 'merge-pass' });
      auditRefused(db, winnerId, loserId, verdict.guard, opts.evidence || '', 'should-merge-coherence');
      return;
    }
  }
  // st_f67bc2eb (coordinator round) — relationship edges are records too:
  // re-point the loser's ACTIVE person_relations onto the winner THROUGH the
  // store (authority rules hold), then deprecate the loser's with reason
  // 'merged'. This lives in the SHARED absorption so pipeline merges
  // (02-resolve mergeInto) can never again archive a loser and leave its
  // edges active — the structural invariant, not a one-time cleanup.
  try {
    absorbRelationEdges(db, String(winnerId), String(loserId));
  } catch (err) {
    console.warn('[people-merge] edge absorption failed (record absorption continues):', err?.message || err);
  }
  // Re-parent person_identifiers — INSERT OR IGNORE handles duplicates.
  // (partial unique indexes mean duplicate hard identifiers on the winner will
  //  skip the move; the loser's duplicate rows are deleted below.)
  try {
    db.prepare(`UPDATE OR IGNORE person_identifiers SET person_id = ? WHERE person_id = ?`).run(winnerId, loserId);
    db.prepare(`
      DELETE FROM person_identifiers
      WHERE person_id = ?
        AND EXISTS (
          SELECT 1 FROM person_identifiers winner
          WHERE winner.person_id = ?
            AND winner.type = person_identifiers.type
            AND winner.value = person_identifiers.value
        )
    `).run(loserId, winnerId);
  } catch { /* unique-constraint conflicts are expected; ignore */ }
  // Re-parent person_interactions (no unique constraint on person_id).
  try {
    db.prepare(`UPDATE person_interactions SET person_id = ? WHERE person_id = ?`).run(winnerId, loserId);
  } catch { /* table may be absent in tests */ }
  // Re-parent person_groups (no unique constraint on person_id).
  try {
    db.prepare(`UPDATE person_groups SET person_id = ? WHERE person_id = ?`).run(winnerId, loserId);
  } catch { /* table absent */ }
  // st_f1a40461 Dedup: re-parent chunk_entities so the survivor inherits the
  // union of chunk coverage. chunk_entities has PRIMARY KEY (chunk_id,
  // entity_id), so a chunk already linked to BOTH collides on UPDATE —
  // UPDATE OR IGNORE skips the dup, then the loser's orphan rows go.
  try {
    db.prepare(`UPDATE OR IGNORE chunk_entities SET entity_id = ? WHERE entity_id = ? AND entity_type = 'person'`).run(winnerId, loserId);
    db.prepare(`DELETE FROM chunk_entities WHERE entity_id = ? AND entity_type = 'person'`).run(loserId);
  } catch { /* table may be absent in tests */ }
  // st_2cd1af73 Phase 3: clean the loser's derived context + facts — the
  // winner re-derives its own context from the unified chunk set, so the
  // loser's derived state is pure garbage. needs_regen=0 because an archived
  // loser must never be picked up by the regen scanner.
  try {
    db.prepare(`UPDATE people SET context_file_path = NULL, needs_regen = 0 WHERE id = ?`).run(loserId);
    db.prepare(`DELETE FROM entity_facts WHERE entity_type = 'person' AND entity_id = ?`).run(loserId);
  } catch { /* columns/table may be absent in minimal test DBs */ }
  // Archive the loser — keeps the row for any historical FK refs but hides it.
  db.prepare(`UPDATE people SET archived = 1, updated_at = datetime('now') WHERE id = ?`).run(loserId);
  try {
    db.prepare(`
      UPDATE people
         SET needs_regen = 1, updated_at = datetime('now')
       WHERE id = ?
         AND archived = 0
         AND n2 IN ('Family', 'Partners', 'Customers', 'Core', 'Network')
         AND context_file_path IS NOT NULL
         AND context_file_path != ''
    `).run(winnerId);
  } catch { /* column absent in minimal tests */ }
  // Audit — evidence carries the loser id plus any guard-specific tokens.
  try {
    const evidence = opts.evidence ? `${loserId}|${opts.evidence}` : loserId;
    db.prepare(`
      INSERT INTO resolve_audit (candidate_id, entity_type, decision, guard, confidence, evidence, source, person_id)
      VALUES (NULL, 'person', 'merge', ?, 1.0, ?, 'merge-pass', ?)
    `).run(guard, evidence, winnerId);
  } catch { /* audit absent */ }

  // st_87a0d072 Gap 2: re-pick the best display_name across the unified
  // identifier set when the caller supplies a picker (ingest pipeline).
  // Non-fatal: a picker failure must not break the merge.
  //
  // Owner name-lock (df_cbd30a5a): NEVER re-pick the owner's display name. The
  // score-based picker has zero owner-awareness — on the welded record it
  // scored a foreign contact's name over the owner's real name and the wrong
  // name stuck. The declared name is pinned; skip the picker entirely for the owner.
  if (typeof opts.pickBestDisplayName === 'function' && !isOwner(winnerId)) {
    try {
      let winner;
      try {
        winner = db.prepare('SELECT id, display_name, linkedin_url FROM people WHERE id = ?').get(winnerId);
      } catch {
        winner = db.prepare('SELECT id, display_name, NULL AS linkedin_url FROM people WHERE id = ?').get(winnerId);
      }
      if (winner) {
        const idents = db.prepare('SELECT type, value FROM person_identifiers WHERE person_id = ?').all(winnerId);
        const picked = opts.pickBestDisplayName(winner, idents, db, opts);
        if (picked && picked !== winner.display_name) {
          db.prepare("UPDATE people SET display_name = ?, updated_at = datetime('now') WHERE id = ?").run(picked, winnerId);
        }
      }
    } catch { /* non-fatal */ }
  }
}

/**
 * Move the loser's ACTIVE relationship edges onto the winner THROUGH the
 * store (authority rules hold: an owner edge on the winner is never displaced
 * by a stated loser edge; conflicts queue instead of silently overwriting),
 * then deprecate the loser's edges with reason 'merged'.
 */
function absorbRelationEdges(db, winnerId, loserId) {
  const loserEdges = getActiveEdgesForPerson(db, loserId);
  let moved = 0;
  for (const e of loserEdges) {
    const a = String(e.person_a) === String(loserId) ? String(winnerId) : e.person_a;
    const b = String(e.person_b) === String(loserId) ? String(winnerId) : e.person_b;
    if (String(a) === String(b)) continue; // loser↔winner edge collapses on merge
    let evidence = [];
    try { evidence = JSON.parse(e.evidence || '[]'); } catch { evidence = []; }
    const res = assertRelation(db, { personA: a, personB: b, relType: e.rel_type }, {
      authority: e.authority,
      source: e.source,
      authorPersonId: e.author_person_id,
      confidence: e.confidence,
      evidence,
      statedAt: e.stated_at,
      validFrom: e.valid_from,
      validUntil: e.valid_until,
    });
    if (['written', 'merged', 'superseded', 'evidence-appended'].includes(res.outcome)) moved++;
  }
  const { deprecated } = deprecateEdgesForPerson(db, loserId, { reason: 'merged' });
  return { moved, deprecated };
}

/**
 * The PRODUCT merge operation (AC-11): winner absorbs identifiers and edges
 * under authority rules, loser archived with edges deprecated, idempotent.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} winnerId
 * @param {string} loserId
 * @param {object} [opts]
 * @returns {{ ok: boolean, merged: boolean, reason?: string, edges?: object }}
 */
export function mergePeople(db, winnerId, loserId, opts = {}) {
  if (!winnerId || !loserId || String(winnerId) === String(loserId)) {
    return { ok: false, merged: false, reason: 'winner and loser must be two different people' };
  }
  const winner = db.prepare('SELECT id, COALESCE(archived,0) AS archived FROM people WHERE id = ?').get(String(winnerId));
  const loser = db.prepare('SELECT id, COALESCE(archived,0) AS archived FROM people WHERE id = ?').get(String(loserId));
  if (!winner) return { ok: false, merged: false, reason: 'winner not found' };
  if (!loser) return { ok: false, merged: false, reason: 'loser not found' };
  if (Number(winner.archived) === 1) return { ok: false, merged: false, reason: 'winner is archived — merge into a live person' };

  // Idempotent re-run: an archived loser with no live records and no active
  // edges has nothing left to move — a second call is a clean no-op.
  const loserActiveEdges = getActiveEdgesForPerson(db, String(loserId)).length;
  let loserIdentifiers = 0;
  try {
    loserIdentifiers = db.prepare('SELECT COUNT(*) AS n FROM person_identifiers WHERE person_id = ?').get(String(loserId))?.n || 0;
  } catch { loserIdentifiers = 0; }
  if (Number(loser.archived) === 1 && loserActiveEdges === 0 && loserIdentifiers === 0) {
    return { ok: true, merged: false, reason: 'already merged (no-op)' };
  }

  if (String(loserId) === String(ownerPersonId() || '')) {
    return { ok: false, merged: false, reason: 'the loser is the owner identity anchor — merge the duplicate into the owner instead' };
  }
  // Edge absorption happens INSIDE absorbPersonRecords (shared with the
  // pipeline mergeInto) — one implementation, no drift. force:true bypasses the
  // AC-12 coherence cut because a product merge / triage --merge is an explicit
  // owner decision (df_cbd30a5a); the owner-anchor + must-not-merge vetoes still
  // apply. opts.viaTriage (triage CLI --merge) maps to the same bypass.
  const edges = { moved_from_loser: loserActiveEdges };
  absorbPersonRecords(db, String(winnerId), String(loserId), opts.viaTriage ? 'triage-merge' : 'product-merge', {
    evidence: opts.evidence || 'routes/network.js merge',
    force: true,
  });
  refreshDerivedRelationCache(db);
  return { ok: true, merged: true, edges };
}

/**
 * Archive a person AND deprecate their active edges (AC-11 archive cleanup) —
 * the shared path for the network UI archive toggle and the rerun sweep.
 */
export function archivePersonWithCleanup(db, personId) {
  // The owner identity anchor is never archived — see absorbPersonRecords.
  if (String(personId) === String(ownerPersonId() || '')) {
    console.warn('[people-merge] REFUSED archive: the owner identity anchor cannot be archived');
    return { archived: false, edges_deprecated: 0, refused: 'owner-identity-anchor' };
  }
  const { deprecated } = deprecateEdgesForPerson(db, String(personId), { reason: 'archived' });
  db.prepare(`UPDATE people SET archived = 1, updated_at = datetime('now') WHERE id = ?`).run(String(personId));
  refreshDerivedRelationCache(db);
  return { archived: true, edges_deprecated: deprecated };
}
