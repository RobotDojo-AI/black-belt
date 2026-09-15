/**
 * lib/people-write.js — write-side DAL for people (Network app).
 *
 * Thin-facade pattern (build-conventions.md): routes/people.js holds the
 * HTTP plumbing; this module holds the data-layer logic. All exported
 * functions take a `db` parameter so they can be unit-tested with an
 * injected in-memory DB.
 *
 * Story: st_87a0d072 — Miyagi manual override for relation_tag.
 *
 * The Miyagi chat tool `set_relation_tag` calls setRelationTag() with
 * confidence 1.0 — overriding any inference. The Phase 4 family detector +
 * Phase 7 inference both check for a pre-existing relation_tag before
 * writing, so a manual tag survives every pipeline run.
 */

import { FAMILY_TAGS } from './scoring.js';
import {
  assertValidLabelForTag,
  labelInfo,
} from './relation-vocabulary.js';
import { appEvents } from './app-events.js';
import { findOrCreateCompany } from './entity-relationships.js';
import {
  assertRelation,
  clearRelation,
  applyNodeHints,
  getActiveEdgesForPerson,
} from './relation-store.js';
import { enqueueRelationQuestion } from './relation-questions.js';
import { walkOwnerView } from './relation-walk.js';
import { ownerPersonId } from './identity.js';

// ── Source authority (st_df0a8d71 QA round 2; remodeled st_f67bc2eb D2/D6) ───
// The truth source is now person_relations (lib/relation-store.js) and
// authority is PER-EDGE DATA: owner > contact > stated. This module keeps the
// source-token → authority-class mapping for the compatibility adapter below:
//
//   owner class     — owner-correction, chat-correction, chat-tool, manual,
//                     family-config, question-answer (the owner's word)
//   contact class   — contact-card (the owner hand-curated a relation field
//                     on the contact card; survives pipeline reruns, never
//                     outranks the owner)
//   inference class — every automated derivation. Inference NEVER writes an
//                     edge — the store refuses it and converts the candidate
//                     into a queue question (AC-3).
const OWNER_CLASS_SOURCES = new Set([
  'owner-correction', 'chat-correction', 'chat-tool', 'manual', 'family-config',
  'question-answer',
]);
const CONTACT_CLASS_SOURCES = new Set(['contact-card']);

export function relationSourceClass(source) {
  const s = String(source || '').trim();
  if (OWNER_CLASS_SOURCES.has(s)) return 'owner';
  if (CONTACT_CLASS_SOURCES.has(s)) return 'contact';
  return 'inference';
}

function refuse(personId, why) {
  console.warn(`[people-write] REFUSED relationship write for ${personId}: ${why}`);
  return null; // caller receives the unchanged row via getPersonById
}

// ── Derived-relation cache (st_f67bc2eb D5) ──────────────────────────────────
// The owner-anchored columns (relation_tag / relation_label /
// relation_derived_phrase) are a WALKER-DERIVED CACHE of person_relations —
// one truth, two precisions, never two truths. Every existing reader keeps
// working off the columns; the walker keeps them coherent.

/**
 * Write the walked owner view into the cache columns. FULL SYNC: rows in the
 * view are updated; tagged rows NOT in the view are cleared (their edges are
 * gone — a stale tag would be a second truth). Returns change counts.
 */
