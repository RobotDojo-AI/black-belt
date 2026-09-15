/**
 * lib/chat/relationship-intent.js — deterministic plain-chat relationship /
 * employer corrections (st_df0a8d71 D4).
 *
 * Follows the proven parseRememberFact shape (lib/chat/memory-intent.js): a
 * pure closed-vocabulary regex parser the route calls on every user message,
 * plus an executor that resolves the named entity and writes through the ONE
 * code-validated write path (lib/people-write.js setRelationTag /
 * setEmployerFact — supersede-archived, provenance 'chat-correction',
 * graph-change event → effective next turn).
 *
 * NO LLM anywhere on this path and no dependency on the disabled tool loop —
 * the write fires deterministically at the route, exactly like "remember X".
 * The old LLM-initiated structured-write path in the context router is
 * DELETED by this story; this module is its replacement, on the right side of
 * the LLM-write boundary.
 *
 * Safety posture: conservative by design. The parser only fires on statement
 * shapes that unambiguously assert a relationship/employer ("Person-A is my
 * wife", "tag Person-B as my brother", "Person-C works at Acme now");
 * questions and out-of-vocabulary relations return null and flow to the model
 * as ordinary conversation. Entity resolution requires exactly ONE
 * unambiguous match — anything else replies asking for the full name and
 * WRITES NOTHING. The failure direction is "ask", never "wrong graph write".
 */

import {
  RELATION_ALIASES,
  resolveRelationAlias,
  resolveRelationWord,
  relationPhrase,
  FAMILY_TAGS,
  EDGE_WORDS,
  resolveEdgeWord,
} from '../relation-vocabulary.js';
import { setRelationTag, setEmployerFact, refreshDerivedRelationCache } from '../people-write.js';
import { assertRelation, applyNodeHints } from '../relation-store.js';
import { searchMeaningfulEntities } from '../network-queries.js';

// Relation alternation: every alias in the closed vocabulary, longest-first so
// "mother-in-law" wins over "mother". Case-insensitive at match time.
const RELATION_ALT = Object.keys(RELATION_ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/-/g, '\\-'))
  .join('|');

// A person name: 1–4 capitalized tokens (same conservative shape as
// lib/family-from-content.js). Post-validated by looksLikeName because the
// `i` flag on the outer regex would otherwise let lowercase noise through.
const NAME = `[A-Z][A-Za-z'’\\-]{1,30}(?:[ ][A-Z][A-Za-z'’\\-]{1,30}){0,3}`;

// A company name: 1–6 tokens, letters/digits/&.'- allowed (companies are not
// case-shaped like person names — "xAI", "23andMe").
const COMPANY = `[A-Za-z0-9][A-Za-z0-9&.'’\\-]*(?:[ ][A-Za-z0-9&.'’\\-]+){0,5}`;

const TRAILING = `[.!]?\\s*$`;

// Statement shapes. Each captures (name, relation) or (name, company).
const RELATION_PATTERNS = [
  // "Person-A is my wife" / "correction: Person-A is our dog, not my cat"
  new RegExp(`^(?:correction:?[ ]+)?(${NAME})[ ]+is[ ]+(?:my|our)[ ]+(${RELATION_ALT})\\b(?:[ ]*,?[ ]*not[ ]+(?:my|our)[ ]+[\\w\\-]+)?${TRAILING}`, 'i'),
  // "my mother-in-law is Person-B" / "actually my brother is Person-C"
  new RegExp(`^(?:correction:?[ ]+|actually[ ,]+)?my[ ]+(${RELATION_ALT})[ ]+is[ ]+(${NAME})${TRAILING}`, 'i'),
  // "tag Person-C as my brother" / "set Person-D as our dog"
  new RegExp(`^(?:please[ ]+)?(?:tag|mark|set|record)[ ]+(${NAME})[ ]+as[ ]+(?:my|our)[ ]+(${RELATION_ALT})${TRAILING}`, 'i'),
];
// Which capture group holds the name per pattern above (1-indexed).
const RELATION_NAME_GROUP = [1, 2, 1];
const RELATION_REL_GROUP = [2, 1, 2];

// st_f67bc2eb AC-4/AC-5 — THIRD-PERSON possessive statements ("Dana's
// cousin is Tess", "Tess is Dana's cousin"). Speaker-relative anchoring:
// the owner typed it, so it is owner-authority evidence about the edge
// BETWEEN THE TWO NAMED PEOPLE — storable only under the person-to-person
// remodel. Closed vocabulary (EDGE_WORDS: storable atomic types only —
// composite in-law words flow to the model, never a silent write).
const EDGE_WORD_ALT = Object.keys(EDGE_WORDS)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/-/g, '\\-'))
  .join('|');

