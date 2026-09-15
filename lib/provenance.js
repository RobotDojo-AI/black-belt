/**
 * lib/provenance.js — the provenance contract (unified design,
 * design-unified-architecture.md §1.1, stories st_553e364b / st_5184eb86 /
 * st_1b2ee2f0).
 *
 * INTELLIGENCE_TIER = 'extraction' (deterministic; no LLM). Pure functions,
 * no DB access — every store keeps its own native provenance columns; this
 * module only maps a row the caller already fetched onto one shared shape
 * and owns the policy decisions built on top of it.
 *
 * The one idea: every claim the system holds is tagged by a closed
 * three-value `source_class` enum (trust order highest to lowest):
 *   user-stated    — the owner said it directly (a correction, a stated fact)
 *   primary-source — from a real structured document/column (resume title,
 *                    a DB column, a confirmed calendar event)
 *   llm-distilled  — a model inferred it from prose (a guessed date, a CC
 *                    co-presence edge, a RAG-only narrative claim)
 *
 * Centralizing the mapping + the hedge policy here means the distiller, the
 * card renderer, and the graph ranker cannot silently drift on what "trusted"
 * means (Stonebraker's rule — a cross-store invariant belongs in one place,
 * never copy-pasted per consumer). The "never, ever wrong" guarantee this
 * unlocks is provenance-GATED assertion: the system never prints an
 * inference as a bare fact — see hedgePolicy() below.
 */

export const INTELLIGENCE_TIER = 'extraction';