export function applyDerivedRelationCache(db, rows) {
  if (!Array.isArray(rows)) return { updated: 0, cleared: 0 };
  const inView = new Set(rows.map((r) => String(r.person_id)));
  let updated = 0;
  let cleared = 0;
  const readStmt = db.prepare('SELECT relation_tag, relation_label, relation_derived_phrase FROM people WHERE id = ?');
  const writeStmt = db.prepare(`
    UPDATE people SET relation_tag = ?, relation_label = ?, relation_derived_phrase = ?,
      updated_at = datetime('now') WHERE id = ?
  `);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const cur = readStmt.get(String(r.person_id));
      if (!cur) continue;
      if (cur.relation_tag === r.relation_tag
        && (cur.relation_label || null) === (r.relation_label || null)
        && (cur.relation_derived_phrase || null) === (r.relation_derived_phrase || null)) continue;
      writeStmt.run(r.relation_tag, r.relation_label || null, r.relation_derived_phrase || null, String(r.person_id));
      try { db.prepare('UPDATE people SET needs_regen = 1 WHERE id = ?').run(String(r.person_id)); } catch { /* defensive */ }
      updated++;
    }
    const stale = db.prepare('SELECT id FROM people WHERE relation_tag IS NOT NULL').all()
      .filter((p) => !inView.has(String(p.id)));
    for (const p of stale) {
      writeStmt.run(null, null, null, String(p.id));
      try { db.prepare('UPDATE people SET needs_regen = 1 WHERE id = ?').run(String(p.id)); } catch { /* defensive */ }
      cleared++;
    }
  });
  tx();
  return { updated, cleared };
}

/**
 * Walk → cache → graph-change. The one refresh entry every edge writer calls
 * (directly or via the warmup-bound relations-change listener). Synchronous —
 * the family graph is ~tens of rows; a chat correction reads a fresh row on
 * return.
 *
 * Pre-backfill grace: an EMPTY person_relations table with tagged people rows
 * means the truth swap has not backfilled yet — clearing the cache then would
 * destroy the only truth. Skip until the table holds any row.
 */
export function refreshDerivedRelationCache(db, { ownerId = null } = {}) {
  let inUse = 0;
  try { inUse = db.prepare('SELECT COUNT(*) AS n FROM person_relations').get()?.n || 0; } catch { return { updated: 0, cleared: 0, skipped: true }; }
  if (!inUse) return { updated: 0, cleared: 0, skipped: true };
  const view = walkOwnerView(db, { ownerId });
  const result = applyDerivedRelationCache(db, view);
  if (result.updated || result.cleared) {
    try {
      appEvents.emit('graph-change', { entity_type: 'person', entity_id: null, source: 'relation-walk' });
    } catch (err) { console.warn('[people-write] graph-change emit failed:', err.message); }
  }
  return result;
}

/**
 * Owner-stated gender for a person node (the correction path). Unlike the
 * fill-only statement hints (relation-store applyNodeHints), the owner may
 * overwrite. Gendered role names derive from this at render — never from how
 * a label happened to be written.
 */
export function setPersonGender(db, personId, gender, { source = 'manual' } = {}) {
  const g = String(gender || '').trim().toLowerCase();
  if (!['male', 'female'].includes(g)) {
    throw new Error(`invalid gender: ${gender}; must be male or female`);
  }
  const res = db.prepare(`UPDATE people SET gender = ?, updated_at = datetime('now') WHERE id = ?`).run(g, String(personId));
  if (res.changes) refreshDerivedRelationCache(db);
  return getPersonById(db, personId);
}

// ── Owner-anchored tag → canonical edge spec ─────────────────────────────────
// The owner view is DERIVED; an owner-anchored statement ("X is my parent")
// stores the atomic person-to-person edge it implies. Directional types put
// the role holder in person_a (lib/relation-store.js normalizes the rest).
function ownerEdgeSpecForTag(tag, personId, ownerId) {
  switch (tag) {
    case 'spouse': return { personA: personId, personB: ownerId, relType: 'spouse' };
    case 'parent': return { personA: personId, personB: ownerId, relType: 'parent' };
    case 'child': return { personA: ownerId, personB: personId, relType: 'parent' };
    case 'sibling': return { personA: personId, personB: ownerId, relType: 'sibling' };
    case 'cousin': return { personA: personId, personB: ownerId, relType: 'cousin' };
    case 'grandparent': return { personA: personId, personB: ownerId, relType: 'grandparent' };
    case 'niece-nephew': return { personA: personId, personB: ownerId, relType: 'niece-nephew' };
    case 'pet': return { personA: personId, personB: ownerId, relType: 'pet' };
    default: return null; // composite (in-law/IL/family) — decompose below
  }
}

