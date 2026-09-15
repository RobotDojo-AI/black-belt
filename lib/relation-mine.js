/**
 * lib/relation-mine.js — Tier-0 possessive relation mining over the
 * owner-authored corpus (st_f67bc2eb D7, AC-5).
 *
 * Extracts closed-vocabulary relation statements ("my sister Sarah",
 * "Dana's cousin Tess", "my former colleague X") from free text, anchors
 * every statement to ITS AUTHOR (speaker-relative anchoring — "my" binds to
 * the message author from envelope metadata, never from in-text inference),
 * clusters instances per (author, subject, rel_type, object) with per-source
 * evidence dedup, and applies the precision-first write policy:
 *
 *   - ≥2 independent instances with no unresolved conflict → edge write at
 *     the AUTHOR's authority (owner text → 'owner'; third-party → 'stated')
 *   - singletons → confirm question
 *   - ambiguous names (two Sarahs — coref F≈0.74 is not write-grade) →
 *     disambiguation question; unresolved names → counted, never written
 *   - composite in-law/step words → decompose question, never a stored edge
 *   - any candidate edge touching the OWNER from a NON-OWNER author →
 *     question only (the PYMK rule)
 *   - a notes-only evidence cluster NEVER writes (the hard shared-note
 *     guard) — notes corroborate chat/email instances or enqueue a question
 *   - transcript-sourced candidates → questions only (probabilistic speaker
 *     attribution never writes an edge)
 *   - former/ex markers → time-bounded edges (valid_until)
 *
 * Pattern extraction is DATA (regex over the closed vocabulary) — no LLM
 * anywhere on this path; precision ~0.85-class rule extraction with recall
 * recovered by the corpus-wide sweep + question queue, never by loosening
 * patterns. Re-runnable: evidence dedup by (kind, source_id) makes the sweep
 * idempotent.
 */

import {
  EDGE_WORDS,
  DECOMPOSE_WORDS,
  resolveEdgeWord,
  resolveDecomposeWord,
} from './relation-vocabulary.js';
import {
  assertRelation,
  applyNodeHints,
  getActivePairEdges,
} from './relation-store.js';
import { titleCaseName } from './relation-vocabulary.js';
import { enqueueRelationQuestion, recordQuestionAnswer } from './relation-questions.js';
import { resolveSinglePerson } from './chat/relationship-intent.js';

/**
 * Extract the OWNER-authored text from an llm_export chunk (st_f67bc2eb,
 * owner-directed: "i have given my family tree many times before").
 *
 * Chunk shape (scripts/backfill-llm-chunks.js): `[date | model | title]` then
 * `User: …` and optionally `Assistant: …`. User lines are the owner by
 * construction (his exported foundation-model chats); Assistant lines are
 * MACHINE TEXT — an LLM's paraphrase of his family is not stated evidence and
 * is excluded rigorously. Summary chunks (First:/Last:) carry no `User:`
 * marker and yield nothing.
 *
 * @returns {{ userText: string, date: string|null }}
 */
export function extractLlmExportUserText(content) {
  const text = String(content || '');
  const dateMatch = text.match(/^\[(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? `${dateMatch[1]}T00:00:00Z` : null;
  const parts = [];
  const re = /(?:^|\n)User:[ ]([\s\S]*?)(?=\nAssistant:[ ]|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) parts.push(m[1]);
  }
  return { userText: parts.join('\n'), date };
}

// ── Statement patterns (data — closed vocabulary alternation) ────────────────

const REL_ALT = [...new Set([...Object.keys(EDGE_WORDS), ...Object.keys(DECOMPOSE_WORDS)])]
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[-\s]/g, (m) => (m === '-' ? '\\-' : '[ ]')))
  .join('|');
const NAME = `[A-Z][A-Za-z'’\\-]{1,29}(?:[ ][A-Z][A-Za-z'’\\-]{1,29}){0,3}`;
const FORMER = `(?:former|ex|ex\\-|previous|late|estranged)`;

