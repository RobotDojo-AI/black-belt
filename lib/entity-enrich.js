/**
 * lib/entity-enrich.js — Core enrichment logic for entity context files.
 *
 * Phase 2 of the entity-body-enrichment story (st_76f3a8a7).
 *
 * WHY a separate lib module (not inline in the script):
 *   All enrichment logic must be testable in isolation. The CLI wrapper
 *   (08-entity-enrich.js) handles I/O and orchestration; this module
 *   holds pure enrichment logic with well-defined inputs/outputs.
 *
 * Compute Tier Protocol (per CLAUDE.md):
 *   Tier 0 (free): SQL joins to fetch chunks + timeline events
 *   Tier 1 (Haiku): REACTS NULL pattern — per-chunk event extraction
 *   Merge: deterministic string manipulation — free
 *
 * REACTS NULL pattern (57-71% batch contamination confirmed):
 *   One entity per LLM call. Never batch entities together. Haiku extracts
 *   events from each chunk individually under a THREE-way contract (design-
 *   unified-architecture.md §4.1, st_553e364b): "CONFIRMED YYYY-MM-DD:
 *   one-sentence summary" when the text states/implies a specific date,
 *   "TENTATIVE: one-sentence summary" when an event is implied but there is
 *   NO confident date, or "NULL" if irrelevant. NULL responses are dropped,
 *   not appended. This replaces the old binary date-or-NULL contract, which
 *   structurally pressured the model to compress vague content ("let's find
 *   time the week of the 29th") into a fabricated exact date — TENTATIVE is
 *   the structural cure: it can never carry a date (see parseReactsNullResponse
 *   and lib/entity-claims.js#recordEntityClaims). Every reactsNullPass
 *   proposal is llm-distilled (an inference from prose, never primary-source)
 *   and is hedged at render time via lib/provenance.js#hedgePolicy — see
 *   hedgedReactsNullEvent() below.
 *
 * Merge strategy:
 *   Replace existing ## Relationship Timeline and ## Key Topics sections
 *   if they exist. Append if absent. Never raw-replace the whole file.
 *   Floor: original content is preserved. Ceiling: re-running must not
 *   grow file > 200 bytes (idempotence test in entity-enrich.test.js).
 *
 * INTELLIGENCE_TIER: synthesis — reactsNullPass calls Haiku (llmCreate) and
 * the merged output writes canonical entity context markdown, never a DB row
 * directly (the LLM-write-boundary: entity_claims writes, when wired, go
 * through the deterministic lib/entity-claims.js#recordEntityClaims writer).
 */

export const INTELLIGENCE_TIER = 'synthesis';

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { llmCreate } from './llm-gateway.js';
import { llmBatch } from './llm-batch.js';
import config from './config.js';
import { appendMemoryEvent } from './memory-events.js';
import { listViewerCorrections } from './viewer-corrections.js';
import { formatEntityTimelineSection, getEntityTimeline } from './entity-timeline.js';
import { LINKEDIN_CSV_PATH, parseLinkedInCsv } from '../scripts/ingest/01-extract.js';
import { SOURCE_CLASS, hedgePolicy, hedgePhrase } from './provenance.js';
import { ensurePersonContextSkeleton } from './entity-card.js';
import { modelFor } from './model-lane.js';

// LinkedIn CSV overlay for enrichment context only.
// The CSV is loaded once at first use and cached. It never creates or merges
// people. Attachment prefers normalized email from the LinkedIn export. The
// fallback is an exact unique full-name match, which is intentionally narrow
// and only affects enrichment fields.
let _linkedinIndex = null;
function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function loadLinkedinIndex() {
  if (_linkedinIndex !== null) return _linkedinIndex;
  if (!existsSync(LINKEDIN_CSV_PATH)) {
    _linkedinIndex = { byEmail: new Map(), byName: new Map() };
    return _linkedinIndex;
  }
  try {
    const rows = parseLinkedInCsv(readFileSync(LINKEDIN_CSV_PATH, 'utf8'));
    const byEmail = new Map();
    const byName = new Map();
    for (const r of rows) {
      const email = normalizeEmail(r.email);
      if (email) byEmail.set(email, r);
      const name = normalizeName(r.display_name);
      if (name) {
        const bucket = byName.get(name) || [];
        bucket.push(r);
        byName.set(name, bucket);
      }
    }
    _linkedinIndex = { byEmail, byName };
  } catch (err) {
    console.warn(`[entity-enrich] LinkedIn CSV load failed: ${err.message}`);
    _linkedinIndex = { byEmail: new Map(), byName: new Map() };
  }
  return _linkedinIndex;
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
    .replace(/\s+/g, ' ');
}

function linkedinProfileFor(person, identifiers = []) {
  const index = loadLinkedinIndex();
  const personEmails = identifiers
    .filter(i => i.type === 'email')
    .map(i => normalizeEmail(i.value))
    .filter(Boolean);
  for (const email of personEmails) {
    const profile = index.byEmail.get(email);
    if (profile) return { profile, guard: 'email' };
  }

  const name = normalizeName(person?.display_name);
  if (!name || name.split(' ').length < 2) return null;
  const nameMatches = index.byName.get(name) || [];
  if (nameMatches.length === 1) return { profile: nameMatches[0], guard: 'exact_unique_name' };
  return null;
}

// ── Haiku model constant (from compute-tier.js) ───────────────────────────────
// WHY Haiku: REACTS NULL pattern — per-chunk extraction. Sonnet would be
// 15x the cost for the same per-chunk extraction quality.
const HAIKU_MODEL = modelFor('fast');

