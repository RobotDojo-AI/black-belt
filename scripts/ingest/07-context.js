/**
 * Phase 7 — Context: generate human-readable markdown files for top-tier entities.
 *
 * Compute Tier Protocol (see lib/compute-tier.js):
 *   Tier 0 (free): thin signal (< 5 interactions AND < 3 RAG chunks) → structured template, no LLM
 *   Tier 1 (Haiku): moderate signal → synthesized bio from structured data + RAG chunks
 *   Tier 2 (Sonnet): top N2 (Family/Core/Partners) + deep signal (50+ interactions) → richer synthesis
 *
 * WHY N2-based tier routing for context files (not entityTier()):
 *   entityTier() uses interaction_count thresholds (< 5 → free). For context generation,
 *   we route by N2 directly: Core/Family/Partners always get at least Haiku regardless of
 *   interaction_count, because the relationship matters more than the signal volume.
 *   entityTier() is still used for people with no explicit N2.
 *
 * WHY 20-concurrent: sequential LLM calls are prohibited (parallelize-by-default rule).
 * 20 is the practical limit before Anthropic rate limiting bites.
 *
 * WHY eligible includes Acquaintance: free templates cost nothing. Better to have a
 * structured card for every entity than skip them — chat can use any context file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve } from 'path';
import { TIER, routeToBuckets } from '../../lib/compute-tier.js';
import { modelFor } from '../../lib/model-lane.js';

// Intelligence Tier Protocol (agents/build-conventions.md): this script reads
// structured entity data and calls Haiku/Sonnet to WRITE canonical context
// markdown — the synthesis tier (reads structure, writes canonical docs only;
// never writes a DB row/edge via the LLM). The only DB writes here are
// deterministic context_file_path pointers, set by code, not the model.
export const INTELLIGENCE_TIER = 'synthesis';
import { entityPackageNameFromDisplay } from '../../lib/context-paths.js';
import { USER_CONTEXTS_DIR, USER_CONTEXTS_REL } from '../../lib/robotdojo-paths.js';
import { getEntityTimeline, formatEntityTimelineLines } from '../../lib/entity-timeline.js';
import { markEntityNeedsRegenForEvidence } from '../../lib/entity-source-evidence.js';
import { relationPhrase } from '../../lib/relation-vocabulary.js';
import { rankedFirstDegreeEdges, buildEntityFloor } from '../../lib/entity-floor.js';
import {
  contextTierFromN2,
  computeCardSignal,
  validateCardNames,
  cardNameWhitelistFor,
  knownCompanyNames,
  buildContextHaystack,
  cardDerivedHash,
  writeCardProvenance,
  CARD_ABSTAIN_FLOOR,
} from '../../lib/entity-card.js';

// st_c619d929 — contextTierFromN2 now lives in lib/entity-card.js (the single
// tier→model rule, reused by the scheduled-refresh writer). Re-exported here so
// existing importers (tests, criteria) keep resolving it from this module.
export { contextTierFromN2 };

// WHY three separate dirs: context files are entity-type-specific. Mixing people,
// companies, and places in one flat dir makes it impossible to pattern-match by type
// in tooling (grep, glob, regen scripts). AC2 verifies all three dirs are populated.
const PEOPLE_DIR    = resolve(USER_CONTEXTS_DIR, 'people');
const COMPANIES_DIR = resolve(USER_CONTEXTS_DIR, 'companies');
const PLACES_DIR    = resolve(USER_CONTEXTS_DIR, 'places');
const BATCH_SIZE = 20; // WHY 20: Anthropic rate limit sweet spot for Haiku

/**
 * Determine context tier for a place based on its rank within its subtype.
 * Rank 1-50 per subtype → Sonnet, 51-150 → Haiku, 150+ → free (no context file generated).
 * WHY rank-based not N2-based: places don't have a relationship tier. Rank within subtype
 * is the best available proxy for importance — top restaurants/offices matter most.
 */
export function contextTierFromPlaceRank(rank) {
  if (rank <= 50) return 'sonnet';
  if (rank <= 150) return 'haiku';
  return 'free';
}

/**
 * Build a context file path for a person entity.
 */
function personContextPath(person) {
  return resolve(PEOPLE_DIR, entityPackageNameFromDisplay(person.id, person.display_name || person.name || person.id), 'context.md');
}

/**
 * Build a context file path for a company entity.
 */
function companyContextPath(company) {
  return resolve(COMPANIES_DIR, entityPackageNameFromDisplay(company.id, company.name || company.id), 'context.md');
}

/**
 * Build a context file path for a place entity.
 */
function placeContextPath(place) {
  return resolve(PLACES_DIR, entityPackageNameFromDisplay(place.id, place.name || place.id), 'context.md');
}

function writeContextFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function repoContextPath(typeDir, entityId, displayName) {
  return `~/robotdojo/${USER_CONTEXTS_REL}/${typeDir}/${entityPackageNameFromDisplay(entityId, displayName || entityId)}/context.md`;
}

/**
 * Format ISO date as YYYY-MM-DD
 */
function fmtDate(iso) {
  if (!iso) return 'unknown';
  return iso.slice(0, 10);
}

function humanDate(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(unknown|null|n\/a|na)$/i.test(raw)) return '';
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})(.*)$/);
  if (!match) return raw;
  const date = new Date(`${match[1]}T00:00:00`);
  if (Number.isNaN(date.getTime())) return raw;
  return `${date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}${match[2] || ''}`;
}

function humanLabel(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function humanPlaceLabel(value) {
  const label = humanLabel(value || 'place').toLowerCase();
  if (label === 'virtual') return 'virtual meeting link';
  return label;
}

function articleFor(value) {
  return /^[aeiou]/i.test(String(value || '')) ? 'an' : 'a';
}

function meaningfulPlaceType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!type || ['place', 'other', 'unknown', 'venue'].includes(type)) return '';
  return type;
}

function meaningfulCompanyLane(value) {
  const lane = humanLabel(value || '');
  if (!lane || /^(unknown|null|n\/a|na|other)$/i.test(lane)) return '';
  return lane;
}

function capturedPlaceArtifact(value) {
  const text = String(value || '');
  if (/scheduled Zoom meeting|Join Zoom Meeting|zoom\.us\/|Meeting ID:|Passcode:|uuid=WN_/i.test(text)) {
    return 'Zoom invitation';
  }
  if (/acuityscheduling\.com|calendly\.com|action=meet|apptID=/i.test(text)) return 'scheduling link';
  if (/^(?:URL:\s*)?https?:\/\//i.test(text)) return 'web link';
  return '';
}

export function cleanPlaceDisplayName(value) {
  const raw = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return raw;
  const artifact = capturedPlaceArtifact(raw);
  if (artifact === 'Zoom invitation') return 'Zoom meeting invitation';
  if (artifact === 'scheduling link') return 'Scheduling link';
  if (artifact === 'web link') return 'Captured web link';
  return raw
    .replace(/,\s*when you dine at restaurants worldwide.*$/i, '')
    .replace(/\s+Terms apply\..*$/i, '')
    .replace(/\s+As a valued guest,.*$/i, '')
    .replace(/,\s*How likely are you.*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[,\s]+$/, '')
    .trim();
}

function cleanPlaceAddress(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/,\s*when you dine at restaurants worldwide.*$/i, '')
    .replace(/\s+Terms apply\..*$/i, '')
    .replace(/\s+As a valued guest,.*$/i, '')
    .replace(/,\s*How likely are you.*$/i, '')
    .trim();
}

function companyMapPhrase(company) {
  const n2 = humanLabel(company.n2 || '').toLowerCase();
  if (!n2) return '';
  if (n2 === 'network') return 'through the network layer';
  if (n2 === 'target') return 'as a target company';
  if (n2 === 'partner' || n2 === 'partners') return 'through the partner layer';
  return `through the ${n2} layer`;
}

