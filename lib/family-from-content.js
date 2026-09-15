/**
 * Family-from-content (Pass 5a) — Tier 0 content-level family inference.
 *
 * Phase 4 Passes 1–4b are STRUCTURAL: surname clusters, config name lookups,
 * Apple Contacts cross-reference, nickname dictionary. None of them reads the
 * user's actual content. A statement like "person-a's mom is person-b"
 * lives in identity cards / Granola / chat / notes — invisible to structural
 * passes. Pass 5a closes that gap by scanning two structured/semi-structured
 * sources for explicit family relationship statements:
 *
 *   1. User profile/context markdown under `~/robotdojo/user/` — markdown
 *      files describing the user, family, etc. Walked recursively across
 *      curated context surfaces while skipping bulky raw-data roots.
 *
 *   2. Apple Contacts ZABCDRELATEDNAME table — built-in relationship metadata
 *      where the user has hand-tagged contacts with labels like "Mother",
 *      "Spouse", "Brother". Each related contact name is resolved to the
 *      tagged owner via shared identifiers, and the label maps to a relation.
 *
 * For each match: derive a relation_tag, resolve Y to a person row by name
 * lookup (with Apple Contacts cross-ref fallback), and tag the row UNLESS
 * the row already has an equal-or-higher-confidence tag.
 *
 * Transitive in-law derivation:
 *   - "my mom is X"            → X is a parent
 *   - "my wife's mom is X"     → X is a parent-in-law
 *   - "my mom's brother is X"  → X is an aunt-uncle (treated as parent-in-law
 *                                under the FAMILY_TAGS set, since aunt-uncle
 *                                is not in FAMILY_TAGS today; conservative
 *                                fallback is to skip rather than mis-tag)
 *
 * WHY no LLM: every match is a deterministic regex against a structured-ish
 * statement. Tier 0 is sufficient and avoids the cost of Haiku per-row.
 *
 * WHY runs AFTER Pass 4b: config/family.json + Apple Contacts nickname
 * inference are higher-trust signals (the user typed Mom into Apple
 * Contacts vs. wrote "my mom is X" in a markdown file). Content inference
 * is the FALLBACK: it fills gaps left by structural passes.
 *
 * WHY only updates relation_tag (not display_name): Pass 4 renames because
 * config/family.json is a stated preference. Content inference produces a
 * relation but no canonical name authority. Leave display_name to the
 * canonical-name picker (lib/canonical-name.js).
 *
 * WHY idempotent: each run sets the same relation for the same person. A
 * second pass over already-tagged rows is a no-op (the existing-tag guard
 * skips them).
 *
 * Exported as `inferFamilyFromContent({ db, log, config, alreadyTagged })`
 * and consumed by scripts/ingest/04-classify.js after Pass 4b. Returns a
 * `Map<personId, relation>` for the new tags so the caller can fold them
 * into its existing write transaction.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { USER_ROOT } from './robotdojo-paths.js';
import { RELATION_ALIASES, resolveRelationAlias } from './relation-vocabulary.js';

// ── Vocabulary ───────────────────────────────────────────────────────────────

// st_df0a8d71 D1 — the alias→tag table is DERIVED from the single closed
// vocabulary in lib/relation-vocabulary.js so this scanner, the chat
// correction parser, and every renderer agree on one word list. Adding an
// alias there makes it recognized here; nothing is duplicated.
// Keys are lowercase, no surrounding punctuation. Captured via regex group.
const DIRECT_RELATION = Object.fromEntries(
  Object.entries(RELATION_ALIASES).map(([alias, v]) => [alias, v.tag]),
);

// In-law transitive derivation: "X's <relation> is Y" where X is the OWNER's
// SPOUSE → Y is the corresponding in-law variant, gendered when the inner
// relation is gendered (wife's mom → mother-in-law). Other transitive chains
// (X is owner's parent → Y is grandparent) are derived in
// deriveTransitiveRelation because they need the chained-relation logic.
function spouseInlawFor(relationAlias) {
  const inner = resolveRelationAlias(relationAlias);
  if (!inner) return null;
  if (inner.tag === 'parent') {
    return {
      tag: 'parent-in-law',
      label: inner.label === 'mother' ? 'mother-in-law' : inner.label === 'father' ? 'father-in-law' : null,
    };
  }
  if (inner.tag === 'sibling') {
    return {
      tag: 'sibling-in-law',
      label: inner.label === 'sister' ? 'sister-in-law' : inner.label === 'brother' ? 'brother-in-law' : null,
    };
  }
  return null;
}

// Joiners between X and Y in "X's <relation> is/= : Y" patterns.
// Use [ ] (literal space) instead of \\s to avoid spanning newlines.
const ASSIGNMENT_JOIN = `(?:[ ]+is[ ]+|[ ]*=[ ]*|[ ]*:[ ]*|\\*\\*[ ]+)`;

// Possessive form: "<Name>'s" or "my".
// Name component: 1–3 capitalized tokens (e.g. "Spouse", "First Last", "Mary
// Jane Watson"), each token starts with a capital, optional hyphens /
// apostrophes inside. We do NOT allow free-form whitespace inside the
// capture — `\\s` would let the regex span paragraphs and capture huge
// garbage strings (the actual name regex would lazy-match the entire body
// up to the first "'s <relation>" found anywhere downstream).
const NAME_TOKEN = `[A-Z][A-Za-z'\\-]{1,30}`;
const NAME_PATTERN = `${NAME_TOKEN}(?:[ ]${NAME_TOKEN}){0,2}`;

// Alternation list of relations (keys of DIRECT_RELATION) sorted longest-first
// so the regex prefers "mother-in-law" over "mother".
const RELATION_KEYS = Object.keys(DIRECT_RELATION).sort((a, b) => b.length - a.length);
const RELATION_ALT = RELATION_KEYS
  .map(k => k.replace(/-/g, '\\-'))
  .join('|');

// Pattern A: "<Name>'s <relation> is/=/: <Name>"
// Pattern B: "my <relation> is/=/: <Name>"
// Pattern C: markdown bullet — "- **Wife:** First Last" / "- Wife: First"
//
// All patterns are case-insensitive on the relation token but case-sensitive
// on the name capture (names start with a capital letter — anchors against
// matching arbitrary lowercase noise).
//
// WHY conservative on the value side: the value name capture is `[A-Z]...`
// followed by a non-capturing terminator. We want to stop at the end of the
// name, not consume the rest of the sentence. The terminator is end-of-line,
// punctuation that ends a clause (.,;), or " (" (parenthetical aside).
// `\\n` is in the character class so end-of-paragraph stops the value cleanly.
const VALUE_TERMINATOR = `(?=\\n|[.,;()]|\\s+(?:and|but|who|which|in|at|of)\\b|$)`;

// Value capture: starts with a capital, allows hyphens/apostrophes, and may
// continue with additional capitalized tokens separated by SINGLE spaces only
// (NOT \\s+ — that matches newlines and lets the value run on across paragraphs).
const VALUE_NAME = `[A-Z][A-Za-z'\\-]+(?:[ ][A-Z][A-Za-z'\\-]+)*`;

const PATTERN_A = new RegExp(
  `\\b(${NAME_PATTERN})['’]s[ ]+(${RELATION_ALT})\\b${ASSIGNMENT_JOIN}(${VALUE_NAME})${VALUE_TERMINATOR}`,
  'gi'
);

const PATTERN_B = new RegExp(
  `\\bmy[ ]+(${RELATION_ALT})\\b${ASSIGNMENT_JOIN}(${VALUE_NAME})${VALUE_TERMINATOR}`,
  'gi'
);

const PATTERN_C = new RegExp(
  `(?:^|\\n)\\s*[-*]\\s+(?:\\*\\*)?(${RELATION_ALT})(?:\\*\\*)?\\s*:\\s*(${VALUE_NAME})`,
  'gi'
);

// ── Helpers ──────────────────────────────────────────────────────────────────

const norm = (s) => (s ? String(s).trim().toLowerCase() : '');

/**
 * Walk a directory recursively for .md files.
 * Skips generated/bulky roots that are not curated user context.
 */
