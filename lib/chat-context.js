/**
 * Layered context assembly for chat system prompts.
 *
 * buildLayeredContext(query, options) assembles all context layers in order,
 * applies a dynamic token budget, and returns a single string to inject into
 * the system prompt. Every layer is try/catch guarded — a failed layer never
 * breaks chat.
 *
 * Layers (White + Black belts unless noted):
 *   0   — Topic preamble (context_md from user_topics)
 *   0.5 — Entity profile cards (Black Belt; people/companies/places detected in query)
 *   0.55 — Source-backed entity timeline (Black Belt; timeline + linked RAG evidence)
 *   0.6 — Interaction signal (Black Belt; per-person person_interactions summary)
 *   0.7 — Memory continuity (latest/next/timeline projection from immutable logs)
 *   1   — Hybrid RAG (vector + FTS via retrieve())
 *   2   — Entity-associated content (Black Belt; chunks linked via chunk_entities)
 *   3   — Referenced conversation injection (UUID detected in query)
 *   6   — Public web context (Black Belt; safe public entity/lookup queries)
 *
 * Token budget: 12000 tokens / ~48000 chars total.
 * RAG gets 50% priority. Remaining layers share the rest.
 *
 * Entity-centric architecture: content surfaces by association to a person,
 * company, or place, not by data type. Health, calendar, messages — all flow through
 * chunk_entities rather than direct type-specific SQL queries.
 */

import db from './db.js';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { LRUCache } from 'lru-cache';
import { retrieve } from './rag/retrieve.js';
import { braveSearch, formatSearchContext } from './brave-search.js';
import { secret } from './config.js';
import { getIdentityCard } from './identity-card.js';
import { REPO_ROOT } from './robotdojo-paths.js';
import { searchMeaningfulEntities } from './network-queries.js';
import { buildMemoryContextPacket, summarizeMemoryContextPacket } from './memory-context.js';
import { topicHistoryCiteInstruction } from './topic-live-thread.js';
import { appEvents } from './app-events.js';
import { relationPhrase, RELATION_WORD_STRIP_RE } from './relation-vocabulary.js';
import { areNicknamesEquivalent } from './nickname-resolver.js';
import { formatEntityTimelineSection, getEntityTimeline } from './entity-timeline.js';
import { buildEntityFloor } from './entity-floor.js';

// Macrotask yield. setImmediate drains the I/O / timer queues (not just the
// microtask queue a bare `await Promise.resolve()` would), so a concurrently-
// streaming chat turn's pending SSE write flushes before the caller resumes.
// Falls back to setTimeout(0) where setImmediate is unavailable (non-Node).
const tick = () =>
  new Promise((res) =>
    (typeof setImmediate === 'function' ? setImmediate : (f) => setTimeout(f, 0))(res),
  );

// ─── Entity-span resolution memo (st_fd14cdd4 — warm-turn dominant cost) ──────
//
// WHY: the name-span matcher resolves a typed span with a `display_name LIKE`
// query. The word-start `% word%` branch is UN-INDEXABLE. Over the FULL people
// table SQLite narrows to active rows via idx_people_archived and then SCANS them
// (~341k live, 99.5% tier='acquaintance' email-backfill noise). Measured cost: a
// single mid-word LIKE scan was ~0.45–1.3 s warm, multiples cold.
// resolveEntitiesFromText() calls the matcher ONCE PER DISCOVERED SPAN, and a chat
// turn resolves entities TWICE — once over the query (entity-context layers) and
// once over the rolling window (the inline-recognition SSE chip frame). The window
// is a superset of the query, so the two passes re-resolve heavily overlapping
// spans, and a multi-word query fans out into many spans. Per the ctx-trace
// measurement this `entities.detect` + `inline_recognition` pair was the dominant,
// contention-amplified warm-turn term (284 ms quiet → 5.4 s under writer load),
// the one cost in our code that pushed a warm turn past the 5 s target.
//
// FIX (two parts):
//   1. BOUND the candidate set. The chat path calls searchMeaningfulEntities —
//      now the sole entity-search query, after the unbounded variant that backed
//      the removed @-mention person-search route was deleted (st_fd14cdd4
//      follow-up, 2026-06-13). That query is
//      scoped to MEANINGFUL_PERSON_PREDICATE and pins idx_people_searchable_name,
//      so the LIKE branch touches the ~16k meaningful set instead of 341k rows —
//      measured ~0.4 ms/span vs ~416 ms. This is the PERMANENT fix: acquaintance
//      noise never re-inflates the scan as the table grows. Real people
//      (core/network, anyone with a context file, real comms history, or a high
//      score) still resolve; only email-address noise stops matching.
//   2. MEMOIZE the per-span lookup. The span → matched-rows map is a pure
//      function of (the immutable-within-a-turn) people/companies/places name
//      columns, so a short TTL is safe: a newly-ingested contact becomes
//      resolvable within TTL_MS, and the entity pipeline is not on the chat read
//      path. The two passes and the span fan-out within one conversation window
//      collapse to ONE lookup per distinct span + memo hits. better-sqlite3 is
//      synchronous, so the memo also stops repeated lookups from re-blocking the
//      event loop. Keyed on the trimmed span only (limit is constant 10 at the
//      sole hot call site, which is now the only call site — the network-UI /
//      @-mention caller was removed).
const ENTITY_SPAN_MEMO_TTL_MS = (() => {
  const env = parseInt(process.env.ROBOTDOJO_ENTITY_SPAN_MEMO_TTL_MS || '', 10);
  return Number.isInteger(env) && env >= 0 ? env : 30_000;
})();
const _entitySpanMemo = new LRUCache({ max: 2000, ttl: ENTITY_SPAN_MEMO_TTL_MS });

/**
 * Memoized wrapper over searchMeaningfulEntities for the chat hot path. Returns
 * an array of matched entity rows, bounded to the meaningful candidate set.
 * Cache miss runs the bounded lookup; cache hit
 * skips it. Errors are NOT cached — a transient failure (e.g. network tables
 * missing on a fresh install) must not pin an empty result for the whole TTL.
 *
 * @param {string} span - the discovered name span (already trimmed/lowercased by discoverEntitySpans)
 * @returns {Array} matched entity rows
 */
function searchEntitiesMemoized(span) {
  const key = span;
  const cached = _entitySpanMemo.get(key);
  if (cached !== undefined) return cached;
  const rows = searchMeaningfulEntities(db, span, 10);
  _entitySpanMemo.set(key, rows);
  return rows;
}

function searchEmailIdentifierExact(email) {
  const value = String(email || '').toLowerCase().trim();
  if (!value) return [];
  return db.prepare(`
    SELECT p.id, p.uuid, p.display_name, p.n1, p.n2, 'person' as type,
           COALESCE(p.score, 0) as score, ? AS matched_name
    FROM person_identifiers pi
    JOIN people p ON p.id = pi.person_id
    WHERE pi.type = 'email'
      AND pi.value = ?
      AND COALESCE(p.archived, 0) = 0
      AND COALESCE(p.service_vendor, 0) = 0
      AND p.display_name NOT LIKE '%@%'
    ORDER BY COALESCE(p.score, 0) DESC, p.display_name COLLATE NOCASE ASC
    LIMIT 5
  `).all(value, value);
}

function isSqliteBusyError(err) {
  const message = String(err?.message || err?.code || err || '');
  return err?.code === 'SQLITE_BUSY'
    || err?.code === 'SQLITE_LOCKED'
    || /SQLITE_(BUSY|LOCKED)|database is locked|database locked/i.test(message);
}

/** Test hook — clear the entity resolution memos between assertions. */
export function _clearEntitySpanMemo() {
  _entitySpanMemo.clear();
  _entityEnrichMemo.clear();
}

const CHARS_PER_TOKEN = 4;
// st_2cd1af73 UNIFIED WATERFALL — the VOLATILE (uncached layered) context budget
// lifts 48k → 60k chars. Under the unified waterfall the stable blocks (product
// prompt, voice canon, identity, world brief, topic summary) all ride the CACHED
// prefix and are read at ~10% on warm turns; the extra room earned by that
// efficiency goes entirely to the volatile tail (RAG + entity-bearing layers),
// where per-turn evidence lives. Precedence (build conventions): env var >
// config/defaults.json chat_context.total_char_budget > hardcoded 60000. NEVER
// mid-truncates — the layers select pre-computed tiers (topic/entity 4k
// summaries) or whole units, and empty space is correct ("leave empty rather than
// fill with noise"): an empty layer contributes '' and the budget simply goes
// unused rather than being padded.
const TOTAL_CHAR_BUDGET = (() => {
  const env = parseInt(process.env.ROBOTDOJO_CONTEXT_CHAR_BUDGET || '', 10);
  if (Number.isInteger(env) && env > 0) return env;
  try {
    const d = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'config', 'defaults.json'), 'utf8'),
    );
    const v = d?.chat_context?.total_char_budget;
    if (Number.isInteger(v) && v > 0) return v;
  } catch { /* defaults.json absent/unreadable — fall through to hardcode */ }
  return 60000;
})();
const RAG_CHAR_BUDGET = Math.floor(TOTAL_CHAR_BUDGET * 0.5);
const OTHER_CHAR_BUDGET = TOTAL_CHAR_BUDGET - RAG_CHAR_BUDGET;

// IDENTITY_CHAR_FLOOR — protected reserve for the Layer -1 identity card
// (st_0c491456 Phase 1c). Identity is "who I am" and must reach the model
// every turn; if topic/entities/RAG already consumed OTHER_CHAR_BUDGET, the
// addSection() cap would slice identity to zero — the exact starvation bug
// this floor exists to prevent. When charRemaining drops below the floor
// BEFORE identity is added, we reset charRemaining to the floor so identity
// gets a guaranteed slot from a protected reserve. Downstream sections then
// share whatever remains. 3000 chars ≈ 750 tokens — enough for name +
// family + identity + career one-paragraph distillations from
// wk_user/context.md without crowding the rest.
const IDENTITY_CHAR_FLOOR = 3000;