function smallNumberWord(value) {
  const n = Number(value || 0);
  return { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five' }[n] || String(n);
}

/**
 * Build the structured data section for a person.
 */
function buildPersonData(person, identifiers, topics, edges, interactions) {
  const emailIds = identifiers.filter(i => i.type === 'email').map(i => i.value);
  const recentInteractions = interactions
    .filter(i => i.last_date)
    .sort((a, b) => new Date(b.last_date) - new Date(a.last_date))
    .slice(0, 3)
    .map(i => `${i.channel} (${fmtDate(i.last_date)})`);

  const topTopics = topics.slice(0, 5).map(t => t.topic);
  const topEdges = edges.slice(0, 3).map(e => e.display_name).filter(Boolean);

  return {
    email: emailIds[0] || null,
    company: person.company_name || null,
    title: person.linkedin_title || null,
    firstSeen: fmtDate(person.first_seen),
    lastSeen: fmtDate(person.last_seen),
    yearsKnown: person.first_seen
      ? Math.round((Date.now() - new Date(person.first_seen).getTime()) / (365.25 * 86400000))
      : null,
    topTopics,
    recentInteractions,
    topEdges,
  };
}

/**
 * Generate the Haiku/Sonnet prompt for a person context file.
 *
 * WHY separate ragChunks and timelineEvents params:
 *   ragChunks = raw body content (email/iMessage/calendar text) — rich context
 *   timelineEvents = structured timeline milestones — dated relationship history
 *   Each contributes a distinct signal type to the LLM synthesis.
 */
export function buildPersonPrompt(person, data, ragChunks, ownerName, timelineEvents = []) {
  // st_f1a40461: bodyChunks now returns ~16 chunks (2 per time-bucket, DESC). Take
  // every other (one per bucket) so the prompt spans the FULL relationship arc —
  // earliest chapters through recent — instead of 5 chunks from the last few weeks.
  // 8 chunks at 800 chars = ~6.4K chars = ~1.6K tokens.
  const ragContext = ragChunks.filter((_, i) => i % 2 === 0).slice(0, 8)
    .map(c => `[${(c.event_time || '').slice(0, 7)}] ${(c.content || '').slice(0, 800)}`)
    .filter((s) => s.length > 12)
    .join('\n\n---\n\n');

  // WHY top 5 timeline events in prompt: gives the LLM dated milestones without
  // exceeding prompt budget. Full timeline synthesis happens in Phase 2 (08-entity-enrich.js).
  const timelineContext = timelineEvents.slice(0, 5)
    .map(e => `${(e.event_date || '').slice(0, 10)}: ${e.summary || ''}`.trim())
    .filter(Boolean)
    .join('\n');

  // WHY ownerName from identity: never hardcode the owner's name in repo code.
  // Read from ~/.robotdojo/identity.json at runtime via ownerDisplayName().
  const ownerRef = ownerName || 'the user';

  // st_df0a8d71 AC-3 — the STORED relationship is source truth in the prompt.
  // The defect card called the owner's spouse a "cohabitating partner" because
  // the generator was never fed relation_tag and guessed the relationship from
  // message tone. The graph value (gendered label falling back to the tag
  // class) now arrives as an explicit non-negotiable fact.
  // st_f67bc2eb AC-2 — the walk-derived phrase ("wife's cousin") is the most
  // precise truth the graph holds; tag+label is the direct-relation fallback.
  const storedRelationship = person.relation_tag
    ? `- Family relationship (SOURCE TRUTH from the entity graph — state it plainly; never contradict, soften, or re-infer it from message tone): this person is ${ownerRef}'s ${person.relation_derived_phrase || relationPhrase(person.relation_tag, person.relation_label)}`
    : '';

  return `You are writing the private "current read" that ${ownerRef} sees before meeting, messaging, or thinking about this person.
This is not a CRM card and not a wiki bio. The goal is recognition: ${ownerRef} should feel oriented to a real person, the relationship, and what matters now.

Write the Summary body only. Use 2-4 short paragraphs. No heading, no bullets, no field list.
Be specific and source-grounded. Use judgment, texture, and relationship context; do not sentimentalize or invent.
If the signal is thin, say what is known and what is still provisional in human language.

PERSON DATA:
- Name: ${person.display_name}
- Relationship type: ${person.n1} > ${person.n2}${storedRelationship ? `\n${storedRelationship}` : ''}
- Company: ${data.company || 'unknown'}
- Title: ${data.title || 'unknown'}
- Email: ${data.email || 'unknown'}
- Known since: ${data.firstSeen} (${data.yearsKnown ?? '?'} years)
- Last contact: ${data.lastSeen}
- Topics discussed: ${data.topTopics.join(', ') || 'none recorded'}
- Recent interactions: ${data.recentInteractions.join(', ') || 'none'}
- Network connections: ${data.topEdges.join(', ') || 'none'}

RELEVANT CONTEXT (from email/calendar/messages/transcripts):
${ragContext || '(no body content available)'}

RELATIONSHIP TIMELINE (recent milestones):
${timelineContext || '(no timeline events recorded)'}

Cover:
- The live read on who they are in ${ownerRef}'s world
- How ${ownerRef} knows them, what connects them, and what the relationship feels useful for
- Recent signal, notable interactions, open questions, or next-contact posture

Write in direct prose. Avoid labels like "Type:", "Recent:", "Low-signal entity", "structured data", "database", or "record".
Do not invent details not supported by the data.
Use the person's name or they/them unless the source data clearly establishes pronouns.`;
}

// Summary/History split markers (st_2cd1af73 Phase 5).
//
// WHY a fixed `## Summary` … `---` … `## History` shape: chat injection
// (lib/chat-context.js) parses for the `## Summary` heading and injects ONLY
// that section by default — a tight ~4k chat-ready card — while everything
// archival (prior bios, manual sections, enrichment additions, the LinkedIn
// line) lives below the `---` under `## History` and is read on demand, never
// force-injected. The marker strings are the load-bearing contract between the
// writer (here) and the reader (readEntityContextMarkdown / layerTopicPreamble);
// they MUST stay in sync. Files written before this split carry no marker — the
// reader keeps a legacy first-4k-verbatim fallback so the budget drop is safe
// before every file is rewritten (failure manifest: forward-rolling, no flag day).
export const SUMMARY_HEADING = '## Summary';
export const HISTORY_HEADING = '## History';
const HISTORY_DELIMITER = '\n\n---\n\n';

// Target ceiling for the injected Summary section. The chat injector caps at
// ENTITY_CONTEXT_CHAR_BUDGET (4k); keeping the written Summary at or under this
// means the summary-first injection is the whole summary, not a truncation.
const SUMMARY_TARGET_CHARS = 4000;

// Placeholder kept under ## History when an entity has nothing archival yet.
// WHY emit it anyway: the Summary/History split is a STRUCTURAL invariant the
// consolidation/split probes assert on (## Summary AND ## History on every
// regenerated file). A ~one-line placeholder below the fold is never injected
// into chat (the injector reads only ## Summary) and costs nothing, but it makes
// the split uniform so the probe is a clean equality check, not a fuzzy majority.
const HISTORY_PLACEHOLDER = '_No prior history recorded yet._';

/**
 * Compose a Summary/History body from a fresh summary plus any historical
 * sections to preserve below the fold. Always emits BOTH the `## Summary`
 * heading (the injection contract) and the `---` + `## History` section (the
 * structural split invariant), using a placeholder when no archival material
 * exists yet.
 *
 * @param {string} summary - the chat-ready bio/template (kept ≤ SUMMARY_TARGET_CHARS)
 * @param {string[]} historyParts - archival blocks (prior bios, LinkedIn line,
 *   manual sections, enrichment additions) appended verbatim under ## History
 */
export function composeSummaryHistory(summary, historyParts = []) {
  const trimmedSummary = String(summary || '').trim().slice(0, SUMMARY_TARGET_CHARS);
  const history = historyParts.map(p => String(p || '').trim()).filter(Boolean);
  const historyBody = history.length ? history.join('\n\n') : HISTORY_PLACEHOLDER;
  return `${SUMMARY_HEADING}\n\n${trimmedSummary}${HISTORY_DELIMITER}${HISTORY_HEADING}\n\n${historyBody}\n`;
}

function appendSourceTimeline(summary, events, { maxEvents = 6 } = {}) {
  const lines = formatEntityTimelineLines(events || [], { maxEvents });
  if (!lines.length) return summary;
  const block = `Source-backed timeline:\n${lines.join('\n')}`;
  const budget = Math.max(0, SUMMARY_TARGET_CHARS - block.length - 2);
  const rawSummary = String(summary || '').trim();
  const cappedSummary = rawSummary.length > budget
    ? `${rawSummary.slice(0, Math.max(0, budget - 3)).trimEnd()}...`
    : rawSummary;
  return [cappedSummary, block].filter(Boolean).join('\n\n');
}

function timelinePromptLines(events, { maxEvents = 8 } = {}) {
  const lines = formatEntityTimelineLines(events || [], { maxEvents });
  return lines.length ? lines.join('\n') : '(no source-backed timeline or linked RAG evidence yet)';
}

function removeSourceTimelineBlock(text) {
  const lines = String(text || '').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== 'Source-backed timeline:') {
      kept.push(lines[i]);
      continue;
    }
    i++;
    while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('- '))) i++;
    i--;
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stableUtf8Text(text) {
  return Buffer.from(String(text || ''), 'utf8').toString('utf8');
}

export function upsertSourceTimelineInSummary(markdown, events, { maxEvents = 6 } = {}) {
  const lines = formatEntityTimelineLines(events || [], { maxEvents });
  if (!lines.length) return markdown;

  const content = String(markdown || '');
  const summaryIdx = content.indexOf(SUMMARY_HEADING);
  if (summaryIdx < 0) {
    return `${content.trimEnd()}\n\n${SUMMARY_HEADING}\n\n${appendSourceTimeline('', events, { maxEvents })}\n`;
  }

  const bodyStart = summaryIdx + SUMMARY_HEADING.length;
  const delimiterIdx = content.indexOf(HISTORY_DELIMITER, bodyStart);
  const historyIdx = content.indexOf(`\n${HISTORY_HEADING}`, bodyStart);
  const summaryEnd = delimiterIdx >= 0
    ? delimiterIdx
    : (historyIdx >= 0 ? historyIdx : content.length);
  const prefix = content.slice(0, bodyStart);
  const summaryBody = content.slice(bodyStart, summaryEnd);
  const suffix = removeSourceTimelineBlock(content.slice(summaryEnd));
  const cleanedSummary = removeSourceTimelineBlock(summaryBody);
  const nextSummary = appendSourceTimeline(cleanedSummary, events, { maxEvents });
  return `${prefix}\n\n${nextSummary}${suffix ? `\n\n${suffix}` : ''}`;
}

function entityContextFilePath(path) {
  const raw = String(path || '');
  if (!raw) return '';
  if (raw.startsWith('~/robotdojo/user/contexts')) {
    return raw.replace('~/robotdojo/user/contexts', USER_CONTEXTS_DIR);
  }
  if (raw.startsWith('~/')) return raw.replace(/^~(?=\/)/, homedir());
  return raw;
}

