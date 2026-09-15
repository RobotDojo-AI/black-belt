/**
 * lib/relation-store.js — THE person_relations write path (st_f67bc2eb D1/D2).
 *
 * Every relationship edge write in the product routes through this module —
 * no INSERT/UPDATE against person_relations may exist anywhere else
 * (grep-enforced criterion). The authority lattice, tombstone rule, temporal
 * chains, direction normalization, and the inference firewall live INSIDE the
 * write path where no writer can forget them — the exact discipline that
 * closed st_df0a8d71's rerun-overwrites-owner hole, applied to the full edge
 * class.
 *
 * AUTHORITY LATTICE (per-edge data, D2): owner > contact > stated.
 *   - higher authority supersedes (deprecate + superseded_by, never delete)
 *   - equal authority same-type merges evidence and lifts confidence
 *   - equal authority different-type resolves newest-wins ONLY through the
 *     closed temporal supersede chains (fiancée→wife); otherwise it writes
 *     NOTHING and enqueues a conflict question
 *   - lower authority never touches an existing edge (evidence append only
 *     on same-type)
 *   - inference has NO rank because inference never writes: any assert
 *     carrying an inference-class source is REFUSED and converted into a
 *     queue candidate (the Buzz/PYMK firewall, AC-3)
 *
 * TOMBSTONES (Wikidata deprecate-to-block-re-inference): an owner-deprecated
 * edge (owner clear, owner decline) is permanent. Re-assertion of that
 * (pair, rel_type) by any non-owner source is refused loudly and logged.
 *
 * DIRECTION: one canonical representation per relation class. Directional
 * types store person_a as the role holder (parent = a is b's parent);
 * symmetric types store canonical order a < b. The inverse aliases (child,
 * mentee, aunt…) are resolved to canonical form by the vocabulary BEFORE the
 * store — a pair can never carry both directions of the same fact.
 *
 * DEPRECATE-NEVER-DELETE: this module contains no DELETE statement. Corrected
 * history is queryable forever, and a corrected error can never be silently
 * re-inferred.
 *
 * Tier 0 — deterministic SQL. The LLM write boundary is untouched: no LLM
 * output reaches this module without a deterministic parse in front of it.
 */

import {
  EDGE_TYPES,
  DIRECTIONAL_EDGE_TYPES,
  TEMPORAL_SUPERSEDE_CHAINS,
  edgeDomain,
  titleCaseName,
} from './relation-vocabulary.js';
import {
  enqueueRelationQuestion,
  recordQuestionAnswer,
} from './relation-questions.js';
import { ownerPersonId } from './identity.js';
import { appEvents } from './app-events.js';

// ── Authority lattice ─────────────────────────────────────────────────────────
// st_f67bc2eb amendment A1 — 'inferred-high': the composite resolver's class
// (lib/relation-resolve.js). Bottom of the lattice: NEVER overrides a
// stated/contact/owner fact (rank rules below make that structural), always
// deprecable, and only the resolver's own source token may carry it — a
// pipeline pass smuggling authority='inferred-high' under an inference
// source is still refused (source gate in assertRelation).
const AUTHORITY_RANK = Object.freeze({ owner: 4, contact: 3, stated: 2, 'inferred-high': 1 });

// The ONLY source token allowed to write at authority 'inferred-high'.
export const COMPOSITE_RESOLVER_SOURCE = 'composite-resolver';

export function authorityRank(authority) {
  return AUTHORITY_RANK[String(authority || '').trim()] || 0;
}

// Inference-class provenance tokens — every automated derivation that used to
// write relation tags. Any assert carrying one is refused and queued (AC-3).
export const INFERENCE_SOURCES = new Set([
  'content-inference', 'family-inference', 'surname-inference',
  'contacts-relation', 'rerun-backfill', 'inference',
]);

