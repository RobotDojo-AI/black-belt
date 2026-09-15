/**
 * lib/relation-vocabulary.js — the single closed relationship vocabulary
 * (st_df0a8d71 D1/D2).
 *
 * WHY one module: before this story, three separate tables described family
 * relationships — scoring's FAMILY_TAGS (the structural class), the
 * family-from-content alias regex table, and whatever prose an LLM card
 * invented. The defect this story closes came from that split: the graph said
 * "spouse" while the injected card said "cohabitating partner". This module is
 * now the single source both writers (setRelationTag, family-from-content,
 * the chat correction parser) and renderers (ego render, entity enrichment,
 * card generator) import. Extending the vocabulary is a code change here —
 * never a string that appears in one consumer only.
 *
 * Two layers, deliberately distinct:
 *
 *   TAG   — the structural CLASS stored in people.relation_tag. Closed set
 *           owned by lib/scoring.js FAMILY_TAGS (spouse, parent, sibling,
 *           child, parent-in-law, sibling-in-law, niece-nephew, grandparent,
 *           family, IL, cousin, pet). Every existing consumer keys on it.
 *   LABEL — the gendered/granular SUB-LABEL stored in people.relation_label
 *           (mother vs father, wife vs husband, …). New in this story;
 *           nullable — a NULL label renders as its tag.
 *
 * The tag can never be derived FROM prose at render time; the label can never
 * contradict its tag (assertValidLabelForTag throws on mismatch — writers are
 * code-validated by construction).
 */

// ── The structural tag set (canonical home) ──────────────────────────────────
// FAMILY_TAGS lives HERE (a pure, db-free module) and lib/scoring.js
// re-exports it for its existing consumers. WHY the move: scoring.js imports
// lib/db.js at module load; the ego renderer (which rides the prompt-assembly
// import graph that lint gates and tests also import) needs this set, and
// pulling it through scoring would open the live encrypted DB as an import
// side effect in every one of those consumers. The vocabulary module is the
// single closed home for relationship words — tags included.
// st_df0a8d71 D2 — 'pet' is a first-class family tag: pets are people rows
// tagged relation_tag='pet' (one vocabulary, no parallel pet store).
export const FAMILY_TAGS = new Set([
  'spouse', 'parent', 'sibling', 'child', 'parent-in-law', 'sibling-in-law',
  'niece-nephew', 'grandparent', 'family', 'IL', 'cousin', 'pet',
]);

// ── The closed label vocabulary (D1) ─────────────────────────────────────────
// label → { tag: structural class, class: blood|in-law|spouse|pet }
//
// WHY the `class` field: AC-4 requires in-law vs blood to stay STRUCTURALLY
// distinct. The tag already encodes that (parent vs parent-in-law); `class` is
// the derived metadata consumers (consistency gate, quiz) use to compare a
// prose claim against the graph at class level. D1 named blood|in-law|pet;
// spouse is a fourth value because marriage is neither blood nor in-law —
// collapsing it into either would let the gate mis-class a spouse claim.
export const RELATION_LABELS = Object.freeze({
  mother:           Object.freeze({ tag: 'parent',         class: 'blood' }),
  father:           Object.freeze({ tag: 'parent',         class: 'blood' }),
  son:              Object.freeze({ tag: 'child',          class: 'blood' }),
  daughter:         Object.freeze({ tag: 'child',          class: 'blood' }),
  'mother-in-law':  Object.freeze({ tag: 'parent-in-law',  class: 'in-law' }),
  'father-in-law':  Object.freeze({ tag: 'parent-in-law',  class: 'in-law' }),
  sister:           Object.freeze({ tag: 'sibling',        class: 'blood' }),
  brother:          Object.freeze({ tag: 'sibling',        class: 'blood' }),
  'sister-in-law':  Object.freeze({ tag: 'sibling-in-law', class: 'in-law' }),
  'brother-in-law': Object.freeze({ tag: 'sibling-in-law', class: 'in-law' }),
  grandmother:      Object.freeze({ tag: 'grandparent',    class: 'blood' }),
  grandfather:      Object.freeze({ tag: 'grandparent',    class: 'blood' }),
  wife:             Object.freeze({ tag: 'spouse',         class: 'spouse' }),
  husband:          Object.freeze({ tag: 'spouse',         class: 'spouse' }),
  cousin:           Object.freeze({ tag: 'cousin',         class: 'blood' }),
  // D2 — species labels under the pet tag so "our dog Biscuit" renders as
  // "Dog: Biscuit" instead of the generic "Pet:". Closed set; extending it is
  // a code change here, never a free-text species column.
  pet:              Object.freeze({ tag: 'pet',            class: 'pet' }),
  dog:              Object.freeze({ tag: 'pet',            class: 'pet' }),
  cat:              Object.freeze({ tag: 'pet',            class: 'pet' }),
});