function sourceEventKey(sourceType, sourceId) {
  if (!sourceType || sourceId == null || sourceId === '') return '';
  return `${sourceType}:${String(sourceId)}`;
}

function tableHasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function sourceEventDate(row) {
  return row?.event_date || row?.created_at || '';
}

function sourceEventSort(a, b) {
  return String(sourceEventDate(b)).localeCompare(String(sourceEventDate(a)))
    || String(b.id || '').localeCompare(String(a.id || ''));
}

function sourceTypeLabel(sourceType) {
  const type = String(sourceType || '').trim().toLowerCase();
  if (type === 'imessage') return 'iMessage';
  if (type === 'granola' || type === 'transcript') return 'meeting transcript';
  if (type === 'drive') return 'document';
  if (type === 'health_note') return 'health note';
  if (type === 'health_metric') return 'health metric';
  if (type === 'key_document') return 'key document';
  return type || 'source';
}

function personTimelineEntryFor(map, personId) {
  if (!map.has(personId)) map.set(personId, { keyed: new Map(), loose: [] });
  return map.get(personId);
}

function batchPersonSourceTimelines(db, people, { limit = 8, chunkLimit = 12 } = {}) {
  if (!people.length) return new Map();

  db.exec('CREATE TEMP TABLE IF NOT EXISTS temp_person_source_timeline_refresh (id TEXT PRIMARY KEY)');
  db.exec('DELETE FROM temp_person_source_timeline_refresh');
  const insert = db.prepare('INSERT OR IGNORE INTO temp_person_source_timeline_refresh (id) VALUES (?)');
  const insertMany = db.transaction((ids) => {
    for (const id of ids) insert.run(id);
  });
  insertMany(people.map((person) => person.id));

  const timelines = new Map();
  const eventLimit = Math.max(1, limit);
  const ragLimit = Math.max(1, chunkLimit);

  const timelineRows = db.prepare(`
    WITH base AS (
      SELECT DISTINCT
        t.id AS person_id,
        te.id,
        te.source_type,
        te.source_id,
        te.event_date,
        te.event_type,
        te.summary,
        tee.role
      FROM temp_person_source_timeline_refresh t
      JOIN timeline_event_entities tee ON (
        tee.person_id = t.id
        OR (tee.entity_type = 'person' AND CAST(tee.entity_id AS TEXT) = t.id)
      )
      JOIN timeline_events te ON te.id = tee.event_id
      WHERE te.event_date IS NOT NULL
        AND te.event_date != ''
    ),
    ranked AS (
      SELECT base.*,
             ROW_NUMBER() OVER (
               PARTITION BY person_id
               ORDER BY event_date DESC, id DESC
             ) AS rn
      FROM base
    )
    SELECT * FROM ranked WHERE rn <= ?
    ORDER BY person_id, event_date DESC, id DESC
  `).all(eventLimit);

  for (const row of timelineRows) {
    const person = personTimelineEntryFor(timelines, row.person_id);
    const key = sourceEventKey(row.source_type, row.source_id) || `event:${row.id}`;
    if (person.keyed.has(key)) continue;
    person.keyed.set(key, {
      id: row.id,
      eventId: row.id,
      event_date: row.event_date,
      date: String(row.event_date || '').slice(0, 10),
      event_type: row.event_type || row.source_type || 'event',
      source_type: row.source_type || null,
      source_id: row.source_id == null ? null : String(row.source_id),
      role: row.role || 'participant',
      summary: row.summary || row.event_type || sourceTypeLabel(row.source_type),
      evidenceIds: [row.id],
      chunkIds: [],
      hasTimelineEvent: true,
      hasLinkedRag: false,
    });
  }

  const chunkRows = db.prepare(`
    WITH ranked AS (
      SELECT
        ce.entity_id AS person_id,
        ce.chunk_id,
        c.source_type,
        c.source_id,
        COALESCE(NULLIF(c.event_time, ''), NULLIF(c.created_at, '')) AS event_date,
        c.created_at,
        c.content,
        c.embedded,
        c.value_rank,
        c.quality_score,
        ROW_NUMBER() OVER (
          PARTITION BY ce.entity_id
          ORDER BY COALESCE(NULLIF(c.event_time, ''), NULLIF(c.created_at, '')) DESC,
                   COALESCE(c.value_rank, 0) DESC,
                   c.id DESC
        ) AS rn
      FROM temp_person_source_timeline_refresh t
      JOIN chunk_entities ce ON ce.entity_type = 'person' AND ce.entity_id = t.id
      JOIN chunks c ON c.id = ce.chunk_id
      WHERE c.content IS NOT NULL
        AND c.content != ''
    )
    SELECT * FROM ranked WHERE rn <= ?
    ORDER BY person_id,
             event_date DESC,
             COALESCE(value_rank, 0) DESC,
             chunk_id DESC
  `).all(ragLimit);

  for (const row of chunkRows) {
    const person = personTimelineEntryFor(timelines, row.person_id);
    const key = sourceEventKey(row.source_type, row.source_id);
    const target = key ? person.keyed.get(key) : null;
    if (target) {
      if (!target.evidenceIds.includes(`chunk:${row.chunk_id}`)) target.evidenceIds.push(`chunk:${row.chunk_id}`);
      if (!target.chunkIds.includes(row.chunk_id)) target.chunkIds.push(row.chunk_id);
      target.hasLinkedRag = true;
      target.embedded = target.embedded || Number(row.embedded || 0) === 1;
      target.valueRank = Math.max(Number(target.valueRank || 0), Number(row.value_rank || 0));
      target.qualityScore = Math.max(Number(target.qualityScore || 0), Number(row.quality_score || 0));
      if (!target.body) target.body = row.content || '';
      continue;
    }

    const chunkEvent = {
      id: `chunk:${row.chunk_id}`,
      eventId: null,
      event_date: row.event_date || row.created_at || '',
      date: String(row.event_date || row.created_at || '').slice(0, 10),
      event_type: 'body_mention',
      source_type: row.source_type || null,
      source_id: row.source_id == null ? null : String(row.source_id),
      role: 'mentioned',
      summary: row.content || sourceTypeLabel(row.source_type),
      body: row.content || '',
      sourceLabel: `Mentioned in ${sourceTypeLabel(row.source_type)}`,
      evidenceIds: [`chunk:${row.chunk_id}`],
      chunkIds: [row.chunk_id],
      hasTimelineEvent: false,
      hasLinkedRag: true,
      embedded: Number(row.embedded || 0) === 1,
      valueRank: Number(row.value_rank || 0),
      qualityScore: Number(row.quality_score || 0),
    };
    if (key) person.keyed.set(key, chunkEvent);
    else person.loose.push(chunkEvent);
  }

  const result = new Map();
  for (const person of people) {
    const entry = timelines.get(person.id);
    if (!entry) {
      result.set(person.id, []);
      continue;
    }
    result.set(person.id, [...entry.keyed.values(), ...entry.loose]
      .filter((event) => event.date || event.summary)
      .sort(sourceEventSort)
      .slice(0, eventLimit));
  }
  return result;
}

const ENTITY_REFRESH_CONFIG = {
  company: {
    table: 'companies',
    nameColumn: 'name',
    orderColumns: ['people_count', 'name'],
  },
  place: {
    table: 'places',
    nameColumn: 'name',
    orderColumns: ['frequency', 'name'],
  },
};

function entityRefreshOrder(db, table, orderColumns) {
  const pieces = [];
  for (const column of orderColumns) {
    if (!tableHasColumn(db, table, column)) continue;
    if (column === 'name') pieces.push(`e.${column}`);
    else pieces.push(`COALESCE(e.${column}, 0) DESC`);
  }
  return pieces.length ? pieces.join(', ') : 'e.id';
}

function uniqueRefreshIds(ids) {
  return [...new Set((ids || []).map(String).map((s) => s.trim()).filter(Boolean))];
}

function markPersonNeedsRegenForEvidence(db, personIds = []) {
  const ids = uniqueRefreshIds(personIds);
  if (!ids.length || !tableHasColumn(db, 'people', 'needs_regen')) return 0;
  const archivedClause = tableHasColumn(db, 'people', 'archived')
    ? 'AND COALESCE(archived, 0) = 0'
    : '';
  const contextClause = tableHasColumn(db, 'people', 'context_file_path')
    ? "AND context_file_path IS NOT NULL AND context_file_path != ''"
    : '';
  const updatedAt = tableHasColumn(db, 'people', 'updated_at')
    ? ", updated_at = datetime('now')"
    : '';
  const update = db.prepare(`
    UPDATE people
       SET needs_regen = 1${updatedAt}
     WHERE id = ?
       ${archivedClause}
       ${contextClause}
  `);
  return db.transaction(() => ids.reduce((total, id) => total + update.run(id).changes, 0))();
}