// Per-layer budget floors for the entity-bearing layers (st_b50005df Phase 5,
// AC-1b). WHY: independent-injection holds for FAILURE (a rejected layer
// degrades to '' and never blocks others) but NOT for BUDGET — the non-RAG
// layers share OTHER_CHAR_BUDGET via addSection() in fixed priority order, so a
// large Layer-0 topic preamble (up to TOPIC_CHAR_BUDGET = 12000 chars, i.e. all
// of OTHER_CHAR_BUDGET) consumes the budget BEFORE the entity cards (0.5),
// interaction signal (0.6), and entity content (2) layers are added — the exact
// layers that prove "knows your world." Those layers then get sliced to zero.
//
// FIX: reserve a guaranteed minimum for each entity-bearing layer BEFORE the
// greedy fill runs, so an earlier high-priority layer can spend the shared
// budget down to (but never past) the sum of the still-unfilled reserves. The
// reserve is released back to the running budget the moment its own layer is
// added (or skipped, if the layer is empty), so a layer that produced no
// content never withholds budget from the rest. Identity keeps its existing
// dedicated floor (handled separately above the greedy fill). Each value is a
// modest slice — enough to carry the load-bearing first lines of the layer
// (the entity name + dominant interaction signal + the most-recent linked
// chunk) without starving RAG or topic. Env-overridable per build conventions.
function envFloor(name, fallback) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}
const ENTITY_CARDS_CHAR_FLOOR = envFloor('ROBOTDOJO_ENTITY_CARDS_CHAR_FLOOR', 1500);
const ENTITY_TIMELINE_CHAR_FLOOR = envFloor('ROBOTDOJO_ENTITY_TIMELINE_CHAR_FLOOR', 1200);
const INTERACTION_SIGNAL_CHAR_FLOOR = envFloor('ROBOTDOJO_INTERACTION_SIGNAL_CHAR_FLOOR', 1000);
const ENTITY_CONTENT_CHAR_FLOOR = envFloor('ROBOTDOJO_ENTITY_CONTENT_CHAR_FLOOR', 1500);
// st_2cd1af73 Phase 5: topic and entity context budgets dropped 12k → 4k. Each
// context file now leads with a tight `## Summary` section (the writer caps it
// at ~4k); the injector reads ONLY that summary by default and the 4k budget is
// the whole summary, not a truncation. Legacy files with no `## Summary`
// delimiter fall back to a verbatim first-4k slice — safe because those files
// lead with the chat summary, so the budget drop never truncates the wrong
// region (failure manifest: forward-rolling, no flag day). The per-layer entity
// floors below are unchanged, so dropping the topic budget cannot starve the
// entity-bearing layers. Env-overridable per build conventions.
const TOPIC_CHAR_BUDGET = envFloor('ROBOTDOJO_TOPIC_CHAR_BUDGET', 4000);
const ENTITY_CONTEXT_CHAR_BUDGET = envFloor('ROBOTDOJO_ENTITY_CONTEXT_CHAR_BUDGET', 4000);
const FAST_ENTITY_CARD_CHAR_LIMIT = envFloor('ROBOTDOJO_FAST_ENTITY_CARD_CHAR_LIMIT', 1200);
const FAST_TIMEOUT_CONTEXT_CHAR_LIMIT = envFloor('ROBOTDOJO_FAST_TIMEOUT_CONTEXT_CHAR_LIMIT', 4000);

const WEB_RE = /latest|news|current|today|search|look up|find out|what is|who is|stock|price/i;
const PRIVATE_WEB_RE = /\b(my|mine|our|ours|your|robotdojo|robot dojo|private|personal|email|calendar|message|messages|conversation|thread|relationship|network|contact|contacts)\b/i;
const PUBLIC_LOOKUP_WEB_TIMEOUT_MS = 900;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Stopwords stripped from query-span discovery so a phrase like "find email
// about budget" doesn't try to resolve "find" / "about" as an entity name.
// Includes common conversational nouns/verbs that also occur as whole words
// inside many entity display names ("today" in "Northwind Today", "calendar"
// in "Master Calendar", "user"/"customer"/"guest" in service-account names) —
// these prefix/word-match real rows yet are never the user's intended entity.
const ENTITY_SPAN_STOPWORDS = new Set([
  'the','and','for','with','about','from','have','has','was','are','were',
  'find','tell','ask','show','give','that','this','what','when','where','who',
  'how','why','can','could','would','should','will','one','two','three',
  'recent','last','first','next','some','any','all','more','most','few',
  'me','you','my','your','our','his','her','their','its','him','them',
  'yes','yep','yeah','sure','okay',
  'today','tomorrow','yesterday','week','month','year','day','time','date',
  'calendar','event','events','meeting','meetings','email','emails','message',
  'messages','note','notes','record','records','file','files','document',
  'user','users','customer','guest','group','master','resource','site',
  'great','good','team','company','people','person','contact','contacts',
  'entity','entities','network','data',
  'weather','know','about','please','thanks','thank',
  'short','brief','concise','version','useful',
]);
const ENTITY_SPAN_BOUNDARY_WORDS = new Set([
  'the','and','for','with','about','from','have','has','was','are','were',
  'is','am','be','been','being','in','on','at','by','to','of','or','as',
  'find','tell','ask','show','give','use','using','that','this','what','when',
  'where','who','how','why','can','could','would','should','will','me','you',
  'my','your','our','please','thanks','thank',
]);
const EMAIL_ADDRESS_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const ENTITY_SPAN_MAX_TOKENS = 4;

// Single-token spans must be at least this long to be searched on their own —
// short tokens ("dan" excepted via name match) overwhelmingly prefix-match
// unrelated rows. Multi-token spans bypass this (they are already specific).
const MIN_SINGLE_TOKEN_LEN = 3;
const FAST_MEMORY_FACT_LIMIT = 300;
const FAST_MEMORY_CONTEXT_LIMIT = 5;
const FAST_MEMORY_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'what', 'when', 'where', 'which', 'who',
  'why', 'how', 'did', 'does', 'do', 'can', 'could', 'would', 'should', 'will',
  'with', 'about', 'into', 'from', 'your', 'you', 'my', 'our', 'asked', 'ask',
  'remember', 'remembered', 'fact', 'exact', 'specific',
]);

function tokenizeFastMemory(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !FAST_MEMORY_STOPWORDS.has(token));
}

/**
 * Discover candidate name-spans from a query, longest contiguous runs first.
 *
 * WHY (st_f1a40461): the prior matcher did a loose substring containment test
 * (LIKE '%hani%' + word-part overlap) which conflated Sam Okafor / Sam Rivera
 * — a single shared first name was enough to surface the wrong person. We now
 * generate contiguous token spans (1..N tokens, no stopwords) and resolve each
 * through the accurate `searchEntities` matcher (prefix / word-start / exact,
 * exact-first ordered — the same matcher `/api/entities/search` uses). Once a
 * longer span resolves, the shorter sub-spans it covers are suppressed so
 * "Sam Okafor" never falls back to the ambiguous bare-"Sam" search.
 *
 * Returns ordered span descriptors: { span, start, end, len }.
 */
function discoverEntitySpans(text) {
  const lower = String(text || '').toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const runBounds = new Map();
  let runStart = null;
  for (let i = 0; i <= tokens.length; i++) {
    const boundary = i === tokens.length || ENTITY_SPAN_BOUNDARY_WORDS.has(tokens[i]);
    if (!boundary && runStart === null) runStart = i;
    if (boundary && runStart !== null) {
      for (let j = runStart; j < i; j++) runBounds.set(j, [runStart, i - 1]);
      runStart = null;
    }
  }
  const spans = [];
  for (let i = 0; i < tokens.length; i++) {
    if (ENTITY_SPAN_BOUNDARY_WORDS.has(tokens[i])) continue;
    const run = runBounds.get(i);
    const maxLen = run ? Math.min(ENTITY_SPAN_MAX_TOKENS, run[1] - i + 1) : Math.min(ENTITY_SPAN_MAX_TOKENS, tokens.length - i);
    for (let len = Math.min(ENTITY_SPAN_MAX_TOKENS, tokens.length - i); len >= 1; len--) {
      if (len > maxLen) continue;
      const slice = tokens.slice(i, i + len);
      // Stopwords should suppress bare conversational tokens ("short") without
      // making real multi-word names impossible ("Dana Ellis").
      if (slice.some((t, idx) => t.length < 2 && !(len >= 3 && idx > 0 && idx < len - 1))) continue;
      if (len === 1 && ENTITY_SPAN_STOPWORDS.has(slice[0])) continue;
      // A bare single token must clear MIN_SINGLE_TOKEN_LEN; multi-token spans
      // are already specific enough to search.
      if (len === 1 && slice[0].length < MIN_SINGLE_TOKEN_LEN) continue;
      const span = slice.join(' ');
      if (span.length < 3) continue;
      spans.push({ span, start: i, end: i + len - 1, len, runStart: run?.[0] ?? i, runEnd: run?.[1] ?? (i + len - 1) });
    }
  }
  // Most tokens first, then longest string — so multi-word names resolve
  // before their constituent single tokens.
  spans.sort((a, b) => (b.len - a.len) || (b.span.length - a.span.length));
  return spans;
}

/**
 * Resolve detected entities from arbitrary text via the accurate matcher.
 *
 * Shared by detectQueryEntities (single query) and detectEntitiesInWindow
 * (rolling conversation window). Accepts only word-start / exact matches
 * (enforced by searchEntities' LIKE patterns), suppresses sub-spans covered
 * by a longer matched span, and dedupes per (type,id). People are ranked by
 * people.score DESC then interaction_count DESC so the right same-first-name
 * person surfaces (Sam Okafor over Sam Rivera when "Sam Okafor" was typed).
 */
/**
 * True when `span` aligns to whole-word boundaries inside `name` — i.e. the
 * span's tokens match a contiguous run of complete words in the name. This
 * tightens searchEntities' prefix-LIKE result so a single common token
 * ("yes") does not accept a name where it is only a sub-word prefix ("Yesil").
 */
function spanMatchesNameWords(span, name) {
  const spanToks = String(span || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const nameToks = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!spanToks.length || !nameToks.length) return false;
  if (spanToks.length >= 2) {
    const spanComparable = dropInteriorInitials(spanToks);
    const nameComparable = dropInteriorInitials(nameToks);
    for (let i = 0; i + spanComparable.length <= nameComparable.length; i++) {
      let all = true;
      for (let j = 0; j < spanComparable.length; j++) {
        const spanTok = spanComparable[j];
        const nameTok = nameComparable[i + j];
        const matched = j === 0
          ? areNicknamesEquivalent(spanTok, nameTok)
          : spanTok === nameTok;
        if (!matched) { all = false; break; }
      }
      if (all) return true;
    }
  }
  for (let i = 0; i + spanToks.length <= nameToks.length; i++) {
    let all = true;
    for (let j = 0; j < spanToks.length; j++) {
      if (nameToks[i + j] !== spanToks[j]) { all = false; break; }
    }
    if (all) return true;
  }
  return false;
}

function dropInteriorInitials(tokens) {
  if (tokens.length <= 2) return tokens;
  return tokens.filter((token, idx) => idx === 0 || idx === tokens.length - 1 || token.length > 1);
}

function normalizeEntityAlias(value) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowHasExactAliasMatch(span, row) {
  const alias = normalizeEntityAlias(row?.matched_name);
  if (!alias) return false;
  const normalizedSpan = normalizeEntityAlias(span);
  if (alias === normalizedSpan) return true;
  const aliasToks = dropInteriorInitials(alias.split(/\s+/).filter(Boolean));
  const spanToks = dropInteriorInitials(normalizedSpan.split(/\s+/).filter(Boolean));
  if (aliasToks.length < 2 || aliasToks.length !== spanToks.length) return false;
  for (let i = 0; i < aliasToks.length; i++) {
    const matched = i === 0
      ? areNicknamesEquivalent(aliasToks[i], spanToks[i])
      : aliasToks[i] === spanToks[i];
    if (!matched) return false;
  }
  return true;
}