// ── Signature patterns for title/employer extraction from email body ─────────
// WHY regex: email signatures are semi-structured plain text. LLM extraction
// for 350K emails is unnecessary — regex captures 80%+ of cases.
// Patterns ordered by specificity (most specific first):
const SIG_PATTERNS = [
  // "John Smith | VP Engineering | Acme Corp"
  /^[A-Z][a-zA-Z\s]+\s*\|\s*([^|]+?)\s*\|\s*([^|\n]+)/m,
  // "Title: VP Engineering"
  /^Title:\s*(.+)$/im,
  // "VP Engineering at Acme Corp" (standalone line)
  /^((?:VP|SVP|EVP|CEO|CTO|CFO|COO|CPO|CMO|CRO|Director|Head|Manager|Partner|Principal|Senior|Lead|Staff|Associate)[^|\n]{3,60})$/m,
];

// ── SQL queries (all parameterised — no interpolation) ───────────────────────

const SQL = {
  // Body chunks via chunk_entities join — no source_type filter.
  // WHY no filter: any future source (Drive, Notes, Oura) flows automatically.
  bodyChunks: `
    SELECT c.source_type, c.content, c.event_time
    FROM chunk_entities ce
    JOIN chunks c ON c.id = ce.chunk_id
    WHERE ce.entity_id = ?
    ORDER BY c.event_time DESC
    LIMIT 20
  `,

  // Professional context from entity_facts (employer rows already in DB).
  entityFacts: `
    SELECT ef.fact_type, ef.fact_value
    FROM entity_facts ef
    WHERE ef.entity_id = ? AND ef.fact_type IN ('employer', 'job_title')
  `,

  // Email addresses for the person (to join email bodies for signature scan).
  emailIds: `
    SELECT pi.value FROM person_identifiers pi
    WHERE pi.person_id = ? AND pi.type = 'email'
  `,

  // Recent email bodies for signature scanning — top 5 by recency.
  // WHY LIKE scan acceptable: capped at 5, daily maintenance batch, non-realtime.
  emailBodies: `
    SELECT e.body_text FROM emails e
    JOIN person_identifiers pi ON e.sender_email = pi.value
    WHERE pi.person_id = ? AND pi.type = 'email' AND length(e.body_text) > 0
    ORDER BY e.received_at DESC LIMIT 5
  `,

  // Person lookup by ID (verify entity exists before enrichment).
  personById: `
    SELECT id, display_name, n2, linkedin_title, needs_regen, context_file_path
    FROM people WHERE id = ?
  `,

  // Write linkedin_title back to people row.
  updateTitle: `UPDATE people SET linkedin_title = ? WHERE id = ?`,

  // Clear needs_regen after successful enrichment.
  // WHY needs_regen = 0 (not NULL): the column is NOT NULL in schema.
  clearNeedsRegen: `UPDATE people SET needs_regen = 0 WHERE id = ?`,
};

// ── Enrichment eligibility + priority (the single source of the priority sort) ─
//
// st_b50005df Phase 4 — the candidate selector is the ONE place that decides
// (a) which entities are eligible for enrichment and (b) in what order. Both the
// daily maintenance batch (08-entity-enrich.js) and the always-on passive worker
// (lib/chunk-worker.js entity_enrich handler) drive enrichment from THIS query,
// so the priority is reused, never re-invented. Reordering or re-gating
// enrichment is a one-line change here, and every driver inherits it.
//
// Eligibility gate (st_87a0d072 P8 + first-session depth fix):
//   needs_regen = 1 AND archived = 0
//   AND n2 IN ('Family','Partners','Customers','Core','Network')
// Acquaintance + the retired Extended tier are EXCLUDED — they are the long tail
// and spending Haiku budget on them yields no signal for the user.
//
// context_file_path is NO longer required for selection. High-value people can
// land cardless (excellent-or-omitted abstention, or pre-card ingest). The
// enrich path ensures a floor-backed skeleton via ensurePersonContextSkeleton
// before writing timeline/topics so first-session depth is not blocked on the
// LLM card pass. Network-tier still enriches when needs_regen=1 (with or without
// a pre-existing file).
//
// Priority sort (highest-value first): tier rank ASC, then score DESC. Family
// outranks Core outranks Partners outranks Customers outranks Network; within a
// tier the higher-scored person enriches first. On a capped run the top-ranked
// entities are enriched before the cap is reached — first-session depth is fast.
export const ENRICHMENT_ELIGIBLE_TIERS = Object.freeze([
  'Family', 'Partners', 'Customers', 'Core', 'Network',
]);

// Tier → rank (lower = enriched first). Mirrors the CASE in the SQL below; kept
// as data so the order is auditable in one place.
const ENRICHMENT_TIER_RANK = Object.freeze({
  Family: 1, Core: 2, Partners: 3, Customers: 4, Network: 5,
});

// SQL fragment shared by the candidate selector and the backlog COUNT so the
// eligibility gate can never drift between "what we enrich" and "how much is
// left". The WHERE is identical; only the projection/order/limit differ.
export const ENRICHMENT_ELIGIBILITY_WHERE = `
  needs_regen = 1 AND archived = 0
  AND n2 IN ('Family', 'Partners', 'Customers', 'Core', 'Network')
`;

const ENRICHMENT_PRIORITY_ORDER = `
  ORDER BY
    CASE n2
      WHEN 'Family' THEN 1
      WHEN 'Core' THEN 2
      WHEN 'Partners' THEN 3
      WHEN 'Customers' THEN 4
      WHEN 'Network' THEN 5
      ELSE 6
    END ASC,
    score DESC
`;

