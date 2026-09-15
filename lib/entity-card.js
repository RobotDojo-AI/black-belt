/**
 * lib/entity-card.js — the precomputed prose-card ceiling (st_c619d929).
 *
 * The prose `## Summary` that chat injects is the CEILING above the deterministic
 * floor (entity-floor.js). This module owns the single reusable Summary writer
 * (`buildEntityCardSummary`) that BOTH the first-card generator
 * (scripts/ingest/07-context.js) and the scheduled freshness refresh
 * (lib/entity-enrich.js) drive — so a card is produced one way, and freshness
 * rewrites the SAME injected section rather than a sibling one.
 *
 * "Excellent or omitted" is selective generation with a STRUCTURAL abstain floor
 * (`computeCardSignal`), checked BEFORE model routing (early-abstention cascade
 * ordering): below the floor no card is written and the live floor stands alone
 * — never a "we don't know much yet" stub. The signal is six structural
 * dimensions, never the summarizer grading its own draft (self-assessment
 * benches at/below no-abstention).
 *
 * ANTI-HALLUCINATION: the prompt is fed code-supplied edges (counterparty names
 * resolved by id) + current facts + the entity's own message context (ragChunks),
 * and every draft is run through TWO post-generation validators — both share the
 * same verbatim-context-or-graph-backed rule, split across two claim classes:
 *   - validateCardNames: a name is legitimate when it is graph-backed
 *     (edge/fact/owner) OR appears VERBATIM in the supplied context the model
 *     was shown. Flags only a plausible person/org name that appears NOWHERE in
 *     any supplied source; deliberately does not flag dates ("In February"),
 *     sentence-start fragments ("From Dana"/"Whether Sam"), or all-common-word
 *     terms ("Required Minimum Distribution").
 *   - validateCardDatesAndNumbers (design-unified-architecture.md §4.3,
 *     st_553e364b): the specific-date/specific-count validator names' own
 *     docstring explicitly excludes — catches an invented meeting date or an
 *     inflated headcount by the same verbatim-context rule: a real "50
 *     engineers" fact the model read in the person's own emails renders fine;
 *     one that appears nowhere in the supplied context is flagged.
 * Both are precision-favoring by design: a false rejection blocks a real card
 * and (before the loop-break below) would loop forever, which is worse than a
 * rare missed fabrication the 100%-code-built floor guards.
 *
 * LOOP-BREAK: a draft that fails validation is regenerated a bounded number of
 * times; if it still fails, the entity ABSTAINS to floor-only (writes no card) and
 * clears needs_regen so the backlog drains — a genuinely-unsummarizable entity
 * never loops. A later real data change refires needs_regen (changed floor) for a
 * fresh attempt; abstention is never a permanent give-up.
 *
 * LLM write boundary: only the prose Summary text is model-authored; every DB
 * write (provenance columns, needs_regen) is deterministic Tier-0 code.
 */

// INTELLIGENCE_TIER: synthesis — buildEntityCardSummary calls an LLM
// (llmCreate) and writeCardSummaryFile persists the result to a canonical
// markdown card under the entity's package (never a DB row the LLM itself
// writes; the deterministic writer above owns the file write).
export const INTELLIGENCE_TIER = 'synthesis';

import crypto from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { relationPhrase } from './relation-vocabulary.js';
import { entityPackageNameFromDisplay } from './context-paths.js';
import { USER_CONTEXTS_DIR, USER_CONTEXTS_REL } from './robotdojo-paths.js';
import { buildEntityFloor } from './entity-floor.js';
import { modelFor } from './model-lane.js';