function addResolvedRows(rows, seen, matched) {
  for (const r of matched) {
    const key = `${r.type}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
  }
}

export function resolveEntitiesFromText(text, { limit = 8, throwBusy = false } = {}) {
  if (!text || text.length < 3) return [];
  const seen = new Set();          // `${type}:${id}` dedup
  const rows = [];

  // Exact email strings are identifiers, not fuzzy name spans. Resolve the
  // full address first, then remove it from span discovery so `gmail com` and
  // local-part fragments cannot inject unrelated entities.
  const textWithoutEmails = String(text).replace(EMAIL_ADDRESS_RE, (email) => {
    try {
      addResolvedRows(rows, seen, searchEmailIdentifierExact(email));
    } catch (err) {
      if (throwBusy && isSqliteBusyError(err)) throw err;
      /* network tables missing on fresh install */
    }
    return ' ';
  });

  // st_df0a8d71 QA fix — relation-vocabulary words are NEVER entity tokens.
  // Hyphenated relation words fragment under tokenization ("mother-in-law" →
  // "mother"/"law") and the fragments surname-match unrelated people (live
  // repro: "Who is my mother-in-law?" served an unrelated contact's profile
  // card via a bare "law" span). Strip the closed vocabulary before span
  // discovery; a real name that happens to CONTAIN a relation word loses only
  // that token — its remaining tokens still resolve via word-start matching.
  const textWithoutRelations = textWithoutEmails.replace(RELATION_WORD_STRIP_RE, ' ');

  const spans = discoverEntitySpans(textWithoutRelations);
  if (!spans.length && !rows.length) return [];

  const coveredRanges = [];        // [start,end] of spans that produced matches
  const blockedRanges = [];        // [start,end] of failed multi-token run spans

  for (const s of spans) {
    // Skip a span fully contained in an already-matched longer span. This is
    // what prevents the bare-"ada" fallback from re-introducing Sam Rivera
    // after "ada lovelace" already resolved precisely.
    if (coveredRanges.some(r => s.start >= r[0] && s.end <= r[1])) continue;
    if (blockedRanges.some(r => s.start >= r[0] && s.end <= r[1])) continue;
    let matched = [];
    try {
      matched = searchEntitiesMemoized(s.span);
    } catch (err) {
      if (throwBusy && isSqliteBusyError(err)) throw err;
      /* network tables missing on fresh install */
    }
    // Precision guard: searchEntities does PREFIX/word-start LIKE matching, so
    // a common single token ("yes", "today", "records") can prefix-match an
    // unrelated name ("Yesil", "Northwind Today", "Records1"). Require the span
    // to align to whole WORD boundaries within the candidate's name — the span
    // must equal a run of complete words. Multi-word spans satisfy this
    // naturally; this only filters loose single-token prefix noise. Exact /
    // multi-word same-name resolution (Sam Okafor) is unaffected.
    const aliasAccepted = matched.filter(r => rowHasExactAliasMatch(s.span, r));
    const accepted = aliasAccepted.length
      ? aliasAccepted
      : matched.filter(r => spanMatchesNameWords(s.span, r.display_name));
    if (!accepted.length) {
      // A failed short full-run like "Google Photos" should block its subspans
      // so "Google" does not inject an unrelated entity. Do not apply that block
      // to max-length runs: those are often clipped lists ("Sam Okafor, Acme
      // Labs") where the full span is expected to fail and the subspans are the
      // actual entities.
      if (s.len >= 2 && s.len < ENTITY_SPAN_MAX_TOKENS && s.start === s.runStart && s.end === s.runEnd) {
        blockedRanges.push([s.start, s.end]);
      }
      continue;
    }
    coveredRanges.push([s.start, s.end]);
    addResolvedRows(rows, seen, accepted);
  }

  // Enrich + rank. People rank by score DESC then interaction_count DESC;
  // companies/places keep searchEntities' own ordering (people_count /
  // frequency surfaced as `score`). Enrichment runs a per-id JOIN read; it is
  // memoized (same TTL rationale as the span memo) so the query/window double
  // pass and span fan-out do not re-read the same entity's profile each time.
  const enriched = rows.map((r) => enrichDetectedEntityMemoized(r, { throwBusy }));
  enriched.sort((a, b) => {
    if (a.type === 'person' && b.type === 'person') {
      return (b.score || 0) - (a.score || 0) ||
        (b.interaction_count || 0) - (a.interaction_count || 0);
    }
    return 0;
  });

  // Collapse same-name duplicates (the live DB still carries un-merged
  // Sam Okafor rows; dedup is owned by the ingest pipeline). Keep the
  // best-ranked row per (type, lowercased name).
  const byName = new Map();
  for (const e of enriched) {
    const nameKey = `${e.type}:${(e.name || '').toLowerCase()}`;
    if (!byName.has(nameKey)) byName.set(nameKey, e);
  }
  return [...byName.values()].slice(0, limit);
}

/**
 * Hydrate a searchEntities row into the entity shape the context layers and
 * the recognition SSE frame consume: { id, name, type, summary,
 * context_file_path, n2, score, interaction_count }.
 */
function enrichDetectedEntity(r, { throwBusy = false } = {}) {
  const base = {
    id: r.id,
    name: r.display_name,
    type: r.type,
    n2: r.n2 || null,
    score: r.score || 0,
    matched_name: r.matched_name || null,
    interaction_count: 0,
    context_file_path: null,
    summary: '',
  };
  try {
    if (r.type === 'person') {
      const row = db.prepare(`
        SELECT p.short_name, p.tier, p.last_seen, p.context_file_path,
               p.interaction_count, p.relation_tag, p.relation_label,
               p.relation_derived_phrase,
               c.name AS company_name
        FROM people p
        LEFT JOIN companies c ON c.id = p.company_id
        WHERE p.id = ?
      `).get(r.id);
      if (row) {
        base.context_file_path = row.context_file_path || null;
        base.interaction_count = row.interaction_count || 0;
        // st_df0a8d71 AC-1/AC-2 (second-tier read) — the graph relationship
        // LEADS the summary for relation-tagged entities, so every consumer of
        // this enrichment (fast fallback signal line, direct local answers,
        // recognition chips) carries graph truth ahead of any derived text.
        // Single-row indexed read, already memoized — no new hot-path cost.
        // st_f67bc2eb AC-2 — the walk-derived phrase ("wife's cousin") is the
        // most precise truth; tag+label stays the fallback (already exact for
        // direct relations).
        base.relation_tag = row.relation_tag || null;
        base.relation_label = row.relation_label || null;
        base.relation_derived_phrase = row.relation_derived_phrase || null;
        const relationLead = row.relation_tag
          ? `Your ${row.relation_derived_phrase || relationPhrase(row.relation_tag, row.relation_label)} (relationship from your entity graph)`
          : null;
        const parts = [
          relationLead,
          row.company_name && `Works at ${row.company_name}`,
          row.tier && `Tier: ${row.tier}`,
          row.last_seen && `Last seen: ${String(row.last_seen).split('T')[0]}`,
        ].filter(Boolean);
        base.summary = parts.length ? parts.join('. ') : 'Person in your network';
      }
    } else if (r.type === 'company') {
      const row = db.prepare('SELECT tier, people_count, industry, context_file_path FROM companies WHERE id = ?').get(r.id);
      if (row) {
        base.context_file_path = row.context_file_path || null;
        const parts = [
          row.industry,
          row.people_count && `${row.people_count} contacts`,
          row.tier && `Tier: ${row.tier}`,
        ].filter(Boolean);
        base.summary = parts.length ? parts.join('. ') : 'Company in your network';
      }
    } else if (r.type === 'place') {
      const row = db.prepare('SELECT place_type, frequency, last_seen, context_file_path FROM places WHERE id = ?').get(r.id);
      if (row) {
        base.context_file_path = row.context_file_path || null;
        const parts = [
          row.place_type && `Type: ${row.place_type}`,
          row.frequency != null && `${row.frequency} visits`,
          row.last_seen && `Last seen: ${String(row.last_seen).slice(0, 10)}`,
        ].filter(Boolean);
        base.summary = parts.length ? parts.join('. ') : 'Place in your world model';
      }
    }
  } catch (err) {
    if (throwBusy && isSqliteBusyError(err)) throw err;
    /* enrichment is best-effort */
  }
  return base;
}

// Per-entity enrichment memo (st_fd14cdd4). enrichDetectedEntity runs a per-id
// JOIN read (people↔companies) or a single-row companies/places read; the same
// entity is enriched again on the second resolution pass (window after query)
// and whenever a span fans out to the same id. Memoize on (type:id) under the
// same short TTL as the span memo. Keyed off the row's resolved id/type so a
// rename or tier change reflects within TTL; chat-read-path only.
const _entityEnrichMemo = new LRUCache({ max: 4000, ttl: ENTITY_SPAN_MEMO_TTL_MS });
function enrichDetectedEntityMemoized(r, { throwBusy = false } = {}) {
  const key = `${r.type}:${r.id}`;
  const cached = _entityEnrichMemo.get(key);
  if (cached !== undefined) return cached;
  const enriched = enrichDetectedEntity(r, { throwBusy });
  _entityEnrichMemo.set(key, enriched);
  return enriched;
}

/**
 * Detect people, companies, and places mentioned in the query.
 * Returns { id, name, type, summary, context_file_path, n2, score,
 * interaction_count } — Layer 0.5 (cards), Layer 0.6 (interaction signal),
 * and Layer 2 (chunk_entities lookup) all share one resolution pass.
 *
 * st_f1a40461: resolution routes through searchEntities (exact-first,
 * word-start) instead of the old loose substring filter, so same-first-name
 * people (Sam Okafor vs Sam Rivera) are never conflated.
 */
export async function detectQueryEntities(query) {
  return resolveEntitiesFromText(query, { limit: 8 });
}

async function detectDirectQueryEntities(query) {
  const retryMs = [25, 75, 150, 300, 600];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return resolveEntitiesFromText(query, { limit: 8, throwBusy: true });
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt >= retryMs.length) throw err;
      await sleep(retryMs[attempt]);
    }
  }
}

/**
 * Detect entities across a rolling conversation window (AC9 inline
 * recognition). Same accurate matcher as detectQueryEntities; the only
 * difference is the input is a multi-turn char-capped text blob so a contact
 * named in an earlier turn still surfaces in a later turn.
 */
export async function detectEntitiesInWindow(windowText) {
  return resolveEntitiesFromText(windowText, { limit: 8 });
}

/**
 * Build the minimal high-confidence context needed for first-token chat.
 *
 * Full layered context may wait on embeddings/RAG. This path is intentionally
 * lexical and local: resolve the named entities, attach their context cards,
 * and add compact interaction signal. It gives the model enough evidence to
 * recognize "who this is" when the slower retrieval layer times out.
 */
export async function buildFastEntityContext(query, { belt = 'white', onTiming = null, entityDetectionText = null } = {}) {
  // Entity cards are a world-model layer (Black). Beta ships friends on Black.
  // For White, still allow entity cards when the query is clearly personal
  // identity/relationship — otherwise "who is my wife" degrades to stock model.
  const text = String(query || '');
  const personalEntityAsk = /\b(who (?:am i|is|are)|my (?:wife|husband|spouse|son|daughter|family|friend|colleague|contact)|about me)\b/i.test(text);
  if (!query) return '';
  if (belt !== 'black' && !personalEntityAsk) return '';
  const emitTiming = (phase, started) => {
    if (typeof onTiming === 'function') {
      try { onTiming({ phase, ms: Date.now() - started }); } catch {}
    }
  };

  let entities = [];
  try {
    const started = Date.now();
    entities = (await detectQueryEntities(entityDetectionText || query)).slice(0, 8);
    emitTiming('fast_context.entities.detect', started);
  } catch {
    return '';
  }
  if (!entities.length) return '';

  const sections = [];
  try {
    const started = Date.now();
    const cards = [];
    for (const e of entities) {
      const body = composeEntityCardBody(e).slice(0, FAST_ENTITY_CARD_CHAR_LIMIT);
      if (body) cards.push(`### ${e.name}\n${body}`);
    }
    if (cards.length) sections.push(`## Entities mentioned\n${cards.join('\n\n')}`);
    emitTiming('fast_context.entity_cards', started);
  } catch { /* guarded */ }

  // Source-backed entity timeline is intentionally excluded from the fast
  // fallback. Its live linked-evidence query can monopolize the event loop for
  // seconds under page-cache or writer contention, and the fast path exists to
  // protect first token. Full/deep layered context still carries this layer.

  try {
    const started = Date.now();
    const interaction = await layerInteractionSignal(entities);
    if (interaction) sections.push(interaction);
    emitTiming('fast_context.interaction_signal', started);
  } catch { /* guarded */ }

  return sections.join('\n\n').trim();
}