/**
 * Select enrichment candidates highest-value first (tier then score).
 *
 * This is the priority sort reused by every enrichment driver (daily batch +
 * always-on worker + reconciler). Pass `limit` to cap a single drain slice; omit
 * it (or pass 0/null) for the full eligible backlog.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ limit?: number|null }} [opts]
 * @returns {Array<{ id: string, display_name: string, n2: string, score: number }>}
 */
export function selectEnrichmentCandidates(db, { limit = null } = {}) {
  const capped = Number.isFinite(limit) && limit > 0;
  const sql = `
    SELECT id, display_name, n2, score, context_file_path
    FROM people
    WHERE ${ENRICHMENT_ELIGIBILITY_WHERE}
    ${ENRICHMENT_PRIORITY_ORDER}
    ${capped ? 'LIMIT ?' : ''}
  `;
  const stmt = db.prepare(sql);
  return capped ? stmt.all(limit) : stmt.all();
}

/**
 * Promote high-value people who have no context package into the enrich backlog.
 *
 * First-session magic: Family/Core/Partners/Customers without a card still need
 * a skeleton so chat ## Summary and enrich timeline sections have a home. Marks
 * needs_regen=1 and creates floor-backed context.md when missing. Bounded.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ limit?: number }} [opts]
 * @returns {{ promoted: number }}
 */
export function promoteHighValueCardlessToBacklog(db, { limit = 40 } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? limit : 40;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, display_name, n2, score, context_file_path
      FROM people
      WHERE archived = 0
        AND n2 IN ('Family', 'Core', 'Partners', 'Customers')
        AND (
          context_file_path IS NULL OR context_file_path = ''
          OR needs_regen = 1
        )
      ORDER BY
        CASE n2
          WHEN 'Family' THEN 1
          WHEN 'Core' THEN 2
          WHEN 'Partners' THEN 3
          WHEN 'Customers' THEN 4
          ELSE 5
        END ASC,
        score DESC
      LIMIT ?
    `).all(cap);
  } catch {
    return { promoted: 0 };
  }
  if (!rows.length) return { promoted: 0 };

  let promoted = 0;
  for (const person of rows) {
    try {
      const path = ensurePersonContextSkeleton(db, person, { forceNeedsRegen: true });
      if (path) promoted += 1;
    } catch (err) {
      console.warn(`[entity-enrich] skeleton promote failed for ${person.id}: ${err.message}`);
    }
  }
  return { promoted };
}

/**
 * How many eligible entities still need enrichment — the backlog from truth.
 * Same WHERE as selectEnrichmentCandidates so backlog and selection never drift.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function enrichmentBacklogCount(db) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM people WHERE ${ENRICHMENT_ELIGIBILITY_WHERE}`,
  ).get().n;
}

/**
 * Stable rank for a tier (lower = higher priority). Exposed so the priority test
 * can assert the ordering contract without re-deriving the CASE.
 * @param {string} tier
 * @returns {number}
 */
export function enrichmentTierRank(tier) {
  return ENRICHMENT_TIER_RANK[tier] ?? 6;
}

// ── fetchBodyChunks ──────────────────────────────────────────────────────────

/**
 * Fetch body content chunks for an entity from chunk_entities join.
 * @param {import('better-sqlite3').Database} db
 * @param {string} entityId
 * @returns {Array<{source_type: string, content: string, event_time: string|null}>}
 */
export function fetchBodyChunks(db, entityId) {
  try {
    return db.prepare(SQL.bodyChunks).all(entityId);
  } catch {
    return [];
  }
}

// ── fetchTimelineEvents ──────────────────────────────────────────────────────

/**
 * Fetch timeline events for a person from timeline_event_entities join.
 * @param {import('better-sqlite3').Database} db
 * @param {string} personId
 * @returns {Array<{event_type: string, source_type: string, event_date: string, summary: string}>}
 */
export function fetchTimelineEvents(db, personId) {
  return getEntityTimeline(db, { entityType: 'person', entityId: personId, limit: 20 });
}

// ── reactsNullPass ────────────────────────────────────────────────────────────

/**
 * Deterministic parse of one reactsNullPass raw LLM response into a
 * structured proposal, or null for NULL/unrecognized output. THREE-way
 * contract (design-unified-architecture.md §4.1) — replaces the old binary
 * date-or-NULL parse, the confirmed root cause of the fabricated-date bug: a
 * vague event ("let's find time the week of the 29th") now parses to
 * TENTATIVE with date:null, never a manufactured calendar date. Exported so
 * the parse itself is unit-testable against literal Haiku response text
 * without a live LLM call. Deterministic Tier-0 (no LLM) — the LLM only ever
 * returns text; this function is the code that reads it.
 *
 * @param {string} responseText
 * @returns {{type:'CONFIRMED'|'TENTATIVE', date:string|null, summary:string}|null}
 */
export function parseReactsNullResponse(responseText) {
  const text = String(responseText || '').trim();

  const confirmed = text.match(/^CONFIRMED\s+(\d{4}-\d{2}-\d{2}):\s*(.+)$/is);
  if (confirmed) {
    const summary = confirmed[2].trim();
    if (!summary) return null;
    return { type: 'CONFIRMED', date: confirmed[1], summary };
  }

  const tentative = text.match(/^TENTATIVE:\s*(.+)$/is);
  if (tentative) {
    const summary = tentative[1].trim();
    if (!summary) return null;
    // Structural guarantee: a TENTATIVE proposal NEVER carries a date, even
    // if the model's prose happened to mention one — there is no branch here
    // that reads a date out of a TENTATIVE response.
    return { type: 'TENTATIVE', date: null, summary };
  }

  return null; // NULL and any unrecognized/malformed response — never guess.
}