// ── Aliases (how people actually write relations) ────────────────────────────
// alias → { tag, label|null }. Gendered nicknames resolve to a canonical
// label; genderless words (spouse, sibling, parent, kid) resolve to a tag with
// label null — the renderer then falls back to the tag word. This is the table
// lib/family-from-content.js derives its DIRECT_RELATION map from (single
// source: adding an alias here makes both the content scanner and the chat
// correction parser understand it).
export const RELATION_ALIASES = Object.freeze({
  // parent
  mom: { tag: 'parent', label: 'mother' },
  mommy: { tag: 'parent', label: 'mother' },
  ma: { tag: 'parent', label: 'mother' },
  mama: { tag: 'parent', label: 'mother' },
  mother: { tag: 'parent', label: 'mother' },
  dad: { tag: 'parent', label: 'father' },
  daddy: { tag: 'parent', label: 'father' },
  pa: { tag: 'parent', label: 'father' },
  papa: { tag: 'parent', label: 'father' },
  father: { tag: 'parent', label: 'father' },
  parent: { tag: 'parent', label: null },
  // spouse
  wife: { tag: 'spouse', label: 'wife' },
  husband: { tag: 'spouse', label: 'husband' },
  spouse: { tag: 'spouse', label: null },
  partner: { tag: 'spouse', label: null },
  // sibling
  sister: { tag: 'sibling', label: 'sister' },
  sis: { tag: 'sibling', label: 'sister' },
  brother: { tag: 'sibling', label: 'brother' },
  bro: { tag: 'sibling', label: 'brother' },
  sibling: { tag: 'sibling', label: null },
  // child
  son: { tag: 'child', label: 'son' },
  daughter: { tag: 'child', label: 'daughter' },
  child: { tag: 'child', label: null },
  kid: { tag: 'child', label: null },
  // grandparent
  grandma: { tag: 'grandparent', label: 'grandmother' },
  grandmother: { tag: 'grandparent', label: 'grandmother' },
  granny: { tag: 'grandparent', label: 'grandmother' },
  gran: { tag: 'grandparent', label: 'grandmother' },
  nana: { tag: 'grandparent', label: 'grandmother' },
  gigi: { tag: 'grandparent', label: 'grandmother' },
  nonna: { tag: 'grandparent', label: 'grandmother' },
  grandpa: { tag: 'grandparent', label: 'grandfather' },
  grandfather: { tag: 'grandparent', label: 'grandfather' },
  nonno: { tag: 'grandparent', label: 'grandfather' },
  grandparent: { tag: 'grandparent', label: null },
  // in-laws
  'mother-in-law': { tag: 'parent-in-law', label: 'mother-in-law' },
  mil: { tag: 'parent-in-law', label: 'mother-in-law' },
  'father-in-law': { tag: 'parent-in-law', label: 'father-in-law' },
  fil: { tag: 'parent-in-law', label: 'father-in-law' },
  'sister-in-law': { tag: 'sibling-in-law', label: 'sister-in-law' },
  sil: { tag: 'sibling-in-law', label: 'sister-in-law' },
  'brother-in-law': { tag: 'sibling-in-law', label: 'brother-in-law' },
  bil: { tag: 'sibling-in-law', label: 'brother-in-law' },
  // cousin
  cousin: { tag: 'cousin', label: 'cousin' },
  // pets (D2 — pets are people rows tagged relation_tag='pet'; the species
  // rides relation_label from the closed label set above)
  pet: { tag: 'pet', label: 'pet' },
  dog: { tag: 'pet', label: 'dog' },
  cat: { tag: 'pet', label: 'cat' },
  puppy: { tag: 'pet', label: 'dog' },
  kitten: { tag: 'pet', label: 'cat' },
});