function walkMarkdown(root, out = []) {
  if (!existsSync(root)) return out;
  try {
    const rootStat = statSync(root);
    if (rootStat.isFile()) {
      if (extname(root).toLowerCase() === '.md') out.push(root);
      return out;
    }
  } catch {
    return out;
  }
  let entries;
  try { entries = readdirSync(root); } catch { return out; }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if ([
      'archive',
      'databases',
      'dist',
      'files',
      'imports',
      'inbox',
      'logs',
      'media',
      'models',
      'node_modules',
      'rollback',
      'transcripts',
      'workbenches',
    ].includes(name.toLowerCase())) continue;
    const full = join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walkMarkdown(full, out);
    } else if (st.isFile() && extname(full).toLowerCase() === '.md') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Build a quick { firstName, lastName, fullName } → relation map from
 * config/family.json so we can recognize "X" as the owner's spouse / parent
 * when X is a name (not the literal "my").
 *
 * Key shapes (all lowercase):
 *   "<full name>"       → relation ("First Last" → spouse)
 *   "<first name>"      → relation ("First" → spouse) — only when unique
 *   "<first> <last>"    → relation
 *
 * WHY first-name-only key: identity files often use first name only.
 * We add the first-name key only when there is no ambiguity (no two members
 * share the same first name). Otherwise the key is dropped — caller falls
 * back to the full-name match.
 */