/**
 * REACTS NULL pattern: per-chunk Haiku extraction.
 *
 * For each chunk, calls Haiku with the entity name and chunk content. Output
 * is a THREE-way contract: "CONFIRMED YYYY-MM-DD: one-sentence summary" (a
 * specific date is stated/implied), "TENTATIVE: one-sentence summary" (an
 * event is implied but there is NO confident date — never compress this into
 * a guessed date), or "NULL" (no relevant event). NULL responses are dropped
 * — they represent no relevant content. Every returned proposal is an
 * llm-distilled inference from prose (never primary-source), rendered hedged
 * downstream (see hedgedReactsNullEvent()) and, when persisted, written only
 * through lib/entity-claims.js#recordEntityClaims (LLM-write-boundary).
 *
 * WHY one entity per LLM call: batching entities causes 57-71% contamination
 * (facts from Entity A bleeding into Entity B's output). This was confirmed
 * empirically in the research phase. The cost is linear but the accuracy
 * is binary — cross-contamination makes the output useless.
 *
 * @param {{id: string, display_name: string}} entity
 * @param {Array<{content: string, event_time: string|null}>} chunks
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] cancels between chunks and during the LLM call
 * @returns {Promise<Array<{type:'CONFIRMED'|'TENTATIVE', date:string|null, summary:string}>>}
 */
/**
 * The one prompt both the sequential and batch lanes send. Shared deliberately:
 * two copies would drift, and a drifted batch prompt would produce results that
 * silently differ from the synchronous path they are supposed to replace.
 */
export function buildReactsNullPrompt(entity, content) {
  return `Extract any event or milestone involving "${entity.display_name}" from this text.
Output format (choose exactly one):
CONFIRMED YYYY-MM-DD: one-sentence summary   (only when the text states or clearly implies a specific date)
TENTATIVE: one-sentence summary              (an event is implied but there is NO confident date — do not guess one)
NULL                                          (no relevant event)

Text:
${content}`;
}

// Below this many usable chunks the batch overhead (submit, poll, fetch) costs
// more wall-clock than the discount is worth, so the sequential lane wins.
const BATCH_MIN_CHUNKS = 10;

/**
 * Batch lane for reactsNullPass. Returns proposals on success, [] when the
 * batch was submitted but did not return in time (the work is paid for and
 * still running — the caller must NOT re-run it), or null when batching did not
 * apply and the sequential lane should handle it.
 */
async function batchReactsNullPass(entity, chunks, { signal = null } = {}) {
  const usable = chunks
    .map((chunk, i) => ({ id: `chunk-${i}`, content: (chunk.content || '').slice(0, 1200) }))
    .filter((c) => c.content.trim());

  if (usable.length < BATCH_MIN_CHUNKS) return null;

  const requests = usable.map((c) => ({
    custom_id: c.id,
    params: {
      model: HAIKU_MODEL,
      max_tokens: 80,
      messages: [{ role: 'user', content: buildReactsNullPrompt(entity, c.content) }],
    },
  }));

  let results;
  try {
    results = await llmBatch(requests, 'entity-enrich-reacts-null', { signal });
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      throw new DOMException('entity enrichment aborted', 'AbortError');
    }
    // A batch that never got off the ground billed nothing, so falling back to
    // the sequential lane is safe here and only here.
    console.warn(`[entity-enrich] batch submit failed for ${entity.id}, falling back to sequential: ${err.message}`);
    return null;
  }

  const proposals = [];
  for (const c of usable) {
    const r = results.get(c.id);
    if (!r || r.error) continue;
    const proposal = parseReactsNullResponse((r.text || '').trim());
    if (proposal) proposals.push(proposal);
  }
  return proposals;
}

export async function reactsNullPass(entity, chunks, { signal = null } = {}) {
  const proposals = [];
  if (process.env.ENTITY_ENRICH_SKIP_LLM === '1' || process.env.ROBOTDOJO_ENTITY_ENRICH_SKIP_LLM === '1') {
    return proposals;
  }

  // st_4312c9c0 AC-7 — half-price lane when the owner has opted in. This job is
  // the batch shape by definition: bulk iteration over the corpus with nothing
  // waiting on the result. OFF by default; the sequential path below is the
  // fallback and stays the only path unless ROBOTDOJO_BATCH_ENRICHMENT=1.
  if (config.batchEnrichment) {
    const batched = await batchReactsNullPass(entity, chunks, { signal });
    if (batched) return batched;
    // A null return means the batch could not be used (too few chunks, or it
    // did not finish inside the wait ceiling). Fall through to sequential only
    // in the too-few case — batchReactsNullPass returns [] rather than null
    // when work was submitted, so nothing is ever billed twice.
  }

  // Process chunks sequentially to avoid rate-limit spikes.
  // WHY sequential not parallel: background batch — throughput is not time-critical.
  // Each chunk is a separate LLM call; parallelism would amplify cost and hit rate limits.
  for (const chunk of chunks) {
    if (signal?.aborted) throw new DOMException('entity enrichment aborted', 'AbortError');
    const content = (chunk.content || '').slice(0, 1200);
    if (!content.trim()) continue;

    const prompt = buildReactsNullPrompt(entity, content);

    let responseText;
    try {
      const resp = await llmCreate({
        model: HAIKU_MODEL,
        max_tokens: 80,
        signal,
        messages: [{ role: 'user', content: prompt }],
      }, 'entity-enrich-reacts-null');
      responseText = (resp.content[0]?.text || '').trim();
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        throw new DOMException('entity enrichment aborted', 'AbortError');
      }
      // Log and skip this chunk — never crash the full run on one chunk failure.
      // WHY log entity_id not entity_name: entity_name may contain PII; ID is safe to log.
      console.warn(`[entity-enrich] reactsNullPass chunk failed for ${entity.id}: ${err.message}`);
      continue;
    }

    const proposal = parseReactsNullResponse(responseText);
    if (proposal) proposals.push(proposal);
  }

  return proposals;
}