/**
 * Cheap timeout fallback for explicitly saved chat facts.
 *
 * Full layered context can time out under DB/model contention. The timeout path
 * used to keep only entity cards, which meant a freshly stored `user-fact`
 * could be present in vectors and still absent from the prompt. This bounded
 * lexical pass scans only recent chat-saved facts and injects strong overlap
 * matches. It never touches vector search, web search, or broad corpus tables.
 */
export async function buildFastMemoryContext(query, { onTiming = null } = {}) {
  const started = Date.now();
  const queryTokens = new Set(tokenizeFastMemory(query));
  if (queryTokens.size < 2) return '';

  try {
    const rows = db.prepare(`
      SELECT id, topic, content, created_at
      FROM chunks
      WHERE source_type = 'user-fact'
      ORDER BY id DESC
      LIMIT ?
    `).all(FAST_MEMORY_FACT_LIMIT);

    const scored = [];
    for (const row of rows) {
      const contentTokens = new Set(tokenizeFastMemory(row.content));
      let overlap = 0;
      for (const token of queryTokens) {
        if (contentTokens.has(token)) overlap += 1;
      }
      if (overlap >= 2) scored.push({ ...row, overlap });
    }

    scored.sort((a, b) => (b.overlap - a.overlap) || (b.id - a.id));
    const hits = scored.slice(0, FAST_MEMORY_CONTEXT_LIMIT);
    if (!hits.length) return '';

    return [
      '## Recently saved facts',
      ...hits.map((hit) => `[user-fact:${hit.topic}]\n${hit.content}`),
    ].join('\n\n');
  } catch {
    return '';
  } finally {
    if (typeof onTiming === 'function') {
      try { onTiming({ phase: 'fast_context.memory_facts', ms: Date.now() - started }); } catch {}
    }
  }
}

function normalizeEnrichmentFaults(value) {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  const raw = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  return new Set(raw.map((v) => String(v || '').trim()).filter(Boolean));
}

function hasEnrichmentFault(faults, name) {
  return faults.has('all')
    || faults.has(name)
    || faults.has(`${name}_error`)
    || faults.has(`${name}.error`);
}

function hasSlowEnrichmentFault(faults, name) {
  return faults.has('all_slow')
    || faults.has(`${name}_slow`)
    || faults.has(`${name}.slow`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (typeof timer.unref === 'function') timer.unref();
  });
}

async function runFastFallbackLayer(name, faults, timeoutMs, fn) {
  if (hasEnrichmentFault(faults, 'fast_context') || hasEnrichmentFault(faults, name)) return '';
  if (hasSlowEnrichmentFault(faults, name)) {
    await sleep(timeoutMs);
    return '';
  }
  try {
    return await fn();
  } catch {
    return '';
  }
}

export async function buildFastTimeoutContext(query, {
  belt = 'white',
  onTiming = null,
  entityDetectionText = null,
  enrichmentFaults = null,
  layerTimeoutMs = 250,
} = {}) {
  const faults = normalizeEnrichmentFaults(enrichmentFaults);
  const [memoryFallback, entityFallback] = await Promise.all([
    runFastFallbackLayer('fast_memory', faults, layerTimeoutMs, () => buildFastMemoryContext(query, { onTiming })),
    runFastFallbackLayer('fast_entities', faults, layerTimeoutMs, () => buildFastEntityContext(query, { belt, onTiming, entityDetectionText })),
  ]);
  const context = [memoryFallback, entityFallback]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, FAST_TIMEOUT_CONTEXT_CHAR_LIMIT);
  return {
    context,
    trace: {
      present: Boolean(context),
      cache_hit: false,
      timeout: true,
      tier: context ? 'fast_timeout_fallback' : null,
      chars: context.length,
      sections: [
        memoryFallback ? 'fast_memory_facts' : null,
        entityFallback ? 'fast_entities' : null,
      ].filter(Boolean),
      source_types: memoryFallback ? ['user-fact'] : [],
      target_types: [],
      event_types: [],
    },
  };
}

const DIRECT_ENTITY_LOOKUP_RE =
  /\b(who\s+is|who's|tell\s+me\s+about|what\s+do\s+(?:we|i)\s+know\s+about|remind\s+me\s+how\s+(?:i|we)\s+know|how\s+do\s+(?:i|we)\s+know|what\s+is\s+my\s+history\s+with|my\s+history\s+with)\b|\b(?:why\s+)?(?:is|isn['’]?t)\s+.{2,120}\bin\s+(?:my|the)\s+(?:entity\s+)?network\b|\b(?:find|look\s+up|lookup|search\s+for|show\s+me|pull\s+up)\s+(?!email|emails|message|messages|latest|last\b).{2,120}\b(?:in\s+(?:my|the)\s+(?:entity\s+)?network)?\b/i;

const DIRECT_ENTITY_DISQUALIFY_RE =
  /\b(ask|draft|write|send|reply|email|opener|proposal|plan|strategy|should\s+i|what\s+should|compare|latest\s+messages|last\s+thing|discussed|schedule|book|create|make)\b/i;

function stripDirectEntityMarkdown(markdown, { compact = false } = {}) {
  let text = String(markdown || '').trim();
  if (!text) return '';
  text = text
    .replace(/^#\s+.+$/gm, '')
    .replace(/^\*[^*\n]*(?:Known since|Last contact|Professional|Personal|Acquaintance|Partners)[^*\n]*\*$/gmi, '')
    .replace(/,\s*reachable at\s+\S+@\S+\.\s*/gi, '. ')
    .replace(/\breachable at\s+\S+@\S+[.,]?\s*/gi, '')
    .replace(/,\s*and\s+(?:his|her|their)\s+phone number is\s+[^.]+\.?\s*/gi, '. ')
    .replace(/\b(?:his|her|their)\s+phone number is\s+[^.]+\.?\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(p => !/^[-*_]{3,}$/.test(p))
    .filter(p => !/^##?\s+/i.test(p));
  if (compact) {
    return paragraphs
      .flatMap(p => p.split(/(?<=[.!?])\s+(?=[A-Z0-9])/))
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(' ')
      .trim();
  }
  const limit = compact ? 2 : 3;
  return paragraphs.slice(0, limit).join('\n\n').trim();
}

function directEntityLocalSignal(entity) {
  const parts = [];
  if (entity?.n2) parts.push(entity.n2);
  if (entity?.interaction_count) parts.push(`${entity.interaction_count} interactions`);
  const summary = String(entity?.summary || '').trim();
  if (summary && !/^Person in your network$|^Company in your network$|^Place in your world model$/i.test(summary)) {
    parts.push(summary.replace(/\.$/, ''));
  }
  return parts.length ? `Local signal: ${parts.join(' · ')}.` : '';
}

/**
 * Build an immediate local answer for direct known-entity lookup prompts.
 *
 * This is deliberately narrow. It does not answer planning, drafting, "latest
 * messages", or relationship-analysis prompts; those still need synthesis. It
 * exists so "Who is Sam Okafor?" can feel recognized from the local entity card
 * instead of waiting on the full model path.
 */
export async function buildDirectEntityAnswer(query, { belt = 'white', onTiming = null } = {}) {
  if (belt !== 'black' || !query) return null;
  const q = String(query || '').trim();
  if (!DIRECT_ENTITY_LOOKUP_RE.test(q)) return null;
  if (DIRECT_ENTITY_DISQUALIFY_RE.test(q)) return null;

  const started = Date.now();
  const entities = (await detectDirectQueryEntities(q))
    .filter(e => e && (e.context_file_path || e.interaction_count > 0 || (e.score || 0) >= 1));
  if (typeof onTiming === 'function') {
    try { onTiming({ phase: 'direct_entity.detect', ms: Date.now() - started }); } catch {}
  }
  if (entities.length !== 1) return null;

  const entity = entities[0];
  const contextStarted = Date.now();
  const context = composeEntityCardBody(entity);
  if (typeof onTiming === 'function') {
    try { onTiming({ phase: 'direct_entity.context', ms: Date.now() - contextStarted }); } catch {}
  }
  const compact = /\b(short|brief|concise|quick|useful version)\b/i.test(q);
  const summary = stripDirectEntityMarkdown(context, { compact });
  if (!summary) return null;

  const signal = directEntityLocalSignal(entity);
  const asksNetworkExistence = /\bis\s+.{2,120}\bin\s+(?:my|the)\s+(?:entity\s+)?network\b|\bin\s+(?:my|the)\s+(?:entity\s+)?network\b/i.test(q);
  const answerLead = asksNetworkExistence ? `Yes. ${entity.name} is in your network.` : '';
  // st_df0a8d71 AC-2 — the no-model local answer LEADS with the deterministic
  // graph relationship for relation-tagged entities, so a card whose prose
  // omits or contradicts the relationship (the defect's mechanism: the
  // spouse's card said "cohabitating partner") can never lead the answer.
  // st_f67bc2eb AC-2 — derived phrase first: "X is your wife's cousin", never
  // "X is your cousin" for a spouse-side relative.
  const relationLine = entity.relation_tag
    ? `${entity.name} is your ${entity.relation_derived_phrase || relationPhrase(entity.relation_tag, entity.relation_label)}.`
    : '';
  const text = [answerLead, relationLine, summary, signal].filter(Boolean).join('\n\n').trim();
  return {
    text,
    entity: {
      id: entity.id,
      name: entity.name,
      type: entity.type,
      n2: entity.n2 || null,
      score: entity.score || 0,
    },
  };
}

/**
 * Layer 0 — Topic preamble.
 */
async function layerTopicPreamble(query, { topic } = {}) {
  if (!topic) return '';
  try {
    const slugs = normalizeTopicList(topic);
    if (!slugs.length) return '';
    const stmt = db.prepare(
      'SELECT label, slug, context_md FROM user_topics WHERE slug = ? AND context_md IS NOT NULL AND length(context_md) > 0'
    );
    const bodies = [];
    let remaining = TOPIC_CHAR_BUDGET;
    for (const slug of slugs) {
      if (remaining <= 0) break;
      const row = stmt.get(slug);
      if (!row?.context_md) continue;
      // st_2cd1af73 Phase 5: inject the topic `## Summary` section by default.
      // Legacy context_md with no marker falls back to the verbatim head slice
      // (those rows lead with the synthesis summary). Either way the result is
      // capped to the remaining 4k topic budget.
      const stripped = stripFrontmatter(row.context_md);
      const summary = extractSummarySection(stripped);
      let body = (summary !== null ? summary : stripped).slice(0, remaining);
      if (!body.trim()) continue;
      const label = row.label || row.slug || slug;
      const section = slugs.length > 1 ? `### ${label}\n${body}` : body;
      bodies.push(section);
      remaining -= section.length;
    }
    const cite = slugs.map((slug) => topicHistoryCiteInstruction(slug)).filter(Boolean).join('\n');
    if (!bodies.length && !cite) return '';
    return `## Topic context\n${bodies.join('\n\n')}${cite ? `\n\n${cite}` : ''}`;
  } catch (err) {
    console.error('[chat-context] layer-0 topic preamble failed:', err.message);
    return '';
  }
}

function stripFrontmatter(markdown) {
  let body = String(markdown || '').trim();
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) body = body.slice(end + 4).trim();
  }
  return body;
}

// st_2cd1af73 Phase 5 — summary-first injection.
//
// Context files (topic context_md and entity context.md) now carry a
// `## Summary` … `---` … `## History` split written by lib/topic-context.js and
// scripts/ingest/07-context.js. Chat injects ONLY the Summary by default: a
// tight ~4k card, not the full file with its archival history.
//
// extractSummarySection(body) returns:
//   - the `## Summary` section's body (heading stripped, stopped at the next
//     `---` fence or `## History` heading) when the delimiter is present, OR
//   - null when no `## Summary` heading exists — the caller then keeps the
//     LEGACY behavior (first-N-chars verbatim). Legacy files lead with their
//     chat summary, so a verbatim head-slice is the right region (failure
//     manifest: forward-rolling, no flag day).
//
// `body` is the post-frontmatter markdown. The match is anchored to a line so a
// stray "## Summary" inside prose never false-positives.
const SUMMARY_HEADING_RE = /^[ \t]*##[ \t]+Summary[ \t]*$/im;
const SECTION_END_RE = /^[ \t]*(?:---[ \t]*|##[ \t]+\S.*)$/m;

function extractSummarySection(body) {
  const text = String(body || '');
  const m = SUMMARY_HEADING_RE.exec(text);
  if (!m) return null; // no split marker → caller uses legacy fallback
  const afterHeading = m.index + m[0].length;
  const rest = text.slice(afterHeading);
  // Find the next section boundary: a `---` fence or any following `##` heading
  // (e.g. `## History`). Search in `rest` so we never re-match the Summary line.
  const endMatch = SECTION_END_RE.exec(rest);
  const section = endMatch ? rest.slice(0, endMatch.index) : rest;
  return section.trim();
}

function resolveContextFilePath(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return null;
  if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2));
  if (isAbsolute(raw)) return raw;
  return resolve(REPO_ROOT, raw);
}