// Composite tags are NEVER stored (D3). Decompose deterministically when the
// graph already disambiguates; otherwise enqueue a decomposition question.
function decomposeCompositeTag(db, personId, tag, label, ownerId, source) {
  // Re-class correction: the owner stating a COMPOSITE relation for someone
  // who currently holds a DIRECT owner-anchored kinship edge means the direct
  // record is wrong ("Person A is my sister" → "no, my sister-in-law").
  // Deprecate it (owner tombstone) before decomposing, or the stale direct
  // edge would poison the decomposition substrate below.
  const direct = getActiveEdgesForPerson(db, personId, { domain: 'kinship' })
    .filter((e) => String(e.person_a) === String(ownerId) || String(e.person_b) === String(ownerId));
  if (direct.length) clearRelation(db, ownerId, personId, { domain: 'kinship', source });

  const ownerEdges = getActiveEdgesForPerson(db, ownerId, { domain: 'kinship' });
  const spouseIds = ownerEdges.filter((e) => e.rel_type === 'spouse')
    .map((e) => (String(e.person_a) === String(ownerId) ? e.person_b : e.person_a));
  const siblingIds = ownerEdges.filter((e) => e.rel_type === 'sibling')
    .map((e) => (String(e.person_a) === String(ownerId) ? e.person_b : e.person_a));
  const childIds = ownerEdges.filter((e) => e.rel_type === 'parent' && String(e.person_a) === String(ownerId))
    .map((e) => e.person_b);
  const name = (id) => db.prepare('SELECT display_name FROM people WHERE id = ?').get(String(id))?.display_name || 'them';
  const personName = name(personId);

  const opts = { authority: 'owner', source, authorPersonId: ownerId, statedAt: new Date().toISOString(), ownerId };

  if (tag === 'parent-in-law') {
    if (spouseIds.length === 1) {
      return { action: 'write', result: assertRelation(db, { personA: personId, personB: spouseIds[0], relType: 'parent' }, opts) };
    }
    const q = enqueueRelationQuestion(db, {
      kind: 'decompose', subjectPersonId: personId, objectPersonId: ownerId, relType: 'parent-in-law',
      questionText: `Whose parent is ${personName} — which spouse-side does that in-law come through? Tell me like "${personName} is <spouse name>'s mother".`,
      payload: { options: [] }, confidence: 1, priority: 5,
    });
    return { action: 'queued', questionId: q.id };
  }
  if (tag === 'sibling-in-law') {
    const options = [];
    if (spouseIds.length === 1) {
      options.push({ key: 'spouse', label: `${name(spouseIds[0])}'s sibling`, spec: { person_a: personId, person_b: spouseIds[0], rel_type: 'sibling' } });
    }
    if (siblingIds.length === 1) {
      options.push({ key: 'sibling', label: `${name(siblingIds[0])}'s spouse`, spec: { person_a: personId, person_b: siblingIds[0], rel_type: 'spouse' } });
    }
    if (options.length === 1) {
      const s = options[0].spec;
      return { action: 'write', result: assertRelation(db, { personA: s.person_a, personB: s.person_b, relType: s.rel_type }, opts) };
    }
    const q = enqueueRelationQuestion(db, {
      kind: 'decompose', subjectPersonId: personId, objectPersonId: ownerId, relType: 'sibling-in-law',
      questionText: `Is ${personName} your spouse's sibling, or your sibling's spouse? Reply "spouse" or "sibling".`,
      payload: { options }, confidence: 1, priority: 5,
    });
    return { action: 'queued', questionId: q.id };
  }
  // Generic composite (IL / family / anything undecomposable): the exact
  // relation is unknown — omission beats a false status; queue it.
  const q = enqueueRelationQuestion(db, {
    kind: 'decompose', subjectPersonId: personId, objectPersonId: ownerId, relType: tag,
    questionText: `${personName} is on record as ${tag === 'IL' ? 'an in-law' : 'family'} — what is the exact relation (e.g. cousin, sibling)?`,
    payload: { options: [], child_of: childIds.slice(0, 4) }, confidence: 1, priority: 4,
  });
  return { action: 'queued', questionId: q.id };
}