function sourceTimelineRefreshRows(db, entityType, { ids } = {}) {
  const config = ENTITY_REFRESH_CONFIG[entityType];
  if (!config) throw new Error(`unsupported source timeline refresh entity type: ${entityType}`);
  if (!tableHasColumn(db, config.table, 'context_file_path')) return [];

  const hasIdFilter = Array.isArray(ids);
  const wantedIds = hasIdFilter ? uniqueRefreshIds(ids) : [];
  if (hasIdFilter && !wantedIds.length) return [];

  const archivedPredicate = tableHasColumn(db, config.table, 'archived')
    ? 'COALESCE(e.archived, 0) = 0'
    : '1 = 1';
  const orderBy = entityRefreshOrder(db, config.table, config.orderColumns);

  let idJoin = '';
  if (wantedIds.length) {
    db.exec(`
      DROP TABLE IF EXISTS temp.source_timeline_refresh_ids;
      CREATE TEMP TABLE source_timeline_refresh_ids (id TEXT PRIMARY KEY);
    `);
    const insert = db.prepare('INSERT OR IGNORE INTO source_timeline_refresh_ids (id) VALUES (?)');
    db.transaction(() => {
      for (const id of wantedIds) insert.run(id);
    })();
    idJoin = 'JOIN source_timeline_refresh_ids wanted ON wanted.id = CAST(e.id AS TEXT)';
  }

  try {
    return db.prepare(`
      WITH source_entities AS (
        SELECT DISTINCT CAST(e.id AS TEXT) AS id
        FROM ${config.table} e
        ${idJoin}
        JOIN chunk_entities ce ON ce.entity_type = ? AND CAST(ce.entity_id AS TEXT) = CAST(e.id AS TEXT)
        WHERE ${archivedPredicate}
          AND e.context_file_path IS NOT NULL
          AND e.context_file_path != ''
        UNION
        SELECT DISTINCT CAST(e.id AS TEXT) AS id
        FROM ${config.table} e
        ${idJoin}
        JOIN timeline_event_entities tee ON tee.entity_type = ? AND CAST(tee.entity_id AS TEXT) = CAST(e.id AS TEXT)
        WHERE ${archivedPredicate}
          AND e.context_file_path IS NOT NULL
          AND e.context_file_path != ''
      )
      SELECT CAST(e.id AS TEXT) AS id, e.${config.nameColumn} AS display_name, e.context_file_path
      FROM source_entities se
      JOIN ${config.table} e ON CAST(e.id AS TEXT) = se.id
      ORDER BY ${orderBy}
    `).all(entityType, entityType);
  } finally {
    if (wantedIds.length) {
      try { db.exec('DROP TABLE IF EXISTS temp.source_timeline_refresh_ids'); } catch { /* best effort */ }
    }
  }
}

export function refreshEntitySourceTimelineSections(db, {
  entityType,
  ids,
  limit = Infinity,
  maxEvents = 6,
  log = () => {},
} = {}) {
  const type = String(entityType || '').trim().toLowerCase();
  const rows = sourceTimelineRefreshRows(db, type, { ids });
  const selected = Number.isFinite(limit) ? rows.slice(0, Math.max(0, limit)) : rows;
  const stats = { checked: 0, updated: 0, unchanged: 0, skippedNoTimeline: 0, missingFiles: 0, failed: 0 };

  for (const entity of selected) {
    stats.checked++;
    const timeline = getEntityTimeline(db, {
      entityType: type,
      entityId: entity.id,
      limit: Math.max(8, maxEvents),
      chunkLimit: 12,
    });
    if (!timeline.length) {
      stats.skippedNoTimeline++;
      continue;
    }
    const file = entityContextFilePath(entity.context_file_path);
    try {
      const existing = readFileSync(file, 'utf8');
      const next = stableUtf8Text(upsertSourceTimelineInSummary(existing, timeline, { maxEvents }));
      if (next === existing) {
        stats.unchanged++;
        continue;
      }
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, next, 'utf8');
      renameSync(tmp, file);
      stats.updated++;
    } catch (err) {
      if (err?.code === 'ENOENT') stats.missingFiles++;
      else {
        stats.failed++;
        log(`  WARN: ${type} source timeline refresh failed for ${entity.display_name || entity.id}: ${err.message}`);
      }
    }
  }
  return stats;
}

export function refreshCompanySourceTimelineSections(db, opts = {}) {
  return refreshEntitySourceTimelineSections(db, { ...opts, entityType: 'company' });
}

export function refreshPlaceSourceTimelineSections(db, opts = {}) {
  return refreshEntitySourceTimelineSections(db, { ...opts, entityType: 'place' });
}

export function refreshLinkedEntitySourceTimelineSections(db, {
  entityIdsByType = {},
  maxEvents = 6,
  log = () => {},
  markFailures = true,
} = {}) {
  const result = {};
  for (const type of ['person', 'company', 'place']) {
    const ids = uniqueRefreshIds(entityIdsByType[type] || []);
    const stats = {
      checked: 0,
      updated: 0,
      unchanged: 0,
      skippedNoTimeline: 0,
      missingFiles: 0,
      failed: 0,
      successfulIds: [],
      failedIds: [],
      markedFailures: 0,
    };
    if (type === 'person' && ids.length) {
      const batch = refreshPersonSourceTimelineSections(db, { ids, maxEvents, log });
      stats.checked = batch.checked;
      stats.updated = batch.updated;
      stats.unchanged = batch.unchanged;
      stats.skippedNoTimeline = batch.skippedNoTimeline;
      stats.missingFiles = batch.missingFiles;
      stats.failed = batch.failed;
      const allOk = batch.checked === ids.length
        && batch.failed === 0
        && batch.missingFiles === 0
        && batch.skippedNoTimeline === 0
        && (batch.updated + batch.unchanged) === ids.length;
      if (allOk) stats.successfulIds.push(...ids);
      else stats.failedIds.push(...ids);
      if (markFailures && stats.failedIds.length) {
        stats.markedFailures = markPersonNeedsRegenForEvidence(db, stats.failedIds);
      }
      result[type] = stats;
      continue;
    }
    for (const id of ids) {
      const single = refreshEntitySourceTimelineSections(db, {
        entityType: type,
        ids: [id],
        maxEvents,
        log,
      });
      stats.checked += single.checked;
      stats.updated += single.updated;
      stats.unchanged += single.unchanged;
      stats.skippedNoTimeline += single.skippedNoTimeline;
      stats.missingFiles += single.missingFiles;
      stats.failed += single.failed;
      const ok = single.checked === 1
        && single.failed === 0
        && single.missingFiles === 0
        && single.skippedNoTimeline === 0
        && (single.updated === 1 || single.unchanged === 1);
      if (ok) stats.successfulIds.push(id);
      else stats.failedIds.push(id);
    }
    if (markFailures && stats.failedIds.length) {
      stats.markedFailures = type === 'person'
        ? markPersonNeedsRegenForEvidence(db, stats.failedIds)
        : markEntityNeedsRegenForEvidence(db, type, stats.failedIds);
    }
    result[type] = stats;
  }
  return result;
}

export function refreshPersonSourceTimelineSections(db, {
  ids,
  limit = Infinity,
  maxEvents = 6,
  log = () => {},
} = {}) {
  const stats = { checked: 0, updated: 0, unchanged: 0, skippedNoTimeline: 0, missingFiles: 0, failed: 0 };
  const hasIdFilter = Array.isArray(ids);
  const wantedIds = hasIdFilter ? uniqueRefreshIds(ids) : [];
  if (hasIdFilter && !wantedIds.length) return stats;

  const personOrder = tableHasColumn(db, 'people', 'score')
    ? 'COALESCE(p.score, 0) DESC, p.display_name'
    : 'p.display_name';
  let idJoin = '';
  if (wantedIds.length) {
    db.exec(`
      DROP TABLE IF EXISTS temp.person_source_timeline_refresh_ids;
      CREATE TEMP TABLE person_source_timeline_refresh_ids (id TEXT PRIMARY KEY);
    `);
    const insert = db.prepare('INSERT OR IGNORE INTO person_source_timeline_refresh_ids (id) VALUES (?)');
    db.transaction(() => {
      for (const id of wantedIds) insert.run(id);
    })();
    idJoin = 'JOIN person_source_timeline_refresh_ids wanted ON wanted.id = p.id';
  }

  let rows;
  try {
    rows = db.prepare(`
      WITH source_people AS (
        SELECT DISTINCT p.id
        FROM people p
        ${idJoin}
        JOIN chunk_entities ce ON ce.entity_type = 'person' AND ce.entity_id = p.id
        WHERE COALESCE(p.archived, 0) = 0
          AND p.context_file_path IS NOT NULL
          AND p.context_file_path != ''
        UNION
        SELECT DISTINCT p.id
        FROM people p
        ${idJoin}
        JOIN timeline_event_entities tee ON (
          tee.person_id = p.id
          OR (tee.entity_type = 'person' AND CAST(tee.entity_id AS TEXT) = p.id)
        )
        WHERE COALESCE(p.archived, 0) = 0
          AND p.context_file_path IS NOT NULL
          AND p.context_file_path != ''
      )
      SELECT p.id, p.display_name, p.context_file_path
      FROM source_people sp
      JOIN people p ON p.id = sp.id
      ORDER BY ${personOrder}
    `).all();
  } finally {
    if (wantedIds.length) {
      try { db.exec('DROP TABLE IF EXISTS temp.person_source_timeline_refresh_ids'); } catch { /* best effort */ }
    }
  }
  const selected = Number.isFinite(limit) ? rows.slice(0, Math.max(0, limit)) : rows;
  const timelines = batchPersonSourceTimelines(db, selected, {
    limit: Math.max(8, maxEvents),
    chunkLimit: 12,
  });

  for (const person of selected) {
    stats.checked++;
    const timeline = timelines.get(person.id) || [];
    if (!timeline.length) {
      stats.skippedNoTimeline++;
      continue;
    }
    const file = entityContextFilePath(person.context_file_path);
    try {
      const existing = readFileSync(file, 'utf8');
      const next = stableUtf8Text(upsertSourceTimelineInSummary(existing, timeline, { maxEvents }));
      if (next === existing) {
        stats.unchanged++;
        continue;
      }
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, next, 'utf8');
      renameSync(tmp, file);
      stats.updated++;
    } catch (err) {
      if (err?.code === 'ENOENT') stats.missingFiles++;
      else {
        stats.failed++;
        log(`  WARN: person source timeline refresh failed for ${person.display_name || person.id}: ${err.message}`);
      }
    }
  }
  return stats;
}