// Confidence per reactsNullPass proposal type — mirrors
// lib/entity-claims.js#recordEntityClaims exactly (one mapping would be safer
// still, but that module is the DB writer and this one is render-only; kept
// as parallel literal constants deliberately small and co-located with their
// single use each, not worth an extra cross-file import for two numbers).
const REACTS_NULL_CONFIDENCE = Object.freeze({ CONFIRMED: 0.8, TENTATIVE: 0.4 });

/**
 * Render one reactsNullPass proposal through the provenance hedge policy.
 * Every proposal is llm-distilled — CONFIRMED and TENTATIVE both hedge in
 * prose (design §4.3: "no bare calendar date"), they differ only in whether a
 * real date is available to show in the timeline line's own date column.
 * Returns null when the policy is 'omit' (confidence below OMIT_FLOOR).
 *
 * @param {{type:'CONFIRMED'|'TENTATIVE', date:string|null, summary:string}} proposal
 * @returns {{date:string|null, summary:string}|null}
 */
export function hedgedReactsNullEvent(proposal) {
  const confidence = REACTS_NULL_CONFIDENCE[proposal.type] ?? REACTS_NULL_CONFIDENCE.TENTATIVE;
  const policy = hedgePolicy(SOURCE_CLASS.LLM_DISTILLED, confidence);
  if (policy === 'omit') return null;
  return {
    date: proposal.date || null,
    summary: hedgePhrase(proposal.summary, { date: proposal.date || null }),
  };
}

// ── mergeEnrichment ──────────────────────────────────────────────────────────

/**
 * Merge enrichment sections into an existing context file.
 *
 * Strategy: Replace ## Relationship Timeline and ## Key Topics sections if they
 * exist. Append them if absent. Never raw-replace the whole file.
 *
 * WHY merge not replace: the original LLM bio (Phase 7) is still the best
 * structured narrative for the entity. Enrichment adds timeline + topics on top.
 * Replacing would lose the bio on each enrichment re-run.
 *
 * Idempotence guarantee: running this twice with the same sections produces
 * output within 200 bytes of the first run. Achieved by section-level replace
 * (not append), so duplicate sections cannot accumulate.
 *
 * @param {string} existingContent - current context file content
 * @param {{ timelineSection: string, topicsSection: string, correctionsSection?: string }} sections
 * @returns {string} merged content
 */
export function mergeEnrichment(existingContent, { timelineSection, topicsSection, correctionsSection = '' }) {
  let content = existingContent;

  // Replace or append ## Relationship Timeline section.
  // WHY regex with [\s\S]*? and lookahead: greedily captures everything between
  // this heading and the next ## heading (or end of file), replacing atomically.
  if (/^## Relationship Timeline/m.test(content)) {
    content = content.replace(
      /^## Relationship Timeline[\s\S]*?(?=^## |\Z)/m,
      timelineSection,
    );
  } else {
    // Append before the final `---` separator if present, otherwise at end.
    const sepIdx = content.lastIndexOf('\n---\n');
    if (sepIdx !== -1) {
      content = content.slice(0, sepIdx) + '\n\n' + timelineSection + '\n---\n' + content.slice(sepIdx + 5);
    } else {
      content = content.trimEnd() + '\n\n' + timelineSection;
    }
  }

  // Replace or append ## Key Topics section.
  if (/^## Key Topics/m.test(content)) {
    content = content.replace(
      /^## Key Topics[\s\S]*?(?=^## |\Z)/m,
      topicsSection,
    );
  } else {
    const sepIdx = content.lastIndexOf('\n---\n');
    if (sepIdx !== -1) {
      content = content.slice(0, sepIdx) + '\n\n' + topicsSection + '\n---\n' + content.slice(sepIdx + 5);
    } else {
      content = content.trimEnd() + '\n\n' + topicsSection;
    }
  }

  return mergeOptionalSection(content, 'User Corrections', correctionsSection);
}

function mergeOptionalSection(content, heading, section) {
  if (!String(section || '').trim()) return content;
  const pattern = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=^## |\\Z)`, 'm');
  if (pattern.test(content)) return content.replace(pattern, section);
  const sepIdx = content.lastIndexOf('\n---\n');
  if (sepIdx !== -1) {
    return content.slice(0, sepIdx) + '\n\n' + section + '\n---\n' + content.slice(sepIdx + 5);
  }
  return content.trimEnd() + '\n\n' + section;
}

function buildViewerCorrectionsSection(corrections) {
  const lines = (corrections || [])
    .map((correction) => {
      const summary = String(correction.summary || correction.correction_text || '').trim();
      if (!summary) return '';
      return `- ${correction.valid_at || 'unknown time'}: ${summary}`;
    })
    .filter(Boolean);
  if (!lines.length) return '';
  return `## User Corrections

${lines.join('\n')}

`;
}

// ── extractProfessionalContext ────────────────────────────────────────────────

/**
 * Extract professional context (title/employer) for a person.
 *
 * Two-pass approach:
 *   1. Query entity_facts for employer rows (1,914 already in DB).
 *   2. Regex scan top-5 recent email bodies for signature patterns.
 *
 * Best available result wins. If nothing found, returns { employer: null, title: null }.
 * WHY not write empty string: empty linkedin_title pollutes the context file header.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string, display_name: string }} person
 * @returns {{ employer: string|null, title: string|null }}
 */