function buildOwnerRelativeMap(members) {
  const map = new Map();
  const firstCounts = new Map();
  for (const m of members) {
    const norm = (m.name || '').trim().toLowerCase();
    if (!norm) continue;
    map.set(norm, m.relation);
    const first = norm.split(/\s+/)[0];
    if (first) firstCounts.set(first, (firstCounts.get(first) || 0) + 1);
  }
  for (const m of members) {
    const first = (m.name || '').trim().toLowerCase().split(/\s+/)[0];
    if (first && firstCounts.get(first) === 1) {
      // unique → safe to add a first-name shortcut
      if (!map.has(first)) map.set(first, m.relation);
    }
  }
  return map;
}

/**
 * Derive a relation {tag, label} from "X's <relation> is Y" where:
 *   - X may be "my", the owner's name, or a member of config/family.json
 *   - <relation> is a DIRECT_RELATION key (mom, dad, wife, etc.)
 *
 * Returns null if the chain produces a relation outside FAMILY_TAGS (e.g.
 * "my friend X" — friend isn't in FAMILY_TAGS, so we don't tag).
 *
 * st_df0a8d71 — the return carries the gendered sub-label when the alias is
 * gendered (mom → { tag: 'parent', label: 'mother' }) so callers that write
 * through setRelationTag can persist relation_label alongside the tag.
 *
 * Logic:
 *   - my <rel> is Y          → resolveRelationAlias(rel)
 *   - <spouse>'s <rel> is Y  → spouseInlawFor(rel) (if spouse known)
 *   - <parent>'s <rel> is Y  → mom→grandmother, dad→grandfather;
 *                              sibling→? (treated as null — too ambiguous,
 *                              would need aunt-uncle in FAMILY_TAGS)
 *   - other transitive cases → null (conservative skip)
 *
 * @param {string} possessor - the X side, lowercased
 * @param {string} relation  - the relation label, lowercased
 * @param {Map<string,string>} ownerRelativeMap - first/full name → relation
 * @returns {{tag: string, label: string|null}|null}
 */
function deriveTransitiveRelation(possessor, relation, ownerRelativeMap) {
  const direct = resolveRelationAlias(relation);
  if (!direct) return null;

  // "my X is Y" — direct claim about the owner
  if (possessor === 'my' || possessor === 'me') return { tag: direct.tag, label: direct.label };

  // If possessor is the owner's spouse, child, parent, or sibling → derive.
  const ownerRel = ownerRelativeMap.get(possessor);
  if (!ownerRel) return null; // X is unknown → can't derive transitively

  if (ownerRel === 'spouse') {
    // "my wife's <X> is Y"
    return spouseInlawFor(relation);
  }
  if (ownerRel === 'parent') {
    // "my mom's mom is Y" → grandparent (gendered when the inner alias is)
    if (direct.tag === 'parent') {
      return {
        tag: 'grandparent',
        label: direct.label === 'mother' ? 'grandmother' : direct.label === 'father' ? 'grandfather' : null,
      };
    }
    // "my mom's sibling is Y" → aunt-uncle (NOT in FAMILY_TAGS today). Skip.
    return null;
  }
  // child, sibling, grandparent → no clean transitive mapping today. Skip.
  return null;
}