// Tombstone reasons: an edge deprecated with one of these blocks any
// non-owner re-assertion of the same (pair, rel_type) forever.
const TOMBSTONE_REASONS = new Set(['owner-cleared', 'owner-declined']);

function refuse(outcome, why) {
  console.warn(`[relation-store] REFUSED edge write: ${why}`);
  return { outcome, refused: true, why };
}

function emitChange(payload) {
  try {
    appEvents.emit('relations-change', payload);
  } catch (err) {
    console.warn('[relation-store] relations-change emit failed:', err.message);
  }
}

/**
 * Normalize an edge spec to its ONE canonical representation.
 * Symmetric types: endpoints ordered a < b. Directional types: as given
 * (person_a is the role holder — inverse words were swapped by the caller
 * via EDGE_WORDS.namedRole before reaching the store).
 */
export function normalizeEdgeSpec(personA, personB, relType) {
  const type = String(relType || '').trim();
  const domain = edgeDomain(type);
  if (!domain) {
    throw new Error(`invalid rel_type: ${type}; must be one of: ${Object.keys(EDGE_TYPES).join(', ')}`);
  }
  let a = String(personA);
  let b = String(personB);
  if (!DIRECTIONAL_EDGE_TYPES.has(type) && b < a) [a, b] = [b, a];
  return { person_a: a, person_b: b, rel_type: type, domain };
}

/** Every ACTIVE edge on the unordered pair (any domain). */
export function getActivePairEdges(db, personA, personB) {
  return db.prepare(`
    SELECT * FROM person_relations
    WHERE status = 'active'
      AND ((person_a = ? AND person_b = ?) OR (person_a = ? AND person_b = ?))
  `).all(String(personA), String(personB), String(personB), String(personA));
}

/** ACTIVE edges touching a person, optionally filtered by domain. */
export function getActiveEdgesForPerson(db, personId, { domain = null } = {}) {
  const rows = db.prepare(`
    SELECT * FROM person_relations
    WHERE status = 'active' AND (person_a = ? OR person_b = ?)
  `).all(String(personId), String(personId));
  return domain ? rows.filter((r) => r.domain === domain) : rows;
}

function tombstoneFor(db, spec) {
  return db.prepare(`
    SELECT * FROM person_relations
    WHERE status = 'deprecated' AND rel_type = ?
      AND ((person_a = ? AND person_b = ?) OR (person_a = ? AND person_b = ?))
      AND deprecated_reason IN ('owner-cleared','owner-declined')
    ORDER BY id DESC LIMIT 1
  `).get(spec.rel_type, spec.person_a, spec.person_b, spec.person_b, spec.person_a);
}