export async function extractProfessionalContext(db, person) {
  const result = { employer: null, title: null };

  // Pass 1: entity_facts (free — already computed)
  const facts = db.prepare(SQL.entityFacts).all(person.id);
  for (const f of facts) {
    if (f.fact_type === 'employer' && !result.employer) result.employer = f.fact_value;
    if (f.fact_type === 'job_title' && !result.title) result.title = f.fact_value;
  }

  // Pass 2: email signature scan (regex — free)
  // WHY only when entity_facts is incomplete: avoid unnecessary DB reads.
  if (!result.title) {
    let bodies;
    try {
      bodies = db.prepare(SQL.emailBodies).all(person.id);
    } catch {
      bodies = [];
    }

    for (const { body_text } of bodies) {
      if (!body_text) continue;
      // Try each signature pattern in order of specificity
      for (const pattern of SIG_PATTERNS) {
        const m = body_text.match(pattern);
        if (m) {
          // Pattern 1 (pipe-separated): group 1 = title, group 2 = employer
          // Pattern 2 (Title: prefix): group 1 = title
          // Pattern 3 (title on own line): group 1 = title
          const extracted = m[1]?.trim();
          if (extracted && extracted.length < 80) {
            result.title = extracted;
            if (!result.employer && m[2]) result.employer = m[2].trim();
            break;
          }
        }
      }
      if (result.title) break;
    }
  }

  return result;
}

// ── backfillTitlesFromFacts ───────────────────────────────────────────────────

/**
 * One-time bulk backfill: write employer from entity_facts → linkedin_title.
 *
 * WHY a separate backfill function:
 *   extractProfessionalContext() works per-entity during enrichment. But there
 *   are 1,914 employer facts already in entity_facts that predate the enrichment
 *   pipeline. This backfill seeds linkedin_title for all of them at once (free —
 *   pure SQL, no LLM). Subsequent enrichment runs can then refine with signature
 *   regex on top of the seeded value.
 *
 *   Called once from 08-entity-enrich.js on first run, then becomes idempotent
 *   (only updates rows where linkedin_title is still empty).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} rows updated
 */
export function backfillTitlesFromFacts(db) {
  const updateStmt = db.prepare(
    "UPDATE people SET linkedin_title = ? WHERE id = ? AND (linkedin_title IS NULL OR linkedin_title = '')",
  );
  const facts = db.prepare(`
    SELECT ef.entity_id, ef.fact_value
    FROM entity_facts ef
    WHERE ef.fact_type = 'employer'
      AND ef.fact_value IS NOT NULL
      AND ef.fact_value != ''
    GROUP BY ef.entity_id
  `).all();

  let updated = 0;
  db.transaction(() => {
    for (const f of facts) {
      const r = updateStmt.run(f.fact_value, f.entity_id);
      if (r.changes > 0) updated++;
    }
  })();
  return updated;
}

// ── buildTimelineSection ──────────────────────────────────────────────────────

/**
 * Build the ## Relationship Timeline section from extracted events + existing events.
 *
 * Deduplicates by date+summary, sorts by date desc.
 *
 * @param {Array<{type:'CONFIRMED'|'TENTATIVE', date: string|null, summary: string}>} extractedEvents - from reactsNullPass
 * @param {Array<{event_date: string, summary: string}>} timelineEvents - from DB
 * @returns {string} formatted section string
 */