function numEnv(name, dflt) {
  const n = Number.parseFloat(String(process.env[name] ?? ''));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function intEnv(name, dflt, min = 1) {
  const n = Number.parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(n) && n >= min ? n : dflt;
}

// The structural signal floor. Below this, abstain (no card) — the floor covers
// the entity. Tunable first-pass data, swappable with no schema change.
export const CARD_ABSTAIN_FLOOR = numEnv('ROBOTDOJO_CARD_ABSTAIN_FLOOR', 0.35);

// How many times a rejected draft is regenerated before the entity abstains to
// floor-only and clears needs_regen (the loop-break). Bounded and small: with the
// context-verbatim whitelist below, real-name rejections vanish, so a persistent
// failure is a genuine fabrication the model will not stop producing — retrying
// forever is the bug this replaces. Env-overridable per the no-hardcoded-tunables
// rule; min 1 (always at least one generation attempt).
export const CARD_MAX_VALIDATION_ATTEMPTS = intEnv('ROBOTDOJO_CARD_MAX_VALIDATION_ATTEMPTS', 2);

// Dimension weights (sum 1.0). connection_count + source_variety + recency +
// tier + fact_density + non_redundancy — all computable with no LLM.
const SIGNAL_WEIGHTS = Object.freeze({
  connection_count: 0.20,
  source_variety: 0.15,
  recency: 0.15,
  tier: 0.25,
  fact_density: 0.15,
  non_redundancy: 0.10,
});
const TARGET_EDGES = 6; // edges beyond which the connection dimension saturates.

// Tier → model. Sonnet is reserved for the owner's two most important tiers;
// everyone else regenerates on cheap Haiku so cost is never the staleness excuse.
export function contextTierFromN2(n2) {
  return (n2 === 'Family' || n2 === 'Core') ? 'sonnet' : 'haiku';
}
export function cardModelForN2(n2) {
  return contextTierFromN2(n2) === 'sonnet' ? modelFor('balanced') : modelFor('fast');
}

function tierDimension(n2) {
  switch (n2) {
    case 'Family': case 'Core': return 1.0;
    case 'Partners': case 'Customers': return 0.66;
    case 'Network': return 0.4;
    default: return 0.2;
  }
}

function recencyDimension(floor) {
  const stamps = [floor?.newestFactAt, ...(floor?.edges || []).map(() => null)].filter(Boolean);
  const newest = stamps.sort().pop();
  if (!newest) return 0;
  const t = Date.parse(newest);
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / 86_400_000;
  // today → 1, ~2y → 0.
  return Math.max(0, Math.min(1, 1 - days / 730));
}

/**
 * Score an entity's structural signal (0..1) across six dimensions. Deterministic
 * — reads the floor already assembled + the entity's n2. The card writer checks
 * this BEFORE choosing a model (early abstention).
 *
 * @returns {{score:number, dims:object}}
 */
export function computeCardSignal(db, entity, floor) {
  const edges = floor?.edges || [];
  const facts = floor?.facts || [];

  const connection_count = Math.min(1, edges.length / TARGET_EDGES);

  // source_variety: how many distinct evidence classes back this entity —
  // curated edges, weighted edges, and each present card-material fact type.
  const classes = new Set();
  if (edges.some((e) => e.source === 'curated')) classes.add('curated');
  if (edges.some((e) => e.source === 'weighted')) classes.add('weighted');
  for (const f of facts) classes.add(`fact:${f.fact_type}`);
  const source_variety = Math.min(1, classes.size / 5);

  const recency = recencyDimension(floor);
  const tier = tierDimension(entity?.n2 ?? floor?.entity?.n2 ?? null);

  const factTypes = new Set(facts.map((f) => f.fact_type));
  const fact_density = Math.min(1, factTypes.size / 3); // job_title/employer/location

  // non_redundancy: type diversity of the edge set. A set of ten identical
  // colleague edges is redundant (low); a mix of types is high.
  let non_redundancy = 0;
  if (edges.length) {
    const typeCounts = new Map();
    for (const e of edges) typeCounts.set(e.relType, (typeCounts.get(e.relType) || 0) + 1);
    const maxShare = Math.max(...typeCounts.values()) / edges.length;
    non_redundancy = 1 - maxShare + 1 / edges.length; // more types → higher; single-edge → 1
    non_redundancy = Math.max(0, Math.min(1, non_redundancy));
  }

  const dims = { connection_count, source_variety, recency, tier, fact_density, non_redundancy };
  let score = 0;
  for (const [k, w] of Object.entries(SIGNAL_WEIGHTS)) score += (dims[k] || 0) * w;
  return { score: Math.max(0, Math.min(1, score)), dims };
}

// Hash of the floor a card is built from. The regen NOOP guard compares the
// stored card_derived_hash against this — a fired dirty flag whose floor did not
// actually change costs no model call.
export function cardDerivedHash(floor) {
  const material = {
    jobTitle: floor?.jobTitle || null,
    employer: floor?.employer || null,
    location: floor?.location || null,
    ownerLine: floor?.ownerLine || '',
    edges: (floor?.edges || []).map((e) => `${e.counterpartyId}:${e.relType}:${e.source}`),
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

// ── Anti-hallucination name-whitelist validator ───────────────────────────────

// Words capitalized only by grammar or sentence position — never the distinctive
// token of a real person/org name. Two jobs: (1) a leading run of these is a
// sentence-start artifact and is stripped down to the name core ("In February" →
// "February", "From Priya" → "Priya", "Whether Barb" → "Barb"); (2) they count as
// "known" filler in token-coverage. Lowercase, matched case-insensitively. A
// linguistic constant (like months), not a business tunable.
const GRAMMAR_STOPWORDS = new Set([
  // articles / demonstratives / pronouns
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its', 'he', 'she',
  'they', 'we', 'you', 'i', 'his', 'her', 'their', 'your', 'our', 'my', 'him',
  'them', 'us',
  // conjunctions / sentence openers
  'and', 'but', 'or', 'nor', 'yet', 'so', 'then', 'than', 'because', 'although',
  'though', 'while', 'whereas', 'whether', 'if', 'as', 'also', 'however',
  'meanwhile', 'moreover', 'furthermore', 'additionally', 'therefore', 'thus',
  'hence', 'plus',
  // prepositions / connectors
  'in', 'on', 'at', 'to', 'for', 'of', 'by', 'with', 'from', 'into', 'onto',
  'over', 'under', 'about', 'across', 'between', 'among', 'during', 'through',
  'without', 'within', 'after', 'before', 'since', 'until', 'per', 'via', 'near',
  'around', 'toward', 'towards', 'upon',
  // question / relative words
  'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom', 'whose',
  // quantifiers / time adverbs
  'recently', 'currently', 'now', 'today', 'yesterday', 'tomorrow', 'later',
  'soon', 'both', 'either', 'neither', 'each', 'every', 'all', 'some', 'any',
  'no', 'not',
  // months / weekdays
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // titles / doc labels
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sir', 'mx', 'summary', 'history',
]);

// Common English nouns/adjectives that appear Title-Cased in business, financial,
// and personal prose but are NOT proper nouns. A multi-word candidate composed
// ENTIRELY of these (+ grammar words) is a term/phrase, not a name ("Required
// Minimum Distribution"), and is never flagged. As token-coverage filler they let
// a partly-common real name pass on its distinctive token ("Northwind Capital"
// clears on "Northwind"). Precision-favoring: including org-suffix words here is
// safe because a plausible name still requires one distinctive proper-noun token.
const COMMON_TERM_WORDS = new Set([
  'required', 'minimum', 'maximum', 'distribution', 'distributions', 'account',
  'accounts', 'statement', 'statements', 'balance', 'portfolio', 'retirement',
  'income', 'tax', 'taxes', 'trust', 'estate', 'fund', 'funds', 'capital',
  'group', 'holdings', 'partners', 'partnership', 'company', 'corporation',
  'incorporated', 'limited', 'associates', 'advisors', 'advisory', 'management',
  'services', 'service', 'solutions', 'ventures', 'plan', 'plans', 'meeting',
  'call', 'update', 'review', 'agreement', 'contract', 'proposal', 'invoice',
  'payment', 'transfer', 'wire', 'deposit', 'withdrawal', 'annual', 'quarterly',
  'monthly', 'weekly', 'daily', 'board', 'committee', 'department', 'division',
]);

function whitelistTokens(names) {
  const tokens = new Set();
  for (const n of names) {
    for (const w of String(n || '').split(/[\s,./&()-]+/)) {
      const t = w.trim().toLowerCase();
      if (t) tokens.add(t);
    }
  }
  return tokens;
}

// A word is proper-noun-like only if it is neither a grammar word nor a common
// Title-Cased term — i.e. it carries name identity. A candidate with zero such
// words is a date/term phrase, not a person/org name.
function isProperNounLike(word) {
  const lw = word.toLowerCase();
  return !GRAMMAR_STOPWORDS.has(lw) && !COMMON_TERM_WORDS.has(lw);
}

// Strip a leading run of grammar words (sentence-position / preposition / month
// artifacts) down to the name core. "In February" → ["February"]; "From Dana" →
// ["Dana"]; "Whether Sam" → ["Sam"]; a real "Alice Reyes" → unchanged.
function nameCore(candidate) {
  let words = String(candidate).split(/\s+/).filter(Boolean);
  while (words.length && GRAMMAR_STOPWORDS.has(words[0].toLowerCase())) words = words.slice(1);
  return words;
}

/**
 * Reject a plausible person/organization name in `text` that appears NOWHERE in
 * any supplied source — the anti-hallucination backstop above the 100%-code-built
 * floor.
 *
 * A multi-word Capitalized sequence is the hallucination risk. For each such
 * sequence we (1) strip a leading grammar run to the name core, (2) require ≥2
 * core words with ≥1 proper-noun-like token — anything else is a date, a
 * sentence-start fragment, or an all-common-word term and is passed over, and
 * (3) flag it ONLY when it is neither token-covered by the structured whitelist
 * (edges/facts/owner) nor present VERBATIM in the supplied context the model was
 * shown. The context path is what makes a real name from the person's own emails
 * (a counterparty or institution named verbatim in their messages) legitimate —
 * it is real code-supplied data, exactly AC-5's "from the actual data, never invented."
 *
 * Deterministic Tier-0 (no LLM). Precision-favoring: a false rejection blocks a
 * real card, so ambiguity resolves toward accept — the floor is the real guard.
 *
 * @param {string} text          the generated draft
 * @param {string[]} allowedNames structured graph names (edges/facts/owner)
 * @param {string} contextText   the raw context the model was shown (ragChunks +
 *                               timeline); a name present here verbatim is real
 * @returns {{ok:boolean, offending:string[]}}
 */
export function validateCardNames(text, allowedNames = [], contextText = '') {
  const allowed = whitelistTokens(allowedNames);
  const haystack = String(contextText || '').toLowerCase().replace(/\s+/g, ' ');
  const offending = [];
  const candidates = String(text || '').match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  for (const cand of candidates) {
    const words = nameCore(cand);
    if (words.length < 2) continue;                 // sentence-start artifact / lone name
    if (!words.some(isProperNounLike)) continue;    // date / all-common-word term → not a name
    const core = words.join(' ');
    const lower = words.map((w) => w.toLowerCase());
    const tokenCovered = lower.every((w) => allowed.has(w) || GRAMMAR_STOPWORDS.has(w) || COMMON_TERM_WORDS.has(w));
    const inContext = haystack.length > 0 && haystack.includes(core.toLowerCase());
    if (!tokenCovered && !inContext) offending.push(core);
  }
  return { ok: offending.length === 0, offending: [...new Set(offending)] };
}

// A specific calendar date: ISO (2026-03-14), slash (3/14/2026), or a named
// month with a day ("March 14th", "March 14, 2026"). Deliberately does NOT
// match a bare month or a bare year — those are the "In February"/"in 2024"
// context-setting phrases validateCardNames already excludes by design; a
// SPECIFIC day is the precision claim the story is about (a fabricated
// meeting date), not a vague time reference.
const MONTHS_RE = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const DATE_CLAIM_RE = new RegExp(
  `\\b(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|${MONTHS_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?)\\b`,
  'gi',
);

// A specific count claim: a number directly modifying a countable-people or
// scale noun ("50 engineers", "12 employees", "3 million users"). Deliberately
// narrow (like validateCardNames' proper-noun-like gate) — plenty of numbers
// in real prose are not fact claims (a date, a phone-adjacent digit run) and
// are left alone; only a number bound to one of these nouns is checked.
const NUMBER_CLAIM_RE = /\b\d[\d,]*(?:\.\d+)?\+?\s*(?:%|percent|engineers?|employees?|hires?|headcount|people|staff|users?|customers?|million|billion|thousand)\b/gi;

/**
 * Extend validateCardNames' anti-hallucination pattern to dates and numbers
 * (design-unified-architecture.md §4.3, st_553e364b) — the validator that
 * catches "invented meeting date" / "inflated headcount", which
 * validateCardNames explicitly excludes by design (its own docstring: "it
 * deliberately does not flag dates").
 *
 * Same verbatim-context check as validateCardNames: a specific date/number
 * claim is legitimate when it appears VERBATIM in the supplied context the
 * model was shown (ragChunks + timeline, via buildContextHaystack) — a real
 * "50 engineers" fact the model read in the person's own emails renders fine.
 * A claim that appears NOWHERE in that context is flagged. Deterministic
 * Tier-0 (no LLM). Precision-favoring, same rationale as validateCardNames: a
 * false rejection blocks a real card, so ambiguity resolves toward accept.
 *
 * @param {string} text        the generated draft
 * @param {string} contextText the raw context the model was shown
 * @returns {{ok:boolean, offending:string[]}}
 */
export function validateCardDatesAndNumbers(text, contextText = '') {
  const haystack = String(contextText || '').toLowerCase().replace(/\s+/g, ' ');
  const offending = [];
  for (const pattern of [DATE_CLAIM_RE, NUMBER_CLAIM_RE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(String(text || ''))) !== null) {
      const claim = match[0].trim();
      const normalized = claim.toLowerCase().replace(/\s+/g, ' ');
      const inContext = haystack.length > 0 && haystack.includes(normalized);
      if (!inContext) offending.push(claim);
    }
  }
  return { ok: offending.length === 0, offending: [...new Set(offending)] };
}

// Build the lowercased context haystack the validator matches names against — the
// same body content (ragChunks) and timeline summaries the prompt is built from,
// so a name the model could legitimately have used is always present to match.
export function buildContextHaystack(ragChunks = [], timelineEvents = []) {
  const parts = [];
  for (const c of ragChunks || []) if (c?.content) parts.push(String(c.content));
  for (const e of timelineEvents || []) if (e?.summary) parts.push(String(e.summary));
  return parts.join(' \n ');
}

// Real company names from the graph, process-cached (like loadSurnameSet). The
// card validator over-rejected legitimate company names a card legitimately
// mentions (a real employer/client) because the whitelist omitted the companies
// graph; feeding these in fixes the single shared validator for BOTH the
// first-card generator and the refresh path. Only names that PROVABLY exist in
// the graph are admitted — the AC-5 "from the actual data" contract.
let _knownCompanyNames = null;
export function knownCompanyNames(db) {
  if (_knownCompanyNames) return _knownCompanyNames;
  let names = [];
  try {
    names = db.prepare("SELECT DISTINCT name FROM companies WHERE name IS NOT NULL AND name != ''").all().map((r) => r.name);
  } catch { names = []; }
  _knownCompanyNames = names;
  return _knownCompanyNames;
}

export function cardNameWhitelistFor(entity, floor, ownerName, companyNames = []) {
  const names = [];
  const push = (n) => { if (n) names.push(n); };
  push(floor?.displayName);
  push(entity?.name || entity?.display_name);
  push(floor?.employer);
  push(floor?.jobTitle);
  push(floor?.location);
  push(ownerName);
  for (const e of floor?.edges || []) push(e.counterpartyName);
  for (const f of floor?.facts || []) push(f.fact_value);
  for (const c of companyNames || []) push(c);
  return names;
}

/**
 * Write the four card-provenance columns deterministically (Tier 0 — never the
 * model). Called by every card write (first-card generator + scheduled refresh)
 * alongside context_file_path so the sweep, the NOOP guard, and the as-of cue
 * have their inputs. Best-effort: a fixture lacking the columns must not crash
 * generation, but a real failure is surfaced (not silently swallowed).
 */
export function writeCardProvenance(db, table, id, { signalScore = null, derivedHash = null, generatedAt = null, modelTier = null } = {}) {
  try {
    db.prepare(
      `UPDATE ${table} SET card_signal_score = ?, card_derived_hash = ?, card_generated_at = ?, card_model_tier = ? WHERE id = ?`,
    ).run(signalScore, derivedHash, generatedAt || new Date().toISOString(), modelTier, String(id));
  } catch (err) {
    console.warn(`[entity-card] writeCardProvenance(${table}, ${id}) failed: ${err.message}`);
  }
}

// ── Prompt ─────────────────────────────────────────────────────────────────

function buildCardPrompt(entity, floor, { ownerName, ragChunks = [], timelineEvents = [] }) {
  const ownerRef = ownerName || 'the user';
  const name = floor?.displayName || entity?.name || entity?.display_name || 'this entity';

  const roleParts = [];
  if (floor?.jobTitle && floor?.employer) roleParts.push(`${floor.jobTitle} at ${floor.employer}`);
  else if (floor?.jobTitle) roleParts.push(floor.jobTitle);
  else if (floor?.employer) roleParts.push(`at ${floor.employer}`);
  if (floor?.location) roleParts.push(`based in ${floor.location}`);

  const edgeLines = (floor?.edges || [])
    .map((e) => `- ${e.counterpartyName} (${String(e.relType || '').replace(/-/g, ' ')})`)
    .join('\n');

  const relationLead = entity?.relation_tag
    ? `- Relationship (SOURCE TRUTH from the entity graph — state it plainly, never re-infer): this person is ${ownerRef}'s ${entity.relation_derived_phrase || relationPhrase(entity.relation_tag, entity.relation_label)}`
    : (floor?.ownerLine ? `- Owner connection: ${floor.ownerLine}` : '');

  const ragContext = (ragChunks || [])
    .slice(0, 8)
    .map((c) => `[${String(c.event_time || '').slice(0, 7)}] ${String(c.content || '').slice(0, 800)}`)
    .filter((s) => s.length > 12)
    .join('\n\n---\n\n');

  const timelineContext = (timelineEvents || [])
    .slice(0, 5)
    .map((e) => `${String(e.event_date || '').slice(0, 10)}: ${e.summary || ''}`.trim())
    .filter(Boolean)
    .join('\n');

  return `You are writing the private "current read" that ${ownerRef} sees before thinking about ${name}.
This is not a CRM card and not a wiki bio. The goal is recognition: ${ownerRef} should feel oriented to a real ${entity?.type || 'entity'}, the relationship, and what matters now.

Write the Summary body only. Use 2-4 short paragraphs. No heading, no bullets, no field list.
Be specific and source-grounded. Use ONLY the facts, connections, and evidence provided below — do not invent names, companies, relationships, or events. If signal is thin, say what is known and what is provisional in human language.

ENTITY:
- Name: ${name}${roleParts.length ? `\n- Role: ${roleParts.join(', ')}` : ''}
${relationLead ? `${relationLead}\n` : ''}CONNECTIONS (the only people/orgs you may name besides ${name} and ${ownerRef}):
${edgeLines || '- (none recorded)'}

RELEVANT CONTEXT (from email/calendar/messages/transcripts):
${ragContext || '(no body content available)'}

RELATIONSHIP TIMELINE (recent milestones):
${timelineContext || '(no timeline events recorded)'}

Cover the live read on who they are in ${ownerRef}'s world, how ${ownerRef} knows them, and the current posture. Avoid labels like "Type:", "Recent:", "structured data", "database", or "record". Do not invent details not supported above.`;
}

async function defaultLlm(args) {
  // Same skip flag reactsNullPass honors — lets a black-box test run the real
  // enrich entrypoint with zero spend by returning empty (caller keeps the flag).
  if (process.env.ENTITY_ENRICH_SKIP_LLM === '1' || process.env.ROBOTDOJO_ENTITY_ENRICH_SKIP_LLM === '1') {
    return { content: [{ text: '' }] };
  }
  const { llmCreate } = await import('./llm-gateway.js');
  return llmCreate(args, 'entity-card-summary');
}

/**
 * Produce the validated `## Summary` prose for one entity, or abstain.
 *
 * Ordering (early-abstention cascade): compute the structural signal FIRST; below
 * the floor, return {abstained:true} WITHOUT any model call. Above the floor,
 * route the model (Haiku default, Sonnet for {Family, Core}) and generate. The
 * draft is validated against the structured whitelist AND the verbatim context the
 * prompt was built from, so real names from the person's own messages pass — PLUS
 * validateCardDatesAndNumbers, so an invented meeting date or inflated headcount
 * can't render as a bare fact either (design-unified-architecture.md §4.3). On a
 * validation failure the draft is regenerated up to CARD_MAX_VALIDATION_ATTEMPTS
 * times; if every attempt fails, return {validationFailed:true} (the caller then
 * abstains to floor-only and clears needs_regen — the loop-break). An empty draft
 * (transient model failure, not a reject) returns {empty:true} for a plain retry.
 *
 * @returns {Promise<{summary:string|null, abstained:boolean, signal:object,
 *   model?:string, tierName?:string, empty?:boolean, validationFailed?:boolean,
 *   offending?:string[], attempts?:number}>}
 */
export async function buildEntityCardSummary(db, entity, floor, {
  llm = defaultLlm,
  ownerName = null,
  ragChunks = [],
  timelineEvents = [],
  n2 = undefined,
  signal = null,
  maxTokens = null,
} = {}) {
  const sig = signal || computeCardSignal(db, entity, floor);
  if (sig.score < CARD_ABSTAIN_FLOOR) {
    return { summary: null, abstained: true, signal: sig };
  }
  const tierN2 = n2 !== undefined ? n2 : (entity?.n2 ?? floor?.entity?.n2 ?? null);
  const tierName = contextTierFromN2(tierN2);
  const model = cardModelForN2(tierN2);
  const tokens = maxTokens || (tierName === 'sonnet' ? 768 : 512);
  const prompt = buildCardPrompt(entity, floor, { ownerName, ragChunks, timelineEvents });

  // Validate against BOTH the structured graph names and the verbatim context the
  // model was shown — a real name from the person's own emails is legitimate data.
  // Real company names from the graph are admitted so a card that names a real
  // company (a real employer/client) is not over-rejected (AC-11b).
  const whitelist = cardNameWhitelistFor(entity, floor, ownerName, knownCompanyNames(db));
  const contextText = buildContextHaystack(ragChunks, timelineEvents);

  let offending = [];
  for (let attempt = 1; attempt <= CARD_MAX_VALIDATION_ATTEMPTS; attempt++) {
    const resp = await llm({ model, max_tokens: tokens, messages: [{ role: 'user', content: prompt }] });
    const text = String(resp?.content?.[0]?.text || '').trim();
    // Empty is a transient model/gateway failure, not a deterministic reject —
    // return immediately so the caller keeps needs_regen for a plain next-run retry
    // rather than burning the bounded validation attempts on a down gateway.
    if (!text) return { summary: null, abstained: false, empty: true, signal: sig, model, tierName };

    const nameCheck = validateCardNames(text, whitelist, contextText);
    const dateNumberCheck = validateCardDatesAndNumbers(text, contextText);
    if (nameCheck.ok && dateNumberCheck.ok) {
      return { summary: text, abstained: false, signal: sig, model, tierName, attempts: attempt };
    }
    offending = [...nameCheck.offending, ...dateNumberCheck.offending];
  }
  // Every bounded attempt named something backed by nothing — genuine fabrication.
  // Signal the caller to abstain-and-clear (loop-break); the floor still covers.
  return { summary: null, abstained: false, validationFailed: true, offending, signal: sig, model, tierName, attempts: CARD_MAX_VALIDATION_ATTEMPTS };
}

function personCardAbsPath(person) {
  return resolve(USER_CONTEXTS_DIR, 'people', entityPackageNameFromDisplay(person.id, person.display_name || person.name || person.id), 'context.md');
}
function personCardRepoPath(person) {
  return `~/robotdojo/${USER_CONTEXTS_REL}/people/${entityPackageNameFromDisplay(person.id, person.display_name || person.name || person.id)}/context.md`;
}

/**
 * Ensure a high-value person has a context.md package on disk and a DB pointer.
 *
 * WHY: enrichment and chat summary injection both require context_file_path.
 * High-value people (Family/Core/Partners/…) can land in the graph with
 * needs_regen=0 and no card after excellent-or-omitted abstention — they then
 * never enter the enrich queue. This is a deterministic Tier-0 skeleton only
 * (floor facts / relation line when available; never a fake "we don't know yet"
 * prose card). LLM Summary writing still goes through writeCardSummaryFile /
 * buildEntityCardSummary.
 *
 * Idempotent: if the pointer already targets an existing file, returns it.
 * If the pointer is missing or the file is gone, creates the package and
 * stamps needs_regen=1 so the enrich worker fills timeline/topics next.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string, display_name?: string, name?: string, n2?: string, context_file_path?: string|null }} person
 * @param {{ summaryBody?: string|null, forceNeedsRegen?: boolean }} [opts]
 * @returns {string|null} repo-relative context_file_path, or null if person has no id
 */
export function ensurePersonContextSkeleton(db, person, opts = {}) {
  const id = String(person?.id || '').trim();
  if (!id) return null;
  const homePath = (p) => (String(p).startsWith('~') ? String(p).replace('~', homedir()) : String(p));
  const existingPtr = person.context_file_path || null;
  if (existingPtr) {
    const abs = homePath(existingPtr);
    if (existsSync(abs)) {
      if (opts.forceNeedsRegen) {
        try { db.prepare('UPDATE people SET needs_regen = 1 WHERE id = ?').run(id); } catch { /* fixture */ }
      }
      return existingPtr;
    }
  }

  const display = person.display_name || person.name || 'Person';
  const abs = personCardAbsPath(person);
  const rel = personCardRepoPath(person);
  let summaryBody = String(opts.summaryBody || '').trim();
  if (!summaryBody) {
    // Prefer a deterministic floor render when available — real graph facts, not a stub.
    try {
      const floor = buildEntityFloor(db, {
        id,
        type: 'person',
        name: display,
        display_name: display,
        n2: person.n2,
      });
      summaryBody = String(floor?.rendered || '').trim();
    } catch { /* floor optional */ }
  }
  if (!summaryBody) {
    const tier = person.n2 ? ` (${person.n2})` : '';
    summaryBody = `${display}${tier} — local graph record. Summary card pending enrichment.`;
  }

  const content = `---\nentity_id: ${id}\nentity_type: person\ndisplay_name: ${display}\ngenerated_at: ${new Date().toISOString()}\nenrichment: skeleton\n---\n# ${display}\n\n## Summary\n\n${summaryBody}\n\n---\n\n## History\n\n_No prior history recorded yet._\n`;
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, abs);
  try {
    db.prepare('UPDATE people SET context_file_path = ?, needs_regen = 1 WHERE id = ?').run(rel, id);
  } catch {
    try { db.prepare('UPDATE people SET context_file_path = ? WHERE id = ?').run(rel, id); } catch { /* fixture */ }
  }
  person.context_file_path = rel;
  return rel;
}

/**
 * Write the freshly-generated `## Summary` into the person's context file — the
 * originating-bug fix: freshness now rewrites the SAME section chat injects.
 *
 *   - existing card  → swap the `## Summary` body in place, `## History` intact.
 *   - cardless person → create the file (frontmatter + `# Name` + Summary +
 *     History placeholder) and set context_file_path so the promoted-but-cardless
 *     person gets a FIRST card.
 *
 * Returns the repo-relative context_file_path (also written to the row for a new
 * file). Atomic (.tmp + rename) so a crash mid-write leaves the original intact.
 */
export function writeCardSummaryFile(db, person, summaryBody) {
  const body = String(summaryBody || '').trim();
  const homePath = (p) => (String(p).startsWith('~') ? String(p).replace('~', homedir()) : String(p));
  if (person.context_file_path) {
    const abs = homePath(person.context_file_path);
    const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    const next = replaceSummaryBody(existing, body);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp`;
    writeFileSync(tmp, next, 'utf8');
    renameSync(tmp, abs);
    return person.context_file_path;
  }
  const abs = personCardAbsPath(person);
  const content = `---\nentity_id: ${person.id}\nentity_type: person\ndisplay_name: ${person.display_name || ''}\ngenerated_at: ${new Date().toISOString()}\nenrichment: card\n---\n# ${person.display_name || 'Person'}\n\n## Summary\n\n${body}\n\n---\n\n## History\n\n_No prior history recorded yet._\n`;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  const rel = personCardRepoPath(person);
  try { db.prepare('UPDATE people SET context_file_path = ? WHERE id = ?').run(rel, person.id); } catch { /* fixture without column */ }
  person.context_file_path = rel;
  return rel;
}

/**
 * Swap the `## Summary` body of a context-file markdown, leaving `## History`
 * (and everything below the `---` fold) untouched. Creates the section if the
 * file has none (first card for a promoted-but-cardless person).
 */
export function replaceSummaryBody(markdown, newBody) {
  const content = String(markdown || '');
  const body = String(newBody || '').trim();
  const SUMMARY = '## Summary';
  const idx = content.indexOf(SUMMARY);
  if (idx < 0) {
    return `${SUMMARY}\n\n${body}\n\n---\n\n## History\n\n${content.trim() || '_No prior history recorded yet._'}\n`;
  }
  const bodyStart = idx + SUMMARY.length;
  const delimIdx = content.indexOf('\n\n---\n\n', bodyStart);
  const historyIdx = content.indexOf('\n## History', bodyStart);
  let end = content.length;
  if (delimIdx >= 0) end = delimIdx;
  else if (historyIdx >= 0) end = historyIdx;
  const prefix = content.slice(0, bodyStart);
  const suffix = content.slice(end);
  return `${prefix}\n\n${body}${suffix}`;
}