const THIRD_PERSON_PATTERNS = [
  // "Dana's cousin is Tess" / "correction: Dana's mom is Carol"
  new RegExp(`^(?:correction:?[ ]+)?(${NAME})['’]s[ ]+(${EDGE_WORD_ALT})[ ]+is[ ]+(${NAME})${TRAILING}`, 'i'),
  // "Tess is Dana's cousin"
  new RegExp(`^(?:correction:?[ ]+)?(${NAME})[ ]+is[ ]+(${NAME})['’]s[ ]+(${EDGE_WORD_ALT})${TRAILING}`, 'i'),
];
// (possessor, relation, named) capture groups per pattern above (1-indexed).
const THIRD_PERSON_GROUPS = [
  { possessor: 1, rel: 2, named: 3 },
  { possessor: 2, rel: 3, named: 1 },
];

const EMPLOYER_PATTERNS = [
  // "Person-A works at Acme now" / "Person-A now works at Acme"
  new RegExp(`^(?:correction:?[ ]+)?(${NAME})[ ]+(?:now[ ]+)?works[ ]+at[ ]+(${COMPANY})(?:[ ]+now)?${TRAILING}`, 'i'),
  // "Person-A joined Acme" / "Person-A moved to Acme"
  new RegExp(`^(?:correction:?[ ]+)?(${NAME})[ ]+(?:joined|moved[ ]+to)[ ]+(${COMPANY})${TRAILING}`, 'i'),
  // "Person-A left OldCo for NewCo" / "… and joined NewCo" — the NEW employer
  // is the write; a bare "left X" (no destination) is deliberately unsupported
  // (no deterministic new value to record) and flows to the model.
  new RegExp(`^(?:correction:?[ ]+)?(${NAME})[ ]+left[ ]+${COMPANY}[ ]+(?:for|and[ ]+joined)[ ]+(${COMPANY})${TRAILING}`, 'i'),
];