function numEnv(name, dflt) {
  const n = Number.parseFloat(String(process.env[name] ?? ''));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// ── The closed enum ──────────────────────────────────────────────────────────

// Every resolver in this file returns exactly one of these three values —
// never a fourth. Object.freeze makes an accidental extra key a runtime error
// at write time, not a silent drift discovered later at read time.
export const SOURCE_CLASS = Object.freeze({
  USER_STATED: 'user-stated',
  PRIMARY_SOURCE: 'primary-source',
  LLM_DISTILLED: 'llm-distilled',
});

const VALID_SOURCE_CLASSES = new Set(Object.values(SOURCE_CLASS));

export function isValidSourceClass(value) {
  return VALID_SOURCE_CLASSES.has(value);
}

// ── Hedge / omit tunables ────────────────────────────────────────────────────

// Confidence thresholds gating an llm-distilled claim's render policy.
// Env-overridable (no buried literals) — mirrors the lib/entity-floor.js /
// lib/entity-card.js numEnv convention. Calibrate on the live confidence
// distribution once it exists; these are the first-pass defaults.
export const HEDGE_FLOOR = numEnv('ROBOTDOJO_PROVENANCE_HEDGE_FLOOR', 0.5);
export const OMIT_FLOOR = numEnv('ROBOTDOJO_PROVENANCE_OMIT_FLOOR', 0.3);

// ── entity_facts.model_tier → source_class/confidence ───────────────────────

// One mapping, shared by resolveSourceClass()'s entity_facts branch below AND
// every entity_facts writer (insertFact/bulkExtractFacts in lib/entity-facts.js)
// — never duplicated (Carmack: duplication is a maintenance burden waiting to
// drift). 'free' tier is structured-column extraction (a real DB column read
// verbatim, e.g. linkedin_title, companies.name) → primary-source/1.0.
// 'haiku'/'sonnet' inferred the fact from prose → llm-distilled/0.6, the same
// default confidence the owner-run legacy-row backfill uses (design §1.2).
// Anything else (missing/unrecognized model_tier) is the conservative default:
// llm-distilled/0.6, never assumed-trusted.
export function sourceClassForModelTier(modelTier) {
  if (modelTier === 'free') return { sourceClass: SOURCE_CLASS.PRIMARY_SOURCE, confidence: 1.0 };
  return { sourceClass: SOURCE_CLASS.LLM_DISTILLED, confidence: 0.6 };
}

// ── Edge-source trust map (§3, consumed by lib/entity-floor.js ranking) ─────

// Full-trust structural sources (a real company-affiliation column, direct
// interaction history, a curated relation tag) = 1.0. An inferred edge (email
// CC co-presence) = 0.2, so it can never outrank a primary-source edge and can
// only surface when a person has few/no primary-source connections —
// provenance-WEIGHTING, not deletion.
export const EDGE_SOURCE_TRUST = Object.freeze({
  company_affiliation: 1.0,
  company_affiliation_direct: 1.0,
  interaction_history: 1.0,
  relation_tag: 1.0,
  email_cc_copresence: 0.2,
});

// Unknown source → conservative low trust, never assumed-good. Env-overridable
// like every other tunable in this file.
const UNKNOWN_EDGE_TRUST = numEnv('ROBOTDOJO_EDGE_UNKNOWN_TRUST', 0.2);

export function edgeSourceTrust(source) {
  if (source && Object.prototype.hasOwnProperty.call(EDGE_SOURCE_TRUST, source)) {
    return EDGE_SOURCE_TRUST[source];
  }
  return UNKNOWN_EDGE_TRUST;
}

// ── resolveSourceClass — the one cross-store mapping ────────────────────────

/**
 * Map one physical store's native row onto the single source_class shape
 * every consumer (distiller, card renderer, graph ranker) reads through.
 * `store` selects the mapping; `row` is whatever the caller already fetched
 * from that table — this function never queries a database itself.
 *
 * @param {'entity_facts'|'entity_claims'|'person_relations'|'entity_relationships'} store
 * @param {Object} row
 * @returns {'user-stated'|'primary-source'|'llm-distilled'}
 */
export function resolveSourceClass(store, row) {
  const r = row || {};
  switch (store) {
    case 'entity_facts': {
      // A backfilled or newly-written row already carries its own tag — trust
      // it. A legacy (pre-provenance) row is NULL and falls back to the
      // model_tier mapping, conservatively landing on llm-distilled for
      // anything that isn't free-tier structured extraction.
      if (r.source_class) return r.source_class;
      return sourceClassForModelTier(r.model_tier).sourceClass;
    }

    case 'entity_claims': {
      // Native column — the table's CHECK constraint already enforces the
      // closed set at write time; this just surfaces it through the same read
      // shape as the other three stores.
      if (!isValidSourceClass(r.source_class)) {
        throw new Error(`resolveSourceClass(entity_claims): invalid source_class "${r.source_class}"`);
      }
      return r.source_class;
    }

    case 'person_relations': {
      // person_relations refuses inference-class writes at the write path
      // (lib/relation-store.js converts an inferred assert into a queued
      // candidate) — it only ever holds owner/contact/stated authority, never
      // an llm-distilled row. 'owner' is the highest trust tier (the user
      // stated it); 'contact'/'stated' (a real person told us, or a document
      // stated it) map to primary-source.
      if (r.authority === 'owner') return SOURCE_CLASS.USER_STATED;
      if (r.authority === 'contact' || r.authority === 'stated') return SOURCE_CLASS.PRIMARY_SOURCE;
      throw new Error(`resolveSourceClass(person_relations): unrecognized authority "${r.authority}"`);
    }

    case 'entity_relationships': {
      // No native source_class column — bucket by the same edge trust map §3
      // uses for ranking: a full-trust structural source (1.0) is
      // primary-source; anything discounted (an inferred/low-confidence
      // source, e.g. CC co-presence) is llm-distilled for hedging purposes,
      // even though it was produced by deterministic SQL, not a model — the
      // enum here tracks trust tier, not literally "who wrote this row."
      return edgeSourceTrust(r.source) >= 1.0 ? SOURCE_CLASS.PRIMARY_SOURCE : SOURCE_CLASS.LLM_DISTILLED;
    }

    case 'memory_log': {
      // Chunk 7A revision (design-unified-architecture.md §7A, st_5184eb86).
      // The memory protocol has every entry authored by an agent PROCESS —
      // `author: 'miyagi'/'chat'/'auto-memory'/...` — never literally
      // 'owner' (see docs/memory-log-spec.md, CLAUDE.md's own
      // `--author miyagi` example). `author` therefore cannot be the
      // authoritative signal; using it made every entry, including
      // verbatim-quoted owner feedback, resolve llm-distilled. The real
      // distinction is GROUNDING: does the entry's body attribute a quote
      // to the owner (isOwnerGrounded), or is it the agent's own
      // generalization/conclusion? Recomputed from `body` every time —
      // for a legacy entry AND a freshly-written one, identically — so a
      // stray or forged source_class tag in frontmatter can never diverge
      // from what the body actually supports.
      return isOwnerGrounded(r.body) ? SOURCE_CLASS.USER_STATED : SOURCE_CLASS.LLM_DISTILLED;
    }

    default:
      throw new Error(`resolveSourceClass: unknown store "${store}"`);
  }
}

// ── memory-log owner-grounding (Chunk 7A revision) ──────────────────────────

// A memory-log entry is GROUNDED in what the owner actually said only when
// its body attributes a quote to the owner explicitly: the literal label
// "Owner" + colon + at least one whitespace character + an opening quote
// (straight or curly, single or double) — e.g. `Owner: 'the core principle
// is to get to great beta product...'` (see the real entry
// user/memory/log/*-great-beta-product-northstar.md).
//
// The mandatory whitespace between the colon and the quote is load-bearing,
// not stylistic: without it, a self-referential mention of the token itself
// — e.g. "No 'Owner:' line in notes; owner is the PM people field." (a real
// log entry describing a board schema convention) — false-positives, because the
// phrase's OWN closing quote sits directly against the colon with no space.
// Verified against every entry in the live log before shipping: exactly the
// 4 genuine owner-quote entries match; the schema-field mention does not.
//
// Deliberately narrow: a bare mention of the word "owner", or any quoted
// text with no attribution label, does not count. This is the ONLY signal
// that decides source_class — not `author` (every entry is authored by an
// agent process; see the case above) and not a caller-supplied flag.
const OWNER_QUOTE_RE = /\bOwner\s*:\s+["'‘“]/i;

export function isOwnerGrounded(body) {
  return OWNER_QUOTE_RE.test(String(body || ''));
}

// resolveSourceClass('memory_log', row) surfaces just the enum value, the
// same shape every other store returns. Memory-log callers (lib/memory.js
// getLogIndex, lib/distill-sources/memory-log.js gather) also need the
// paired `status` (the provisional marker), so this wraps both in one place
// rather than re-deriving "grounded? else provisional" independently in two
// files that would inevitably drift. `row.body` is the only field read.
export function resolveMemoryLogProvenance(row) {
  const sourceClass = resolveSourceClass('memory_log', row);
  const status = sourceClass === SOURCE_CLASS.LLM_DISTILLED ? 'provisional' : null;
  return { sourceClass, status };
}

// ── hedgePolicy — assert / hedge / omit ─────────────────────────────────────

/**
 * Decide how a claim renders: assert it plainly, hedge it, or omit it
 * entirely. user-stated and primary-source ALWAYS assert — the "never, ever
 * wrong" guarantee is provenance-gated, not confidence-gated: the system only
 * ever asserts plainly what a human said or a real document backs.
 * llm-distilled is gated on confidence against the two floors.
 *
 * @param {'user-stated'|'primary-source'|'llm-distilled'} sourceClass
 * @param {number} confidence
 * @returns {'assert'|'hedge'|'omit'}
 */
export function hedgePolicy(sourceClass, confidence) {
  if (sourceClass === SOURCE_CLASS.USER_STATED || sourceClass === SOURCE_CLASS.PRIMARY_SOURCE) {
    return 'assert';
  }
  if (sourceClass === SOURCE_CLASS.LLM_DISTILLED) {
    const c = Number(confidence);
    // An unreadable/missing confidence on an inferred claim is the worst
    // case, not a free pass — never assert, and never silently omit either
    // (that would drop real signal); hedge is the conservative default so the
    // claim still surfaces, softened.
    if (!Number.isFinite(c)) return 'hedge';
    return c < OMIT_FLOOR ? 'omit' : 'hedge'; // >= OMIT_FLOOR (incl. the
    // between-floors band and >= HEDGE_FLOOR) all hedge — only a confidence
    // below OMIT_FLOOR drops the claim entirely.
  }
  throw new Error(`hedgePolicy: unknown source_class "${sourceClass}"`);
}

// ── hedgePhrase — the deterministic hedge wrapper ───────────────────────────

/**
 * Deterministic hedge wrapper for text whose hedgePolicy() resolved to
 * 'hedge'. Never fabricates a precise date — `date` is a presence SIGNAL
 * (truthy when the caller already has a real date shown elsewhere, e.g. a
 * timeline line's own date column), never a value this function prints
 * itself, so there is no code path here that can manufacture a date string.
 * Assert paths (user-stated/primary-source) never call this — the caller
 * checks hedgePolicy() first and only wraps text whose policy is 'hedge'.
 *
 * @param {string} text
 * @param {{date?: boolean|string|null}} [opts] truthy when a real date is
 *   known and rendered elsewhere by the caller
 * @returns {string} the hedged text, or '' for empty/whitespace-only input
 */
export function hedgePhrase(text, { date = null } = {}) {
  const clean = String(text || '').trim().replace(/[.\s]+$/, '');
  if (!clean) return '';
  return date
    ? `${clean} (appears to be the case, based on available signals)`
    : `${clean} — date not confirmed`;
}