// Tag → plain-English phrase for NULL-label rendering ("Parent: X" when we
// don't know mother vs father). Covers every FAMILY_TAGS member.
const TAG_PHRASES = Object.freeze({
  spouse: 'spouse',
  parent: 'parent',
  sibling: 'sibling',
  child: 'child',
  'parent-in-law': 'parent-in-law',
  'sibling-in-law': 'sibling-in-law',
  'niece-nephew': 'niece or nephew',
  grandparent: 'grandparent',
  family: 'family member',
  IL: 'in-law',
  cousin: 'cousin',
  pet: 'pet',
});

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

/** Vocabulary entry for a canonical label, or null. */
export function labelInfo(label) {
  return RELATION_LABELS[normalize(label)] || null;
}

/** Resolve any alias/label word to { tag, label|null }, or null when unknown. */
export function resolveRelationAlias(word) {
  const key = normalize(word);
  if (RELATION_ALIASES[key]) return RELATION_ALIASES[key];
  const info = RELATION_LABELS[key];
  return info ? { tag: info.tag, label: key } : null;
}

/** All canonical labels for a structural tag. */
export function labelsForTag(tag) {
  const t = normalize(tag);
  return Object.entries(RELATION_LABELS)
    .filter(([, info]) => info.tag === t)
    .map(([label]) => label);
}

/**
 * The render phrase for (tag, label): the gendered label when present, else
 * the tag's plain-English phrase. Never returns '' for a valid tag.
 */
export function relationPhrase(tag, label = null) {
  const l = normalize(label);
  if (l && RELATION_LABELS[l]) return l;
  return TAG_PHRASES[String(tag || '').trim()] || normalize(tag);
}

/**
 * Throw when a non-null label does not belong to `tag`. This is the write-side
 * validation every relationship writer runs — a "mother" label can never land
 * on a parent-in-law row.
 */
export function assertValidLabelForTag(tag, label) {
  if (label === null || label === undefined || label === '') return;
  const info = labelInfo(label);
  if (!info) {
    throw new Error(
      `invalid relation_label: ${label}; must be one of: ${Object.keys(RELATION_LABELS).join(', ')}`,
    );
  }
  if (info.tag !== String(tag || '').trim()) {
    throw new Error(
      `relation_label "${label}" belongs to tag "${info.tag}", not "${tag}"`,
    );
  }
}

/** Structural class ('blood'|'in-law'|'spouse'|'pet') for a label, or null. */
export function labelClass(label) {
  return labelInfo(label)?.class || null;
}

// ── Relation words as text tokens ─────────────────────────────────────────────
// Every closed-vocabulary relation word (labels + aliases), longest-first so
// hyphenated forms win ("mother-in-law" strips as ONE word before its parts
// could tokenize into "mother"/"law"). QA repro that mandated this: in the
// real UI, "Who is my mother-in-law?" tokenized to a bare "law" span, which
// entity-matched an unrelated contact's surname and served that profile card
// as the answer. A relation-vocabulary word must NEVER be an entity-match
// token.
const ALL_RELATION_WORDS = [...new Set([
  ...Object.keys(RELATION_LABELS),
  ...Object.keys(RELATION_ALIASES),
])].sort((a, b) => b.length - a.length);