function truncateMarkdownAtBoundary(markdown, limit = ENTITY_CONTEXT_CHAR_BUDGET) {
  const text = String(markdown || '').trim();
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const boundary = Math.max(
    slice.lastIndexOf('\n## '),
    slice.lastIndexOf('\n---'),
    slice.lastIndexOf('\n\n')
  );
  if (boundary > limit * 0.45) return slice.slice(0, boundary).trim();
  return slice.trim();
}

function readEntityContextMarkdown(entity) {
  const path = resolveContextFilePath(entity?.context_file_path);
  if (!path || !existsSync(path)) return null;
  try {
    const body = stripFrontmatter(readFileSync(path, 'utf8'));
    // st_2cd1af73 Phase 5: inject the `## Summary` section only when present.
    // The summary is already written ≤4k, so a hard slice at the budget is a
    // safety net, not the normal path. Legacy files (no `## Summary` marker)
    // keep the prior behavior: truncate the whole file at a clean markdown
    // boundary within the (now 4k) budget — those files lead with their chat
    // summary, so the head slice is the right content.
    const summary = extractSummarySection(body);
    const capped = summary !== null
      ? summary.slice(0, ENTITY_CONTEXT_CHAR_BUDGET).trim()
      : truncateMarkdownAtBoundary(body);
    return capped.trim() ? capped : null;
  } catch (err) {
    console.error('[chat-context] entity context read failed:', err.message);
    return null;
  }
}

export function composeEntityCardBody(entity) {
  const floor = entity?.id ? safeEntityFloor(entity) : '';
  const context = readEntityContextMarkdown(entity);
  if (context && floor) {
    const marker = floor.split('\n')[0].slice(0, 40);
    if (marker && context.includes(marker)) return context;
    return `${floor}\n\n${context}`;
  }
  return context || formatEntityFallbackCard(entity);
}

function safeEntityFloor(entity) {
  try {
    const floor = buildEntityFloor(db, {
      id: entity.id,
      type: entity.type || 'person',
      name: entity.name,
      display_name: entity.name || entity.display_name,
      n2: entity.n2,
    });
    return String(floor?.rendered || '').trim();
  } catch {
    return '';
  }
}

function formatEntityFallbackCard(entity) {
  const name = String(entity?.name || '').trim();
  if (!name) return '';
  const type = String(entity?.type || 'entity').trim();

  // Prefer the deterministic turn-1 floor (facts, kinship, top connections).
  // This is the product contract when context.md is missing or lagging: chat
  // still knows the person from the graph, never a hollow "Known person" stub.
  if (entity?.id) {
    try {
      const floor = buildEntityFloor(db, {
        id: entity.id,
        type,
        name,
        display_name: name,
        n2: entity.n2,
      });
      const rendered = String(floor?.rendered || '').trim();
      if (rendered) {
        const lines = [rendered];
        if (entity?.summary && !/^Person in your network$|^Company in your network$|^Place in your world model$/i.test(entity.summary)) {
          const s = entity.summary.endsWith('.') ? entity.summary : `${entity.summary}.`;
          if (!rendered.includes(s.slice(0, Math.min(40, s.length)))) lines.push(s);
        }
        lines.push('Live graph floor (context.md Summary pending enrichment); stay within these facts.');
        return lines.join('\n');
      }
    } catch { /* floor optional — fall through to minimal record */ }
  }

  const typeLabel = type === 'person'
    ? 'person in your local network'
    : type === 'company'
      ? 'company in your local network'
      : type === 'place'
        ? 'place in your local world model'
        : 'local entity';
  const lines = [`Known ${typeLabel}.`];
  if (entity?.n2) lines.push(`Relationship tier: ${entity.n2}.`);
  if (entity?.summary && !/^Person in your network$|^Company in your network$|^Place in your world model$/i.test(entity.summary)) {
    lines.push(entity.summary.endsWith('.') ? entity.summary : `${entity.summary}.`);
  }
  lines.push('Generated context.md is not available yet; do not claim deeper facts beyond this local entity record.');
  return lines.join('\n');
}

function normalizeTopicList(topic) {
  if (Array.isArray(topic)) {
    return [...new Set(topic.filter(t => typeof t === 'string' && t.length > 0 && t !== 'general'))];
  }
  return (typeof topic === 'string' && topic.length > 0 && topic !== 'general') ? [topic] : [];
}

function topicScopeFromOption(topic) {
  const slugs = normalizeTopicList(topic);
  return slugs.length ? [...new Set([...slugs, 'general'])] : null;
}

/**
 * Resolve the topic scope for a conversation from `conversation_topics`.
 *
 * WHY (st_74f45a1a R2): the raw corpus is 39 topic vec tables × 1.2 M chunks,
 * and better-sqlite3 is synchronous on the main thread, so fan-out across all
 * topics serializes into ~22 s of cold RAG cost. The conversation_topics
 * junction already records which topics each conversation belongs to —
 * scoping the search to those topics plus an ambient `general` shard cuts
 * fan-out cost by ~10x without an ANN library swap.
 *
 * Returns null when no conversation_id is supplied; layerRAG then falls back
 * to the ambient `general` shard instead of broad all-topic chat fan-out.
 */
function resolveTopicScope(conversation_id) {
  if (!conversation_id) return null;
  try {
    const rows = db.prepare(
      `SELECT topic_slug FROM conversation_topics WHERE conversation_id = ?`
    ).all(conversation_id);
    const direct = rows.map(r => r.topic_slug).filter(Boolean);

    // Walk parent_slug chain for each direct topic so a sub-topic scope
    // (e.g. coaching) also searches its parent (personal) where the
    // ancestor-level content actually lives. st_8c7b7a6b — the 553K
    // chunks tagged `personal` were invisible to chats in `coaching`
    // before this rule.
    const parents = new Set();
    if (direct.length > 0) {
      const parentStmt = db.prepare('SELECT parent_slug FROM user_topics WHERE slug=?');
      const seen = new Set(direct);
      const queue = [...direct];
      while (queue.length) {
        const slug = queue.shift();
        const row = parentStmt.get(slug);
        const p = row?.parent_slug;
        if (p && !seen.has(p)) {
          seen.add(p);
          parents.add(p);
          queue.push(p);
        }
      }
    }

    // Always include the ambient `general` shard so first-turn conversations
    // (no junction rows yet) still see common-knowledge content.
    const scope = [...new Set([...direct, ...parents, 'general'])];
    return scope.length > 0 ? scope : ['general'];
  } catch {
    // conversation_topics table missing on fresh install — caller falls back
    // to ambient general, not broad all-topic fan-out.
    return null;
  }
}

/**
 * Layer 1 — Hybrid RAG with confidence gate.
 * retrieve() applies recency scoring and a 0.55 confidence threshold.
 * When confidence is too low, we surface an explicit "no context" note so
 * the LLM doesn't speculate about personal data it doesn't have.
 *
 * @param {string} query - The latest user message
 * @param {object} [opts]
 * @param {string|null} [opts.conversation_id] - When supplied, restricts the
 *   RAG fan-out to topics linked via `conversation_topics`. Cuts cold TTFB
 *   from ~22 s to ~2 s on the live corpus.
 * @param {Function} [opts.onHits] - (count: number) => void. Fires once with
 *   the post-retrieve hit count so the caller can update its indicator
 *   ("Searching 12 sources…"). Best-effort; never throws.
 */