function mergeEvidence(existingJson, incoming) {
  let list = [];
  try { list = JSON.parse(existingJson || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  const seen = new Set(list.map((e) => `${e.kind}|${e.source_id}`));
  let added = 0;
  for (const e of incoming || []) {
    if (!e || !e.kind || !e.source_id) continue;
    const key = `${e.kind}|${e.source_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ kind: e.kind, source_id: e.source_id, date: e.date || null });
    added++;
  }
  return { json: JSON.stringify(list), added };
}

function insertEdge(db, spec, opts) {
  const res = db.prepare(`
    INSERT INTO person_relations
      (person_a, person_b, rel_type, domain, status, authority, author_person_id,
       source, confidence, evidence, stated_at, valid_from, valid_until)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    spec.person_a, spec.person_b, spec.rel_type, spec.domain,
    opts.authority, opts.authorPersonId || null, opts.source,
    Number.isFinite(opts.confidence) ? opts.confidence : 1.0,
    mergeEvidence('[]', opts.evidence).json,
    opts.statedAt || null, opts.validFrom || null, opts.validUntil || null,
  );
  return db.prepare('SELECT * FROM person_relations WHERE id = ?').get(Number(res.lastInsertRowid));
}

/**
 * Deprecate an edge — the ONLY way an edge leaves the active set. Never a
 * DELETE. `supersededBy` links the replacing edge when there is one.
 */
export function deprecateEdge(db, edgeId, { reason, supersededBy = null } = {}) {
  db.prepare(`
    UPDATE person_relations
       SET status = 'deprecated', deprecated_reason = ?, superseded_by = ?,
           updated_at = datetime('now')
     WHERE id = ? AND status = 'active'
  `).run(String(reason || 'deprecated'), supersededBy, edgeId);
  const row = db.prepare('SELECT * FROM person_relations WHERE id = ?').get(edgeId);
  emitChange({ op: 'deprecate', edge_id: edgeId, reason });
  return row;
}

/**
 * Enqueue the refused/conflicting candidate as a question — the firewall's
 * conversion arm. Names are resolved here so question text is one readable
 * line the owner can answer in a word.
 */
export function enqueueRelationCandidate(db, spec, opts, kind, questionText, payloadExtra = {}, conflictReason = null) {
  const name = (id) => {
    try {
      return titleCaseName(db.prepare('SELECT display_name FROM people WHERE id = ?').get(String(id))?.display_name || String(id));
    } catch { return String(id); }
  };
  const text = questionText
    || `Is ${name(spec.person_a)} ${spec.rel_type === 'spouse' ? 'the spouse of' : `the ${spec.rel_type} of`} ${name(spec.person_b)}?`;
  return enqueueRelationQuestion(db, {
    kind,
    subjectPersonId: spec.person_a,
    objectPersonId: spec.person_b,
    relType: spec.rel_type,
    questionText: text,
    conflictReason,
    payload: {
      spec: { person_a: spec.person_a, person_b: spec.person_b, rel_type: spec.rel_type },
      source: opts.source || null,
      author_person_id: opts.authorPersonId || null,
      evidence: (opts.evidence || []).slice(0, 20),
      ...payloadExtra,
    },
    confidence: Number.isFinite(opts.confidence) ? opts.confidence : 0,
    priority: Number.isFinite(opts.priority) ? opts.priority : (Number(opts.confidence) || 0),
  });
}

/**
 * Assert a relationship edge — THE write path.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} spec - { personA, personB, relType } (pre-normalization)
 * @param {object} opts
 * @param {'owner'|'contact'|'stated'} opts.authority
 * @param {string} opts.source - provenance token
 * @param {string|null} [opts.authorPersonId] - who stated it
 * @param {Array<{kind:string,source_id:string,date?:string}>} [opts.evidence]
 * @param {number} [opts.confidence=1.0]
 * @param {string|null} [opts.statedAt] - newest statement date
 * @param {string|null} [opts.validFrom]
 * @param {string|null} [opts.validUntil] - non-null = former/ended
 * @param {string|null} [opts.ownerId] - test override for identity.json
 * @returns {{ outcome: string, edge?: object, questionId?: number|null }}
 */
export function assertRelation(db, { personA, personB, relType }, opts = {}) {
  const source = String(opts.source || '').trim();
  const authority = String(opts.authority || '').trim();

  const spec = normalizeEdgeSpec(personA, personB, relType);
  if (spec.person_a === spec.person_b) {
    return refuse('refused-self-edge', `self-edge on ${spec.person_a}`);
  }

  // Archived endpoints never take NEW edges — with one deliberate exemption:
  // the OWNER's own row (kept unarchived and structurally guarded since the
  // vendor-misfire repair; the exemption survives as belt-and-braces because
  // owner-anchored edges are the whole point and a stale archive flag must
  // never sever them). A
  // background archive pass can also archive an endpoint after evidence
  // accumulated; refusing here keeps the graph and the archive state from
  // drifting (AC-11 belt-and-braces; the rerun sweep catches the reverse
  // race).
  const ownerForArchiveCheck = String(opts.ownerId || ownerPersonId() || '');
  try {
    const archStmt = db.prepare('SELECT COALESCE(archived, 0) AS archived FROM people WHERE id = ?');
    for (const end of [spec.person_a, spec.person_b]) {
      if (end === ownerForArchiveCheck) continue;
      const row = archStmt.get(end);
      if (row && Number(row.archived) === 1) {
        return refuse('refused-archived-endpoint', `person ${end} is archived — no new edges onto archived people`);
      }
    }
  } catch { /* people table absent only in minimal fixtures */ }

  // ── THE INFERENCE FIREWALL (AC-3) ─────────────────────────────────────────
  // Inference ranks importance and generates questions; it NEVER writes an
  // edge of any type. Refused loudly and converted into a queue candidate.
  // Amendment A1 carve-out: 'inferred-high' is a REAL authority (composite
  // resolver, calibrated ≥0.90 fusion) but only its own source token may
  // carry it — any other pairing falls to the firewall.
  const inferredHighMisuse = authority === 'inferred-high' && source !== COMPOSITE_RESOLVER_SOURCE;
  if (INFERENCE_SOURCES.has(source) || !AUTHORITY_RANK[authority] || inferredHighMisuse) {
    const q = enqueueRelationCandidate(db, spec, opts, 'confirm');
    console.warn(`[relation-store] REFUSED inference-class edge write (source "${source}", authority "${authority}") — queued as question ${q.id}`);
    return { outcome: 'refused-inference', questionId: q.id };
  }

  const rank = AUTHORITY_RANK[authority];

  // ── Tombstone rule: an owner-deprecated (pair, rel_type) blocks every
  // non-owner re-assertion forever. Only the owner may speak over the owner.
  const tomb = tombstoneFor(db, spec);
  if (tomb && authority !== 'owner') {
    return refuse('refused-tombstone',
      `(${spec.person_a}, ${spec.person_b}, ${spec.rel_type}) carries an owner tombstone (edge ${tomb.id}, ${tomb.deprecated_reason}) — non-owner source "${source}" may not re-assert`);
  }

  const pairEdges = getActivePairEdges(db, spec.person_a, spec.person_b);
  const sameDomain = pairEdges.filter((e) => e.domain === spec.domain);
  const sameType = sameDomain.find((e) => e.rel_type === spec.rel_type
    && (DIRECTIONAL_EDGE_TYPES.has(spec.rel_type)
      ? (e.person_a === spec.person_a && e.person_b === spec.person_b)
      : true));

  // Directional collision: same type, opposite direction, both active — a
  // pair cannot be each other's parent. Treat as a different-type conflict.
  const oppositeDirection = DIRECTIONAL_EDGE_TYPES.has(spec.rel_type)
    ? sameDomain.find((e) => e.rel_type === spec.rel_type && e.person_a === spec.person_b && e.person_b === spec.person_a)
    : null;

  // ── Same type: merge, never duplicate ─────────────────────────────────────
  if (sameType) {
    const existingRank = authorityRank(sameType.authority);
    const merged = mergeEvidence(sameType.evidence, opts.evidence);
    if (rank < existingRank) {
      // Lower authority never touches an existing edge beyond evidence.
      if (merged.added > 0) {
        db.prepare('UPDATE person_relations SET evidence = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(merged.json, sameType.id);
      }
      return { outcome: 'evidence-appended', edge: db.prepare('SELECT * FROM person_relations WHERE id = ?').get(sameType.id) };
    }
    const nextAuthority = rank > existingRank ? authority : sameType.authority;
    const nextConfidence = Math.max(Number(sameType.confidence) || 0, Number.isFinite(opts.confidence) ? opts.confidence : 1.0);
    const nextStatedAt = [sameType.stated_at, opts.statedAt].filter(Boolean).sort().pop() || null;
    // valid_until moves only on equal-or-higher authority: a newer "former X"
    // ends the relation; a newer current statement clears an earlier end.
    let nextValidUntil = sameType.valid_until;
    if (opts.validUntil !== undefined) {
      const incomingNewer = !sameType.stated_at || !opts.statedAt || opts.statedAt >= sameType.stated_at;
      if (incomingNewer) nextValidUntil = opts.validUntil;
    }
    const changed = nextAuthority !== sameType.authority
      || nextValidUntil !== sameType.valid_until
      || merged.added > 0
      || nextConfidence !== sameType.confidence
      || nextStatedAt !== sameType.stated_at;
    if (changed) {
      db.prepare(`
        UPDATE person_relations
           SET authority = ?, confidence = ?, evidence = ?, stated_at = ?,
               valid_until = ?, updated_at = datetime('now')
         WHERE id = ?
      `).run(nextAuthority, nextConfidence, merged.json, nextStatedAt, nextValidUntil, sameType.id);
      if (nextValidUntil !== sameType.valid_until || nextAuthority !== sameType.authority) {
        emitChange({ op: 'merge', edge_id: sameType.id });
      }
    }
    return { outcome: 'merged', edge: db.prepare('SELECT * FROM person_relations WHERE id = ?').get(sameType.id) };
  }

  // ── Different type in the same domain (or opposite direction) ────────────
  const conflict = oppositeDirection || sameDomain[0] || null;
  if (conflict) {
    const existingRank = authorityRank(conflict.authority);
    if (rank > existingRank) {
      // Higher authority supersedes — deprecate, never delete.
      const edge = insertEdgeSuperseding(db, spec, opts, conflict, 'superseded-by-higher-authority');
      return afterWrite(db, spec, opts, edge, 'superseded');
    }
    if (rank < existingRank) {
      return refuse('refused-authority',
        `${authority} source "${source}" may not overwrite ${conflict.authority} edge ${conflict.id} (${conflict.rel_type}) on the same pair`);
    }
    // Equal authority: newest-wins ONLY through the closed temporal chains.
    const supersedes = (TEMPORAL_SUPERSEDE_CHAINS[spec.rel_type] || []).includes(conflict.rel_type);
    const isOlderStage = (TEMPORAL_SUPERSEDE_CHAINS[conflict.rel_type] || []).includes(spec.rel_type);
    const incomingNewer = !conflict.stated_at || !opts.statedAt || opts.statedAt >= conflict.stated_at;
    if (supersedes && incomingNewer) {
      const edge = insertEdgeSuperseding(db, spec, opts, conflict, 'temporal-supersede');
      return afterWrite(db, spec, opts, edge, 'superseded');
    }
    if (isOlderStage && !incomingNewer) {
      // A dated statement of the earlier stage ("my fiancée X", 2019) landing
      // after the later stage is history, not conflict — nothing to record.
      return { outcome: 'noop-historical', edge: conflict };
    }
    const q = enqueueRelationCandidate(db, spec, opts, 'conflict',
      null, { conflicting_edge_id: conflict.id, conflicting_rel_type: conflict.rel_type },
      `equal-authority type conflict: ${spec.rel_type} vs recorded ${conflict.rel_type}`);
    console.warn(`[relation-store] equal-authority conflict (${spec.rel_type} vs ${conflict.rel_type}) on (${spec.person_a}, ${spec.person_b}) — queued as question ${q.id}`);
    return { outcome: 'conflict-queued', questionId: q.id };
  }

  // ── Cross-domain temporal chains (spouse ends romantic-partner) ──────────
  for (const older of TEMPORAL_SUPERSEDE_CHAINS[spec.rel_type] || []) {
    const staged = pairEdges.find((e) => e.rel_type === older);
    if (staged && authorityRank(staged.authority) <= rank) {
      deprecateEdge(db, staged.id, { reason: 'temporal-supersede' });
    }
  }
  // Reverse direction across domains: the incoming type is an OLDER stage of
  // an active later-stage edge ("my fiancée X" after spouse is on record).
  for (const [later, earlierList] of Object.entries(TEMPORAL_SUPERSEDE_CHAINS)) {
    if (!earlierList.includes(spec.rel_type)) continue;
    const laterEdge = pairEdges.find((e) => e.rel_type === later);
    if (!laterEdge) continue;
    const incomingNewer = laterEdge.stated_at && opts.statedAt && opts.statedAt > laterEdge.stated_at;
    if (!incomingNewer) {
      // A dated earlier-stage statement is history, not conflict.
      return { outcome: 'noop-historical', edge: laterEdge };
    }
    if (rank < authorityRank(laterEdge.authority)) {
      return refuse('refused-authority',
        `${authority} source "${source}" may not regress ${later} edge ${laterEdge.id} to ${spec.rel_type}`);
    }
    const q = enqueueRelationCandidate(db, spec, opts, 'conflict',
      null, { conflicting_edge_id: laterEdge.id, conflicting_rel_type: laterEdge.rel_type },
      `temporal regression: newer ${spec.rel_type} statement against recorded ${laterEdge.rel_type}`);
    return { outcome: 'conflict-queued', questionId: q.id };
  }

  // ── Clean insert ──────────────────────────────────────────────────────────
  const edge = insertEdge(db, spec, { ...opts, authority });
  return afterWrite(db, spec, opts, edge, 'written');
}

function insertEdgeSuperseding(db, spec, opts, oldEdge, reason) {
  // Deprecate FIRST — the partial UNIQUE (pair, domain, active) rejects a
  // second active row, which is exactly the two-truths guarantee; the
  // transaction keeps supersede atomic (no window with zero truth).
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE person_relations
         SET status = 'deprecated', deprecated_reason = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'active'
    `).run(reason, oldEdge.id);
    const edge = insertEdge(db, spec, opts);
    db.prepare('UPDATE person_relations SET superseded_by = ? WHERE id = ?').run(edge.id, oldEdge.id);
    return edge;
  });
  return tx();
}

function afterWrite(db, spec, opts, edge, outcome) {
  emitChange({ op: outcome, edge_id: edge.id, rel_type: spec.rel_type, domain: spec.domain });
  maybeEnqueueCrossAnchor(db, spec, opts);
  return { outcome, edge };
}

// ── Cross-anchor re-anchoring (AC-10) ────────────────────────────────────────
// A spouse-side kinship edge lands for person X while an active owner↔X edge
// of the SAME class exists → both truths cannot silently coexist. Enqueue the
// cross-anchor question; the owner's decline deprecates the owner-anchored
// edge with owner authority (tombstone).
function maybeEnqueueCrossAnchor(db, spec, opts) {
  try {
    if (spec.domain !== 'kinship' || spec.rel_type === 'spouse' || spec.rel_type === 'pet') return;
    const ownerId = opts.ownerId || ownerPersonId();
    if (!ownerId) return;
    const owner = String(ownerId);
    if (spec.person_a === owner || spec.person_b === owner) return;
    // Which endpoint is the owner's spouse?
    const spouseEdge = getActivePairEdgesToOwnerSpouse(db, owner, spec);
    if (!spouseEdge) return;
    const spouseId = spouseEdge.spouseId;
    const x = spec.person_a === spouseId ? spec.person_b : spec.person_a;
    const ownerEdge = getActivePairEdges(db, owner, x)
      .find((e) => e.domain === 'kinship' && e.rel_type === spec.rel_type);
    if (!ownerEdge) return;
    const name = (id) => db.prepare('SELECT display_name FROM people WHERE id = ?').get(String(id))?.display_name || 'this person';
    enqueueRelationQuestion(db, {
      kind: 'cross-anchor',
      subjectPersonId: x,
      objectPersonId: owner,
      relType: spec.rel_type,
      questionText: `${name(x)} is on record as your ${spec.rel_type} and as ${name(spouseId)}'s ${spec.rel_type} — are they your blood ${spec.rel_type} too?`,
      payload: { owner_edge_id: ownerEdge.id, spouse_side_person_id: spouseId },
      confidence: 1,
      priority: 10, // both-truths-active is the highest-information question
    });
  } catch (err) {
    console.warn('[relation-store] cross-anchor enqueue failed:', err.message);
  }
}