// Irregular plurals the singular+`s` rule misses.
const RELATION_PLURAL_IRREGULARS = { children: 'child', wives: 'wife' };

/**
 * Regex matching any closed-vocabulary relation word (optionally pluralized)
 * as a whole word. Global + case-insensitive. Callers strip matches from text
 * BEFORE entity-span discovery so relation words can never become entity
 * tokens; a fresh regex per call would be identical, so the shared instance
 * is safe as long as callers use String.replace (which resets lastIndex).
 */
export const RELATION_WORD_STRIP_RE = new RegExp(
  `\\b(?:${[...ALL_RELATION_WORDS.map((w) => w.replace(/-/g, '\\-')), ...Object.keys(RELATION_PLURAL_IRREGULARS)].join('|')})(?:s)?\\b`,
  'gi',
);

/**
 * Resolve a possibly-pluralized relation word ("cousins", "children") to
 * { tag, label|null, plural }, or null when outside the closed vocabulary.
 * Used by the reverse-question parser ("Who are my cousins?").
 */
export function resolveRelationWord(word) {
  const w = normalize(word);
  if (RELATION_PLURAL_IRREGULARS[w]) {
    const resolved = resolveRelationAlias(RELATION_PLURAL_IRREGULARS[w]);
    return resolved ? { ...resolved, plural: true } : null;
  }
  const direct = resolveRelationAlias(w);
  if (direct) return { ...direct, plural: false };
  if (w.endsWith('s')) {
    const singular = resolveRelationAlias(w.slice(0, -1));
    if (singular) return { ...singular, plural: true };
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Person-to-person EDGE vocabulary (st_f67bc2eb) — the stored atomic relation
// types for person_relations, GEDCOM-shaped: in-law, step, and grand-composite
// relations are NEVER stored; they derive by walking (lib/relation-walk.js).
// This module stays db-free by design — it rides the prompt-assembly import
// graph the same way the tag/label tables above do.
// ═════════════════════════════════════════════════════════════════════════════

// Storable atomic edge types → domain. Closed set; extending it is a code
// change here, never a free string in a writer.
export const EDGE_TYPES = Object.freeze({
  spouse:             'kinship',
  parent:             'kinship',   // directional: person_a is person_b's parent
  sibling:            'kinship',
  cousin:             'kinship',
  grandparent:        'kinship',   // directional: person_a is person_b's grandparent
  'niece-nephew':     'kinship',   // directional: person_a is person_b's niece/nephew
  pet:                'kinship',   // directional: person_a is person_b's pet
  friend:             'social',
  'best-friend':      'social',
  'romantic-partner': 'social',    // pre-spouse stage (girlfriend/boyfriend/fiancé(e))
  colleague:          'professional',
  mentor:             'professional', // directional: person_a is person_b's mentor
  classmate:          'professional',
  'business-partner': 'professional',
});

// Directional types (one canonical representation; the inverse alias swaps
// endpoints on the way in — a pair can never carry both directions).
export const DIRECTIONAL_EDGE_TYPES = new Set(['parent', 'grandparent', 'niece-nephew', 'mentor', 'pet']);

/** Domain for an edge type, or null when outside the closed vocabulary. */
export function edgeDomain(relType) {
  return EDGE_TYPES[String(relType || '').trim()] || null;
}

// Temporal supersede chains (Wikidata's was-true-then rule): a NEWER statement
// of the key type deprecates an ACTIVE edge of a listed older-stage type on
// the same pair, newest-wins, without a conflict question. Every other
// equal-authority different-type collision writes nothing and asks.
export const TEMPORAL_SUPERSEDE_CHAINS = Object.freeze({
  spouse: Object.freeze(['romantic-partner']),
  'best-friend': Object.freeze(['friend']),
});

// Anchoring-question stakes floor (st_f67bc2eb, owner QC round): an
// anchor-ambiguity on a LOW-STAKES type never merits interrupting the owner —
// silence, store nothing (omission per the cost asymmetry). Kinship and
// romantic-partner types keep asking.
export const LOW_STAKES_ANCHOR_TYPES = new Set([
  'friend', 'best-friend', 'colleague', 'classmate', 'business-partner', 'mentor',
]);

// Exclusive relation types: one active partner per person at a time — a
// candidate pairing someone with a NEW partner while an OWNER-authority edge
// of the same type stands is answered by the lattice, not askable.
export const EXCLUSIVE_EDGE_TYPES = new Set(['spouse', 'romantic-partner']);

// Former/ex markers → the statement asserts an ENDED relation (valid_until
// set); never an active edge.
export const FORMER_MARKERS = Object.freeze(['former', 'ex', 'ex-', 'previous', 'estranged', 'late']);

// ── Mining/statement word table ──────────────────────────────────────────────
// word → { type, namedRole, gender } for the possessive statement shapes
// ("my <word> <Name>", "<Name>'s <word> <Name2>").
//   type      — storable atomic edge type
//   namedRole — which endpoint the NAMED person occupies for directional
//               types: 'a' (the marked role: parent/grandparent/niece-nephew/
//               mentor/pet) or 'b' (the object: child/grandchild/aunt-uncle/
//               mentee). Symmetric types use 'a' by convention (ignored).
//   gender    — gender hint for the NAMED person, applied as node data
//               (never as edge data) when the node's gender is unknown.
//   species   — pet species hint (node data, same rule as gender).
// In-law and step words are NOT here: they decompose (lib/relation-store.js)
// or enqueue a decomposition question — composite relations are never stored.
export const EDGE_WORDS = Object.freeze({
  // kinship — parent class
  mother: { type: 'parent', namedRole: 'a', gender: 'female' },
  mom: { type: 'parent', namedRole: 'a', gender: 'female' },
  mommy: { type: 'parent', namedRole: 'a', gender: 'female' },
  mama: { type: 'parent', namedRole: 'a', gender: 'female' },
  father: { type: 'parent', namedRole: 'a', gender: 'male' },
  dad: { type: 'parent', namedRole: 'a', gender: 'male' },
  daddy: { type: 'parent', namedRole: 'a', gender: 'male' },
  papa: { type: 'parent', namedRole: 'a', gender: 'male' },
  parent: { type: 'parent', namedRole: 'a', gender: null },
  son: { type: 'parent', namedRole: 'b', gender: 'male' },
  daughter: { type: 'parent', namedRole: 'b', gender: 'female' },
  child: { type: 'parent', namedRole: 'b', gender: null },
  kid: { type: 'parent', namedRole: 'b', gender: null },
  // kinship — grandparent class
  grandmother: { type: 'grandparent', namedRole: 'a', gender: 'female' },
  grandma: { type: 'grandparent', namedRole: 'a', gender: 'female' },
  granny: { type: 'grandparent', namedRole: 'a', gender: 'female' },
  nana: { type: 'grandparent', namedRole: 'a', gender: 'female' },
  grandfather: { type: 'grandparent', namedRole: 'a', gender: 'male' },
  grandpa: { type: 'grandparent', namedRole: 'a', gender: 'male' },
  grandparent: { type: 'grandparent', namedRole: 'a', gender: null },
  grandson: { type: 'grandparent', namedRole: 'b', gender: 'male' },
  granddaughter: { type: 'grandparent', namedRole: 'b', gender: 'female' },
  grandchild: { type: 'grandparent', namedRole: 'b', gender: null },
  // kinship — sibling / cousin / spouse
  sister: { type: 'sibling', namedRole: 'a', gender: 'female' },
  sis: { type: 'sibling', namedRole: 'a', gender: 'female' },
  brother: { type: 'sibling', namedRole: 'a', gender: 'male' },
  bro: { type: 'sibling', namedRole: 'a', gender: 'male' },
  sibling: { type: 'sibling', namedRole: 'a', gender: null },
  cousin: { type: 'cousin', namedRole: 'a', gender: null },
  wife: { type: 'spouse', namedRole: 'a', gender: 'female' },
  husband: { type: 'spouse', namedRole: 'a', gender: 'male' },
  spouse: { type: 'spouse', namedRole: 'a', gender: null },
  // "partner" stays spouse-class to match RELATION_ALIASES (the shipped
  // correction-parser behavior) — but it is EXCLUDED from bulk mining
  // (miningExcluded): in corpus text "my partner X" is dominantly business
  // language, and the first live sweep proved it writes false spouse edges
  // ("My partner <Name> has been invited to speak…"). The interactive
  // correction lane keeps accepting it because the owner is in the loop.
  partner: { type: 'spouse', namedRole: 'a', gender: null, miningExcluded: true },
  // kinship — niece/nephew ↔ aunt/uncle
  niece: { type: 'niece-nephew', namedRole: 'a', gender: 'female' },
  nephew: { type: 'niece-nephew', namedRole: 'a', gender: 'male' },
  aunt: { type: 'niece-nephew', namedRole: 'b', gender: 'female' },
  auntie: { type: 'niece-nephew', namedRole: 'b', gender: 'female' },
  uncle: { type: 'niece-nephew', namedRole: 'b', gender: 'male' },
  // kinship — pets (species is node data, like gender)
  dog: { type: 'pet', namedRole: 'a', gender: null, species: 'dog' },
  puppy: { type: 'pet', namedRole: 'a', gender: null, species: 'dog' },
  cat: { type: 'pet', namedRole: 'a', gender: null, species: 'cat' },
  kitten: { type: 'pet', namedRole: 'a', gender: null, species: 'cat' },
  // social
  friend: { type: 'friend', namedRole: 'a', gender: null },
  'best friend': { type: 'best-friend', namedRole: 'a', gender: null },
  'best-friend': { type: 'best-friend', namedRole: 'a', gender: null },
  bff: { type: 'best-friend', namedRole: 'a', gender: null },
  girlfriend: { type: 'romantic-partner', namedRole: 'a', gender: 'female' },
  boyfriend: { type: 'romantic-partner', namedRole: 'a', gender: 'male' },
  fiancée: { type: 'romantic-partner', namedRole: 'a', gender: 'female' },
  fiancé: { type: 'romantic-partner', namedRole: 'a', gender: 'male' },
  fiancee: { type: 'romantic-partner', namedRole: 'a', gender: 'female' },
  fiance: { type: 'romantic-partner', namedRole: 'a', gender: null },
  // professional
  colleague: { type: 'colleague', namedRole: 'a', gender: null },
  coworker: { type: 'colleague', namedRole: 'a', gender: null },
  'co-worker': { type: 'colleague', namedRole: 'a', gender: null },
  mentor: { type: 'mentor', namedRole: 'a', gender: null },
  mentee: { type: 'mentor', namedRole: 'b', gender: null },
  classmate: { type: 'classmate', namedRole: 'a', gender: null },
  'business partner': { type: 'business-partner', namedRole: 'a', gender: null },
  'business-partner': { type: 'business-partner', namedRole: 'a', gender: null },
});

// Composite words that are NEVER stored — a stated in-law/step relation
// decomposes deterministically when the graph already disambiguates, else
// enqueues a decomposition question. word → the decomposition recipe: the
// named person is `via`'s `inner` (e.g. sister-in-law: spouse's sibling OR
// sibling's spouse — both listed; the store picks the one the graph supports).
export const DECOMPOSE_WORDS = Object.freeze({
  'mother-in-law':  Object.freeze({ gender: 'female', paths: Object.freeze([{ via: 'spouse', inner: 'parent', namedRole: 'a' }]) }),
  'father-in-law':  Object.freeze({ gender: 'male',   paths: Object.freeze([{ via: 'spouse', inner: 'parent', namedRole: 'a' }]) }),
  'parent-in-law':  Object.freeze({ gender: null,     paths: Object.freeze([{ via: 'spouse', inner: 'parent', namedRole: 'a' }]) }),
  mil:              Object.freeze({ gender: 'female', paths: Object.freeze([{ via: 'spouse', inner: 'parent', namedRole: 'a' }]) }),
  fil:              Object.freeze({ gender: 'male',   paths: Object.freeze([{ via: 'spouse', inner: 'parent', namedRole: 'a' }]) }),
  'sister-in-law':  Object.freeze({ gender: 'female', paths: Object.freeze([{ via: 'spouse', inner: 'sibling', namedRole: 'a' }, { via: 'sibling', inner: 'spouse', namedRole: 'a' }]) }),
  'brother-in-law': Object.freeze({ gender: 'male',   paths: Object.freeze([{ via: 'spouse', inner: 'sibling', namedRole: 'a' }, { via: 'sibling', inner: 'spouse', namedRole: 'a' }]) }),
  'sibling-in-law': Object.freeze({ gender: null,     paths: Object.freeze([{ via: 'spouse', inner: 'sibling', namedRole: 'a' }, { via: 'sibling', inner: 'spouse', namedRole: 'a' }]) }),
  sil:              Object.freeze({ gender: 'female', paths: Object.freeze([{ via: 'spouse', inner: 'sibling', namedRole: 'a' }, { via: 'sibling', inner: 'spouse', namedRole: 'a' }]) }),
  bil:              Object.freeze({ gender: 'male',   paths: Object.freeze([{ via: 'spouse', inner: 'sibling', namedRole: 'a' }, { via: 'sibling', inner: 'spouse', namedRole: 'a' }]) }),
  'son-in-law':     Object.freeze({ gender: 'male',   paths: Object.freeze([{ via: 'child', inner: 'spouse', namedRole: 'a' }]) }),
  'daughter-in-law': Object.freeze({ gender: 'female', paths: Object.freeze([{ via: 'child', inner: 'spouse', namedRole: 'a' }]) }),
  stepmother:       Object.freeze({ gender: 'female', paths: Object.freeze([{ via: 'parent', inner: 'spouse', namedRole: 'a' }]) }),
  stepfather:       Object.freeze({ gender: 'male',   paths: Object.freeze([{ via: 'parent', inner: 'spouse', namedRole: 'a' }]) }),
  stepmom:          Object.freeze({ gender: 'female', paths: Object.freeze([{ via: 'parent', inner: 'spouse', namedRole: 'a' }]) }),
  stepdad:          Object.freeze({ gender: 'male',   paths: Object.freeze([{ via: 'parent', inner: 'spouse', namedRole: 'a' }]) }),
});

/**
 * Title-case a display name for user-facing question text ("charlotte's" →
 * "Charlotte's"). Only lifts a lowercase first letter per word — existing
 * interior capitals (McCarthy, DiPietro) are never rewritten.
 */
export function titleCaseName(name) {
  return String(name || '').replace(/(^|[\s-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

/** Resolve a statement word to an EDGE_WORDS entry, or null. */
export function resolveEdgeWord(word) {
  const w = normalize(word);
  return EDGE_WORDS[w] || null;
}

/** Resolve a statement word to a DECOMPOSE_WORDS entry, or null. */
export function resolveDecomposeWord(word) {
  const w = normalize(word);
  return DECOMPOSE_WORDS[w] || null;
}

// ── Walk-role vocabulary (lib/relation-walk.js) ──────────────────────────────
// Atomic role words seen FROM a node toward its neighbor, and how each role
// genders. The walker composes these; it never invents a word outside them.
export const GENDERED_ROLE_WORDS = Object.freeze({
  spouse:        Object.freeze({ male: 'husband', female: 'wife' }),
  parent:        Object.freeze({ male: 'father', female: 'mother' }),
  child:         Object.freeze({ male: 'son', female: 'daughter' }),
  sibling:       Object.freeze({ male: 'brother', female: 'sister' }),
  cousin:        Object.freeze({}),
  grandparent:   Object.freeze({ male: 'grandfather', female: 'grandmother' }),
  grandchild:    Object.freeze({ male: 'grandson', female: 'granddaughter' }),
  'niece-nephew': Object.freeze({ male: 'nephew', female: 'niece' }),
  'aunt-uncle':  Object.freeze({ male: 'uncle', female: 'aunt' }),
  pet:           Object.freeze({}),
  'pet-owner':   Object.freeze({}),
  friend:        Object.freeze({}),
  'best-friend': Object.freeze({}),
  'romantic-partner': Object.freeze({ male: 'boyfriend', female: 'girlfriend' }),
  colleague:     Object.freeze({}),
  mentor:        Object.freeze({}),
  mentee:        Object.freeze({}),
  classmate:     Object.freeze({}),
  'business-partner': Object.freeze({}),
});

/**
 * The role word for (atomic role, node gender): gendered when the node's
 * gender is known, the genderless role word otherwise. NEVER guesses.
 */
export function genderedRoleWord(role, gender) {
  const table = GENDERED_ROLE_WORDS[String(role || '').trim()] || {};
  return table[String(gender || '').trim()] || String(role || '').trim();
}

// Two-hop composition rules: `${roleFromOwner}∘${roleFromNode}` → the owner
// view. Each entry names the coarse TAG (existing closed FAMILY_TAGS set so
// every legacy reader keeps a valid value), whether the composed role is
// itself an ATOMIC role that can chain one more hop, and how the derived
// phrase renders:
//   phrase: 'label'  — tag+label fully express the role (derived phrase null)
//           'named'  — a single named composite word (step-parent, child-in-law)
//           'path'   — spouse-word possessive path ("wife's cousin")
// Uncovered compositions render the honest path phrase ("your mother's
// brother") under the coarse 'family' tag — never a guessed single label.
export const COMPOSITION_RULES = Object.freeze({
  'spouse∘parent':   Object.freeze({ tag: 'parent-in-law', phrase: 'label' }),
  'spouse∘sibling':  Object.freeze({ tag: 'sibling-in-law', phrase: 'label' }),
  'sibling∘spouse':  Object.freeze({ tag: 'sibling-in-law', phrase: 'label' }),
  'spouse∘cousin':   Object.freeze({ tag: 'IL', phrase: 'path' }),
  'parent∘spouse':   Object.freeze({ tag: 'family', phrase: 'named', named: 'step-parent' }),
  'sibling∘child':   Object.freeze({ tag: 'niece-nephew', phrase: 'label', atomic: 'niece-nephew' }),
  'child∘spouse':    Object.freeze({ tag: 'IL', phrase: 'named', named: 'child-in-law' }),
  'parent∘parent':   Object.freeze({ tag: 'grandparent', phrase: 'label', atomic: 'grandparent' }),
  'child∘child':     Object.freeze({ tag: 'family', phrase: 'path', atomic: 'grandchild' }),
  'parent∘sibling':  Object.freeze({ tag: 'family', phrase: 'path', atomic: 'aunt-uncle' }),
});

// Coarse tag for each DIRECT atomic role in the owner view (walk depth 1).
// Roles outside FAMILY_TAGS (grandchild, aunt-uncle, social/professional
// stated relations) map to the closest legacy tag so six readers keep valid
// values; their precise role rides relation_derived_phrase.
export const DIRECT_ROLE_TAGS = Object.freeze({
  spouse: 'spouse',
  parent: 'parent',
  child: 'child',
  sibling: 'sibling',
  cousin: 'cousin',
  grandparent: 'grandparent',
  grandchild: 'family',
  'niece-nephew': 'niece-nephew',
  'aunt-uncle': 'family',
  pet: 'pet',
});