export function buildTimelineSection(extractedEvents, timelineEvents) {
  // Combine REACTS NULL events with existing timeline events.
  // WHY both: REACTS NULL extracts from body content (email/iMessage text);
  // timeline_events has structured event metadata (meeting dates, etc.).
  const allEvents = [];

  // Every reactsNullPass proposal is llm-distilled — route it through the
  // hedge policy before it ever reaches the rendered timeline. A TENTATIVE
  // proposal (hedgedReactsNullEvent) carries date:null, so
  // formatEntityTimelineLines (lib/entity-timeline.js) falls back to its own
  // "unknown date" label rather than ever printing a fabricated one.
  for (const e of extractedEvents) {
    const hedged = hedgedReactsNullEvent(e);
    if (hedged) allEvents.push(hedged);
  }
  for (const e of timelineEvents) {
    const date = (e.event_date || '').slice(0, 10);
    if (date && e.summary) {
      allEvents.push({
        date,
        summary: e.summary.slice(0, 120),
        sourceLabel: e.sourceLabel,
        hasTimelineEvent: e.hasTimelineEvent,
        hasLinkedRag: e.hasLinkedRag,
        embedded: e.embedded,
      });
    }
  }

  // Deduplicate by date+first-50-chars of summary
  const seen = new Set();
  const deduped = allEvents.filter(e => {
    const key = `${e.date}:${e.summary.slice(0, 50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort newest-first. WHY (b.date || '') not b.date: a TENTATIVE proposal's
  // date is null (structurally — never fabricated); comparing null > string
  // coerces both sides to Number (NaN), which always compares false and would
  // silently corrupt ordering. Defaulting null to '' keeps dated events
  // sorted correctly and groups undated events consistently at the tail.
  deduped.sort((a, b) => ((b.date || '') > (a.date || '') ? 1 : -1));

  return formatEntityTimelineSection(deduped, {
    heading: 'Relationship Timeline',
    maxEvents: 15,
    empty: '- No source-backed timeline events extracted yet.',
  }) + '\n';
}

// ── buildTopicsSection ────────────────────────────────────────────────────────

/**
 * Build the ## Key Topics section from chunk content (keyword extraction).
 * WHY free-tier: full topic extraction via LLM is unnecessary for the topics section.
 * The context file already has topics from person_topics table (Phase 7).
 * This section adds body-content-derived keywords to supplement.
 *
 * @param {Array<{content: string}>} chunks
 * @returns {string}
 */
function buildTopicsSection(chunks) {
  // WHY simple word frequency: the goal is "discussed topics" not semantic clustering.
  // A regex word count over top chunks is free and sufficient for the topics section.
  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
    'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his',
    'how', 'its', 'let', 'may', 'new', 'now', 'old', 'see', 'two', 'who',
    'did', 'she', 'use', 'way', 'even', 'most', 'from', 'they', 'this',
    'with', 'that', 'have', 'will', 'your', 'been', 'more', 'also', 'into',
    'than', 'then', 'some', 'what', 'when', 'here', 'just', 'know', 'take',
    'time', 'over', 'each', 'such', 'like', 'only', 'very', 'their', 'there',
    'about', 'which', 'would', 'these', 'other', 'could', 'after', 'first',
    'well', 'back', 'were', 'need', 'make', 'want', 'come', 'said', 'going',
    'reply', 'email', 'mailto', 'wrote', 'original', 'message', 'sent', 'from',
    'subject', 'date', 'dear', 'hello', 'thanks', 'thank', 'best', 'regards',
  ]);

  const freq = new Map();
  for (const { content } of chunks.slice(0, 10)) {
    const words = (content || '').toLowerCase().match(/\b[a-z]{4,20}\b/g) || [];
    for (const w of words) {
      if (!STOP_WORDS.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
    }
  }

  const topWords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);

  return `## Key Topics

${topWords.length ? topWords.join(', ') : 'No topics extracted yet.'}

`;
}

// ── enrichEntity ─────────────────────────────────────────────────────────────

/**
 * Enrich a single entity: fetch body chunks, run REACTS NULL, merge into context file.
 *
 * Failure handling per brief:
 *   - Haiku call fails mid-batch: log entity_id, leave needs_regen=1 for retry
 *   - Context file write: write to {uuid}.md.tmp, rename on success
 *   - Any unhandled error: re-throw (caller handles needs_regen state)
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string, display_name: string }} entity - minimal entity shape
 * @param {{ belt: string }} opts
 * @returns {Promise<{ enriched: boolean, events: number, titleUpdated: boolean }>}
 */
export async function enrichEntity(db, entity, opts = {}) {
  // BB gate MUST be first — before any DB or LLM call.
  // WHY process.env fallback: opts.belt is the primary path; env allows CLI override.
  const belt = opts.belt || process.env.BELT || 'white';
  if (belt !== 'black') {
    throw new Error(`Black Belt required for entity enrichment (current: ${belt})`);
  }
  const signal = opts.signal || null;
  if (signal?.aborted) throw new DOMException('entity enrichment aborted', 'AbortError');

  // Verify entity exists in DB.
  const person = db.prepare(SQL.personById).get(entity.id);
  if (!person) {
    throw new Error(`Entity not found: ${entity.id}`);
  }

  // Cardless high-value people: create a floor-backed skeleton so timeline /
  // topics have a file to merge into. No LLM — Tier-0 only.
  if (!person.context_file_path) {
    try {
      ensurePersonContextSkeleton(db, person);
      const refreshed = db.prepare(SQL.personById).get(entity.id);
      if (refreshed) Object.assign(person, refreshed);
    } catch (err) {
      console.warn(`[entity-enrich] skeleton ensure failed for ${entity.id}: ${err.message}`);
    }
  }

  // Phase 1: Fetch body chunks via chunk_entities join.
  const chunks = fetchBodyChunks(db, entity.id);

  // Phase 2: Fetch existing timeline events.
  const timelineEvents = fetchTimelineEvents(db, entity.id);

  // Phase 3: REACTS NULL pass — extract events from body chunks via Haiku.
  // Only run if there are chunks with content to analyze.
  let extractedEvents = [];
  if (chunks.length > 0) {
    extractedEvents = await reactsNullPass(person, chunks, { signal });
  }
  if (signal?.aborted) throw new DOMException('entity enrichment aborted', 'AbortError');

  // Phase 4: Professional context (entity_facts + email signatures).
  let profContext;
  try {
    profContext = await extractProfessionalContext(db, person);
  } catch (err) {
    console.warn(`[entity-enrich] profContext failed for ${entity.id}: ${err.message}`);
    profContext = { employer: null, title: null };
  }

  // Phase 4b: overlay LinkedIn CSV only as enrichment context. It never creates
  // or merges people. Match by normalized email from the LinkedIn export when
  // present, otherwise by exact unique full name as a narrow enrichment-only
  // fallback.
  const identifiers = db.prepare(SQL.emailIds).all(person.id).map(r => ({ type: 'email', value: r.value }));
  const linkedinMatch = linkedinProfileFor(person, identifiers);
  if (linkedinMatch?.profile?.position) {
    profContext.title = profContext.title || linkedinMatch.profile.position;
  }
  if (linkedinMatch?.profile?.company) {
    profContext.employer = profContext.employer || linkedinMatch.profile.company;
  }

  // Write linkedin_title if we found something and the current value is empty.
  let titleUpdated = false;
  const bestTitle = profContext.title || profContext.employer || null;
  if (bestTitle && !person.linkedin_title) {
    try {
      db.prepare(SQL.updateTitle).run(bestTitle, entity.id);
      titleUpdated = true;
    } catch (err) {
      console.warn(`[entity-enrich] updateTitle failed for ${entity.id}: ${err.message}`);
    }
  }

  // Phase 5: Build enrichment sections.
  const timelineSection = buildTimelineSection(extractedEvents, timelineEvents);
  const topicsSection = buildTopicsSection(chunks);
  const correctionsSection = buildViewerCorrectionsSection(listViewerCorrections(db, {
    targetType: 'person',
    targetId: person.id,
    limit: 20,
  }));

  // Phase 6: Merge into context file (write to .tmp, rename on success).
  if (person.context_file_path) {
    const contextPath = person.context_file_path.replace('~', homedir());
    try {
      const existingContent = readFileSync(contextPath, 'utf8');
      const merged = mergeEnrichment(existingContent, { timelineSection, topicsSection, correctionsSection });
      const tmpPath = contextPath + '.tmp';
      // WHY .tmp + rename: atomic write — if we crash mid-write, original is preserved.
      writeFileSync(tmpPath, merged, 'utf8');
      renameSync(tmpPath, contextPath);
      appendMemoryEvent(db, {
        streamType: 'entity',
        streamId: person.id,
        eventType: 'entity.context.updated',
        actor: 'entity-enrich',
        source: 'entity-enrich',
        subjectType: 'person',
        subjectId: person.id,
        validAt: new Date().toISOString(),
        idempotencyKey: `entity-context:${person.id}:${sha256(merged)}`,
        payload: {
          entity_type: 'person',
          display_name: person.display_name,
          context_file_path: person.context_file_path,
          context_hash: sha256(merged),
          extracted_events: extractedEvents.length,
          timeline_events: timelineEvents.length,
          title_updated: titleUpdated,
        },
        links: [{ targetType: 'person', targetId: person.id, role: 'canonical_context' }],
      });
    } catch (err) {
      // Context file missing or write failed — log but don't crash.
      // needs_regen stays 1 so the next maint_enrich pass retries.
      console.warn(`[entity-enrich] context file write failed for ${entity.id}: ${err.message}`);
      throw err; // re-throw so caller keeps needs_regen = 1
    }
  }

  // Phase 7: Clear needs_regen = 0 on success.
  // WHY needs_regen = 0 (not NULL): column is NOT NULL in schema (confirmed).
  db.prepare(SQL.clearNeedsRegen).run(entity.id);

  return {
    enriched: true,
    events: extractedEvents.length + timelineEvents.length,
    titleUpdated,
  };
}

// ── runEnrichmentSlice ────────────────────────────────────────────────────────

// Default slice size for one passive-worker enrichment drain. Small + bounded so
// a single fire stays well under the launchd timeout and never spikes spend —
// the same "small steady batches" discipline the embedder uses. Env-overridable
// per the no-hardcoded-tunables rule.
const ENRICH_SLICE_DEFAULT = (() => {
  const n = Number.parseInt(String(process.env.ROBOTDOJO_ENRICH_SLICE_SIZE ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
})();

/**
 * Enrich one bounded, highest-value-first slice of the needs_regen backlog.
 *
 * st_b50005df Phase 4 — this is the unit of work the always-on passive worker
 * runs per `entity_enrich` job. It reuses selectEnrichmentCandidates (the single
 * tier-then-score priority sort), enriches up to `limit` entities, and returns a
 * count. Each enriched entity has its needs_regen cleared by enrichEntity, so
 * the backlog the reconciler re-derives shrinks monotonically — and a re-run of
 * a reclaimed job naturally picks up where the last one stopped (the cleared
 * rows drop out of the candidate set). That is what makes enrichment idempotent
 * and self-healing on the lease/reconciler queue: a crash mid-slice loses at
 * most the in-flight entity, which is simply re-selected next fire.
 *
 * The actual enrichment call is INJECTED (`enrich`, default enrichEntity) so the
 * self-heal/priority tests can drive the full queue + reconciler path with a
 * fixture enricher and NEVER touch the model — zero real spend in test.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.limit]   max entities this slice may enrich
 * @param {string} [opts.belt]    'black' required (enrichEntity enforces the gate)
 * @param {Function} [opts.enrich] (db, entity, {belt}) => Promise — injectable
 * @param {AbortSignal} [opts.signal] cooperative abort between entities
 * @returns {Promise<{ enriched: number, failed: number, remaining: number, aborted: boolean }>}
 */
export async function runEnrichmentSlice(db, {
  limit = ENRICH_SLICE_DEFAULT,
  belt = process.env.BELT || 'white',
  enrich = enrichEntity,
  signal = null,
} = {}) {
  // Before selecting: promote cardless high-value people into the backlog so
  // first-session Family/Core/Partners are not stuck without a context package.
  try { promoteHighValueCardlessToBacklog(db, { limit: Math.max(limit || 20, 20) }); }
  catch (err) { console.warn('[entity-enrich] cardless promote skipped:', err.message); }

  const candidates = selectEnrichmentCandidates(db, { limit });
  let enriched = 0;
  let failed = 0;
  let aborted = false;

  for (const person of candidates) {
    // Cooperative abort between entities (idle/SIGTERM). The in-flight entity is
    // never half-written — enrichEntity writes atomically and clears needs_regen
    // only on success — so an abort here simply leaves the rest for the next
    // fire. The worker maps this to a benign requeue (attempts unchanged).
    if (signal?.aborted) { aborted = true; break; }
    try {
      await enrich(db, person, { belt, signal });
      enriched += 1;
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        aborted = true;
        break;
      }
      // Non-fatal per-entity: needs_regen stays 1, so the entity is simply
      // re-selected on a later fire. Never crash the whole slice on one entity.
      failed += 1;
    }
  }

  return { enriched, failed, remaining: enrichmentBacklogCount(db), aborted };
}