/**
 * Build the markdown frontmatter + content for a person context file.
 * WHY enrichment field: AC3 greps for 'enrichment: sonnet' to verify
 * that Sonnet-tier entities were processed by the right model.
 *
 * st_2cd1af73 Phase 5: the body is split into `## Summary` (the bio, the only
 * section chat injects by default, ≤4k) and `## History` (the LinkedIn line and
 * any other archival material), separated by `---`. The LinkedIn provenance
 * line moved from inline-after-the-bio to under ## History so it never eats the
 * injected summary budget.
 */
export function buildContextFile(entity, entityType, bio, enrichmentTier) {
  const generatedAt = new Date().toISOString();
  const name = entity.display_name || entity.name || entity.id;
  const firstYear = entity.first_seen ? new Date(entity.first_seen).getFullYear() : '?';
  const lastDate = fmtDate(entity.last_seen);

  const frontmatter = `---
entity_id: ${entity.id}
entity_type: ${entityType}
n1: ${entity.n1 || ''}
n2: ${entity.n2 || ''}
display_name: ${name}
generated_at: ${generatedAt}
enrichment: ${enrichmentTier}
---`;

  const subtitle = entityType === 'person'
    ? `*${entity.n1 || ''} > ${entity.n2 || ''} | Known since ${firstYear} | Last contact ${lastDate}*`
    : `*${entity.n1 || ''} > ${entity.n2 || ''}*`;

  const historyParts = [];
  if (entity.linkedin_title) {
    historyParts.push(`*LinkedIn (from your connections import): ${entity.linkedin_title}*`);
  }

  // st_df0a8d71 AC-3 — deterministic (non-LLM) relationship lead. For
  // relation-tagged people the written Summary OPENS with the graph
  // relationship, prepended by code after synthesis — the card can no longer
  // omit or invent the relationship regardless of what the model wrote, and
  // the 1200-char fast-fallback head slice always carries it.
  const relationLead = entityType === 'person' && entity.relation_tag
    ? `Relationship on record: your ${entity.relation_derived_phrase || relationPhrase(entity.relation_tag, entity.relation_label)} (from the entity graph — authoritative for who-is-who).`
    : '';
  const summaryBody = relationLead ? `${relationLead}\n\n${String(bio || '').trim()}` : bio;

  return `${frontmatter}
# ${name}
${subtitle}

${composeSummaryHistory(summaryBody, historyParts)}`;
}

/**
 * Build the Haiku/Sonnet prompt for a company context file.
 * Parallel to buildPersonPrompt — same owner-reference pattern, same factual discipline.
 */
export function buildCompanyPrompt(company, topContacts, ownerRef, timelineEvents = []) {
  const contactLines = topContacts.length > 0
    ? topContacts.map(p => `${p.display_name} (${p.n2 || '?'})`).join(', ')
    : 'none recorded';
  return `You are writing the private "current read" that ${ownerRef} sees before thinking about this company.
This is not a company profile or database card. The goal is orientation: what this company means in ${ownerRef}'s world, who anchors it, and why it matters now.

Write the Summary body only. Use 1-3 short paragraphs. No heading, no bullets, no field list.
Be specific and factual — only use the data provided. Do not invent details.

COMPANY DATA:
- Name: ${company.name}
- Relationship tier: ${company.n1 || 'Company'} > ${company.n2 || ''}
- Industry: ${company.industry || 'unknown'}
- People associated: ${company.people_count || 0}
- Key contacts: ${contactLines}

SOURCE-BACKED TIMELINE AND RAG EVIDENCE:
${timelinePromptLines(timelineEvents)}

Cover what the company appears to do, ${ownerRef}'s relationship to it, the human doorway into it, recent source-backed signal, and any caution about thin signal.
Avoid labels like "Industry:", "People:", "Key Contacts", "structured data", "database", or "record".`;
}

export function buildCompanyFreeTemplate(company, topContacts) {
	  const contacts = topContacts.map(p => p.display_name).filter(Boolean);
	  const relation = companyMapPhrase(company);
	  const lane = meaningfulCompanyLane(company.industry || '');
	  const peopleCount = Number(company.people_count || 0);
	  const opening = `You have ${company.name} on the company radar${relation ? ` ${relation}` : ''}${lane ? `, with the visible lane around ${lane}` : ''}.`;
  const doorway = contacts.length
    ? `The human doorway is ${contacts.slice(0, 5).join(', ')}.`
    : `No one clearly anchors it yet.`;
  const scale = peopleCount > 0
    ? `${smallNumberWord(peopleCount)} linked ${peopleCount === 1 ? 'person gives' : 'people give'} the relationship some shape.`
    : `The relationship is still mostly structural rather than lived-in.`;
	  const caution = `The useful question is who opens this company and why it matters now; the page needs that before it can feel lived-in.`;
  return [opening, doorway, scale, caution].join('\n\n');
}

/**
 * Build the Haiku/Sonnet prompt for a place context file.
 */
export function buildPlacePrompt(place, ownerRef, timelineEvents = []) {
  const displayName = cleanPlaceDisplayName(place.name);
  const artifact = capturedPlaceArtifact(place.name || place.address || '');
  return `You are writing the private "place read" that ${ownerRef} sees for a place in their life.
This is not a venue listing. The goal is memory and orientation: what kind of place it is, how it appears in ${ownerRef}'s patterns, and why it might matter.

Write the Summary body only. Use 1-2 short paragraphs. No heading, no bullets, no field list.
Be factual — only use the data provided.
${artifact ? `This source looks like a captured ${artifact}, not a true physical place. Say that plainly instead of pretending it is a venue.` : ''}

PLACE DATA:
- Name: ${displayName}
- Type: ${humanPlaceLabel(place.place_subtype || place.place_type || 'venue')}
- Address: ${cleanPlaceAddress(place.address) || 'unknown'}
- Visits: ${place.frequency || 0}
- First visited: ${fmtDate(place.first_seen)}
- Last visited: ${fmtDate(place.last_seen)}

SOURCE-BACKED TIMELINE AND RAG EVIDENCE:
${timelinePromptLines(timelineEvents)}

Cover what the place is, the visit pattern, what the actual source-backed traces show, and the current emotional/practical read. If the signal is thin, say that plainly without making it feel like a database row.
Avoid labels like "Type:", "Visits:", "Address:", "structured data", "database", or "record".`;
}

export function buildPlaceFreeTemplate(place) {
  const name = cleanPlaceDisplayName(place.name);
	  const artifact = capturedPlaceArtifact(place.name || place.address || '');
	  const kind = humanPlaceLabel(place.place_subtype || place.place_type || 'place');
	  const visits = Number(place.frequency || 0);
	  const lastSeen = humanDate(fmtDate(place.last_seen));
	  const firstSeen = humanDate(fmtDate(place.first_seen));
	  const visitLine = visits > 0
	    ? `You have ${visits === 1 ? 'one known place trace' : `${visits} known place traces`}${lastSeen ? `, most recently around ${lastSeen}` : ''}.`
	    : `You have a place trace here, but the visit signal is still thin.`;
  if (artifact) {
    return [
      `${name} looks like a captured ${artifact}, not a true place memory.`,
      visitLine,
      'Do not read this as a place; the useful memory is probably in the surrounding calendar event, message, or source note.',
    ].filter(Boolean).join('\n\n');
  }
  const address = cleanPlaceAddress(place.address);
	  const span = place.first_seen && firstSeen !== lastSeen
	    ? `The first known trace is ${firstSeen}${address ? `, at ${address}` : ''}.`
	    : (address ? `The known anchor is ${address}.` : '');
	  const meaningfulType = meaningfulPlaceType(kind);
	  const typeLine = meaningfulType
	    ? `The source tags it as ${articleFor(meaningfulType)} ${meaningfulType}, but the page does not yet have enough surrounding context to say what it meant.`
	    : `The page does not yet have enough surrounding context to say what it meant.`;
	  const read = `For now, use it as an anchor to recover the surrounding trip, meal, meeting, or errand rather than as a fully felt memory.`;
	  return [`You have a place trace for ${name}.`, visitLine, typeLine, span, read].filter(Boolean).join('\n\n');
	}

/**
 * Assemble full person context in one pass:
 *   1. Fetch structured data + body chunks (Tier 0 — free)
 *   2. Route to TIER based on N2 (contextTierFromN2) — overrides entityTier() for context generation
 *   3. Write template (free), call Haiku, or call Sonnet accordingly
 *
 * WHY chunk_entities join (not FTS index):
 *   The FTS index was empty (pre-existing condition — FTS is a separate build step).
 *   chunk_entities is the canonical entity→chunk link table, populated by
 *   scripts/ingest/link-chunk-entities.js. It has 405,930+ rows and returns real
 *   content immediately — no FTS index required.
 *   No source_type filter: any future content type (Drive, Notes, Oura) flows
 *   through automatically when it lands in the chunks table.
 */