function getActivePairEdgesToOwnerSpouse(db, ownerId, spec) {
  for (const endpoint of [spec.person_a, spec.person_b]) {
    const edges = getActivePairEdges(db, ownerId, endpoint);
    if (edges.some((e) => e.rel_type === 'spouse' && e.domain === 'kinship')) {
      return { spouseId: endpoint };
    }
  }
  return null;
}

/**
 * Owner clear — a first-class correction that deprecates, never deletes
 * (AC-11). Leaves the permanent tombstone that blocks re-inference.
 */
export function clearRelation(db, personA, personB, { relType = null, domain = null, source = 'chat-correction' } = {}) {
  const edges = getActivePairEdges(db, personA, personB)
    .filter((e) => (relType ? e.rel_type === relType : true))
    .filter((e) => (domain ? e.domain === domain : true));
  for (const e of edges) {
    deprecateEdge(db, e.id, { reason: 'owner-cleared' });
  }
  return { cleared: edges.length };
}

/**
 * Archive/merge cleanup (AC-11): every active edge touching the person is
 * deprecated with the given reason. Shared by the merge operation, the
 * archive path, and the rerun sweep.
 */
export function deprecateEdgesForPerson(db, personId, { reason = 'archived' } = {}) {
  const edges = getActiveEdgesForPerson(db, personId);
  for (const e of edges) {
    deprecateEdge(db, e.id, { reason });
  }
  return { deprecated: edges.length };
}