/**
 * Set a person's relation to the OWNER — the COMPATIBILITY ADAPTER
 * (st_f67bc2eb D6). Same signature and call sites as st_df0a8d71's one write
 * path, new truth underneath:
 *
 *   - owner/contact-class sources translate to a person_relations edge assert
 *     through lib/relation-store.js (owner-anchored tag = owner↔person edge),
 *     then refresh the derived cache so the returned row is already coherent.
 *   - inference-class sources are REFUSED at the store and converted into
 *     queue candidates — inference promotes attention and generates
 *     questions, never edges (AC-3). The unchanged row returns, exactly like
 *     the old floor refusals, so every existing caller's landed-check keeps
 *     the same semantics.
 *   - composite tags (parent-in-law, sibling-in-law, IL, family) are NEVER
 *     stored: they decompose to the atomic edge when the graph already
 *     disambiguates, else enqueue a decomposition question (D3).
 *   - a gendered label ("mother") becomes a NODE fact (gender fill) — the
 *     rendered label then derives from the node, never from label spelling.
 *
 * entity_facts relationship_label supersede pairs are RETIRED for new writes
 * (D5): full history now lives on edges; existing fact rows stay untouched.
 *
 * @returns {object|null} updated row or null if person not found
 * @throws {Error} if relationTag or relationLabel is invalid
 */
