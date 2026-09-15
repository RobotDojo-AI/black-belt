/**
 * lib/relation-resolve.js — the composite relation resolver
 * (st_f67bc2eb amendment A1, owner-directed).
 *
 * Owner verbatim: "i will not answer questions, the point is the
 * infrastructure is smart". Per candidate, fuse EVERY signal the system
 * already holds into one calibrated confidence, anchor to the CORRECT person
 * (spouse-side relatives anchor to the spouse, never the owner), and:
 *
 *   confidence ≥ 0.90  → write the edge, authority 'inferred-high'
 *                        (bottom of the lattice: never overrides stated/
 *                        owner/contact facts; always deprecable; the walk
 *                        phrases it honestly — "your wife's cousin")
 *   0.70 – 0.90        → a question, CORRECTLY ANCHORED in its phrasing
 *   below 0.70         → silence (auto-declined with the confidence named)
 *   both sides plausible → conflict question with a named conflict_reason
 *
 * SIGNALS (each deterministic, each with a documented weight; fusion is
 * noisy-OR evidence accumulation — the Knowledge-Vault pattern: independent
 * corroboration raises belief, per-source dedup prevents self-corroboration):
 *
 *   config-pattern   0.60  owner-curated surname→relation entry in
 *                          config/family.json surname_patterns (rel_type
 *                          evidence, owner-curated; anchor-ambiguous — the
 *                          historical wrongness was anchoring these to the
 *                          owner, which this module exists to fix)
 *   contact-label    0.70  Apple contact relation field (owner-curated on
 *                          the card; anchor-ambiguous)
 *   surname-decisive 0.75  candidate's surname token appears ONLY in one
 *                          family cluster's confirmed surname tokens
 *   list-coherence   0.50  candidate's surname is co-curated in the family
 *                          config surname list alongside surnames that are
 *                          confirmed members of the anchor cluster
 *   contacts-source  0.45  the person row came from Apple Contacts — the
 *                          extraction hierarchy's top trust class (the owner
 *                          deliberately saved this person)
 *   neighborhood     0.50/0.70  ≥1 / ≥2 active kinship edges into the
 *                          anchor cluster
 *   shared-groups    0.25/0.40  ≥1 / ≥3 iMessage groups shared with
 *                          confirmed cluster members
 *   shared-calendar  0.20/0.35  ≥2 / ≥10 calendar chunks co-tagged with
 *                          confirmed cluster members
 *   mined-statement  (mining confidence × 0.8)  mined possessive cluster
 *                          supporting the same (anchor, rel_type)
 *   personal-origin  0.10  relationship_origin='personal' prior; a business
 *                          origin contributes nothing to a kinship claim
 *
 * ANCHOR RULE (sealed): a kinship candidate belonging to a confirmed
 * NON-OWNER family cluster anchors to that cluster's hub (the spouse),
 * never the owner. Owner-anchoring requires owner-side corroboration.
 * Positive signals on both sides → conflict question, never a guess.
 *
 * Tier 0 — deterministic SQL + arithmetic. No LLM anywhere.
 */

import {
  assertRelation,
  getActiveEdgesForPerson,
  getActivePairEdges,
  COMPOSITE_RESOLVER_SOURCE,
} from './relation-store.js';
import { recordQuestionAnswer, clearsTierCutoff } from './relation-questions.js';
import { refreshDerivedRelationCache } from './people-write.js';
import {
  edgeDomain,
  TEMPORAL_SUPERSEDE_CHAINS,
  LOW_STAKES_ANCHOR_TYPES,
  EXCLUSIVE_EDGE_TYPES,
} from './relation-vocabulary.js';
import { ownerEmails } from './identity.js';
import { ownerPersonId } from './identity.js';

export const WRITE_THRESHOLD = 0.90;
export const QUESTION_THRESHOLD = 0.70;

const W = Object.freeze({
  configPattern: 0.60,
  contactLabel: 0.70,
  surnameDecisive: 0.75,
  listCoherence: 0.50,
  contactsSource: 0.45,
  neighborhood1: 0.50,
  neighborhood2: 0.70,
  groups1: 0.25,
  groups3: 0.40,
  calendar2: 0.20,
  calendar10: 0.35,
  minedFactor: 0.80,
  personalOrigin: 0.10,
});