async function layerRAG(query, { conversation_id = null, topicScope = null, onHits = null, onTiming = null } = {}) {
  try {
    const scopedTopics = topicScope || resolveTopicScope(conversation_id) || ['general'];
    const checked = await retrieve(query, { topicScope: scopedTopics, onTiming });
    const hits = checked.results?.length || 0;
    if (typeof onHits === 'function') {
      try { onHits(hits); } catch { /* never break chat on indicator */ }
    }
    if (checked.insufficient) {
      // Internal guardrail: prevents invented private facts without forcing
      // a user-facing "no context" preamble for ordinary public questions.
      return [
        '## Private Robot Dojo context status',
        'No high-confidence document or retrieval evidence was found for this query.',
        'Use any explicit entity, profile, topic, memory, or relationship sections that follow as local evidence. Do not invent private relationship or personal-data facts beyond those sections.',
        'For public/general questions, still answer from general knowledge and any public web context.',
      ].join('\n');
    }
    // WHY format inline (st_8c7b7a6b hot-fix): the previous code called the
    // old unscoped context builder, which re-ran searchAll across all 39 topic
    // tables and threw away the topic-scoped results we just computed.
    // That's 20+ s of duplicate work on the warm path. Use the scored
    // results from retrieve() — they came from the same searchAll under
    // the resolved topicScope and are already recency-weighted.
    return _formatRagResults(checked.results);
  } catch (err) {
    console.error('[chat-context] layer-1 RAG failed:', err.message);
    return null;
  }
}

// Inline formatter for layer-1 RAG output. Mirrors buildContext()'s envelope
// in chat.js but operates over an in-memory result list rather than re-running
// the search. Char budget keeps the system prompt within the cache prefix.
function _formatRagResults(results) {
  if (!results || results.length === 0) return null;
  const charCap = 12_000; // ~3K tokens — same budget shape as chat.js buildContext
  let context = '';
  let charBudget = charCap;
  const topicsSeen = new Set();
  let chunkCount = 0;
  for (const r of results) {
    if (charBudget <= 0) break;
    const meta = r.metadata || {};
    const header = meta.title
      ? `[${r.source_type}: ${meta.title}]`
      : `[${r.source_type}]`;
    const entry = `${header}\n${r.content}\n\n`;
    if (entry.length <= charBudget) {
      context += entry;
      charBudget -= entry.length;
      if (r.topic) topicsSeen.add(r.topic);
      chunkCount++;
    }
  }
  if (chunkCount === 0) return null;
  const manifest = [
    'Here is relevant context from your personal data:',
    `- ${chunkCount} chunks across ${topicsSeen.size} topic(s): ${[...topicsSeen].join(', ')}`,
    `- ~${Math.round((charCap - charBudget) / 4)} tokens of context\n`,
  ].join('\n');
  return manifest + '\n' + context;
}

/**
 * Layer 2 — Entity-associated content.
 * For each detected entity, pull all RAG chunks associated with it via
 * chunk_entities, ordered by recency. De-duplicates across entities.
 */
async function layerEntityContent(entities) {
  if (!entities.length) return '';

  const chunkMap = new Map(); // chunk_id → { content, source_type, created_at, entityName }

  for (const entity of entities) {
    try {
      const rows = db.prepare(`
        SELECT ce.chunk_id, c.content, c.source_type, c.created_at
        FROM chunk_entities ce
        JOIN chunks c ON c.id = ce.chunk_id
        WHERE ce.entity_type = ?
          AND (ce.entity_id = ? OR CAST(ce.entity_id AS TEXT) = ?)
        ORDER BY c.created_at DESC
        LIMIT 20
      `).all(entity.type, entity.id, String(entity.id));

      for (const row of rows) {
        if (!chunkMap.has(row.chunk_id)) {
          chunkMap.set(row.chunk_id, { ...row, entityName: entity.name });
        }
      }
    } catch (err) {
      if (!err.message.includes('no such table')) {
        console.error('[chat-context] layer-2 entity content failed:', err.message);
      }
    }
  }

  if (!chunkMap.size) return '';

  const sorted = [...chunkMap.values()]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, 15);

  const lines = sorted.map(c => {
    const date = c.created_at ? c.created_at.slice(0, 10) : '';
    const source = c.source_type ? ` [${c.source_type}]` : '';
    const prefix = date ? `(${date}${source}) ` : '';
    return prefix + c.content.trim();
  });

  const entityNames = [...new Set(entities.map(e => e.name))].join(', ');
  return `## Content related to ${entityNames}\n${lines.join('\n\n')}`;
}

/**
 * Layer 0.55 — Source-backed entity timeline.
 *
 * This is the real-time bridge between deterministic timeline projection and
 * chat enrichment. Context files may lag a data arrival by one maintenance
 * slice; this layer reads the live entity timeline feed directly so a named
 * person/company/place carries recent source-backed events immediately.
 */
async function layerEntityTimeline(entities) {
  if (!entities.length) return '';

  const blocks = [];
  for (const entity of entities) {
    try {
      const events = getEntityTimeline(db, {
        entityType: entity.type,
        entityId: entity.id,
        limit: 6,
        chunkLimit: 12,
      });
      if (!events.length) continue;
      const lines = formatEntityTimelineSection(events, {
        heading: null,
        maxEvents: 6,
      });
      if (lines.trim()) blocks.push(`### ${entity.name}\n${lines}`);
    } catch (err) {
      if (!String(err?.message || '').includes('no such table')) {
        console.error('[chat-context] layer-0.55 entity timeline failed:', err.message);
      }
    }
  }

  if (!blocks.length) return '';
  return `## Source-backed entity timeline\n${blocks.join('\n\n')}`;
}

/**
 * Layer 0.6 — Interaction signal (AC7).
 *
 * WHY (st_f1a40461): context_file_path is NULL for every person, so the Layer
 * 0.5 entity card is empty, and no other chat layer reads person_interactions.
 * Scoring alone therefore never surfaces a contact's real communication
 * history in chat. This layer renders a compact per-person interaction summary
 * straight from person_interactions so "tell me about Dana Ellis" answers with
 * real signal ("129 inbound email, last 2024-…") rather than "no signal".
 *
 * Cheap synchronous SQL; no LLM spend. Cache key includes person id via the
 * detected-entity set already folded into the layered-context cache key.
 */
async function layerInteractionSignal(entities) {
  const people = (entities || []).filter(e => e.type === 'person');
  if (!people.length) return '';

  const blocks = [];
  for (const p of people) {
    try {
      const rows = db.prepare(`
        SELECT channel, direction, COUNT(*) n, MAX(date) last, MIN(date) first
        FROM person_interactions
        WHERE person_id = ?
        GROUP BY channel, direction
      `).all(p.id);
      if (!rows.length) continue;

      // One line per channel/direction, ordered by volume so the dominant
      // signal leads (e.g. "129 inbound email" before "3 imessage").
      rows.sort((a, b) => (b.n || 0) - (a.n || 0));
      const lines = rows.map((r) => {
        const last = r.last ? String(r.last).slice(0, 10) : null;
        const verb = [r.direction, r.channel].filter(Boolean).join(' ');
        const recency = last ? `, last ${last}` : '';
        return `- ${r.n} ${verb}${recency}`;
      });

      const meta = [
        p.interaction_count ? `${p.interaction_count} total interactions` : null,
        p.n2 || null,
      ].filter(Boolean).join(' · ');

      const header = meta ? `### ${p.name} — ${meta}` : `### ${p.name}`;
      blocks.push(`${header}\n${lines.join('\n')}`);
    } catch (err) {
      // person_interactions absent on a fresh install — silent skip.
      if (!err.message.includes('no such table')) {
        console.error('[chat-context] layer-0.6 interaction signal failed:', err.message);
      }
    }
  }

  if (!blocks.length) return '';
  return `## Interaction signal\n${blocks.join('\n\n')}`;
}

/**
 * Layer 3 — Referenced conversation injection.
 */
async function layerReferencedConversation(query) {
  const match = query.match(UUID_RE);
  if (!match) return '';
  const convId = match[0];
  try {
    const rows = db.prepare(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY seq LIMIT 30'
    ).all(convId);
    if (!rows.length) return '';
    const text = rows.map(r => `${r.role}: ${r.content}`).join('\n').slice(0, 4000);
    return `## Referenced conversation\n${text}`;
  } catch (err) {
    if (!err.message.includes('no such table')) {
      console.error('[chat-context] layer-3 referenced conv failed:', err.message);
    }
    return '';
  }
}