export function setRelationTag(db, personId, relationTag, relationLabel = null, { source = 'manual', ownerId = null } = {}) {
  const sourceClass = relationSourceClass(source);
  const owner = ownerId || ownerPersonId();

  // CLEAR mode (relationTag === null): owner-class only. A clear is a
  // first-class correction that DEPRECATES the pair's kinship edges (owner
  // tombstone — blocks every non-owner re-assertion forever) and re-derives
  // the cache. Never a delete (AC-11).
  if (relationTag === null || relationTag === undefined) {
    if (sourceClass !== 'owner') {
      refuse(personId, `clear requested by ${sourceClass}-class source "${source}" — clears are owner-only`);
      return getPersonById(db, personId);
    }
    const existing = db.prepare('SELECT id FROM people WHERE id = ?').get(personId);
    if (!existing) return null;
    if (owner) clearRelation(db, owner, personId, { domain: 'kinship', source });
    // Direct column clear covers pre-backfill rows with no edge behind them.
    db.prepare(`UPDATE people SET relation_tag = NULL, relation_label = NULL, relation_derived_phrase = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(personId);
    try { db.prepare('UPDATE people SET needs_regen = 1 WHERE id = ?').run(personId); } catch { /* defensive */ }
    refreshDerivedRelationCache(db, { ownerId: owner });
    try {
      appEvents.emit('graph-change', { entity_type: 'person', entity_id: personId, relation_tag: null, relation_label: null, source });
    } catch (err) { console.warn('[people-write] graph-change emit failed:', err.message); }
    return getPersonById(db, personId);
  }

  if (!FAMILY_TAGS.has(relationTag)) {
    throw new Error(`invalid relation_tag: ${relationTag}; must be one of: ${Array.from(FAMILY_TAGS).join(', ')}`);
  }
  assertValidLabelForTag(relationTag, relationLabel);

  const existing = db.prepare('SELECT id, relation_tag, relation_label FROM people WHERE id = ?').get(personId);
  if (!existing) return null;

  if (!owner) {
    refuse(personId, 'owner_person_id missing from identity.json — an owner-anchored relation has no anchor');
    return getPersonById(db, personId);
  }

  // THE FIREWALL (AC-3): inference-class calls never reach the edge store as
  // writes — they become queue candidates. The store enforces the same rule
  // (belt and braces); routing here keeps the question text tag-shaped.
  if (sourceClass === 'inference') {
    const spec = ownerEdgeSpecForTag(relationTag, String(personId), String(owner));
    const personName = db.prepare('SELECT display_name FROM people WHERE id = ?').get(String(personId))?.display_name || 'this person';
    enqueueRelationQuestion(db, {
      kind: 'confirm',
      subjectPersonId: String(personId),
      objectPersonId: String(owner),
      relType: spec ? spec.relType : relationTag,
      questionText: `Is ${personName} your ${relationLabel || relationTag}?`,
      payload: spec ? { spec: { person_a: spec.personA, person_b: spec.personB, rel_type: spec.relType } } : {},
      confidence: 0.5,
      priority: 0.5,
    });
    refuse(personId, `inference source "${source}" may not write a relationship edge — candidate queued as a question`);
    return getPersonById(db, personId);
  }

  const authority = sourceClass === 'owner' ? 'owner' : 'contact';

  // Node hints from the gendered/species label — the label was always a
  // (relation class x gender) denormalization; the node keeps the fact.
  const labelWord = relationLabel ? String(relationLabel).trim().toLowerCase() : null;
  if (labelWord && labelInfo(labelWord)) {
    const genderHint = ({
      mother: 'female', father: 'male', 'mother-in-law': 'female', 'father-in-law': 'male',
      sister: 'female', brother: 'male', 'sister-in-law': 'female', 'brother-in-law': 'male',
      grandmother: 'female', grandfather: 'male', wife: 'female', husband: 'male',
      daughter: 'female', son: 'male',
    })[labelWord] || null;
    const speciesHint = ['dog', 'cat'].includes(labelWord) ? labelWord : null;
    applyNodeHints(db, personId, { gender: genderHint, species: speciesHint });
  }

  const opts = {
    authority,
    source,
    authorPersonId: authority === 'owner' ? String(owner) : null,
    statedAt: new Date().toISOString(),
    evidence: [{ kind: source, source_id: `person:${personId}` }],
    ownerId: String(owner),
  };

  const spec = ownerEdgeSpecForTag(relationTag, String(personId), String(owner));
  if (spec) {
    assertRelation(db, spec, opts);
  } else {
    decomposeCompositeTag(db, String(personId), relationTag, relationLabel, String(owner), source);
  }

  // Re-derive the cache synchronously so the caller's returned row is already
  // coherent (the correction's confirmation message reads it).
  refreshDerivedRelationCache(db, { ownerId: owner });
  return getPersonById(db, personId);
}

/**
 * Fetch a person by id. Returns the full row or null.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} personId
 * @returns {object|null}
 */
export function getPersonById(db, personId) {
  return db.prepare('SELECT * FROM people WHERE id = ?').get(personId) || null;
}

/**
 * One-time truth-swap backfill (st_f67bc2eb, re-runnable/idempotent): convert
 * the legacy owner-anchored relation_tag rows into person_relations edges BY
 * PROVENANCE CLASS.
 *
 *   owner class    — latest relationship_label fact from an owner-class
 *                    source, OR (no fact at all) the person appears by name
 *                    in config/family.json (detectFamily's owner-curated
 *                    seed predates fact provenance). → owner↔person edge,
 *                    authority 'owner', source 'legacy-backfill'. Composite
 *                    tags decompose (or queue) exactly like a live statement.
 *   inference class — everything else. → NO edge; a high-priority confirm
 *                    question enqueues. The graph starts honest: omission
 *                    beats a false status, and the onboarding pass walks
 *                    exactly these first (a wrongly-cleared true relation
 *                    recovers with one word).
 *
 * Storable owner rows write BEFORE composite rows so in-law decomposition
 * finds the spouse/sibling substrate. Ends with a cache refresh — after this
 * runs, the columns are pure walker output.
 */
export function backfillLegacyRelationColumns(db, { ownerId = null, familyConfig = null } = {}) {
  const owner = String(ownerId || ownerPersonId() || '');
  const report = { owner_edges: 0, composites_written: 0, composites_queued: 0, questions: 0, skipped_existing: 0 };
  if (!owner) {
    console.warn('[people-write] backfill skipped: owner_person_id missing');
    return report;
  }
  const configNames = new Set(
    ((familyConfig && familyConfig.members) || []).map((m) => String(m.name || '').toLowerCase().trim()).filter(Boolean),
  );
  const rows = db.prepare(`
    SELECT id, display_name, relation_tag, relation_label FROM people
    WHERE relation_tag IS NOT NULL AND COALESCE(archived, 0) = 0 AND id != ?
  `).all(owner);

  const factSourceStmt = db.prepare(`
    SELECT source_event_ids FROM entity_facts
    WHERE entity_id = ? AND entity_type = 'person' AND fact_type = 'relationship_label'
    ORDER BY id DESC LIMIT 1
  `);
  const classify = (row) => {
    let token = null;
    try {
      const fact = factSourceStmt.get(String(row.id));
      if (fact?.source_event_ids) {
        const parsed = JSON.parse(fact.source_event_ids);
        const t = (Array.isArray(parsed) ? parsed : []).find((v) => String(v).startsWith('source:'));
        token = t ? String(t).slice('source:'.length) : null;
      }
    } catch { token = null; }
    if (token) return relationSourceClass(token);
    // Pre-provenance rows: owner-curated iff named in config/family.json.
    return configNames.has(String(row.display_name || '').toLowerCase().trim()) ? 'owner' : 'inference';
  };

  const ownerRows = [];
  const inferenceRows = [];
  for (const row of rows) {
    (classify(row) === 'owner' ? ownerRows : inferenceRows).push(row);
  }

  // Storable atomics first (spouse before all, so decomposition has an anchor).
  const storableOrder = (r) => (r.relation_tag === 'spouse' ? 0 : ownerEdgeSpecForTag(r.relation_tag, 'x', 'y') ? 1 : 2);
  ownerRows.sort((a, b) => storableOrder(a) - storableOrder(b));
  for (const row of ownerRows) {
    const spec = ownerEdgeSpecForTag(row.relation_tag, String(row.id), owner);
    const opts = {
      authority: 'owner', source: 'legacy-backfill', authorPersonId: owner,
      statedAt: new Date().toISOString(),
      evidence: [{ kind: 'legacy-backfill', source_id: `person:${row.id}` }],
      ownerId: owner,
    };
    if (row.relation_label) {
      // The gendered/species label already backfilled the node in migration
      // 135; applyNodeHints is the idempotent belt-and-braces.
      applyNodeHints(db, row.id, {
        gender: ({ mother: 'female', father: 'male', wife: 'female', husband: 'male', sister: 'female', brother: 'male', grandmother: 'female', grandfather: 'male', daughter: 'female', son: 'male' })[row.relation_label] || null,
        species: ['dog', 'cat'].includes(row.relation_label) ? row.relation_label : null,
      });
    }
    if (spec) {
      const res = assertRelation(db, spec, opts);
      if (['written', 'merged', 'superseded'].includes(res.outcome)) report.owner_edges++;
      else report.skipped_existing++;
    } else {
      const d = decomposeCompositeTag(db, String(row.id), row.relation_tag, row.relation_label, owner, 'legacy-backfill');
      if (d.action === 'write') report.composites_written++;
      else report.composites_queued++;
    }
  }

  for (const row of inferenceRows) {
    const spec = ownerEdgeSpecForTag(row.relation_tag, String(row.id), owner);
    const phrase = row.relation_label || row.relation_tag;
    const { inserted } = enqueueRelationQuestion(db, {
      kind: 'confirm',
      subjectPersonId: String(row.id),
      objectPersonId: owner,
      relType: spec ? spec.relType : row.relation_tag,
      questionText: `Is ${row.display_name || 'this person'} your ${phrase}?`,
      payload: spec ? { spec: { person_a: spec.personA, person_b: spec.personB, rel_type: spec.relType } } : {},
      confidence: 0.6,
      // High priority: these were live truth until this swap — the onboarding
      // pass must walk them first so recovery is one word each.
      priority: 8,
    });
    if (inserted) report.questions++;
  }

  refreshDerivedRelationCache(db, { ownerId: owner });
  return report;
}

/**
 * Set a person's employer from a plain-chat correction (st_df0a8d71 D4 —
 * the employer-change arm of the deterministic correction path).
 *
 * Same three invariants as setRelationTag: code-validated (company resolved
 * or created through the canonical case-insensitive lookup — never an LLM),
 * supersede-archived (entity_facts fact_type='employer' pair), observable
 * (graph-change event so the ego block's "works at" line re-renders next
 * turn for the owner row).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} personId
 * @param {string} companyName - plain company name as stated in chat
 * @param {object} [opts]
 * @param {string} [opts.source='manual']
 * @returns {object|null} { person, company } or null if person not found
 */
export function setEmployerFact(db, personId, companyName, { source = 'manual' } = {}) {
  const name = String(companyName || '').trim();
  if (!name) throw new Error('setEmployerFact requires a non-empty company name');
  const existing = db.prepare('SELECT id, company_id FROM people WHERE id = ?').get(personId);
  if (!existing) return null;

  // entity-relationships owns the canonical find-or-create
  // (LOWER(TRIM(name)) uniqueness) — never a second company-matching path.
  const company = findOrCreateCompany(db, name);
  const changed = existing.company_id !== company.id;

  db.prepare(`UPDATE people SET company_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(company.id, personId);

  const currentFact = db.prepare(`
    SELECT fact_value FROM entity_facts
    WHERE entity_id = ? AND entity_type = 'person'
      AND fact_type = 'employer' AND invalid_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(String(personId));

  if (changed || (currentFact?.fact_value || null) !== company.name) {
    db.prepare(`
      UPDATE entity_facts SET invalid_at = datetime('now','utc')
      WHERE entity_id = ? AND entity_type = 'person'
        AND fact_type = 'employer' AND invalid_at IS NULL
    `).run(String(personId));
    db.prepare(`
      INSERT INTO entity_facts (entity_id, entity_type, fact_type, fact_value, source_event_ids, valid_at, model_tier)
      VALUES (?, 'person', 'employer', ?, ?, datetime('now','utc'), 'free')
    `).run(String(personId), company.name, JSON.stringify([`source:${source}`]));
    try {
      db.prepare('UPDATE people SET needs_regen = 1 WHERE id = ?').run(personId);
    } catch { /* defensive */ }
    try {
      appEvents.emit('graph-change', {
        entity_type: 'person',
        entity_id: personId,
        employer: company.name,
        source,
      });
    } catch (err) {
      console.warn('[people-write] graph-change emit failed:', err.message);
    }
  }

  return { person: getPersonById(db, personId), company };
}

/**
 * Confirm a transcript turn's speaker — the pull-based human confirm
 * (st_8a841c68 AC-6). Writes a permanent method='confirmed' assignment at
 * confidence 1.0 and clears needs_confirm. A confirmed turn is STICKY: the
 * attribution orchestrator skips method='confirmed' on every later pass, so the
 * tag survives re-attribution (plan failure manifest #7).
 *
 * Confirm NEVER sticks a NULL person — a confirm names someone, by definition;
 * passing a missing/invalid person throws rather than silently blanking the
 * turn. The person must exist (no phantom ids).
 *
 * Feeds learning: after the write, the confirmed person's speech profile is
 * refreshed from all their confirmed/owner turns (the caller passes the
 * already-imported updateProfile so this module stays import-light and the LLM
 * boundary is unaffected — this is pure deterministic structure).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} segmentId
 * @param {string} personId
 * @returns {object} the updated segment row
 * @throws {Error} when the segment or person is missing
 */
export function confirmSegmentSpeaker(db, segmentId, personId) {
  if (!personId) throw new Error('confirmSegmentSpeaker requires a personId; a confirm never sticks NULL');
  const seg = db.prepare('SELECT * FROM transcript_segments WHERE id = ?').get(segmentId);
  if (!seg) throw new Error(`segment ${segmentId} not found`);
  const person = db.prepare('SELECT id FROM people WHERE id = ?').get(personId);
  if (!person) throw new Error(`person ${personId} not found — confirm must name an existing entity`);

  db.prepare(`
    UPDATE transcript_segments
       SET speaker_person_id = ?, confidence = 1.0, method = 'confirmed', needs_confirm = 0
     WHERE id = ?
  `).run(personId, segmentId);

  return db.prepare('SELECT * FROM transcript_segments WHERE id = ?').get(segmentId);
}