async function assemblePersonContext(person, stmts, db) {
  const identifiers  = stmts.identifiers.all(person.id);
  const topics       = stmts.topics.all(person.id);
  const interactions = stmts.interactions.all(person.id);
  // st_c619d929 — real first-degree edges. The card was edge-blind: the old
  // `edges: { all: () => [] }` stub fed nothing, so the generator never named a
  // connection. Feed the SAME firewalled ranking the turn-1 floor uses, shaped
  // to the `{ display_name }` buildPersonData expects, so floor and card agree.
  let rankedEdges = [];
  try {
    rankedEdges = rankedFirstDegreeEdges(db, person.id, { entityType: 'person' })
      .map((e) => ({ display_name: e.counterpartyName, relType: e.relType }));
  } catch { /* relation tables absent in minimal test envs — non-fatal */ }
  const data = buildPersonData(person, identifiers, topics, rankedEdges, interactions);

  // Fetch body chunks via chunk_entities join.
  // WHY top 20: prompt budget is 800 chars per chunk, ~16K tokens total per entity.
  // Sorted by event_time DESC to prioritize recent content.
  let ragChunks = [];
  try {
    ragChunks = stmts.bodyChunks.all(person.id, person.id);
  } catch { /* chunk_entities missing in some test envs — non-fatal */ }

  // Fetch timeline events for relationship history context in LLM prompt.
  let timelineEvents = [];
  try {
    timelineEvents = stmts.timelineEvents.all(person.id);
  } catch { /* timeline_event_entities missing in some test envs — non-fatal */ }

  let sourceTimeline = [];
  try {
    sourceTimeline = getEntityTimeline(db, { entityType: 'person', entityId: person.id, limit: 8, chunkLimit: 12 });
  } catch { /* minimal test DBs may omit timeline/chunk tables — non-fatal */ }

  // st_c619d929 — the structural floor + signal drive excellent-or-omitted.
  // The signal is scored HERE, before any model routing (early abstention).
  let floor = null;
  try {
    floor = buildEntityFloor(db, { id: person.id, type: 'person', name: person.display_name, n2: person.n2 });
  } catch { floor = null; }
  const signal = floor ? computeCardSignal(db, person, floor) : { score: 0, dims: {} };
  // Tier drives the MODEL (Haiku default, Sonnet for {Family, Core}); the signal
  // above drives whether a card is written at all.
  const tier = contextTierFromN2(person.n2);
  return { person, tier, data, ragChunks, timelineEvents, sourceTimeline, floor, signal };
}

/**
 * Process a batch of people using the Compute Tier Protocol (st_c619d929).
 *
 * Excellent-or-omitted: below the structural abstain floor no card is written
 * (the live floor covers the person — no stub, ever). Above the floor, route by
 * tier (Haiku default, Sonnet for {Family, Core}), generate, validate every
 * name against the code-supplied floor, and write provenance deterministically.
 *
 * @param {string|null} ownerName - from identity.json for prompt personalisation
 */
export async function processPeopleBatch(batch, db, anthropic, log, ownerName) {
  const stmts = {
    identifiers: db.prepare("SELECT type, value FROM person_identifiers WHERE person_id = ?"),
    topics:      db.prepare("SELECT topic, weight FROM person_topics WHERE person_id = ? ORDER BY weight DESC LIMIT 10"),
    interactions: db.prepare(`
      SELECT channel, direction, COUNT(*) as count, MAX(date) as last_date
      FROM person_interactions WHERE person_id = ? GROUP BY channel, direction
    `),
    updatePath: db.prepare("UPDATE people SET context_file_path=? WHERE id=?"),
    // WHY chunk_entities join: FTS was empty — chunk_entities is the canonical entity→chunk link.
    // No source_type filter — all content types included automatically.
    // st_f1a40461: TIME-SPANNING but BOUNDED. A 19-year relationship was summarised
    // from only the last few weeks of chunks, missing every earlier chapter. The
    // first fix used NTILE(8) window functions, but those needed temp b-trees and
    // cost ~19ms/entity on heavy people — a hang risk at scale. This version unions
    // the 12 most-recent + 8 oldest chunks (both plain indexed LIMIT scans, ~2ms)
    // so the prompt still sees the whole arc with NO unbounded work. Bind the
    // entity id twice (one per subquery).
    bodyChunks: db.prepare(`
      SELECT source_type, content, event_time FROM (
        SELECT c.source_type, c.content, c.event_time
        FROM chunk_entities ce JOIN chunks c ON c.id = ce.chunk_id
        WHERE ce.entity_id = ? AND c.content IS NOT NULL AND length(c.content) > 60
        ORDER BY c.event_time DESC LIMIT 12)
      UNION
      SELECT source_type, content, event_time FROM (
        SELECT c.source_type, c.content, c.event_time
        FROM chunk_entities ce JOIN chunks c ON c.id = ce.chunk_id
        WHERE ce.entity_id = ? AND c.content IS NOT NULL AND length(c.content) > 60
        ORDER BY c.event_time ASC LIMIT 8)
      ORDER BY event_time DESC
    `),
    // WHY timeline events here: timeline gives dated relationship milestones that the
    // LLM prompt uses for "recent context or notable interactions" section.
    timelineEvents: db.prepare(`
      SELECT te.event_type, te.source_type, te.event_date, te.summary
      FROM timeline_event_entities tee
      JOIN timeline_events te ON te.id = tee.event_id
      WHERE tee.person_id = ?
      ORDER BY te.event_date DESC
      LIMIT 20
    `),
  };

  // Tier 0: assemble context (facts + floor + signal) for everyone — no LLM.
  const assembled = await Promise.all(batch.map(p => assemblePersonContext(p, stmts, db)));

  const results = [];

  // Excellent-or-omitted: abstain below the structural floor BEFORE any routing.
  // A below-floor person gets no card — the live floor stands alone (no stub).
  const cardable = [];
  for (const item of assembled) {
    if (!item.signal || item.signal.score < CARD_ABSTAIN_FLOOR) {
      results.push({ success: true, id: item.person.id, abstained: true });
      continue;
    }
    cardable.push(item);
  }

  // No model client (or CONTEXT_TIER_CAP='free' cost cap) → write no cards this
  // pass; the deterministic floor covers every person until a model-backed pass
  // runs. The person free-template stub is removed by design.
  const cap = process.env.CONTEXT_TIER_CAP;
  if (cap === 'free' || !anthropic) {
    for (const item of cardable) results.push({ success: true, id: item.person.id, skipped_no_model: true });
    return results;
  }

  const buckets = routeToBuckets(cardable, item => item.tier);
  // 'haiku' cap (st_f1a40461) downgrades Sonnet-tier entities to Haiku for a
  // cheap whole-graph validation pass; unset the env var to restore Sonnet.
  const sonnetModel = cap === 'haiku' ? modelFor('fast') : modelFor('balanced');
  const sonnetTier  = cap === 'haiku' ? TIER.HAIKU  : TIER.SONNET;

  async function runLlmBucket(items, model, tierName, maxTokens) {
    const tasks = items.map(async (item) => {
      try {
        const prompt = buildPersonPrompt(item.person, item.data, item.ragChunks, ownerName, item.timelineEvents);
        const response = await anthropic.complete({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        });
        const raw = response.content[0]?.text || '';
        // st_c619d929 anti-hallucination — reject any proper noun not backed by
        // the code-supplied floor (edges/facts) + owner. A rejected card writes
        // NOTHING and leaves needs_regen for one retry; the floor still covers
        // the person, so a rejection degrades to facts-only, never to fiction.
        // st_c619d929 QA-fix — validator parity with the scheduled refresh path:
        // pass the same real message context (ragChunks + timeline) as the whitelist
        // haystack so real names from the person's own data are not rejected as
        // invented. Without this, the first-card generator over-rejects rich cards.
        const check = validateCardNames(
          raw,
          cardNameWhitelistFor(item.person, item.floor, ownerName, knownCompanyNames(db)),
          buildContextHaystack(item.ragChunks, item.timelineEvents),
        );
        if (!check.ok) {
          log(`  WARN: card for ${item.person.id} rejected (unverified names: ${check.offending.join(', ')}) — needs_regen kept`);
          return { success: false, id: item.person.id, tier: model, rejected: true };
        }
        const bio = appendSourceTimeline(raw || '(no bio generated)', item.sourceTimeline);
        const content = buildContextFile(item.person, 'person', bio, tierName);
        writeContextFile(personContextPath(item.person), content);
        stmts.updatePath.run(repoContextPath('people', item.person.id, item.person.display_name || item.person.name), item.person.id);
        // Deterministic (Tier 0) provenance alongside the pointer — the sweep,
        // the NOOP hash guard, and the as-of cue all read these.
        writeCardProvenance(db, 'people', item.person.id, {
          signalScore: item.signal.score,
          derivedHash: item.floor ? cardDerivedHash(item.floor) : null,
          generatedAt: new Date().toISOString(),
          modelTier: tierName,
        });
        return { success: true, id: item.person.id, tier: model };
      } catch (err) {
        log(`  WARN: context failed for ${item.person.display_name}: ${err.message}`);
        return { success: false, id: item.person.id, tier: model, error: err.message };
      }
    });
    return Promise.all(tasks);
  }

  const [haikuResults, sonnetResults] = await Promise.all([
    runLlmBucket(buckets.haiku,  modelFor('fast'), TIER.HAIKU, 512),
    runLlmBucket(buckets.sonnet, sonnetModel, sonnetTier, 768),
  ]);

  results.push(...haikuResults, ...sonnetResults);
  return results;
}