/** Noisy-OR fusion: belief rises with independent corroboration. */
export function fuse(weights) {
  let miss = 1;
  for (const w of weights) miss *= 1 - Math.min(0.99, Math.max(0, w));
  return 1 - miss;
}

function surnameTokens(displayName) {
  return String(displayName || '').trim().split(/\s+/).slice(1)
    .map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
}

/**
 * Build the confirmed family clusters from ACTIVE kinship edges: the
 * owner-side cluster (BFS from the owner) and one cluster per direct
 * non-owner hub — today the spouse (BFS from the spouse, not crossing the
 * owner). Surname tokens present in more than one cluster are AMBIGUOUS and
 * never anchor-decisive (live case: a married-in sibling shares the owner's
 * surname with the spouse's family).
 */
export function buildFamilyClusters(db, { ownerId = null } = {}) {
  const owner = String(ownerId || ownerPersonId() || '');
  const edges = db.prepare(`
    SELECT person_a, person_b, rel_type FROM person_relations
    WHERE status = 'active' AND domain = 'kinship' AND valid_until IS NULL
  `).all();
  const adj = new Map();
  for (const e of edges) {
    for (const [x, y] of [[e.person_a, e.person_b], [e.person_b, e.person_a]]) {
      if (!adj.has(String(x))) adj.set(String(x), new Set());
      adj.get(String(x)).add(String(y));
    }
  }
  const nameStmt = db.prepare('SELECT display_name FROM people WHERE id = ?');
  const bfs = (start, exclude) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      for (const n of adj.get(cur) || []) {
        if (n === exclude || seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return seen;
  };

  const clusters = [];
  if (owner) {
    const spouseEdge = edges.find((e) => e.rel_type === 'spouse'
      && [String(e.person_a), String(e.person_b)].includes(owner));
    const spouse = spouseEdge
      ? (String(spouseEdge.person_a) === owner ? String(spouseEdge.person_b) : String(spouseEdge.person_a))
      : null;
    // Each side's BFS excludes the OTHER hub — otherwise the owner cluster
    // walks through the spouse edge and swallows her whole family, and no
    // surname is ever decisive.
    clusters.push({ key: 'owner', hubId: owner, members: bfs(owner, spouse) });
    if (spouse) {
      clusters.push({ key: 'spouse', hubId: spouse, members: bfs(spouse, owner) });
    }
  }
  for (const c of clusters) {
    c.surnames = new Set();
    for (const id of c.members) {
      // The owner's own surname never counts as SPOUSE-cluster evidence even
      // when a married-in relative carries it into that cluster's member set.
      if (c.key !== 'owner' && String(id) === owner) continue;
      for (const t of surnameTokens(nameStmt.get(String(id))?.display_name)) c.surnames.add(t);
    }
  }
  // Decisive = token unique to one cluster.
  for (const c of clusters) {
    c.decisive = new Set([...c.surnames].filter((t) =>
      clusters.every((o) => o === c || !o.surnames.has(t))));
  }
  return { owner, clusters };
}

/** Owner-curated surname patterns, keyed lowercase. */
export function configPatternIndex(familyConfig) {
  const map = new Map();
  for (const p of (familyConfig?.surname_patterns || [])) {
    if (p?.surname && p?.relation) map.set(String(p.surname).toLowerCase(), String(p.relation));
  }
  return map;
}

/**
 * Score one candidate against one anchor cluster. Returns the anchor-side
 * signal weights (evidence the candidate BELONGS to this cluster) and the
 * rel_type evidence weights, kept separate so "knows the relation, wrong
 * side" can never anchor by rel_type strength alone.
 */
function scoreAgainstCluster(db, person, cluster, ctx) {
  const anchor = [];
  const relType = [];
  const signals = [];
  const tokens = surnameTokens(person.display_name);

  // surname-decisive
  if (tokens.some((t) => cluster.decisive.has(t))) {
    anchor.push(W.surnameDecisive);
    signals.push(`surname-decisive:${cluster.key}`);
  }

  // config surname pattern (rel_type evidence; list-coherence gives anchor)
  const patterned = tokens.find((t) => ctx.patterns.has(t));
  if (patterned) {
    relType.push(W.configPattern);
    signals.push(`config-pattern:${patterned}→${ctx.patterns.get(patterned)}`);
    // list-coherence: other surnames in the SAME owner-curated list are
    // confirmed members of this cluster → the list itself is cluster evidence.
    const others = [...ctx.patterns.keys()].filter((sn) => sn !== patterned);
    const confirmedHere = others.filter((sn) => cluster.surnames.has(sn));
    if (confirmedHere.length >= 1 && confirmedHere.length >= others.length / 2) {
      anchor.push(W.listCoherence);
      signals.push(`list-coherence:${confirmedHere.join('+')}∈${cluster.key}`);
    }
  }

  // neighborhood: active kinship edges into cluster members
  const edgesInto = getActiveEdgesForPerson(db, String(person.id), { domain: 'kinship' })
    .filter((e) => {
      const other = String(e.person_a) === String(person.id) ? String(e.person_b) : String(e.person_a);
      return cluster.members.has(other);
    }).length;
  if (edgesInto >= 2) { anchor.push(W.neighborhood2); signals.push(`neighborhood:${edgesInto}-edges:${cluster.key}`); }
  else if (edgesInto === 1) { anchor.push(W.neighborhood1); signals.push(`neighborhood:1-edge:${cluster.key}`); }

  // shared iMessage groups with confirmed cluster members
  const memberIds = [...cluster.members].filter((id) => id !== String(person.id));
  if (memberIds.length) {
    const ph = memberIds.map(() => '?').join(',');
    let groups = 0;
    try {
      groups = db.prepare(`
        SELECT COUNT(DISTINCT pg.group_identifier) n FROM person_groups pg
        WHERE pg.person_id = ? AND pg.group_identifier IN
          (SELECT group_identifier FROM person_groups WHERE person_id IN (${ph}))
      `).get(String(person.id), ...memberIds).n;
    } catch { groups = 0; }
    if (groups >= 3) { anchor.push(W.groups3); signals.push(`shared-groups:${groups}:${cluster.key}`); }
    else if (groups >= 1) { anchor.push(W.groups1); signals.push(`shared-groups:${groups}:${cluster.key}`); }

    let cal = 0;
    try {
      cal = db.prepare(`
        SELECT COUNT(DISTINCT ce.chunk_id) n FROM chunk_entities ce
        JOIN chunks c ON c.id = ce.chunk_id AND c.source_type = 'calendar'
        WHERE ce.entity_id = ? AND ce.chunk_id IN
          (SELECT chunk_id FROM chunk_entities WHERE entity_id IN (${ph}))
      `).get(String(person.id), ...memberIds).n;
    } catch { cal = 0; }
    if (cal >= 10) { anchor.push(W.calendar10); signals.push(`shared-calendar:${cal}:${cluster.key}`); }
    else if (cal >= 2) { anchor.push(W.calendar2); signals.push(`shared-calendar:${cal}:${cluster.key}`); }
  }

  return { anchor, relType, signals, patternedRelType: patterned ? ctx.patterns.get(patterned) : null };
}

/**
 * Resolve ONE candidate: fuse all signals per cluster, apply the anchor rule,
 * and return the decision.
 *
 * @returns {{ decision: 'write'|'question'|'silence'|'conflict',
 *   anchorPersonId?: string, relType?: string, confidence: number,
 *   signals: string[], conflictReason?: string }}
 */
export function resolveCandidate(db, personId, relTypeHint, ctx) {
  const person = db.prepare('SELECT id, display_name, primary_source, relationship_origin, personal_tier FROM people WHERE id = ?')
    .get(String(personId));
  if (!person) return { decision: 'silence', confidence: 0, signals: ['person-missing'] };

  // Person-level (anchor-independent) evidence.
  const personal = [];
  const personalSignals = [];
  if (['contacts', 'google_contacts'].includes(String(person.primary_source))) {
    personal.push(W.contactsSource);
    personalSignals.push('contacts-source');
  }
  if (String(person.relationship_origin) === 'personal') {
    personal.push(W.personalOrigin);
    personalSignals.push('personal-origin');
  }
  // Apple contact relation label (rel_type evidence, anchor-ambiguous).
  const label = ctx.contactLabels?.get(String(personId)) || null;
  const labelWeights = label ? [W.contactLabel] : [];
  if (label) personalSignals.push(`contact-label:${label}`);
  // Mined statement support (anchor decided by the statement's own spec).
  const mined = ctx.minedByPerson?.get(String(personId)) || null;

  const scored = ctx.clusters.clusters.map((cluster) => {
    const s = scoreAgainstCluster(db, person, cluster, ctx);
    const relType = s.patternedRelType || label || relTypeHint || mined?.rel_type || null;
    const minedWeights = mined && mined.anchor_cluster === cluster.key ? [mined.confidence * W.minedFactor] : [];
    return {
      cluster,
      relType,
      anchorScore: fuse(s.anchor),
      confidence: fuse([...s.anchor, ...s.relType, ...labelWeights, ...minedWeights, ...personal]),
      signals: [...s.signals, ...personalSignals],
    };
  });

  const positive = scored.filter((x) => x.anchorScore > 0 && x.relType && edgeDomain(x.relType));
  if (!positive.length) {
    const best = scored.filter((x) => x.relType).sort((a, b) => b.confidence - a.confidence)[0];
    return { decision: 'silence', confidence: best?.confidence || 0, signals: best?.signals || [] };
  }

  const ownerSide = positive.find((x) => x.cluster.key === 'owner');
  const nonOwner = positive.filter((x) => x.cluster.key !== 'owner').sort((a, b) => b.confidence - a.confidence)[0];

  // ANCHOR RULE: both sides plausible → a named conflict, never a guess.
  if (ownerSide && nonOwner) {
    return {
      decision: 'conflict',
      confidence: Math.max(ownerSide.confidence, nonOwner.confidence),
      signals: [...ownerSide.signals, ...nonOwner.signals],
      conflictReason: `both sides plausible: owner-side (${ownerSide.signals.join('; ')}) vs ${nonOwner.cluster.key}-side (${nonOwner.signals.join('; ')})`,
    };
  }

  const winner = nonOwner || ownerSide;
  const relType = winner.relType;
  const anchorId = winner.cluster.hubId;
  if (String(anchorId) === String(personId)) {
    return { decision: 'silence', confidence: 0, signals: ['candidate-is-anchor'] };
  }
  const result = {
    anchorPersonId: String(anchorId),
    relType,
    confidence: winner.confidence,
    signals: winner.signals,
    anchorClusterKey: winner.cluster.key,
  };
  if (winner.confidence >= WRITE_THRESHOLD) return { decision: 'write', ...result };
  if (winner.confidence >= QUESTION_THRESHOLD) return { decision: 'question', ...result };
  return { decision: 'silence', ...result };
}

/**
 * The re-runnable resolution operation over the open queue.
 *
 * Fixed-point iteration (max 3 passes): a pass that writes edges grows the
 * confirmed clusters (a resolved cousin's surname becomes cluster evidence),
 * so later passes can resolve candidates the first could not — the owner's
 * "keep stepping into relationships", deterministically.
 *
 * @returns {object} report
 */
export function runCompositeResolution(db, { ownerId = null, familyConfig = null, contactLabels = null } = {}) {
  const owner = String(ownerId || ownerPersonId() || '');
  const report = {
    started_at: new Date().toISOString(),
    passes: 0,
    resolved_written: 0,
    auto_answered_questions: 0,
    re_anchored_questions: 0,
    conflicts_tagged: 0,
    silenced: 0,
    by_conflict_reason: {},
  };
  if (!owner) {
    report.error = 'owner_person_id missing';
    return report;
  }
  const patterns = configPatternIndex(familyConfig);
  const nm = (id) => db.prepare('SELECT display_name FROM people WHERE id = ?').get(String(id))?.display_name || 'this person';

  // Composite in-law hypotheses decompose to their atomic type on the
  // non-owner side (sister-in-law resolved into the spouse cluster = the
  // spouse's sibling). Never stored composite (D3).
  const DECOMPOSE_INNER = Object.freeze({
    'sister-in-law': 'sibling', 'brother-in-law': 'sibling', 'sibling-in-law': 'sibling',
    'mother-in-law': 'parent', 'father-in-law': 'parent', 'parent-in-law': 'parent',
    IL: null, family: null,
  });

  const tagConflict = (q, reason, bucket) => {
    if (q.conflict_reason === reason) return; // idempotent across passes
    db.prepare("UPDATE relation_questions SET conflict_reason = ?, updated_at = datetime('now') WHERE id = ?")
      .run(reason, q.id);
    report.conflicts_tagged++;
    report.by_conflict_reason[bucket] = (report.by_conflict_reason[bucket] || 0) + 1;
  };
  const silence = (q, confidence, signals = []) => {
    recordQuestionAnswer(db, q.id, {
      status: 'declined',
      answer: `auto-silenced: insufficient composite evidence (confidence=${(confidence || 0).toFixed(2)}${signals.length ? `; signals: ${signals.join('; ')}` : ''})`,
    });
    report.silenced++;
  };
  const writeEdge = (q, subjectId, r) => {
    const res = assertRelation(db, {
      personA: subjectId,
      personB: r.anchorPersonId,
      relType: r.relType,
    }, {
      authority: 'inferred-high',
      source: COMPOSITE_RESOLVER_SOURCE,
      authorPersonId: null,
      confidence: r.confidence,
      evidence: r.signals.map((sig) => ({ kind: 'composite-signal', source_id: sig })),
      statedAt: new Date().toISOString(),
      ownerId: owner,
    });
    if (['written', 'merged', 'superseded', 'evidence-appended'].includes(res.outcome)) {
      report.resolved_written++;
      recordQuestionAnswer(db, q.id, {
        status: 'confirmed',
        answer: `auto-resolved: composite resolver anchored to ${nm(r.anchorPersonId)} (${r.relType}, confidence=${r.confidence.toFixed(2)}; signals: ${r.signals.join('; ')})`,
      });
      report.auto_answered_questions++;
      return true;
    }
    if (res.outcome === 'conflict-queued') {
      tagConflict(q, `store conflict while writing ${r.relType} at inferred-high`, 'store-conflict');
      return true;
    }
    // refused (tombstone / archived / authority): the composite claim lost to
    // recorded truth — the question is answered by that truth.
    recordQuestionAnswer(db, q.id, {
      status: 'declined',
      answer: `auto-silenced: composite claim refused by the store (${res.outcome}) — recorded truth stands`,
    });
    report.silenced++;
    return true;
  };
  // Decompose the hypothesis type when it is a composite in-law word and the
  // anchor landed on a non-owner cluster.
  const effectiveRelType = (q, r) => {
    if (q.rel_type && DECOMPOSE_INNER[q.rel_type] !== undefined) {
      const inner = DECOMPOSE_INNER[q.rel_type];
      if (!inner) return null;                       // IL/family: unknowable exact type
      return r.anchorClusterKey !== 'owner' ? inner : null; // in-law on the owner side is a contradiction
    }
    return r.relType;
  };

  for (let pass = 1; pass <= 3; pass++) {
    report.passes = pass;
    const clusters = buildFamilyClusters(db, { ownerId: owner });
    const ctx = { clusters, patterns, contactLabels: contactLabels || new Map(), minedByPerson: new Map() };
    // ASKED rows are user-facing pending questions too — every rule that
    // silences or resolves an open row governs them identically (a silenced
    // asked row simply stops matching answer capture; replies flow onward).
    const open = db.prepare("SELECT * FROM relation_questions WHERE status IN ('open','asked')").all();
    let changed = 0;

    for (const q of open) {
      // ── disambiguate: score every candidate; exactly one write-grade
      // candidate resolves it, two+ is a named conflict, none is silence. ──
      if (q.kind === 'disambiguate') {
        let payload = {};
        try { payload = JSON.parse(q.payload || '{}'); } catch { payload = {}; }
        // TIER CUTOFF (scope A1 addendum): only top-tier candidates are worth
        // disambiguating; when the cut leaves fewer than two AND no
        // write-grade single, the ambiguity is below the owner's floor.
        const rawCandidates = (payload.candidates || []).filter((c) => c.person_id);
        const candidates = rawCandidates.filter((c) => clearsTierCutoff(db, c.person_id));
        if (!candidates.length && rawCandidates.length) {
          recordQuestionAnswer(db, q.id, { status: 'declined', answer: 'auto-silenced: below-tier-cutoff (no disambiguation candidate clears the question floor)' });
          report.silenced++;
          report.by_conflict_reason['below-tier-cutoff'] = (report.by_conflict_reason['below-tier-cutoff'] || 0) + 1;
          changed++;
          continue;
        }
        const hint = payload.spec?.rel_type || q.rel_type;
        const results = candidates.map((c) => ({ c, r: resolveCandidate(db, c.person_id, edgeDomain(hint) ? hint : null, ctx) }));
        const writable = results.filter((x) => x.r.decision === 'write');
        if (writable.length === 1) {
          if (writeEdge(q, writable[0].c.person_id, writable[0].r)) changed++;
        } else if (writable.length > 1) {
          tagConflict(q, `ambiguous name: ${writable.length} candidates carry write-grade composite evidence (${writable.map((x) => x.c.display_name).join(' vs ')})`, 'ambiguous-multi-candidate');
        } else {
          const best = results.sort((a, b) => (b.r.confidence || 0) - (a.r.confidence || 0))[0];
          if (best && best.r.confidence >= QUESTION_THRESHOLD) {
            tagConflict(q, `ambiguous name at mid-band confidence ${best.r.confidence.toFixed(2)} — needs the owner`, 'ambiguous-mid-band');
          } else {
            silence(q, best?.r.confidence || 0, best?.r.signals || []);
            changed++;
          }
        }
        continue;
      }

      const subject = q.subject_person_id;
      if (!subject) {
        silence(q, 0, ['no-subject']);
        changed++;
        continue;
      }

      // ── The silencing rules (owner QC round — AC-12's "question only for
      // genuine conflict, else silence") ────────────────────────────────────

      // 0. TIER CUTOFF (scope A1 addendum): a subject below the question
      //    floor (core/network only) never merits the owner's attention.
      if (q.subject_person_id && !clearsTierCutoff(db, q.subject_person_id)) {
        recordQuestionAnswer(db, q.id, { status: 'declined', answer: 'auto-silenced: below-tier-cutoff (subject below the core/network question floor)' });
        report.silenced++;
        report.by_conflict_reason['below-tier-cutoff'] = (report.by_conflict_reason['below-tier-cutoff'] || 0) + 1;
        changed++;
        continue;
      }

      // 1. PERSON-ONLY: a service/system artifact endpoint is junk, never a
      //    question ("Are you Facebook's friend?").
      {
        const sv = db.prepare('SELECT COALESCE(service_vendor, 0) AS sv FROM people WHERE id = ?');
        const junk = [subject, q.object_person_id].some((end) => end && Number(sv.get(String(end))?.sv) === 1);
        if (junk) {
          recordQuestionAnswer(db, q.id, { status: 'declined', answer: 'auto-silenced: non-person-entity (service/system artifact endpoint)' });
          report.silenced++;
          report.by_conflict_reason['non-person-entity'] = (report.by_conflict_reason['non-person-entity'] || 0) + 1;
          changed++;
          continue;
        }
      }

      // 2. TEMPORAL SUPERSESSION: an older statement class superseded by an
      //    active later-stage edge on the same pair ("Is X your fiancée?"
      //    while the spouse edge stands — fiancée→wife newest-wins).
      if (q.object_person_id && q.rel_type) {
        const laterStages = Object.entries(TEMPORAL_SUPERSEDE_CHAINS)
          .filter(([, earlier]) => earlier.includes(q.rel_type)).map(([later]) => later);
        if (laterStages.length) {
          const pairEdges = getActivePairEdges(db, String(subject), String(q.object_person_id));
          if (pairEdges.some((e) => laterStages.includes(e.rel_type))) {
            recordQuestionAnswer(db, q.id, { status: 'declined', answer: `auto-silenced: temporal-superseded (an active ${laterStages.join('/')} edge post-dates this ${q.rel_type} statement — newest wins)` });
            report.silenced++;
            report.by_conflict_reason['temporal-superseded'] = (report.by_conflict_reason['temporal-superseded'] || 0) + 1;
            changed++;
            continue;
          }
        }
      }

      // 3. LATTICE-ANSWERED: an EXCLUSIVE-type candidate pairing someone with
      //    a new partner while an OWNER-authority edge of the same type stands
      //    is answered by the lattice, not askable ("Is <wife> X's wife?").
      //    The evidence stays recorded in the declined row's payload.
      if (q.rel_type && EXCLUSIVE_EDGE_TYPES.has(q.rel_type)) {
        const heldElsewhere = [subject, q.object_person_id].filter(Boolean).some((end) => {
          const other = String(end) === String(subject) ? q.object_person_id : subject;
          return getActiveEdgesForPerson(db, String(end), { domain: null })
            .some((e) => e.rel_type === q.rel_type && e.authority === 'owner'
              && ![String(e.person_a), String(e.person_b)].includes(String(other)));
        });
        if (heldElsewhere) {
          recordQuestionAnswer(db, q.id, { status: 'declined', answer: `auto-silenced: contradicts-owner-authority (an owner-authority ${q.rel_type} edge already binds an endpoint to a different partner; evidence retained in payload for audit)` });
          report.silenced++;
          report.by_conflict_reason['contradicts-owner-authority'] = (report.by_conflict_reason['contradicts-owner-authority'] || 0) + 1;
          changed++;
          continue;
        }
      }

      // ALIAS-AUTHORSHIP artifact (found investigating rule 3's live cases):
      // an owner-touching candidate whose mined evidence emails were sent
      // from addresses that resolve to the OWNER's row via identifiers but
      // are NOT in identity.json ownerEmails() — the authorship chain is a
      // split owner alias (often carrying unstripped quoted third-party
      // text). Untrustworthy evidence: silence, never write, never ask.
      if ((String(subject) === owner || String(q.object_person_id || '') === owner)) {
        let payload = {};
        try { payload = JSON.parse(q.payload || '{}'); } catch { payload = {}; }
        const emailIds = (payload.evidence || [])
          .filter((e) => e.kind === 'mining-email')
          .map((e) => String(e.source_id || '').replace(/^email:/, ''));
        if (emailIds.length) {
          const ownSet = new Set(ownerEmails());
          const ident = db.prepare("SELECT person_id FROM person_identifiers WHERE type = 'email' AND LOWER(value) = ? LIMIT 1");
          const sender = db.prepare('SELECT sender_email FROM emails WHERE id = ?');
          const aliasArtifact = emailIds.every((id) => {
            const addr = String(sender.get(id)?.sender_email || '').toLowerCase();
            if (!addr || ownSet.has(addr)) return false;
            return String(ident.get(addr)?.person_id || '') === owner;
          });
          if (aliasArtifact) {
            recordQuestionAnswer(db, q.id, { status: 'declined', answer: 'auto-silenced: ambiguous-authorship-owner-alias (evidence sent from an owner-identifier address missing from identity.json ownerEmails — authorship chain untrustworthy)' });
            report.silenced++;
            report.by_conflict_reason['ambiguous-authorship-owner-alias'] = (report.by_conflict_reason['ambiguous-authorship-owner-alias'] || 0) + 1;
            changed++;
            continue;
          }
        }
      }

      // Already on record: an ACTIVE edge covering the question's own pair
      // and type answers it — recorded truth needs no owner word and no
      // conflict tag (live case: mined spouse questions about the recorded
      // wife). Same rule the mining sweep applies before queueing.
      if (q.object_person_id && q.rel_type && edgeDomain(q.rel_type)) {
        const covered = db.prepare(`
          SELECT COUNT(*) n FROM person_relations WHERE status = 'active' AND rel_type = ?
            AND ((person_a = ? AND person_b = ?) OR (person_a = ? AND person_b = ?))
        `).get(q.rel_type, String(subject), String(q.object_person_id), String(q.object_person_id), String(subject)).n;
        if (covered) {
          recordQuestionAnswer(db, q.id, {
            status: 'confirmed',
            answer: 'auto-resolved: already on record (active edge)',
          });
          report.auto_answered_questions++;
          changed++;
          continue;
        }
      }

      const hint = q.rel_type && edgeDomain(q.rel_type) ? q.rel_type : null;
      const r = resolveCandidate(db, subject, hint, ctx);

      if (r.decision === 'conflict') {
        // 4. STAKES FLOOR: anchor ambiguity on a low-stakes type never merits
        //    interrupting the owner — silence, store nothing (omission per
        //    the cost asymmetry). Kinship/romantic types keep asking.
        if (q.rel_type && LOW_STAKES_ANCHOR_TYPES.has(q.rel_type)) {
          recordQuestionAnswer(db, q.id, { status: 'declined', answer: `auto-silenced: low-stakes-anchor-ambiguity (${q.rel_type} anchoring conflict below the interruption floor; nothing stored)` });
          report.silenced++;
          report.by_conflict_reason['low-stakes-anchor-ambiguity'] = (report.by_conflict_reason['low-stakes-anchor-ambiguity'] || 0) + 1;
          changed++;
          continue;
        }
        tagConflict(q, r.conflictReason, 'both-sides-plausible');
        continue;
      }

      if (r.decision === 'write') {
        const rel = effectiveRelType(q, r);
        if (!rel || !edgeDomain(rel)) {
          tagConflict(q, `write-grade evidence (confidence=${r.confidence.toFixed(2)}) but the exact relation type is undecidable from "${q.rel_type}" — needs the owner`, 'undecidable-type');
          continue;
        }
        if (writeEdge(q, subject, { ...r, relType: rel })) changed++;
        continue;
      }

      if (r.decision === 'question') {
        if (q.rel_type && LOW_STAKES_ANCHOR_TYPES.has(q.rel_type)) {
          recordQuestionAnswer(db, q.id, { status: 'declined', answer: `auto-silenced: low-stakes-anchor-ambiguity (${q.rel_type} at mid-band confidence below the interruption floor)` });
          report.silenced++;
          report.by_conflict_reason['low-stakes-anchor-ambiguity'] = (report.by_conflict_reason['low-stakes-anchor-ambiguity'] || 0) + 1;
          changed++;
          continue;
        }
        const rel = effectiveRelType(q, r) || r.relType || q.rel_type;
        const anchored = r.anchorClusterKey === 'owner'
          ? `Is ${nm(subject)} your ${rel}?`
          : `Is ${nm(subject)} ${nm(r.anchorPersonId)}'s ${rel}?`;
        db.prepare(`
          UPDATE relation_questions
             SET question_text = ?, payload = ?, conflict_reason = ?, updated_at = datetime('now')
           WHERE id = ?
        `).run(
          anchored,
          JSON.stringify({ spec: { person_a: String(subject), person_b: String(r.anchorPersonId), rel_type: rel }, composite_confidence: r.confidence, signals: r.signals }),
          `mid-band composite confidence ${r.confidence.toFixed(2)} (${r.signals.join('; ')})`,
          q.id,
        );
        report.re_anchored_questions++;
        report.by_conflict_reason['mid-band-confidence'] = (report.by_conflict_reason['mid-band-confidence'] || 0) + 1;
        continue;
      }

      silence(q, r.confidence, r.signals);
      changed++;
    }

    if (!changed) break; // fixed point reached
  }

  refreshDerivedRelationCache(db, { ownerId: owner });
  report.finished_at = new Date().toISOString();
  report.open_after = db.prepare("SELECT COUNT(*) n FROM relation_questions WHERE status = 'open'").get().n;
  report.open_conflict_tagged = db.prepare("SELECT COUNT(*) n FROM relation_questions WHERE status = 'open' AND conflict_reason IS NOT NULL").get().n;
  return report;
}