/**
 * Resolve a name string to a person_id using:
 *   1. Exact case-insensitive display_name match (active people)
 *   2. Apple Contacts cross-reference (the name appears as a Contact name; the
 *      contact's email/phone resolves to a person via person_identifiers)
 *
 * Returns null if no resolution.
 *
 * @param {string} name
 * @param {object} db
 * @param {Array} contacts - extractContacts() output (cached by caller)
 * @param {object} stmts   - prepared statements (see caller)
 */
function resolveNameToPerson(name, db, contacts, stmts) {
  const lookup = name.trim();
  if (!lookup) return null;

  // 1) Exact display_name match
  const direct = stmts.findByName.get(lookup.toLowerCase());
  if (direct) return direct.id;

  // 2) Apple Contacts cross-reference — find a contact whose name equals
  // (case-insensitive) `name`, then look up its identifiers in person_identifiers.
  const lower = lookup.toLowerCase();
  for (const c of contacts) {
    if (!c.name) continue;
    if (c.name.trim().toLowerCase() !== lower) continue;
    for (const e of (c.emails || [])) {
      const r = stmts.findPersonByIdent.get(e);
      if (r) return r.person_id;
    }
    for (const p of (c.phones || [])) {
      const r = stmts.findPersonByIdent.get(p);
      if (r) return r.person_id;
    }
  }
  return null;
}

// ── Pass 5a-1: scan identity markdown files ─────────────────────────────────