/**
 * Generate context files for all companies with n2 assigned.
 * Tier routing mirrors people: contextTierFromN2 → free template / Haiku / Sonnet synthesis.
 * WHY same logic as people: company ontology uses the same N2 tier taxonomy.
 *
 * Context body: name, type, key contacts (from people with this company_id).
 */
async function processCompanies(db, log, anthropic, ownerName, { preserveExisting = false } = {}) {
  const companies = db.prepare(`
    SELECT id, name, n1, n2, industry, people_count, created_at
    FROM companies
    WHERE n2 IS NOT NULL AND n2 != ''
      ${preserveExisting ? "AND (context_file_path IS NULL OR context_file_path = '')" : ''}
    ORDER BY people_count DESC
  `).all();

  log(`  Companies eligible: ${companies.length}${preserveExisting ? ' (missing context only)' : ''}`);

  const topContactsStmt = db.prepare(`
    SELECT display_name, n2, score FROM people
    WHERE company_id = ? AND archived = 0
    ORDER BY score DESC LIMIT 5
  `);
  const updatePathStmt = db.prepare("UPDATE companies SET context_file_path=? WHERE id=?");

  let generated = 0;
  let failed = 0;
  const byTier = { free: 0, haiku: 0, sonnet: 0 };
  // st_f1a40461: companies/places default to FREE templates (no LLM) — the
  // org LLM pass fires thousands of requests with no per-call timeout and one
  // hung request stalls the whole run. People (chat-critical) still use Haiku.
  // Opt back into org LLM with CONTEXT_ORG_LLM=1 once a request timeout exists.
  const freeOnly = process.env.CONTEXT_TIER_CAP === 'free' || process.env.CONTEXT_ORG_LLM !== '1';
  const ownerRef = ownerName || 'the user';

  async function synthesizeCompany(company, topContacts, tier, timeline = []) {
    if (tier === 'free' || freeOnly || !anthropic) {
      return buildCompanyFreeTemplate(company, topContacts);
    }
    const model = tier === 'sonnet' ? modelFor('balanced') : modelFor('fast');
    const maxTokens = tier === 'sonnet' ? 512 : 384;
    const prompt = buildCompanyPrompt(company, topContacts, ownerRef, timeline);
    const response = await anthropic.complete({
      model, max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0]?.text || '(no synthesis generated)';
  }

  // Process in parallel batches of BATCH_SIZE
  for (let i = 0; i < companies.length; i += BATCH_SIZE) {
    const batch = companies.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async company => {
      try {
        const topContacts = topContactsStmt.all(company.id);
        const tier = contextTierFromN2(company.n2);
        const timeline = getEntityTimeline(db, { entityType: 'company', entityId: company.id, limit: 8, chunkLimit: 12 });
        const bio = appendSourceTimeline(await synthesizeCompany(company, topContacts, tier, timeline), timeline);
        const generatedAt = new Date().toISOString();
        const frontmatter = `---\nentity_id: ${company.id}\nentity_type: company\nn1: ${company.n1 || 'Company'}\nn2: ${company.n2 || ''}\ndisplay_name: ${company.name}\ngenerated_at: ${generatedAt}\nenrichment: ${tier}\n---`;
        const content = `${frontmatter}\n# ${company.name}\n*${company.n1 || 'Company'} > ${company.n2 || ''}*\n\n${composeSummaryHistory(bio)}`;
        writeContextFile(companyContextPath(company), content);
        updatePathStmt.run(repoContextPath('companies', company.id, company.name), company.id);
        return { success: true, tier };
      } catch (err) {
        log(`  WARN: company context failed for ${company.name}: ${err.message}`);
        return { success: false };
      }
    }));
    for (const r of results) {
      if (r.success) { generated++; byTier[r.tier]++; }
      else failed++;
    }
  }

  log(`  Company context files: ${generated} generated, ${failed} failed`);
  log(`  Tier breakdown — free: ${byTier.free}, haiku: ${byTier.haiku}, sonnet: ${byTier.sonnet}`);
  return { generated, failed };
}

/**
 * Generate context files for top places per subtype.
 * Tier routing by rank within subtype: rank 1-50 → Sonnet, 51-150 → Haiku, 150+ → skip.
 * WHY rank-based (not N2): places have no relationship tier. Rank within subtype is the
 * best proxy for importance — top restaurants/offices get richer synthesis.
 * WHY 150 cap: beyond 150 per subtype, marginal context value drops sharply.
 */
async function processPlaces(db, log, anthropic, ownerName, { preserveExisting = false } = {}) {
  // Select top 150 per subtype, ranked by frequency DESC then id ASC (stable rank when frequency ties)
  const selected = db.prepare(`
    WITH ranked AS (
      SELECT id, name, place_type, place_subtype, frequency, first_seen, last_seen, address,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(place_subtype, 'other')
               ORDER BY frequency DESC, id ASC
             ) AS subtype_rank
      FROM places
      WHERE frequency > 0
        ${preserveExisting ? "AND (context_file_path IS NULL OR context_file_path = '')" : ''}
    )
    SELECT * FROM ranked WHERE subtype_rank <= 150
    ORDER BY place_subtype, subtype_rank
  `).all();

  log(`  Places eligible: ${selected.length} (top 150/subtype${preserveExisting ? ', missing context only' : ''})`);

  const updatePathStmt = db.prepare("UPDATE places SET context_file_path=? WHERE id=?");
  const freeOnly = process.env.CONTEXT_TIER_CAP === 'free' || process.env.CONTEXT_ORG_LLM !== '1'; // st_f1a40461: places free unless org LLM opted in
  const ownerRef = ownerName || 'the user';
  let generated = 0, failed = 0;
  const byTier = { sonnet: 0, haiku: 0 };

  async function processPlaceBatch(places, model, tierName, maxTokens) {
    for (let i = 0; i < places.length; i += BATCH_SIZE) {
      const chunk = places.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(chunk.map(async place => {
        try {
          let bio;
          if (freeOnly || !anthropic) {
            bio = buildPlaceFreeTemplate(place);
          } else {
            const timeline = getEntityTimeline(db, { entityType: 'place', entityId: place.id, limit: 8, chunkLimit: 12 });
            const prompt = buildPlacePrompt(place, ownerRef, timeline);
            const response = await anthropic.complete({
              model, max_tokens: maxTokens,
              messages: [{ role: 'user', content: prompt }],
            });
            bio = response.content[0]?.text || '(no description generated)';
          }
          const timeline = getEntityTimeline(db, { entityType: 'place', entityId: place.id, limit: 8, chunkLimit: 12 });
          bio = appendSourceTimeline(bio, timeline);
          const generatedAt = new Date().toISOString();
          const displayName = cleanPlaceDisplayName(place.name);
          const frontmatter = `---\nentity_id: ${place.id}\nentity_type: place\nplace_type: ${place.place_type || 'venue'}\nplace_subtype: ${place.place_subtype || 'other'}\ndisplay_name: ${displayName}\ngenerated_at: ${generatedAt}\nenrichment: ${tierName}\n---`;
          const content = `${frontmatter}\n# ${displayName}\n*${humanPlaceLabel(place.place_subtype || place.place_type || 'venue')} | ${place.frequency} visits*\n\n${composeSummaryHistory(bio)}`;
          writeContextFile(placeContextPath(place), content);
          try { updatePathStmt.run(repoContextPath('places', place.id, place.name), place.id); } catch { /* column may not exist */ }
          return { success: true };
        } catch (err) {
          log(`  WARN: place context failed for ${place.name}: ${err.message}`);
          return { success: false };
        }
      }));
      for (const r of results) {
        if (r.success) { generated++; byTier[tierName]++; }
        else failed++;
      }
    }
  }

  const sonnetBatch = selected.filter(p => contextTierFromPlaceRank(p.subtype_rank) === 'sonnet');
  const haikuBatch  = selected.filter(p => contextTierFromPlaceRank(p.subtype_rank) === 'haiku');

  await Promise.all([
    processPlaceBatch(sonnetBatch, modelFor('balanced'), 'sonnet', 512),
    processPlaceBatch(haikuBatch,  modelFor('fast'),  'haiku',  384),
  ]);

  log(`  Place context files: ${generated} generated, ${failed} failed`);
  log(`  Tier breakdown — sonnet: ${byTier.sonnet}, haiku: ${byTier.haiku}`);
  return { generated, failed };
}

/**
 * Regenerate the context file for a single company by id.
 * Called by regen-entities.js for entities with needs_regen=1.
 * Applies N2-based tier routing — same logic as the batch phaseContext path.
 */