function looksLikeName(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  for (const tok of t.split(/[ ]+/)) {
    if (!/^[A-Z][A-Za-z'’\-]{1,30}$/.test(tok)) return false;
  }
  return true;
}

function cleanCompany(raw) {
  let c = String(raw || '').trim().replace(/[.!,]+$/, '').trim();
  // The greedy company capture can swallow a trailing "now" ("works at Acme
  // now") — strip it; "now" is never the last word of a company name we
  // should trust from a correction.
  c = c.replace(/\s+now$/i, '').trim();
  if (!c || c.length > 80) return null;
  if (!/[A-Za-z]/.test(c)) return null;
  return c;
}

/**
 * Parse a chat message as a relationship/employer correction.
 *
 * @param {string} input - the raw user message
 * @returns {null
 *   | { kind: 'relation', name: string, alias: string, tag: string, label: string|null }
 *   | { kind: 'employer', name: string, company: string }}
 */
export function parseRelationshipCorrection(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  // Questions are never corrections ("is Person-A my cousin?").
  if (/[?？]\s*$/.test(text)) return null;
  if (/^(?:is|are|was|were|do|does|did|who|what|when|where|why|how|can|could|would|will|should)\b/i.test(text)) {
    return null;
  }

  for (let i = 0; i < RELATION_PATTERNS.length; i++) {
    const m = text.match(RELATION_PATTERNS[i]);
    if (!m) continue;
    const name = m[RELATION_NAME_GROUP[i]]?.trim();
    const alias = m[RELATION_REL_GROUP[i]]?.trim().toLowerCase();
    if (!looksLikeName(name)) continue;
    const resolved = resolveRelationAlias(alias);
    if (!resolved) continue;
    return { kind: 'relation', name, alias, tag: resolved.tag, label: resolved.label || null };
  }

  // Third-person possessive AFTER the owner-anchored shapes so "my …" always
  // wins; a possessive whose relation word is outside the storable edge
  // vocabulary never matches (flows to the model — ask, never wrong write).
  for (let i = 0; i < THIRD_PERSON_PATTERNS.length; i++) {
    const m = text.match(THIRD_PERSON_PATTERNS[i]);
    if (!m) continue;
    const g = THIRD_PERSON_GROUPS[i];
    const possessor = m[g.possessor]?.trim();
    const named = m[g.named]?.trim();
    const relWord = m[g.rel]?.trim().toLowerCase();
    if (!looksLikeName(possessor) || !looksLikeName(named)) continue;
    const entry = resolveEdgeWord(relWord);
    if (!entry) continue;
    return { kind: 'relation3p', possessor, name: named, relWord, edge: entry };
  }

  for (const pattern of EMPLOYER_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    const name = m[1]?.trim();
    const company = cleanCompany(m[2]);
    if (!looksLikeName(name) || !company) continue;
    return { kind: 'employer', name, company };
  }

  return null;
}

/**
 * Resolve the named person to exactly one graph row. Resolution rides the
 * existing exact-first matcher (searchMeaningfulEntities — the same bounded
 * matcher the chat entity layers use); un-merged duplicate rows sharing one
 * display name collapse to the best-ranked row (the matcher's own ordering),
 * mirroring resolveEntitiesFromText's same-name dedup.
 *
 * @returns {{ person: object }|{ error: 'not_found'|'ambiguous', candidates?: string[] }}
 */
export function resolveSinglePerson(db, name) {
  let rows = [];
  try {
    rows = searchMeaningfulEntities(db, name, 10).filter((r) => r.type === 'person');
  } catch {
    rows = [];
  }
  if (!rows.length) return { error: 'not_found' };

  const norm = (s) => String(s || '').trim().toLowerCase();
  const exact = rows.filter(
    (r) => norm(r.display_name) === norm(name) || norm(r.matched_name) === norm(name),
  );
  const pool = exact.length ? exact : rows;

  // Collapse duplicate rows that share a display name (dedup is owned by the
  // ingest pipeline; the matcher orders best-first).
  const distinctNames = [...new Set(pool.map((r) => norm(r.display_name)))];
  if (distinctNames.length > 1) {
    return {
      error: 'ambiguous',
      candidates: pool.slice(0, 4).map((r) => r.display_name),
      // id-bearing rows for callers that need to build an answerable
      // disambiguation question (the mining sweep) — additive, existing
      // callers keep reading `candidates`.
      candidateRows: pool.slice(0, 4).map((r) => ({ person_id: String(r.id), display_name: r.display_name })),
    };
  }
  return { person: pool[0] };
}

/**
 * Execute a parsed correction against the graph. Never throws — returns a
 * user-facing message either way, and writes ONLY on an unambiguous match.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{kind: string}} correction - parseRelationshipCorrection() output
 * @returns {{ ok: boolean, wrote: boolean, message: string, person?: object }}
 */
export function executeRelationshipCorrection(db, correction) {
  if (!correction) return { ok: false, wrote: false, message: 'Nothing to record.' };

  const resolved = resolveSinglePerson(db, correction.name);
  if (resolved.error === 'not_found') {
    return {
      ok: false,
      wrote: false,
      message: `I could not find "${correction.name}" in your entity graph, so I did not record anything. Give me the full name as it appears in your network and I will record it.`,
    };
  }
  if (resolved.error === 'ambiguous') {
    return {
      ok: false,
      wrote: false,
      message: `"${correction.name}" matches more than one person (${resolved.candidates.join(', ')}), so I did not record anything. Give me the full name and I will record it.`,
    };
  }

  const person = resolved.person;
  try {
    if (correction.kind === 'relation') {
      const updated = setRelationTag(db, person.id, correction.tag, correction.label, { source: 'chat-correction' });
      if (!updated) {
        return { ok: false, wrote: false, message: `I could not update ${person.display_name} — the record was not found.` };
      }
      // st_f67bc2eb D3 — composite tags (in-law, generic family) are never
      // stored; when the graph cannot decompose them deterministically the
      // adapter queues a one-line question instead of writing. Say so — an
      // honest "queued" beats a false "recorded".
      if (!updated.relation_tag) {
        return {
          ok: true,
          wrote: false,
          message: `That relation depends on who it comes through, and your graph does not disambiguate it yet — I queued a one-line question so one word from you anchors it exactly. Nothing was guessed.`,
          person: { id: updated.id, display_name: updated.display_name, relation_tag: null, relation_label: null },
        };
      }
      const phrase = updated.relation_derived_phrase || relationPhrase(updated.relation_tag, updated.relation_label);
      return {
        ok: true,
        wrote: true,
        message: `Recorded: ${updated.display_name} is your ${phrase}. This takes effect from your next message; the previous value is archived, not overwritten.`,
        person: { id: updated.id, display_name: updated.display_name, relation_tag: updated.relation_tag, relation_label: updated.relation_label || null },
      };
    }
    if (correction.kind === 'relation3p') {
      // Resolve the possessor too — both endpoints must be unambiguous or
      // nothing is written (ask, never wrong graph write).
      const possessorResolved = resolveSinglePerson(db, correction.possessor);
      if (possessorResolved.error === 'not_found') {
        return { ok: false, wrote: false, message: `I could not find "${correction.possessor}" in your entity graph, so I did not record anything. Give me the full name as it appears in your network and I will record it.` };
      }
      if (possessorResolved.error === 'ambiguous') {
        return { ok: false, wrote: false, message: `"${correction.possessor}" matches more than one person (${possessorResolved.candidates.join(', ')}), so I did not record anything. Give me the full name and I will record it.` };
      }
      const possessor = possessorResolved.person;
      if (String(possessor.id) === String(person.id)) {
        return { ok: false, wrote: false, message: 'Those resolve to the same person, so I did not record anything.' };
      }
      const { edge } = correction;
      // EDGE_WORDS namedRole: 'a' = the NAMED person holds the marked role
      // relative to the possessor ("Dana's mother X": X parent-of Dana);
      // 'b' = the object role ("Dana's son X": Dana parent-of X).
      const spec = edge.namedRole === 'b'
        ? { personA: possessor.id, personB: person.id, relType: edge.type }
        : { personA: person.id, personB: possessor.id, relType: edge.type };
      const res = assertRelation(db, spec, {
        authority: 'owner',
        source: 'chat-correction',
        statedAt: new Date().toISOString(),
        evidence: [{ kind: 'chat-correction', source_id: `stmt:${Date.now()}` }],
      });
      if (edge.gender || edge.species) {
        applyNodeHints(db, person.id, { gender: edge.gender || null, species: edge.species || null });
      }
      if (res.outcome === 'conflict-queued') {
        return { ok: true, wrote: false, message: `That conflicts with what is already on record for ${person.display_name} and ${possessor.display_name} — I queued a one-line question instead of overwriting. Nothing was changed.` };
      }
      if (res.refused) {
        return { ok: false, wrote: false, message: `I could not record that: ${res.why || res.outcome}.` };
      }
      refreshDerivedRelationCache(db);
      return {
        ok: true,
        wrote: true,
        message: `Recorded: ${person.display_name} is ${possessor.display_name}'s ${correction.relWord}. Your own view derives from the graph; the previous value is archived, not overwritten.`,
        person: { id: person.id, display_name: person.display_name },
      };
    }
    if (correction.kind === 'employer') {
      const result = setEmployerFact(db, person.id, correction.company, { source: 'chat-correction' });
      if (!result) {
        return { ok: false, wrote: false, message: `I could not update ${person.display_name} — the record was not found.` };
      }
      return {
        ok: true,
        wrote: true,
        message: `Recorded: ${result.person.display_name} works at ${result.company.name}. This takes effect from your next message; the previous value is archived, not overwritten.`,
        person: { id: result.person.id, display_name: result.person.display_name, employer: result.company.name },
      };
    }
  } catch (err) {
    // Validation errors (bad label/tag combos) surface as an honest reply —
    // never a silent drop, never a partial write (setRelationTag validates
    // before any UPDATE).
    return { ok: false, wrote: false, message: `I could not record that: ${err.message}` };
  }
  return { ok: false, wrote: false, message: 'Nothing to record.' };
}

// ── Reverse-direction relationship questions (st_df0a8d71 QA fix) ────────────
// "Who is my mother-in-law?" must answer FROM THE GRAPH, deterministically,
// BEFORE any entity-card path can fire. The live QA failure: the question's
// "law" fragment entity-matched an unrelated contact's surname and the
// direct-entity path served that profile card as the answer. Same closed
// vocabulary and conservative posture as the correction parser: a question
// outside the vocabulary parses to null and flows to the model.

// Relation words (aliases already include every label) with an optional
// plural `s` ("cousins"); irregular plurals ("children") are listed in the
// pattern and resolved inside resolveRelationWord.
const RELATION_QUESTION_WORD = `(?:${RELATION_ALT})s?|children|wives`;

const RELATION_QUESTION_PATTERNS = [
  // "Who is my mother-in-law?" / "who's my wife" / "Who are my cousins?"
  new RegExp(`^(?:ok[,\\s]+|so[,\\s]+)?who(?:['\u2019]s|\\s+is|\\s+are)\\s+my\\s+(${RELATION_QUESTION_WORD})\\s*[?.!]*$`, 'i'),
  // "What is my mother-in-law's name?" / "what's my cousins' names"
  new RegExp(`^what(?:['\u2019]s|\\s+is|\\s+are)\\s+my\\s+(${RELATION_QUESTION_WORD})(?:['\u2019]s?)?\\s+names?\\s*[?.!]*$`, 'i'),
  // "Tell me who my mother-in-law is"
  new RegExp(`^tell\\s+me\\s+who\\s+my\\s+(${RELATION_QUESTION_WORD})\\s+(?:is|are)\\s*[.!]*$`, 'i'),
];

// st_f67bc2eb \u2014 FORWARD per-person relationship questions ("What is my
// relationship to <Name>?"). Pre-remodel these flowed to the model, which
// narrates from injected card prose \u2014 the exact two-truths leak the quiz
// caught live (a regenerated card's narrative outweighed the ego block).
// Deterministic rule: when the resolved person carries graph truth
// (relation_tag), the graph answers \u2014 derived phrase first; when they carry
// none, matched:'flow' lets the ordinary card/context answer proceed.
const FORWARD_RELATION_PATTERNS = [
  new RegExp(`^what(?:['\u2019]s|\\s+is)\\s+my\\s+relationship\\s+(?:to|with)\\s+(${NAME})\\s*[?.!]*$`, 'i'),
  new RegExp(`^how\\s+(?:am\\s+i|are\\s+we)\\s+related\\s+to\\s+(${NAME})\\s*[?.!]*$`, 'i'),
];

// st_f67bc2eb AC-2/AC-9 \u2014 DERIVED-PATH reverse questions ("Who is my wife's
// cousin?"). The chain of possessive relation words mirrors the walker's
// derived phrase exactly ("wife's cousin"), so the answer is a deterministic
// column match against relation_derived_phrase \u2014 graph truth, never a card.
const DERIVED_PATH_PATTERNS = [
  new RegExp(`^(?:ok[,\\s]+|so[,\\s]+)?who(?:['\u2019]s|\\s+is|\\s+are)\\s+my\\s+((?:${RELATION_ALT})(?:['\u2019]s\\s+(?:${RELATION_ALT}))+)s?\\s*[?.!]*$`, 'i'),
  new RegExp(`^tell\\s+me\\s+who\\s+my\\s+((?:${RELATION_ALT})(?:['\u2019]s\\s+(?:${RELATION_ALT}))+)\\s+(?:is|are)\\s*[.!]*$`, 'i'),
];

/** Normalize a derived phrase for matching (unicode apostrophes, spacing). */
function normalizeDerivedPhrase(raw) {
  return String(raw || '').toLowerCase().replace(/[\u2019]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * Parse a reverse-direction relationship question.
 *
 * @param {string} input
 * @returns {null | { tag: string, label: string|null, plural: boolean, word: string }
 *   | { derivedPhrase: string, word: string }}
 */
export function parseRelationshipQuestion(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  // Forward per-person shape first \u2014 the deterministic graph lane owns
  // "what is my relationship to <Name>" whenever graph truth exists.
  for (const pattern of FORWARD_RELATION_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    const name = m[1].trim();
    if (looksLikeName(name)) return { personName: name, word: name };
  }
  // Multi-hop possessive chains next \u2014 "my wife's cousin" must not tokenize
  // as a bare "cousin" question (which would answer with the wrong side).
  for (const pattern of DERIVED_PATH_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    const phrase = normalizeDerivedPhrase(m[1]);
    return { derivedPhrase: phrase, word: phrase };
  }
  for (const pattern of RELATION_QUESTION_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    const word = m[1].trim().toLowerCase();
    const resolved = resolveRelationWord(word);
    if (!resolved || !FAMILY_TAGS.has(resolved.tag)) continue;
    return { tag: resolved.tag, label: resolved.label || null, plural: Boolean(resolved.plural), word };
  }
  return null;
}

/**
 * Answer a parsed relationship question deterministically from the graph.
 * ALWAYS returns an answer for a parsed question — either the graph rows or
 * the canonical abstention (AC-6): a parsed relation question never falls
 * through to a card or the model, by construction.
 *
 * Resolution: exact label rows first (the gendered truth); when the label is
 * not recorded, fall back to the label's TAG class and say so honestly (a
 * NULL-label parent-in-law row still answers "Who is my mother-in-law?" with
 * the person's name, plus how to record the gendered detail).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{tag: string, label: string|null, plural: boolean}} question
 * @returns {{ text: string, matched: 'label'|'tag'|'none' }}
 */
export function answerRelationshipQuestion(db, question) {
  // Forward per-person questions: graph truth answers when it exists —
  // derived phrase first ("wife's cousin"), never a card narrative; a person
  // with NO graph relationship returns matched:'flow' and the callers fall
  // through so ordinary contacts keep the rich card/context answer.
  if (question.personName) {
    const resolved = resolveSinglePerson(db, question.personName);
    if (resolved.error) return { text: null, matched: 'flow' };
    const row = db.prepare('SELECT id, display_name, relation_tag, relation_label, relation_derived_phrase FROM people WHERE id = ?')
      .get(String(resolved.person.id));
    if (!row?.relation_tag) return { text: null, matched: 'flow' };
    const phrase = row.relation_derived_phrase || relationPhrase(row.relation_tag, row.relation_label);
    return { text: `${row.display_name} is your ${phrase} — from your entity graph, which is authoritative for who-is-who.`, matched: 'forward' };
  }

  // Derived-path questions ("who is my wife's cousin") answer from the
  // walker-maintained derived phrase — exact column match, deterministic.
  if (question.derivedPhrase) {
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT id, display_name, relation_derived_phrase
        FROM people
        WHERE relation_derived_phrase IS NOT NULL AND COALESCE(archived, 0) = 0
        ORDER BY display_name COLLATE NOCASE ASC
      `).all().filter((r) => normalizeDerivedPhrase(r.relation_derived_phrase) === question.derivedPhrase);
    } catch { rows = []; }
    if (rows.length) {
      const names = rows.map((r) => r.display_name);
      const text = names.length === 1
        ? `Your ${question.derivedPhrase} on record is ${names[0]}.`
        : `On record as your ${question.derivedPhrase}: ${names.join(', ')}.`;
      return { text, matched: 'derived' };
    }
    return {
      text: 'I do not have that on record. Want me to take a deeper look, or you can tell me — e.g. "<full name> is <person>\'s cousin" — and I will record it.',
      matched: 'none',
    };
  }

  const { tag, label } = question;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, display_name, relation_tag, relation_label, relation_derived_phrase
      FROM people
      WHERE relation_tag = ? AND COALESCE(archived, 0) = 0
      ORDER BY display_name COLLATE NOCASE ASC
    `).all(tag);
  } catch { rows = []; }

  const labelRows = label ? rows.filter((r) => String(r.relation_label || '').toLowerCase() === label) : [];
  const phrase = relationPhrase(tag, label);

  if (labelRows.length) {
    const names = labelRows.map((r) => r.display_name);
    const text = names.length === 1
      ? `Your ${phrase} on record is ${names[0]}.`
      : `On record as your ${phrase}: ${names.join(', ')}.`;
    return { text, matched: 'label' };
  }

  if (rows.length) {
    const tagPhrase = relationPhrase(tag, null);
    const names = rows.map((r) => {
      // st_f67bc2eb — the walk-derived phrase outranks the raw tag wherever a
      // person's relationship to the owner is phrased (reader-precedence
      // rule): an IL-tagged wife-side cousin reads "(wife's cousin)", never a
      // bare coarse tag word.
      const rowPhrase = r.relation_derived_phrase || relationPhrase(r.relation_tag, r.relation_label);
      return (r.relation_label || r.relation_derived_phrase) ? `${r.display_name} (${rowPhrase})` : r.display_name;
    });
    let text = names.length === 1
      ? `On record: ${names[0]} — your ${tagPhrase}.`
      : `On record as your ${tagPhrase}${names.length > 1 ? 's' : ''}: ${names.join(', ')}.`;
    if (label) {
      // The gendered detail was asked for but is not recorded — say so and
      // name the correction path (which records it in one message).
      text += ` I do not have the ${label} vs other-${tagPhrase} detail recorded — tell me "<full name> is my ${label}" and I will record it.`;
    }
    return { text, matched: 'tag' };
  }

  return {
    text: 'I do not have that on record. Want me to take a deeper look, or you can tell me — e.g. "<full name> is my ' + (label || relationPhrase(tag, null)) + '" — and I will record it.',
    matched: 'none',
  };
}