// Each pattern names its captures via order; possessor 'self' = the author.
const STATEMENT_PATTERNS = [
  // "Dana's cousin is Tess"
  { re: () => new RegExp(`\\b(${NAME})['’]s[ ](?:(${FORMER})[ ])?(${REL_ALT})[ ]is[ ](${NAME})\\b`, 'g'), groups: { possessor: 1, former: 2, rel: 3, named: 4 } },
  // "Dana's cousin Tess" / "Dana's cousin, Tess"
  { re: () => new RegExp(`\\b(${NAME})['’]s[ ](?:(${FORMER})[ ])?(${REL_ALT})[,:]?[ ](${NAME})\\b`, 'g'), groups: { possessor: 1, former: 2, rel: 3, named: 4 } },
  // "my sister is Sarah"
  { re: () => new RegExp(`\\b[Mm]y[ ](?:(${FORMER})[ ])?(${REL_ALT})[ ]is[ ](${NAME})\\b`, 'g'), groups: { possessor: null, former: 1, rel: 2, named: 3 } },
  // "my sister Sarah" / "my former colleague John Smith"
  { re: () => new RegExp(`\\b[Mm]y[ ](?:(${FORMER})[ ])?(${REL_ALT})[,:]?[ ](${NAME})\\b`, 'g'), groups: { possessor: null, former: 1, rel: 2, named: 3 } },
  // "Sarah is my sister"
  { re: () => new RegExp(`\\b(${NAME})[ ]is[ ]my[ ](?:(${FORMER})[ ])?(${REL_ALT})\\b`, 'g'), groups: { named: 1, former: 2, rel: 3, possessor: null } },
  // "Dana (my wife)" — parenthetical apposition, the dominant naming shape
  // in the owner's professional prose and exported LLM chats.
  { re: () => new RegExp(`\\b(${NAME})[ ]\\((?:my|our)[ ](?:(${FORMER})[ ])?(${REL_ALT})\\)`, 'g'), groups: { named: 1, former: 2, rel: 3, possessor: null } },
];