function sanitizePublicWebQuery(query) {
  return String(query || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[`<>{}[\]\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * Build safe public web-search queries.
 *
 * Privacy contract: the web layer may search only the public name/query the
 * user typed. It never sends private Robot Dojo context, topic markdown,
 * relationship notes, RAG chunks, or entity cards to Brave.
 */
export function buildPublicWebSearchQueries(query, entities = [], { belt = 'white' } = {}) {
  if (belt !== 'black') return [];

  const seen = new Set();
  const entityQueries = [];
  for (const entity of entities || []) {
    const name = sanitizePublicWebQuery(entity?.name);
    if (name.length < 3 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    entityQueries.push(name);
    if (entityQueries.length >= 2) break;
  }
  if (entityQueries.length) return entityQueries;

  const q = sanitizePublicWebQuery(query);
  if (!q || q.length < 4 || q.length > 120) return [];
  if (!WEB_RE.test(q)) return [];
  if (PRIVATE_WEB_RE.test(q)) return [];
  return [q];
}

function formatPublicWebContext(results) {
  const formatted = formatSearchContext(results);
  if (!formatted) return '';
  return [
    '## Public web context',
    'Use this as outside/public context only. Do not describe the retrieval process unless the user asks.',
    formatted.replace(/^## Web search results\n\n/, ''),
  ].join('\n');
}

/**
 * Layer 6 — Public web context.
 */
async function layerWebSearch(query, { entities = [], belt = 'white' } = {}) {
  // Web context (Brave search) disabled by default for launch (owner-directed
  // 2026-06-09): no web search in chat — grounding is the user's own data, and
  // the web round-trips stalled turns. Enable via ROBOTDOJO_ENABLE_WEB_CONTEXT=1.
  if (process.env.ROBOTDOJO_ENABLE_WEB_CONTEXT !== '1') return '';
  if (process.env.ROBOTDOJO_DISABLE_WEB_CONTEXT === '1') return '';
  if (process.env.ROBOTDOJO_DB === ':memory:') return '';

  const key = secret('BRAVE_API_KEY') || process.env.BRAVE_API_KEY;
  if (!key) return '';

  const queries = buildPublicWebSearchQueries(query, entities, { belt });
  if (!queries.length) return '';

  try {
    const searches = queries.map(q => braveSearch(q, { count: 2, timeoutMs: PUBLIC_LOOKUP_WEB_TIMEOUT_MS }));
    const results = (await Promise.all(searches)).flat();
    if (!results.length) return '';
    return formatPublicWebContext(results.slice(0, 4));
  } catch (err) {
    console.error('[chat-context] layer-6 web search failed:', err.message);
    return '';
  }
}

/**
 * Read the persisted chat model preference from user_settings.
 * Returns the value string or null when the row is missing/corrupt.
 *
 * Thin-facade extraction: this function replaces the inline db.prepare
 * call at routes/chat.js:97 (st_5a63545d AC 22 — zero db.prepare in
 * routes/). Kept in chat-context.js because all chat-turn model resolution
 * already centralizes here. Pass `db` explicitly so the function is
 * unit-testable against an in-memory database.
 */
export function getChatModel(database) {
  try {
    const row = database.prepare("SELECT value FROM user_settings WHERE key='chat_model'").get();
    return row?.value || null;
  } catch {
    // user_settings may be missing on a freshly-migrated install — same
    // failure mode the inline call previously swallowed.
    return null;
  }
}

/**
 * Assemble all context layers into a single string for system prompt injection.
 *
 * @param {string} query - The latest user message
 * @param {object} options
 * @param {string|string[]|null} options.topic - Active topic slug(s)
 * @param {string} [options.belt] - 'white' | 'black'
 * @param {string|null} [options.conversation_id] - Conversation id for topic-scoped RAG (st_74f45a1a R2)
 * @returns {Promise<string>} Assembled context string, or '' if nothing to inject
 */
export async function buildLayeredContext(query, { topic = null, belt = 'white', conversation_id = null, onHits = null, onTiming = null, onContextTrace = null, skipIdentityLayer = false, skipTopicLayer = false, entityDetectionText = null } = {}) {
  if (!query) return '';
  const entityEnabled = belt === 'black';
  const topicScope = topicScopeFromOption(topic);

  // st_2cd1af73 AC-1 — composition flags (NOT a layer-logic change). When the
  // caller injects the byte-stable identity (Layer -1) and topic (Layer 0)
  // sections as CACHED system blocks upstream (lib/chat/system-prompt.js
  // assembleCachedSystemBlocks), it sets these so this build emits the VOLATILE
  // remainder only — no duplication, and the stable content sits in the cached
  // prefix where it earns a cache hit. Both default false, so every existing
  // caller (and every test) gets byte-identical output to before: identity +
  // topic still appear here, identity-first, when the flags are unset.

  const emitTiming = (phase, started) => {
    if (typeof onTiming === 'function') {
      try { onTiming({ phase, ms: Date.now() - started }); } catch {}
    }
  };
  const timed = (phase, fn) => (async () => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      emitTiming(phase, started);
    }
  })();
  const emitContextTrace = (summary) => {
    if (typeof onContextTrace === 'function') {
      try { onContextTrace(summary); } catch {}
    }
  };

  // Black Belt only: detect entities from query text. White Belt must not run,
  // show, inject, or cache-replay entity context.
  let entities = [];
  if (entityEnabled) try {
    const started = Date.now();
    const textDetected = await detectQueryEntities(entityDetectionText || query);
    emitTiming('layer.entities.detect', started);
    const seen = new Set();
    entities = textDetected.filter((e) => {
      const key = `${e.type}:${e.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 8);
  } catch { /* guarded */ }

  // Loop-hygiene yield (st_2cd1af73 AC-1 final). detectQueryEntities is the one
  // SEGMENT that runs serially before the parallel layer block. Its span-
  // resolution loop now runs the BOUNDED searchMeaningfulEntities (st_fd14cdd4),
  // so each span lookup is an ~0.4 ms index seek over the ~16k meaningful set
  // rather than a multi-hundred-ms scan of the full active people table. The
  // yield is retained: a cold OS page cache and the per-span loop can still cost
  // a few ms, and on a contended turn even that synchronous slice would delay a
  // concurrently-streaming turn's status frame if we didn't hop the loop. Yielding
  // here lets the loop flush any pending I/O (a parallel request's SSE write)
  // before the Promise.allSettled fan-out below re-saturates the thread with the
  // RAG embed round-trip and the per-layer sync SQL. tick() is a macrotask hop
  // (setImmediate when available, else setTimeout 0) so it drains the I/O queue,
  // not just the microtask queue. Cheap: one event-loop turn on the build path
  // that the 5-min LRU otherwise serves from memory.
  await tick();

  // WHY Promise.allSettled (st_74f45a1a R2): the six layers below are
  // independent. better-sqlite3's sync queries still queue on the main
  // thread, but the I/O-bound layers — public web context (HTTP), layerRAG's
  // embed call (HTTPS round-trip to Gemini) — run truly in parallel, so the
  // total cost compresses to ~max(layer) instead of sum(layers). One failed
  // layer never breaks the whole context (allSettled, not all).
  const [
    ragResult,
    identityResult,
    topicResult,
    memoryResult,
    entityCardsResult,
    entityTimelineResult,
    interactionSignalResult,
    entityContentResult,
    referencedResult,
    webResult,
  ] = await Promise.allSettled([
    // Layer 1 — RAG (topic-scoped via conversation_id)
    timed('layer.rag', () => layerRAG(query, { conversation_id, topicScope, onHits, onTiming })),
    // Layer -1 — Identity card (always on; ~1KB; "who I am" preamble).
    // Cached by mtime so repeated chat turns are an in-memory read. Skipped
    // when the caller injects identity as a cached system block (st_2cd1af73).
    timed('layer.identity', () => (skipIdentityLayer ? '' : getIdentityCard())),
    // Layer 0 — Topic preamble. Skipped when the caller injects topic context
    // as a cached system block (st_2cd1af73).
    timed('layer.topic', () => (skipTopicLayer ? '' : layerTopicPreamble(query, { topic }))),
    // Layer 0.7 — Memory continuity. Literal by default: official snapshots
    // and source-backed event metadata can enter chat; generated synthesis,
    // inferred snapshots, and timeline summaries require explicit opt-in.
    timed('layer.memory_continuity', async () => {
      const packet = await buildMemoryContextPacket({ db, query, topic, entities });
      emitContextTrace(summarizeMemoryContextPacket(packet));
      return packet;
    }),
    // Layer 0.5 — Entity profile cards (sync DB reads but cheap)
    timed('layer.entity_cards', () => {
      if (!entities.length) return '';
      const cards = [];
      for (const e of entities) {
        const body = composeEntityCardBody(e);
        if (body) cards.push(`### ${e.name}\n${body}`);
      }
      if (!cards.length) return '';
      return `## Entities mentioned\n${cards.join('\n\n')}`;
    }),
    // Layer 0.55 — Source-backed entity timeline. Reads live timeline/chunk
    // evidence so context-rich chat does not wait for the next context.md regen.
    timed('layer.entity_timeline', () => layerEntityTimeline(entities)),
    // Layer 0.6 — Interaction signal (AC7). Compact person_interactions
    // summary per detected person. Load-bearing: context_file_path is NULL
    // for all people, so this is the only chat layer carrying real comms
    // history into the prompt.
    timed('layer.interaction_signal', () => layerInteractionSignal(entities)),
    // st_2cd1af73 — the special computed HEALTH layer is RETIRED. Health is not
    // architecturally special; it rides as an ordinary topic (its topic doc via
    // the cached topic block when selected, RAG otherwise) like coaching or work.
    // Removing the dedicated layer is "the elegance of the platform" (owner) —
    // every domain flows through the same topic + RAG path. The old layer ran a
    // health-specific SQL aggregation only when topic==='health'; that bespoke
    // surface is gone, no replacement needed.
    // Layer 2 — Entity-associated content
    timed('layer.entity_content', () => layerEntityContent(entities)),
    // Layer 3 — Referenced conversation
    timed('layer.referenced', () => layerReferencedConversation(query)),
    // Layer 6 — public web context. Black Belt precise/public entity lookups
    // may get a short, safe web enhancement. The query is reduced to public
    // entity names or a short public lookup string; no private context leaves
    // the local app, and normal chat tools remain off.
    timed('layer.web', () => layerWebSearch(query, { entities, belt })),
  ]);

  // Unwrap each settled promise. Rejected layers degrade gracefully to ''.
  const unwrap = (r, label) => {
    if (r.status === 'fulfilled') return r.value || '';
    console.error(`[chat-context] ${label} failed:`, r.reason?.message || r.reason);
    return '';
  };

  let ragText = unwrap(ragResult, 'layer-1 RAG').slice(0, RAG_CHAR_BUDGET);

  // Apply OTHER_CHAR_BUDGET to non-RAG sections in priority order:
  // -1 (identity) → 0 (topic) → 0.7 (memory) → 0.5 (entity cards) → 0.55 (entity timeline) → 0.6 (interaction signal) → 2 (entity content) → 3 (referenced) → 6 (web)
  // (st_2cd1af73 — the 1.5 health layer is retired; health is an ordinary topic.)
  //
  // Per-layer floors (st_b50005df Phase 5, AC-1b): the entity-bearing layers
  // (0.5 cards, 0.6 interaction, 2 entity content) each carry a reserved
  // minimum. While an EARLIER layer is being filled, the budget it may spend is
  // capped so the sum of the reserves owned by entity-bearing layers NOT YET
  // ADDED is held back — a large topic preamble can spend the budget down to,
  // but never past, those pending reserves. Each reserve is released to the
  // running budget the instant its own layer is reached (added or skipped), so
  // an empty entity layer never withholds budget from the rest. This makes
  // independent-injection hold for budget, not only for failure.
  const sections = [];
  let charRemaining = OTHER_CHAR_BUDGET;
  // Reserve still held back for entity-bearing layers not yet added. Earlier
  // layers must leave at least this much for the entity layers downstream.
  let reservePending =
    ENTITY_CARDS_CHAR_FLOOR + ENTITY_TIMELINE_CHAR_FLOOR + INTERACTION_SIGNAL_CHAR_FLOOR + ENTITY_CONTENT_CHAR_FLOOR;

  // addSection drops empty strings (no header pushed when a layer returned
  // ''). The `.trim()` guard is what AC-28 leans on: an empty identity
  // layer must not emit a blank "## Who I am" header that crowds the prompt
  // with structure but no content.
  //
  // `ownReserve` (default 0) is THIS layer's own floor: it is released from
  // reservePending before the cap is computed, so an entity-bearing layer can
  // spend its own reserve. The spendable budget for any layer is
  // charRemaining minus whatever reserve is still pending for OTHER downstream
  // entity layers.
  function addSection(text, ownReserve = 0) {
    // Release this layer's reserve — it is now this layer's turn to spend it.
    reservePending = Math.max(0, reservePending - ownReserve);
    if (!text) return;
    const spendable = Math.max(0, charRemaining - reservePending);
    const capped = text.slice(0, spendable);
    if (capped.trim()) {
      sections.push(capped);
      charRemaining -= capped.length;
    }
  }

  // Layer -1 identity floor (st_0c491456 Phase 1c, AC-26). Identity is the
  // "who I am" baseline every other layer is contextualized against; it
  // must reach the model every turn. The assembly order already places
  // identity first (so OTHER_CHAR_BUDGET is intact at this point), but if
  // any future re-ordering or growing pre-identity budget consumer drops
  // charRemaining below IDENTITY_CHAR_FLOOR, identity gets a protected
  // reserve from Math.max — taken from the shared budget but never
  // starved below the floor. Identity-card.js already caps the body at
  // USER_CARD_CHAR_BUDGET=4000, so this reserve is loose enough to hold
  // the whole card plus the "## Who I am" wrapper.
  charRemaining = Math.max(charRemaining, IDENTITY_CHAR_FLOOR);
  addSection(unwrap(identityResult, 'layer-minus-1 identity'));
  addSection(unwrap(topicResult, 'layer-0 topic'));
  addSection(unwrap(memoryResult, 'layer-0.7 memory continuity'));
  addSection(unwrap(entityCardsResult, 'layer-0.5 entity cards'), ENTITY_CARDS_CHAR_FLOOR);
  addSection(unwrap(entityTimelineResult, 'layer-0.55 entity timeline'), ENTITY_TIMELINE_CHAR_FLOOR);
  addSection(unwrap(interactionSignalResult, 'layer-0.6 interaction signal'), INTERACTION_SIGNAL_CHAR_FLOOR);
  // Layer 1.5 (health) retired — st_2cd1af73 (health rides as an ordinary topic).
  addSection(unwrap(entityContentResult, 'layer-2 entity content'), ENTITY_CONTENT_CHAR_FLOOR);
  addSection(unwrap(referencedResult, 'layer-3 referenced'));
  addSection(unwrap(webResult, 'layer-6 web'));

  // RAG first (highest priority), then other layers
  const all = [];
  if (ragText.trim()) all.push(ragText);
  all.push(...sections);

  return all.join('\n\n').trim();
}

// ─── Layered-context cache (st_74f45a1a R2 — perceived-speed win) ─────────
//
// WHY: assembling the layered context is the dominant cost of a chat turn
// (cold ~22 s, warm ~3 s). Within a 5-minute conversation window the same
// (user, conversation, last-message-hash) tuple produces the same context.
// Cache it so the second turn skips the entire fan-out.
//
// Eviction: LRU + 5-minute TTL. The 5-minute window matches Anthropic's
// ephemeral prompt-cache TTL — they invalidate together on the same clock.
// Failures are NOT cached (they would lock the conversation into a broken
// context until TTL); we cache only successful non-empty assemblies.
const _contextCache = new LRUCache({ max: 1000, ttl: 5 * 60_000 });

function hashMessages(messagesOrQuery) {
  // Accept either a string (single-message hint) or an array of message
  // objects (last 3 used). Hashing only the role + content of the trailing
  // window keeps the key tight and tolerant of incidental message-shape
  // changes (timestamps, ids).
  const h = crypto.createHash('sha256');
  if (typeof messagesOrQuery === 'string') {
    h.update(messagesOrQuery);
  } else if (Array.isArray(messagesOrQuery)) {
    const tail = messagesOrQuery.slice(-3);
    for (const m of tail) {
      h.update(`${m.role || ''}\n`);
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      h.update(c);
      h.update(''); // record separator
    }
  }
  return h.digest('hex');
}

function cacheKey({ user_id, conversation_id, query, messages, belt, topic, skipIdentityLayer, skipTopicLayer, entityDetectionText }) {
  const u = user_id || 'anon';
  const c = conversation_id || '';
  const b = belt || 'white';
  const t = Array.isArray(topic) ? JSON.stringify(topic) : (topic || '');
  const m = hashMessages(messages || query || '');
  const e = entityDetectionText ? crypto.createHash('sha256').update(entityDetectionText).digest('hex').slice(0, 16) : '-';
  // st_2cd1af73 AC-1 — the skip flags change the emitted sections, so they are
  // part of the identity of the result. Without them a skip-on call could read
  // a skip-off entry (identity+topic duplicated) or vice versa. 's'/'i'/'t'
  // encode which stable layers were suppressed.
  const s = `${skipIdentityLayer ? 'i' : '-'}${skipTopicLayer ? 't' : '-'}`;
  return `${u}:${c}:${b}:${t}:${s}:${e}:${m}`;
}

export function peekCachedLayeredContext(query, options = {}) {
  const key = cacheKey({
    user_id: options.user_id,
    conversation_id: options.conversation_id,
    query,
    messages: options.messages,
    belt: options.belt,
    topic: options.topic,
    skipIdentityLayer: options.skipIdentityLayer,
    skipTopicLayer: options.skipTopicLayer,
    entityDetectionText: options.entityDetectionText,
  });
  const cached = _contextCache.get(key);
  if (cached === undefined) return null;
  if (typeof options.onTiming === 'function') {
    try { options.onTiming({ phase: 'context.cache_hit', ms: 0 }); } catch {}
  }
  if (cached && typeof cached === 'object' && Object.prototype.hasOwnProperty.call(cached, 'value')) {
    if (typeof options.onContextTrace === 'function' && cached.memoryTrace) {
      try { options.onContextTrace({ ...cached.memoryTrace, cache_hit: true }); } catch {}
    }
    return cached.value;
  }
  return cached;
}

/**
 * LRU-cached wrapper around buildLayeredContext.
 *
 * Cache key is (user_id, conversation_id, hash(last-3-messages || query)).
 * 1000 entries, 5-minute TTL — matches the Anthropic ephemeral-cache window
 * so cached layered context and cached system-prompt tokens invalidate
 * together. Pass-through on error (failures aren't cached).
 *
 * @param {string} query
 * @param {object} options - Same as buildLayeredContext, plus:
 * @param {string|null} [options.user_id] - Owner id for cache partition
 * @param {Array} [options.messages] - Full message array; last 3 are hashed
 */
export async function cachedBuildLayeredContext(query, options = {}) {
  const key = cacheKey({
    user_id: options.user_id,
    conversation_id: options.conversation_id,
    query,
    messages: options.messages,
    belt: options.belt,
    topic: options.topic,
    skipIdentityLayer: options.skipIdentityLayer,
    skipTopicLayer: options.skipTopicLayer,
    entityDetectionText: options.entityDetectionText,
  });
  const cached = peekCachedLayeredContext(query, options);
  if (cached !== null) return cached;

  try {
    const started = Date.now();
    let memoryTrace = null;
    const value = await buildLayeredContext(query, {
      ...options,
      onContextTrace: (summary) => {
        memoryTrace = summary;
        if (typeof options.onContextTrace === 'function') {
          try { options.onContextTrace(summary); } catch {}
        }
      },
    });
    if (typeof options.onTiming === 'function') {
      try { options.onTiming({ phase: 'context.build_total', ms: Date.now() - started }); } catch {}
    }
    // Only cache non-empty successful results — empty context could mask
    // a transient failure into a permanent "no context" state for 5 min.
    if (value && value.length > 0) _contextCache.set(key, { value, memoryTrace });
    return value;
  } catch (err) {
    // Pass-through; do not cache failures.
    console.error('[chat-context] cached wrapper passthrough:', err.message);
    return '';
  }
}

// ─── Prewarm hooks (st_2cd1af73 AC-1 final — cold-start elimination) ──────────
//
// WHY a representative ambient build, not a synthetic-key LRU prime: the LRU is
// keyed on (user, conversation, belt, topic, hash(message)), so the user's first
// real message is always a fresh key — a cache MISS by construction. We cannot
// pre-populate the key of an unknown future message. What turns that first build
// from 13–25 s COLD into ~1 s warm is the SUBSTRATE the build touches:
//   1. OS page cache — the people / chunk_entities / person_interactions /
//      chunks / user_topics index pages the layers walk. The 7.3 GB DB is
//      memory-mapped; under memory pressure those pages get evicted and the
//      cold build pays disk-seek tax per index probe (the measured 13–25 s).
//   2. The identity-card mtime cache (query-independent — a true reuse).
//   3. The Gemini embed HTTPS socket + circuit (rag.embed, the 0.8–1.9 s
//      dominant component of every cold build).
// Running ONE real ambient build at boot — and again on the keep-warm cadence
// before pages can be evicted — keeps all three hot, so every real (cache-miss)
// turn lands on the warm-page path. This is the honest mechanism: we are not
// faking an LRU hit; we are keeping the cost underneath the miss warm.
//
// The ambient scope (topic=null, conversation_id=null) is the no-topic floor
// every first turn shares; resolveTopicScope falls back to the `general` shard,
// the same path a topicless first message takes.
const AMBIENT_WARM_QUERY =
  process.env.ROBOTDOJO_WARM_QUERY ||
  'what should I focus on today and who should I follow up with';

// Last successful ambient warm per belt, epoch ms. Lets the keep-warm cadence
// rebuild ONLY when the prior warm is older than the staleness window, instead
// of paying a full build every 120 s tick.
const _ambientWarmedAt = new Map(); // belt → epoch ms
// The actual ambient string, kept so a real first turn can serve the
// prewarmed world model instead of a 400-char timeout stub.
const _ambientContext = new Map(); // belt → string

function clearLayeredContextState() {
  _contextCache.clear();
  _ambientWarmedAt.clear();
  _ambientContext.clear();
  _clearEntitySpanMemo();
}

appEvents.on('memory-context-change', () => {
  clearLayeredContextState();
});

// st_df0a8d71 — a graph write (relationship/employer correction) must reach
// the next turn everywhere, not only in the ego block: the entity-enrichment
// memo caches relation_tag/relation_label for its TTL, and the layered LRU
// can hold a summary built from the superseded value. Clear both on the same
// event the ego memo re-renders on.
appEvents.on('graph-change', () => {
  clearLayeredContextState();
});

/**
 * Age (ms) of the last ambient warm for `belt`, or Infinity if never warmed.
 * The keep-warm scheduler reads this to decide whether a rebuild is due.
 */
export function ambientWarmAgeMs(belt = 'white') {
  const at = _ambientWarmedAt.get(belt);
  return at ? Date.now() - at : Infinity;
}

/**
 * Instant personally-aware floor from boot / keep-warm. Null when this
 * process has not yet completed an ambient build for `belt`.
 */
export function peekAmbientLayeredContext(belt = 'white') {
  const value = _ambientContext.get(belt);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Run one real ambient (no-topic) layered build to warm the page cache,
 * identity card, and embed socket. Bypasses the per-query LRU (it would only
 * cache a key no real turn hits) and instead calls buildLayeredContext directly.
 * Records the warm timestamp per belt for the staleness check. Never throws —
 * a failed warm is logged and reported, never surfaced to a caller.
 *
 * @param {object} [opts]
 * @param {string} [opts.belt='white']
 * @param {number} [opts.maxAgeMs] - when set, skip the rebuild if a prior warm
 *   is younger than this (keep-warm cadence passes ~4 min; boot omits it).
 * @returns {Promise<{ ok: boolean, ms: number, chars: number, skipped: boolean, error: string|null }>}
 */
export async function warmAmbientLayeredContext({ belt = 'white', maxAgeMs = null } = {}) {
  if (Number.isFinite(maxAgeMs) && ambientWarmAgeMs(belt) < maxAgeMs) {
    return { ok: true, ms: 0, chars: 0, skipped: true, error: null };
  }
  const started = Date.now();
  try {
    const ctx = await buildLayeredContext(AMBIENT_WARM_QUERY, {
      topic: null,
      belt,
      conversation_id: null,
    });
    _ambientWarmedAt.set(belt, Date.now());
    if (ctx && ctx.length > 0) _ambientContext.set(belt, ctx);
    return { ok: true, ms: Date.now() - started, chars: ctx.length, skipped: false, error: null };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, chars: 0, skipped: false, error: err?.message || String(err) };
  }
}

/**
 * Test hook — clear the chat-context caches between assertions.
 *
 * Clears the layered-context LRU, the ambient-warm timestamps, AND the entity
 * resolution memos (st_fd14cdd4). The entity memos must reset here too: tests
 * that seed an entity, resolve it, then re-seed under a new identity would
 * otherwise read a span/enrichment result cached from the prior seed within the
 * 30s TTL — a stale hit that fails the assertion. This is the single
 * "reset all chat-context state" hook beforeEach() blocks already call.
 */
export function _clearLayeredContextCache() {
  clearLayeredContextState();
}