// ── Question answers → owner-provenance writes ───────────────────────────────

const YES_WORDS = new Set(['yes', 'y', 'yeah', 'yep', 'correct', 'right', 'true', 'confirm', 'confirmed', 'sure']);
const NO_WORDS = new Set(['no', 'n', 'nope', 'wrong', 'false', 'decline', 'incorrect', 'never']);

/** Classify a short reply: 'yes' | 'no' | null (null = not a verdict word). */
export function classifyAnswerWord(text) {
  const w = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (YES_WORDS.has(w)) return 'yes';
  if (NO_WORDS.has(w)) return 'no';
  return null;
}

/**
 * Apply the owner's answer to an asked question. yes → edge write with
 * authority 'owner', source 'question-answer'; no → permanent decline (the
 * dedup_key blocks re-insert; never re-asked); a reply that matches neither
 * the verdict words nor the question's option set returns null and flows to
 * the model as conversation.
 *
 * @returns {{ applied: boolean, wrote: boolean, message: string }|null}
 */
export function applyQuestionAnswer(db, question, rawAnswer, { ownerId = null } = {}) {
  if (!question || question.status !== 'asked') return null;
  const answer = String(rawAnswer || '').trim();
  const verdict = classifyAnswerWord(answer);
  let payload = {};
  try { payload = JSON.parse(question.payload || '{}'); } catch { payload = {}; }
  const owner = ownerId || ownerPersonId();
  const name = (id) => {
    try { return db.prepare('SELECT display_name FROM people WHERE id = ?').get(String(id))?.display_name || 'them'; } catch { return 'them'; }
  };

  const writeSpec = (spec) => assertRelation(db, {
    personA: spec.person_a,
    personB: spec.person_b,
    relType: spec.rel_type,
  }, {
    authority: 'owner',
    source: 'question-answer',
    authorPersonId: owner,
    evidence: [{ kind: 'question-answer', source_id: `rq:${question.id}` }],
    statedAt: new Date().toISOString(),
    ownerId: owner,
  });

  if (question.kind === 'cross-anchor') {
    if (verdict === 'yes') {
      recordQuestionAnswer(db, question.id, { status: 'confirmed', answer });
      return { applied: true, wrote: false, message: 'Noted — both relationships stand on record.' };
    }
    if (verdict === 'no') {
      if (payload.owner_edge_id) deprecateEdge(db, payload.owner_edge_id, { reason: 'owner-declined' });
      recordQuestionAnswer(db, question.id, { status: 'confirmed', answer });
      return { applied: true, wrote: true, message: 'Corrected — that relationship is now recorded on the right side of the family only.' };
    }
    return null;
  }

  if (question.kind === 'disambiguate') {
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    if (verdict === 'no') {
      recordQuestionAnswer(db, question.id, { status: 'declined', answer });
      return { applied: true, wrote: false, message: 'Understood — I will not record it and will not ask again.' };
    }
    const norm = (s) => String(s || '').trim().toLowerCase();
    const match = candidates.find((c) => norm(c.display_name) === norm(answer)
      || norm(c.display_name).split(/\s+/).pop() === norm(answer)
      || norm(c.display_name).split(/\s+/)[0] === norm(answer));
    if (!match) return null;
    const spec = { ...payload.spec };
    if (spec.person_a === payload.placeholder) spec.person_a = match.person_id;
    if (spec.person_b === payload.placeholder) spec.person_b = match.person_id;
    const res = writeSpec(spec);
    recordQuestionAnswer(db, question.id, { status: 'confirmed', answer });
    return { applied: true, wrote: res.outcome !== 'refused-tombstone', message: `Recorded for ${match.display_name}. The previous state is archived, not overwritten.` };
  }

  if (question.kind === 'decompose' || question.kind === 'conflict') {
    const options = Array.isArray(payload.options) ? payload.options : [];
    if (verdict === 'no') {
      recordQuestionAnswer(db, question.id, { status: 'declined', answer });
      return { applied: true, wrote: false, message: 'Understood — I will not record it and will not ask again.' };
    }
    const normAnswer = answer.toLowerCase();
    const match = options.find((o) => normAnswer.includes(String(o.key || '').toLowerCase())
      || String(o.label || '').toLowerCase() === normAnswer);
    if (!match || !match.spec) return null;
    const res = writeSpec(match.spec);
    recordQuestionAnswer(db, question.id, { status: 'confirmed', answer });
    return { applied: true, wrote: res.outcome !== 'conflict-queued', message: `Recorded: ${match.label}. The previous state is archived, not overwritten.` };
  }

  // confirm (default)
  if (verdict === 'yes') {
    const spec = payload.spec || {
      person_a: question.subject_person_id,
      person_b: question.object_person_id,
      rel_type: question.rel_type,
    };
    const res = writeSpec(spec);
    recordQuestionAnswer(db, question.id, { status: 'confirmed', answer });
    const subject = name(spec.person_a);
    return { applied: true, wrote: ['written', 'merged', 'superseded'].includes(res.outcome), message: `Recorded — ${subject} is on record as ${spec.rel_type === 'spouse' ? 'the spouse' : `the ${spec.rel_type}`} there now.` };
  }
  if (verdict === 'no') {
    recordQuestionAnswer(db, question.id, { status: 'declined', answer });
    return { applied: true, wrote: false, message: 'Understood — I will not record it and will not ask again.' };
  }
  return null;
}

/**
 * Fill-only node-fact hint: gender/species learned from a statement word
 * ("my mother X" implies X female) lands on the node ONLY when unknown —
 * never overwrites recorded node truth. Gendered role names derive from this
 * at render; a wrong overwrite here would mis-gender every derived label.
 */
export function applyNodeHints(db, personId, { gender = null, species = null } = {}) {
  if (gender === 'male' || gender === 'female') {
    db.prepare('UPDATE people SET gender = ? WHERE id = ? AND gender IS NULL').run(gender, String(personId));
  }
  if (species === 'dog' || species === 'cat') {
    db.prepare('UPDATE people SET species = ? WHERE id = ? AND species IS NULL').run(species, String(personId));
  }
}