export async function processCompany(id, db, log) {
  const company = db.prepare(
    'SELECT id, name, n1, n2, industry, people_count, created_at FROM companies WHERE id = ?'
  ).get(id);
  if (!company) { log(`  [company] not found: ${id}`); return { generated: 0, failed: 1 }; }

  const topContacts = db.prepare(
    'SELECT display_name, n2, score FROM people WHERE company_id = ? AND archived = 0 ORDER BY score DESC LIMIT 5'
  ).all(company.id);
  const updatePathStmt = db.prepare('UPDATE companies SET context_file_path=? WHERE id=?');
  const tier = contextTierFromN2(company.n2);
  const freeOnly = process.env.CONTEXT_TIER_CAP === 'free' || process.env.CONTEXT_ORG_LLM !== '1';

  let ownerRef = 'the user';
  try {
    const { ownerDisplayName } = await import('../../lib/identity.js');
    ownerRef = ownerDisplayName() || 'the user';
  } catch { /* graceful degradation */ }

  let bio;
  if (tier !== 'free' && !freeOnly) {
    try {
      const { getProvider } = await import('../../lib/llm/index.js');
      const anthropic = await getProvider('anthropic');
      const model = tier === 'sonnet' ? modelFor('balanced') : modelFor('fast');
      const maxTokens = tier === 'sonnet' ? 512 : 384;
      const timeline = getEntityTimeline(db, { entityType: 'company', entityId: company.id, limit: 8, chunkLimit: 12 });
      const prompt = buildCompanyPrompt(company, topContacts, ownerRef, timeline);
      const response = await anthropic.complete({
        model, max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      bio = response.content[0]?.text || '(no synthesis generated)';
    } catch (err) {
      log(`  [company] LLM failed, falling back to template: ${err.message}`);
      bio = null;
    }
  }

  if (!bio) {
    bio = buildCompanyFreeTemplate(company, topContacts);
  }

  const generatedAt = new Date().toISOString();
  const frontmatter = `---\nentity_id: ${company.id}\nentity_type: company\nn1: ${company.n1 || 'Company'}\nn2: ${company.n2 || ''}\ndisplay_name: ${company.name}\ngenerated_at: ${generatedAt}\nenrichment: ${tier}\n---`;
  const timeline = getEntityTimeline(db, { entityType: 'company', entityId: company.id, limit: 8, chunkLimit: 12 });
  const content = `${frontmatter}\n# ${company.name}\n*${company.n1 || 'Company'} > ${company.n2 || ''}*\n\n${composeSummaryHistory(appendSourceTimeline(bio, timeline))}`;
  try {
    writeContextFile(companyContextPath(company), content);
    updatePathStmt.run(repoContextPath('companies', company.id, company.name), company.id);
    log(`  [company] regen complete (${tier}): ${company.name}`);
    return { generated: 1, failed: 0 };
  } catch (err) {
    log(`  [company] regen failed: ${company.name}: ${err.message}`);
    return { generated: 0, failed: 1 };
  }
}

/**
 * Regenerate the context file for a single place by id.
 * Called by regen-entities.js for entities with needs_regen=1.
 * Determines tier from rank within subtype — same routing as the batch path.
 */
export async function processPlace(id, db, log) {
  const place = db.prepare(
    'SELECT id, name, place_type, place_subtype, frequency, first_seen, last_seen, address FROM places WHERE id = ?'
  ).get(id);
  if (!place) { log(`  [place] not found: ${id}`); return { generated: 0, failed: 1 }; }

  const updatePathStmt = db.prepare('UPDATE places SET context_file_path=? WHERE id=?');
  const freeOnly = process.env.CONTEXT_TIER_CAP === 'free' || process.env.CONTEXT_ORG_LLM !== '1';

  // Determine rank within subtype (stable: by frequency DESC, id ASC)
  const subtype = place.place_subtype || 'other';
  const rankRow = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM places
    WHERE COALESCE(place_subtype, 'other') = ? AND (frequency > ? OR (frequency = ? AND id < ?))
  `).get(subtype, place.frequency, place.frequency, place.id);
  const rank = rankRow?.rank || 999;
  const tier = contextTierFromPlaceRank(rank);

  let ownerRef = 'the user';
  try {
    const { ownerDisplayName } = await import('../../lib/identity.js');
    ownerRef = ownerDisplayName() || 'the user';
  } catch { /* graceful degradation */ }

  let bio;
  if (tier !== 'free' && !freeOnly) {
    try {
      const { getProvider } = await import('../../lib/llm/index.js');
      const anthropic = await getProvider('anthropic');
      const model = tier === 'sonnet' ? modelFor('balanced') : modelFor('fast');
      const maxTokens = tier === 'sonnet' ? 512 : 384;
      const timeline = getEntityTimeline(db, { entityType: 'place', entityId: place.id, limit: 8, chunkLimit: 12 });
      const prompt = buildPlacePrompt(place, ownerRef, timeline);
      const response = await anthropic.complete({
        model, max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      bio = response.content[0]?.text || '(no description generated)';
    } catch (err) {
      log(`  [place] LLM failed, falling back to template: ${err.message}`);
      bio = null;
    }
  }

  if (!bio) {
    bio = buildPlaceFreeTemplate(place);
  }

  const generatedAt = new Date().toISOString();
  const displayName = cleanPlaceDisplayName(place.name);
  const frontmatter = `---\nentity_id: ${place.id}\nentity_type: place\nplace_type: ${place.place_type || 'venue'}\nplace_subtype: ${place.place_subtype || 'other'}\ndisplay_name: ${displayName}\ngenerated_at: ${generatedAt}\nenrichment: ${tier}\n---`;
  const timeline = getEntityTimeline(db, { entityType: 'place', entityId: place.id, limit: 8, chunkLimit: 12 });
  const content = `${frontmatter}\n# ${displayName}\n*${humanPlaceLabel(place.place_subtype || place.place_type || 'venue')} | ${place.frequency} visits*\n\n${composeSummaryHistory(appendSourceTimeline(bio, timeline))}`;
  try {
    writeContextFile(placeContextPath(place), content);
    try { updatePathStmt.run(repoContextPath('places', place.id, place.name), place.id); } catch { /* column may not exist */ }
    log(`  [place] regen complete (${tier}, rank ${rank}): ${place.name}`);
    return { generated: 1, failed: 0 };
  } catch (err) {
    log(`  [place] regen failed: ${place.name}: ${err.message}`);
    return { generated: 0, failed: 1 };
  }
}

/**
 * Phase 7 main: generate context files for eligible entities.
 * @param {Function} log
 * @returns {{ generated: number, failed: number }}
 */
export async function phaseContext(log, { preserveExisting = false } = {}) {
  log('\n=== Phase 7: Context files ===');

  const { default: db } = await import('../../lib/db.js');
  const { getProvider } = await import('../../lib/llm/index.js');

  // Ensure output directories exist
  mkdirSync(PEOPLE_DIR, { recursive: true });
  mkdirSync(COMPANIES_DIR, { recursive: true });
  mkdirSync(PLACES_DIR, { recursive: true });

  let anthropic;
  try {
    anthropic = await getProvider('anthropic');
  } catch (err) {
    anthropic = null;
    log(`  Context LLM unavailable; writing deterministic templates only (${err.message})`);
  }

  // Read owner display name from identity.json for personalized prompts.
  // Never hardcoded — reads from ~/.robotdojo/identity.json at runtime.
  let ownerName = null;
  try {
    const { ownerDisplayName } = await import('../../lib/identity.js');
    ownerName = ownerDisplayName() || null;
  } catch { /* graceful degradation — prompts use 'the user' fallback */ }

  // All non-archived people with any N2 assigned, or only people missing a
  // context pointer when the orchestrator is doing a preserving corpus rerun.
  // Existing rich context is not rewritten unless the caller explicitly asks
  // for a refresh; dirty updates are handled by entity enrichment after linking.
  // st_df0a8d71 AC-3 — relation_tag/relation_label ride the eligible-people
  // rows so the generator prompt AND the deterministic Summary lead receive
  // the stored relationship for every relation-tagged entity it renders.
  const eligiblePeople = db.prepare(`
    SELECT p.id, p.display_name, p.n1, p.n2, p.first_seen, p.last_seen,
           p.interaction_count, p.linkedin_title, p.relation_tag, p.relation_label,
           p.relation_derived_phrase,
           c.name as company_name
    FROM people p
    LEFT JOIN companies c ON c.id = p.company_id
    WHERE p.archived = 0 AND p.n2 IS NOT NULL AND p.n2 != ''
      ${preserveExisting ? "AND (p.context_file_path IS NULL OR p.context_file_path = '')" : ''}
    ORDER BY p.score DESC
  `).all();

  log(`  Eligible people: ${eligiblePeople.length}${preserveExisting ? ' (missing context only)' : ''}`);

  const stats = { generated: 0, failed: 0, byTier: { free: 0, haiku: 0, sonnet: 0 } };

  // Process in batches of BATCH_SIZE concurrently
  for (let i = 0; i < eligiblePeople.length; i += BATCH_SIZE) {
    const batch = eligiblePeople.slice(i, i + BATCH_SIZE);
    const results = await processPeopleBatch(batch, db, anthropic, log, ownerName);
    for (const r of results) {
      if (r.success) {
        stats.generated++;
        const tierKey = r.tier === modelFor('balanced') ? 'sonnet' : r.tier === modelFor('fast') ? 'haiku' : 'free';
        stats.byTier[tierKey] = (stats.byTier[tierKey] || 0) + 1;
      } else {
        stats.failed++;
      }
    }
    if (i % (BATCH_SIZE * 5) === 0 && i > 0) {
      log(`  Progress: ${i}/${eligiblePeople.length} people`);
    }
  }

  log(`  Context files: ${stats.generated} generated, ${stats.failed} failed`);
  log(`  Tier breakdown — free: ${stats.byTier.free}, haiku: ${stats.byTier.haiku}, sonnet: ${stats.byTier.sonnet}`);

  // Companies: N2-based tier routing (same logic as people). Places: rank-within-subtype routing.
  const companyStats = await processCompanies(db, log, anthropic, ownerName, { preserveExisting });
  const placeStats = await processPlaces(db, log, anthropic, ownerName, { preserveExisting });

  return {
    generated: stats.generated + companyStats.generated + placeStats.generated,
    failed: stats.failed + companyStats.failed + placeStats.failed,
    people: stats,
    companies: companyStats,
    places: placeStats,
  };
}