function looksLikeName(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  for (const tok of t.split(/[ ]+/)) {
    if (!/^[A-Z][A-Za-z'’\-]{1,30}$/.test(tok)) return false;
  }
  return true;
}

/**
 * Extract relation statements from one text. Pure function — no DB.
 *
 * @param {string} text
 * @returns {Array<{possessor: string|'self', relWord: string, named: string,
 *   former: boolean, decompose: boolean}>}
 */
export function extractRelationStatements(text) {
  const t = String(text || '');
  if (!t || t.length > 500_000) return [];
  const out = [];
  const seen = new Set();
  for (const pattern of STATEMENT_PATTERNS) {
    const re = pattern.re();
    let m;
    while ((m = re.exec(t)) !== null) {
      const g = pattern.groups;
      const possessor = g.possessor ? m[g.possessor]?.trim() : 'self';
      const named = m[g.named]?.trim();
      const relWord = m[g.rel]?.trim().toLowerCase();
      const former = Boolean(g.former && m[g.former]);
      if (!named || !looksLikeName(named)) continue;
      if (possessor !== 'self' && !looksLikeName(possessor)) continue;
      const edgeEntry = resolveEdgeWord(relWord);
      const isDecompose = Boolean(resolveDecomposeWord(relWord));
      if (!edgeEntry && !isDecompose) continue;
      // Words below bulk-mining precision (miningExcluded — "partner") only
      // count in the interactive lane where the owner confirms live.
      if (edgeEntry?.miningExcluded) continue;
      // Dedup within one text: the same (possessor, rel, named) counts once —
      // two patterns matching the same phrase are not two instances.
      const key = `${possessor.toLowerCase()}|${relWord}|${named.toLowerCase()}|${former ? 1 : 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ possessor, relWord, named, former, decompose: isDecompose });
    }
  }
  return out;
}

// ── Candidate accumulation (clustering + evidence) ───────────────────────────

/**
 * A mining accumulator: collects statement instances across sources, resolves
 * names deterministically (exact-first, ambiguity → question, unresolved →
 * counted), and clusters evidence per (author, subject, rel_type, object).
 */
export function createMiningAccumulator(db, { ownerId }) {
  const clusters = new Map(); // key → cluster
  const counters = { unresolved: 0, ambiguous: 0, decompose: 0 };
  const nameCache = new Map(); // name(lower) → { person } | { error, candidates? }

  function resolveName(name) {
    const key = String(name).toLowerCase();
    if (nameCache.has(key)) return nameCache.get(key);
    const res = resolveSinglePerson(db, name);
    nameCache.set(key, res);
    return res;
  }

  /**
   * Add one statement instance.
   * @param {object} stmt - extractRelationStatements() entry
   * @param {object} ctx - { authorPersonId, authorIsOwner, evidence: {kind, source_id, date}, questionOnly }
   */
  // WRITE-GRADE binding (the live-sweep lesson, research anti-pattern 4):
  // "my husband <FirstName>" fuzzy-bound a single-token first name to the
  // wrong same-first-name contact and a FALSE SPOUSE EDGE reached the graph.
  // A name binds at write grade ONLY when it carries ≥2 tokens AND matches
  // the person's display name (or name identifier) exactly. Anything weaker —
  // single-token names, fuzzy prefix matches — degrades the whole statement
  // to QUESTION-ONLY: the owner's word converts it, never the matcher's.
  function bindingGrade(name, resolved) {
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const tokens = norm(name).split(' ').filter(Boolean);
    if (tokens.length < 2) return 'weak';
    const p = resolved.person;
    return norm(p.display_name) === norm(name) || norm(p.matched_name) === norm(name) ? 'exact' : 'weak';
  }

  function add(stmt, ctx) {
    const named = resolveName(stmt.named);
    if (named.error === 'not_found') { counters.unresolved++; return; }

    // Possessor: 'self' anchors to the author (envelope metadata, Tier 0).
    let possessorId = null;
    let weakBinding = false;
    if (stmt.possessor === 'self') {
      possessorId = ctx.authorPersonId;
      if (!possessorId) { counters.unresolved++; return; }
    } else {
      const possessor = resolveName(stmt.possessor);
      if (possessor.error) { counters.unresolved++; return; }
      possessorId = String(possessor.person.id);
      if (bindingGrade(stmt.possessor, possessor) !== 'exact') weakBinding = true;
    }
    if (!named.error && bindingGrade(stmt.named, named) !== 'exact') weakBinding = true;

    // Ambiguous named person → a disambiguation question (never a write).
    if (named.error === 'ambiguous') {
      counters.ambiguous++;
      if (stmt.decompose) { counters.decompose++; return; }
      const entry = resolveEdgeWord(stmt.relWord);
      const spec = specFor(entry, possessorId, '?');
      enqueueRelationQuestion(db, {
        kind: 'disambiguate',
        subjectPersonId: null,
        objectPersonId: possessorId,
        relType: entry.type,
        questionText: `"${stmt.named}" reads as ${stmt.possessor === 'self' ? 'the author' : stmt.possessor}'s ${stmt.relWord} but matches more than one person (${named.candidates.join(', ')}) — which one?`,
        payload: {
          placeholder: '?',
          spec,
          candidates: named.candidateRows || named.candidates.map((c) => ({ person_id: null, display_name: c })),
        },
        confidence: 0.4,
        priority: 1,
      });
      return;
    }

    const namedId = String(named.person.id);
    if (namedId === String(possessorId)) return; // self-reference noise

    // Composite in-law/step words are never stored — always a question.
    if (stmt.decompose) {
      counters.decompose++;
      const d = resolveDecomposeWord(stmt.relWord);
      enqueueRelationQuestion(db, {
        kind: 'decompose',
        subjectPersonId: namedId,
        objectPersonId: possessorId,
        relType: stmt.relWord,
        questionText: `A message says ${named.person.display_name} is ${stmt.possessor === 'self' ? 'someone\'s' : `${stmt.possessor}'s`} ${stmt.relWord} — which side does that come through? Tell me like "<name> is <spouse>'s sister".`,
        payload: { options: [], gender: d?.gender || null },
        confidence: 0.4,
        priority: 1,
      });
      return;
    }

    const entry = resolveEdgeWord(stmt.relWord);
    const spec = specFor(entry, possessorId, namedId);
    const clusterKey = [ctx.authorPersonId || 'unknown', spec.person_a, spec.person_b, spec.rel_type, stmt.former ? 'former' : 'current'].join('|');
    let cluster = clusters.get(clusterKey);
    if (!cluster) {
      cluster = {
        spec,
        authorPersonId: ctx.authorPersonId || null,
        authorIsOwner: Boolean(ctx.authorIsOwner),
        former: stmt.former,
        genderHint: entry.gender || null,
        speciesHint: entry.species || null,
        namedId,
        namedName: named.person.display_name,
        possessorId,
        relWord: stmt.relWord,
        evidence: new Map(), // `${kind}|${source_id}` → {kind, source_id, date}
        kinds: new Set(),
        questionOnly: Boolean(ctx.questionOnly),
      };
      clusters.set(clusterKey, cluster);
    }
    const evKey = `${ctx.evidence.kind}|${ctx.evidence.source_id}`;
    if (!cluster.evidence.has(evKey)) {
      cluster.evidence.set(evKey, { ...ctx.evidence });
      cluster.kinds.add(ctx.evidence.kind);
    }
    if (ctx.questionOnly) cluster.questionOnly = true;
    if (weakBinding) cluster.questionOnly = true; // below write grade forever
  }

  function specFor(entry, possessorId, namedId) {
    // EDGE_WORDS namedRole: 'a' = the named person holds the marked role
    // relative to the possessor; 'b' = the object role.
    return entry.namedRole === 'b'
      ? { person_a: String(possessorId), person_b: String(namedId), rel_type: entry.type }
      : { person_a: String(namedId), person_b: String(possessorId), rel_type: entry.type };
  }

  /**
   * Apply the write/question policy to every cluster. Returns counts.
   */
  /**
   * A mined OWNER statement that lands an edge also answers any matching OPEN
   * question — the owner already said it in his own words (retroactively), so
   * the queue must not re-ask him (owner-directed auto-resolve). Provenance
   * rides the answer text: source kinds, instance count, statement dates.
   * Conservative kinds only: confirm + cross-anchor (pair-and-type matched);
   * disambiguate/decompose stay with the owner — their answer changes WHICH
   * edge is written.
   */
  function autoResolveMatchingQuestions(spec, evidence) {
    let resolved = 0;
    try {
      const rows = db.prepare(`
        SELECT id, kind FROM relation_questions
        WHERE status IN ('open','asked') AND kind IN ('confirm','cross-anchor')
          AND rel_type = ?
          AND ((subject_person_id = ? AND object_person_id = ?)
            OR (subject_person_id = ? AND object_person_id = ?))
      `).all(spec.rel_type, spec.person_a, spec.person_b, spec.person_b, spec.person_a);
      for (const q of rows) {
        const dates = evidence.map((e) => e.date).filter(Boolean).sort();
        recordQuestionAnswer(db, q.id, {
          status: 'confirmed',
          answer: `auto-resolved: owner-stated in mined corpus (${evidence.length} instance${evidence.length === 1 ? '' : 's'}: ${[...new Set(evidence.map((e) => e.kind))].join(', ')}${dates.length ? `, ${dates[0].slice(0, 10)}…${dates[dates.length - 1].slice(0, 10)}` : ''})`,
        });
        resolved++;
      }
    } catch (err) {
      console.warn('[relation-mine] question auto-resolve failed:', err?.message || err);
    }
    return resolved;
  }

  function flush() {
    const stats = { written: 0, queued: 0, refused: 0, conflicts: 0, auto_resolved: 0, ...counters };
    const owner = ownerId ? String(ownerId) : null;
    for (const c of clusters.values()) {
      const evidence = [...c.evidence.values()];
      const instances = evidence.length;
      const dates = evidence.map((e) => e.date).filter(Boolean).sort();
      const spreadDays = dates.length >= 2
        ? (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86_400_000
        : 0;
      const confidence = Math.min(0.95, 0.5 + 0.1 * instances + (spreadDays > 30 ? 0.1 : 0));
      const statedAt = dates[dates.length - 1] || null;

      const touchesOwner = owner && (c.spec.person_a === owner || c.spec.person_b === owner);
      const notesOnly = c.kinds.size > 0 && [...c.kinds].every((k) => k === 'mining-notes');
      const mustQuestion =
        c.questionOnly                                   // transcripts
        || (touchesOwner && !c.authorIsOwner)            // PYMK rule
        || notesOnly                                     // hard notes guard
        || instances < 2;                                // singleton floor

      if (mustQuestion) {
        // Never ask what an active edge already records — the graph holds
        // the truth; a wrong edge is corrected via the clear path, not by
        // re-confirming it (live lesson: weak-binding "Dana (my wife)"
        // clusters were queueing questions about the recorded spouse).
        const alreadyRecorded = getActivePairEdges(db, c.spec.person_a, c.spec.person_b)
          .some((e) => e.rel_type === c.spec.rel_type);
        if (alreadyRecorded) {
          stats.skipped_known = (stats.skipped_known || 0) + 1;
          continue;
        }
        const q = enqueueRelationQuestion(db, {
          kind: 'confirm',
          subjectPersonId: c.spec.person_a,
          objectPersonId: c.spec.person_b,
          relType: c.spec.rel_type,
          questionText: buildConfirmText(c, owner),
          payload: { spec: c.spec, evidence: evidence.slice(0, 10), former: c.former },
          confidence,
          priority: confidence + (touchesOwner ? 1 : 0),
        });
        if (q.inserted) stats.queued++;
        continue;
      }

      const res = assertRelation(db, {
        personA: c.spec.person_a,
        personB: c.spec.person_b,
        relType: c.spec.rel_type,
      }, {
        authority: c.authorIsOwner ? 'owner' : 'stated',
        source: evidence[0]?.kind || 'mining',
        authorPersonId: c.authorPersonId,
        confidence,
        evidence,
        statedAt,
        validUntil: c.former ? statedAt : undefined,
        ownerId: owner,
      });
      if (['written', 'merged', 'superseded', 'evidence-appended'].includes(res.outcome)) {
        stats.written++;
        if (c.genderHint || c.speciesHint) {
          applyNodeHints(db, c.namedId, { gender: c.genderHint, species: c.speciesHint });
        }
        // Only the OWNER's own words auto-answer his queue — never a third
        // party's statement (the PYMK line holds on questions too).
        if (c.authorIsOwner) {
          stats.auto_resolved += autoResolveMatchingQuestions(c.spec, evidence);
        }
      } else if (res.outcome === 'conflict-queued') {
        stats.conflicts++;
      } else {
        stats.refused++;
      }
    }
    return stats;
  }

  // Question text phrases by STATEMENT roles, not by canonical edge
  // endpoints: relWord names the NAMED person's role relative to the
  // possessor ("my son Kyle" → "Is Kyle your son?"), so the named person is
  // the sentence subject and the possessor takes the possessive — never
  // "Is you …?" (the live grammar bug) and never relWord glued to the wrong
  // endpoint. Names render title-cased.
  function buildConfirmText(c, owner) {
    const name = (id) => {
      try { return titleCaseName(db.prepare('SELECT display_name FROM people WHERE id = ?').get(String(id))?.display_name || 'this person'); } catch { return 'this person'; }
    };
    const rel = c.former ? `former ${c.relWord}` : c.relWord;
    if (String(c.namedId) === owner) return `Are you ${name(c.possessorId)}'s ${rel}?`;
    const possessive = String(c.possessorId) === owner ? 'your' : `${name(c.possessorId)}'s`;
    return `Is ${name(c.namedId)} ${possessive} ${rel}?`;
  }

  return { add, flush, counters };
}