// Validate a captured name starts with a capital letter and contains only
// expected chars. Required because the regexes use the `i` flag (so the
// relation alternation is case-insensitive), which also makes `[A-Z]` in the
// NAME_PATTERN match lowercase. JS lacks inline (?-i:) flag groups, so we
// post-validate.
function looksLikeName(s) {
  if (!s) return false;
  const t = s.trim();
  if (!t) return false;
  // Each token must start with a capital. Tokens separated by single spaces.
  for (const tok of t.split(/[ ]+/)) {
    if (!/^[A-Z][A-Za-z'\-]{1,30}$/.test(tok)) return false;
  }
  return true;
}

/**
 * Scan curated user-context markdown under `~/robotdojo/user/` for explicit
 * family relation statements via PATTERN_A, PATTERN_B, and PATTERN_C.
 *
 * Returns an array of { possessor, relation, value, source } records BEFORE
 * resolving names to people. The caller will resolve + tag.
 *
 * Each candidate match is post-validated by looksLikeName() on both the
 * possessor (when not "my"/"me") and the value, to filter out lowercase
 * matches the case-insensitive regex flag would otherwise admit.
 *
 * @param {string} identityRoot - path to user-context root or markdown file
 * @returns {Array<{possessor:string, relation:string, value:string, source:string}>}
 */
export function scanIdentityFiles(identityRoot) {
  const files = walkMarkdown(identityRoot);
  const out = [];
  // Helper: when a regex match passes the engine but fails the looksLikeName
  // post-validation (because the case-insensitive flag let lowercase tokens
  // sneak in), nudge lastIndex back to start_of_match+1 so the engine tries
  // a slightly different starting position. Without this, a failed lazy
  // match consumes the search window and a valid match further inside the
  // same line is missed.
  const stepRegex = (re, body, onMatch) => {
    re.lastIndex = 0;
    while (re.lastIndex < body.length) {
      const startedAt = re.lastIndex;
      const m = re.exec(body);
      if (!m) break;
      const accepted = onMatch(m);
      if (!accepted) {
        // Failed validation — back up to one past where this match started.
        re.lastIndex = (m.index ?? startedAt) + 1;
      }
    }
  };

  for (const f of files) {
    let body;
    try { body = readFileSync(f, 'utf8'); } catch { continue; }
    stepRegex(PATTERN_A, body, (m) => {
      const possessorRaw = m[1].trim();
      const valueRaw = m[3].trim();
      if (!looksLikeName(possessorRaw)) return false;
      if (!looksLikeName(valueRaw)) return false;
      out.push({ possessor: norm(possessorRaw), relation: norm(m[2]), value: valueRaw, source: f });
      return true;
    });
    stepRegex(PATTERN_B, body, (m) => {
      const valueRaw = m[2].trim();
      if (!looksLikeName(valueRaw)) return false;
      out.push({ possessor: 'my', relation: norm(m[1]), value: valueRaw, source: f });
      return true;
    });
    stepRegex(PATTERN_C, body, (m) => {
      const valueRaw = m[2].trim();
      if (!looksLikeName(valueRaw)) return false;
      out.push({ possessor: 'my', relation: norm(m[1]), value: valueRaw, source: f });
      return true;
    });
  }
  return out;
}

// ── Pass 5a-2: scan Apple Contacts ZABCDRELATEDNAME ─────────────────────────

// Apple stores relationship labels in `_$!<Label>!$_` form sometimes.
// Strip the wrapper and lowercase, then resolve through the single closed
// vocabulary (st_df0a8d71 — the old inline MAP duplicated it). Returns
// { tag, label|null } or null when the Apple label is not a family relation.
function normalizeContactsLabel(raw) {
  if (!raw) return null;
  const m = String(raw).match(/_\$!<(.+?)>!\$_/);
  const label = (m ? m[1] : raw).trim().toLowerCase();
  return resolveRelationAlias(label);
}

/**
 * Walk Apple Contacts. For every contact that carries one or more
 * ZABCDRELATEDNAME entries, find the OWNER contact's relation entries
 * (e.g. owner contact has "Mother: Laurel") AND for every other contact
 * whose own relation entries point at the owner (less common path).
 *
 * Returns an array of { contactName, relation, source } records — the
 * `contactName` is the related person's name as Apple stored it; we then
 * resolve that name to a person_id via the same shared-identifier logic.
 *
 * Implementation: contacts-extractor.js exposes c.relations = [{name,label}].
 * For every contact c, every relation row is interpreted as "I (the contact)
 * have a <label> named <name>". We treat every contact as if it COULD be the
 * owner — duplicates are filtered out at tag time (a person row can only have
 * one relation_tag, and the existing-tag guard wins).
 *
 * Tradeoff: this is over-inclusive (a friend's contact card might say
 * "spouse: their-spouse" and we'd tag the friend's spouse as the owner's
 * spouse). The false-positive risk is mitigated by:
 *   - SPOUSE_INLAW_DERIVATION not applying here (we use direct labels only)
 *   - The existing-tag guard preventing overwrite of higher-confidence Pass 4
 *     results
 *   - The vast majority of users have ZABCDRELATEDNAME populated only for
 *     their own immediate family (the iOS Contacts UI surfaces it only on
 *     the user's own card flow)
 *
 * In practice on this user's data, ZABCDRELATEDNAME is empty (0 rows) so this
 * pass contributes nothing. Kept for portability — users on iCloud-synced
 * accounts often have it populated.
 */
export function scanContactsRelations(contacts) {
  const out = [];
  for (const c of contacts) {
    const rels = c.relations || [];
    for (const r of rels) {
      if (!r.name) continue;
      const resolved = normalizeContactsLabel(r.label);
      if (!resolved) continue;
      out.push({
        contactName: r.name.trim(),
        relation: resolved.tag,
        label: resolved.label || null,
        source: `apple-contacts:${c.name || '?'}`,
      });
    }
  }
  return out;
}

// ── Top-level driver ─────────────────────────────────────────────────────────

/**
 * Run Pass 5a content-level inference. Returns a Map<personId, relation> of
 * NEW tags (caller is responsible for the actual UPDATE — keeps this module
 * pure and testable without DB writes).
 *
 * @param {object} args
 * @param {object} args.db - better-sqlite3 db
 * @param {Function} args.log
 * @param {object} args.config - parsed config/family.json
 * @param {Set<string>} args.alreadyTagged - person_ids already tagged by Pass 1/4/4b
 * @param {Array} [args.contacts] - extractContacts() output (caller pre-loads)
 * @param {string} [args.identityRoot] - override user-context path (default ~/robotdojo/user)
 * @returns {Promise<{ tags: Map<string,string>, labels: Map<string,string|null>, samples: Array }>}
 */
export async function inferFamilyFromContent({
  db, log, config, alreadyTagged, contacts, identityRoot,
}) {
  const root = identityRoot || USER_ROOT;
  const ownerRelativeMap = buildOwnerRelativeMap(config.members || []);

  // Lazily load contacts if caller didn't pre-load.
  if (!contacts) {
    try {
      const { extractContacts } = await import('./contacts-extractor.js');
      contacts = extractContacts();
    } catch (err) {
      log?.(`  ? Pass 5a: extractContacts failed: ${err.message}`);
      contacts = [];
    }
  }

  const stmts = {
    findByName: db.prepare(
      "SELECT id FROM people WHERE LOWER(display_name) = LOWER(?) AND COALESCE(archived,0)=0 LIMIT 1"
    ),
    findPersonByIdent: db.prepare(
      "SELECT person_id FROM person_identifiers WHERE LOWER(value) = LOWER(?) LIMIT 1"
    ),
  };

  const tags = new Map();
  // st_df0a8d71 — gendered sub-labels (mom → mother) discovered alongside the
  // tags. Same key set as `tags`; value may be null (genderless alias).
  // Existing callers (scripts/ingest/04-classify.js) keep reading `tags`
  // unchanged; label-aware writers (the relationship-graph rerun) consume this.
  const labels = new Map();
  // st_f67bc2eb D6 — provenance class per match: 'identity' (markdown content
  // → inference class, question-only under the firewall) vs 'apple-related'
  // (a relation field the user hand-tagged on the contact card → authority
  // 'contact'). Callers map these to 'content-inference' / 'contact-card'.
  const vias = new Map();
  const samples = [];

  // ── Pass 5a-1: identity markdown files ──────────────────────────────────
  const identityMatches = scanIdentityFiles(root);
  for (const match of identityMatches) {
    const derived = deriveTransitiveRelation(match.possessor, match.relation, ownerRelativeMap);
    if (!derived) continue;
    const personId = resolveNameToPerson(match.value, db, contacts, stmts);
    if (!personId) continue;
    if (alreadyTagged.has(personId)) continue; // higher-confidence pass already tagged
    if (tags.has(personId)) continue; // first-content match wins (deterministic by file walk order)
    tags.set(personId, derived.tag);
    labels.set(personId, derived.label || null);
    vias.set(personId, 'identity');
    samples.push({
      via: 'identity',
      possessor: match.possessor,
      relation: match.relation,
      derived: derived.tag,
      derivedLabel: derived.label || null,
      value: match.value,
      personId,
      source: match.source,
    });
  }

  // ── Pass 5a-2: Apple Contacts ZABCDRELATEDNAME ──────────────────────────
  const contactsRel = scanContactsRelations(contacts);
  for (const r of contactsRel) {
    const personId = resolveNameToPerson(r.contactName, db, contacts, stmts);
    if (!personId) continue;
    if (alreadyTagged.has(personId)) continue;
    if (tags.has(personId)) continue;
    tags.set(personId, r.relation);
    labels.set(personId, r.label || null);
    vias.set(personId, 'apple-related');
    samples.push({
      via: 'apple-related',
      relation: r.relation,
      derivedLabel: r.label || null,
      value: r.contactName,
      personId,
      source: r.source,
    });
  }

  log?.(`  Pass 5a: ${tags.size} new family tags from content (identity=${identityMatches.length} matches scanned, apple-related=${contactsRel.length} matches scanned)`);
  return { tags, labels, vias, samples };
}
