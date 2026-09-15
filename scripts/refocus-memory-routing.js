#!/usr/bin/env node
/**
 * Refocus current needs-routing memory links after topics/chunks are classified.
 *
 * Dry-run by default. With --apply, immutable memory_events are preserved and
 * only the current memory_event_links projection moves to sharper topics.
 */

export const INTELLIGENCE_TIER = 'maintenance';

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import db from '../lib/db.js';
import {
  refocusMemoryScopesForSubject,
  suppressMemoryScopesForSubject,
} from '../lib/memory-scope-routing.js';
import {
  NEEDS_ROUTING_TOPIC,
  normalizeMemoryTopicSlug,
} from '../lib/topic-routing-policy.js';

const args = parseArgs(process.argv.slice(2));
const APPLY = args.apply === true;
const JSON_MODE = args.json === true;
const RESULT_FILE = args.resultFile || process.env.ROBOTDOJO_MEMORY_REFOCUS_RESULT_FILE || null;
const maxSeconds = numberArg(args.maxSeconds, 0);
const deadline = maxSeconds > 0 ? Date.now() + maxSeconds * 1000 : null;
const maxSubjects = numberArg(args.maxSubjects, 0);
const sampleLimit = numberArg(args.sampleLimit, 10);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function numberArg(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function hasTable(table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function topicExists(slug) {
  if (!hasTable('user_topics')) return true;
  return !!db.prepare('SELECT 1 FROM user_topics WHERE slug = ?').get(slug);
}

function normalizeCandidateTopic(value) {
  const slug = normalizeMemoryTopicSlug(value, { fallback: false });
  if (!slug || slug === NEEDS_ROUTING_TOPIC || !topicExists(slug)) return null;
  return slug;
}

function dominantChunkTopic(conversationId) {
  if (!hasTable('chunks')) return null;
  const rows = db.prepare(`
    SELECT topic, COUNT(*) AS n
    FROM chunks
    WHERE source_type = 'conversation'
      AND source_id = ?
      AND topic IS NOT NULL
      AND topic != ''
    GROUP BY topic
    ORDER BY n DESC, topic
    LIMIT 12
  `).all(conversationId);
  for (const row of rows) {
    const topic = normalizeCandidateTopic(row.topic);
    if (topic) return topic;
  }
  return null;
}

function suppressionReasonForConversation({ conversationId, title }) {
  const id = String(conversationId || '');
  const text = String(title || '').trim().toLowerCase();
  if (id === 'warmup-fullturn') return 'warmup probe conversation';
  if (/^(test-|ttft-|qa-|session-qa-|health-check$)/.test(id) || /^st[a-z0-9-]*probe/i.test(id)) return 'test harness conversation';
  if (id.startsWith('session-claude-code:')) return 'topicless imported Claude Code session';
  if (/text summary request|^summary \d+ please\.?$|^summarize key points\.?$|^is this a good summary\??$|^transcription request$|^analyze$|^turn into two paragraphs$|distribution by alphabet letter/.test(text)) return 'generic summary utility request';
  if (/^reply (with (exactly|only|just): )?ok\b|^reply with (just )?(the )?(single )?word:? (ok|ping|ready)\b|^say ok \d+\.?$/.test(text) || /\bok (openai|anthropic|ollama|xai|google|a1|b1|probe)\b/.test(text) || /reply ok/.test(text)) {
    return 'model availability probe';
  }
  if (/^greet me\b|^say hello\b|^say hi\b|^hello\b|^hi\b/.test(text)) return 'ephemeral greeting';
  if (/what'?s on my calendar|calendar this week|what.*calendar/.test(text)) return 'ephemeral calendar lookup';
  if (/remember this exactly:|no-spec proof|proof \d|matte green silver|matte cobalt saffron|chrome no-spec|post-restart memory proof/.test(text)) {
    return 'ephemeral browser or memory proof prompt';
  }
  if (/^what did i work on|^recent work\?|what.*recently|what is most important right now|what should i prioritize today|what should i follow up on this week|any follow-ups i am forgetting|what meetings do i have context on|who have i talked to most recently|who are my closest contacts|what topics do you know about me|what do you know about me|what.*most recent.*worked|summarize my recent priorities|single most important thing for me today|what are my top priorities|who do i talk to most|what is on my to complete list/.test(text)) {
    return 'ephemeral status lookup';
  }
  if (/\bwhat is \d+ (times|\*) \d+\b|just the number|number only|days between|warmbase-|^\[final\d+-\d+\]|^\[vw[a-z]-\d+\]|\bvw[a-z]?\d|cache verification|^ctl \d+\.?$|^worker-fix \d+\.?$|^interleave \d+\.?$|^iso \d+\.?$|^qa turn \d+\.?$|qa smoke route proof|no response needed|system check confirmed|activity row probe|still quiet\. has it been \d+ mins|^q\d+\.?$|^baseline turn \d+\.?$|^floor[a-z]? \d+\.?$|^floor test \d+\.?$|^v\d+ \d+\.?$|^finallive \d+\.?$|^control \d+ week summary\.?$|^cold turn \d+ ground summary\.?$|^clean baseline \d+\.?$|^settled turn \d+\.?$|^reclass test \d+\.?$|^daemon test \d+\.?$|^recovery check\.?$|^attribution probe \d+|^wfix\d* \d+\.?$|^trace \d+\.?$|^warm(up)?$|^ping( two)?\.?$|acqa\d|ac\d.*turn|probe-?\d|tool: bash|sim-test|real-sim/.test(text)) {
    return 'test harness prompt';
  }
  return null;
}

function titleTopic(conversationTitle) {
  const text = String(conversationTitle || '').trim().toLowerCase();
  if (!text) return null;
  const placeLike = /,|\d{3,}|trattoria|restaurant|parking|avenue| ave\b|street| st\b|brooklyn|ny\b/.test(text);
  const rules = [
    ['hobbies', /\b(restaurant|trattoria|food|recipe|sesame|cooking|frying|falafel|instant pot|finishing oil|travel|flight|bora bora)\b/],
    ['health', /\b(marathon|training|fitness|sleep|health|symptom|doctor|oura)\b/],
    ['home', /\b(parking|clean up ram|everything is slow|wifi|phone|device|outlook web downloads|downloads go|desktop|washing machine|detergent)\b/],
    ['learning', /\b(origin of|what does|meaning of|explain|terminology|slang|staircase idea|futarky)\b/],
    ['career', /\b(daily work agenda|current role|customer|stakeholder)\b/],
    ['side-projects', /\b(side project|prototype|startup idea|launch plan)\b/],
    ['coaching', /\bcoaching-session\b/],
    ['robot-dojo', /\brobot dojo\b/],
    ['nl-tech', /\bhelium token\b/],
    ['networking', /\bwho is\b/],
    ['networking', /\b(how|hoe) do i know\b|\bdo i know\b/],
    ['networking', /\b(business connections|casa\.io)\b/],
    ['networking', placeLike ? null : /\btell me about\b/],
  ];
  const matches = [];
  for (const [topic, pattern] of rules) {
    if (pattern && pattern.test(text) && normalizeCandidateTopic(topic)) matches.push(topic);
  }
  const unique = [...new Set(matches)];
  if (unique.includes('hobbies') && /\b(sesame|cooking|frying|falafel|instant pot|recipe|restaurant|trattoria|food|finishing oil|flight|bora bora)\b/.test(text)) {
    return 'hobbies';
  }
  return unique.length === 1 ? unique[0] : null;
}

function unresolvedCurrentMemoryLinks() {
  if (!hasTable('memory_event_links')) return 0;
  return db.prepare(`
    SELECT COUNT(*) AS n
    FROM memory_event_links
    WHERE target_type = 'topic'
      AND target_id = ?
      AND role IN ('needs-routing', 'scope')
  `).get(NEEDS_ROUTING_TOPIC)?.n || 0;
}

function candidateRows() {
  if (!hasTable('memory_events') || !hasTable('memory_event_links')) return [];
  const limitClause = maxSubjects > 0 ? `LIMIT ${maxSubjects}` : '';
  return db.prepare(`
    SELECT
      e.subject_id AS conversation_id,
      COALESCE(c.topic_slug, '') AS conversation_topic,
      COALESCE(c.title, '') AS conversation_title,
      COUNT(DISTINCT e.event_id) AS event_count
    FROM memory_events e
    JOIN memory_event_links l ON l.event_id = e.event_id
    LEFT JOIN conversations c ON c.id = e.subject_id
    WHERE e.subject_type = 'conversation'
      AND l.target_type = 'topic'
      AND l.target_id = ?
      AND l.role IN ('needs-routing', 'scope')
    GROUP BY e.subject_id, COALESCE(c.topic_slug, ''), COALESCE(c.title, '')
    ORDER BY event_count DESC, e.subject_id
    ${limitClause}
  `).all(NEEDS_ROUTING_TOPIC);
}

function markTopicsStale(slugs) {
  const topics = [...new Set([NEEDS_ROUTING_TOPIC, ...slugs].filter(Boolean))];
  if (!topics.length || !hasTable('user_topics')) return { changed: 0, topics };
  const placeholders = topics.map(() => '?').join(',');
  const info = db.prepare(`
    UPDATE user_topics
       SET needs_regen = 1,
           updated_at = datetime('now')
     WHERE slug IN (${placeholders})
  `).run(...topics);
  return { changed: info.changes, topics };
}

function atomicWriteJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}

function pushLimited(array, entry) {
  if (array.length < sampleLimit) array.push(entry);
}

const before = unresolvedCurrentMemoryLinks();
const candidates = candidateRows();
const movedTopics = new Set();
let scanned = 0;
let movable = 0;
let moved = 0;
let suppressed = 0;
let skippedNoTopic = 0;
let suppressedSubjects = 0;
let partial = false;
const examples = [];
const movedExamples = [];
const suppressedExamples = [];
const skippedExamples = [];

for (const candidate of candidates) {
  if (deadline && Date.now() >= deadline) {
    partial = true;
    break;
  }
  scanned += 1;
  const topic = normalizeCandidateTopic(candidate.conversation_topic)
    || dominantChunkTopic(candidate.conversation_id)
    || titleTopic(candidate.conversation_title);
  if (!topic) {
    const suppressionReason = suppressionReasonForConversation({
      conversationId: candidate.conversation_id,
      title: candidate.conversation_title,
    });
    if (suppressionReason) {
      suppressedSubjects += 1;
      if (!APPLY) {
        suppressed += Number(candidate.event_count || 0);
        const example = {
          conversation_id: candidate.conversation_id,
          reason: suppressionReason,
          event_count: candidate.event_count,
          dry_run: true,
          suppressed: true,
        };
        pushLimited(examples, example);
        pushLimited(suppressedExamples, example);
        continue;
      }
      const result = suppressMemoryScopesForSubject(db, {
        subjectType: 'conversation',
        subjectId: candidate.conversation_id,
        actor: 'post-drain-memory-refocus',
        reason: suppressionReason,
        correlationId: candidate.conversation_id,
      });
      suppressed += result.suppressed || 0;
      const example = {
        conversation_id: candidate.conversation_id,
        reason: suppressionReason,
        scanned_events: result.scanned,
        suppressed_events: result.suppressed,
      };
      pushLimited(examples, example);
      pushLimited(suppressedExamples, example);
      continue;
    }

    skippedNoTopic += 1;
    const example = {
      conversation_id: candidate.conversation_id,
      reason: 'no_sharper_topic',
      event_count: candidate.event_count,
      title: candidate.conversation_title,
      current_topic: candidate.conversation_topic || null,
    };
    pushLimited(examples, example);
    pushLimited(skippedExamples, example);
    continue;
  }
  movable += 1;
  if (!APPLY) {
    moved += Number(candidate.event_count || 0);
    movedTopics.add(topic);
    const example = {
      conversation_id: candidate.conversation_id,
      to_topic: topic,
      event_count: candidate.event_count,
      dry_run: true,
    };
    pushLimited(examples, example);
    pushLimited(movedExamples, example);
    continue;
  }
  const result = refocusMemoryScopesForSubject(db, {
    subjectType: 'conversation',
    subjectId: candidate.conversation_id,
    toTopic: topic,
    actor: 'post-drain-memory-refocus',
    reason: 'conversation/chunk classification resolved needs-routing scope',
    correlationId: candidate.conversation_id,
  });
  moved += result.moved || 0;
  if ((result.moved || 0) > 0) movedTopics.add(topic);
  const example = {
    conversation_id: candidate.conversation_id,
    to_topic: topic,
    scanned_events: result.scanned,
    moved_events: result.moved,
  };
  pushLimited(examples, example);
  pushLimited(movedExamples, example);
}

const staleTopics = APPLY ? markTopicsStale([...movedTopics]) : { changed: 0, topics: [...movedTopics] };
const after = APPLY ? unresolvedCurrentMemoryLinks() : Math.max(0, before - moved - suppressed);
const output = {
  ok: true,
  applied: APPLY,
  partial,
  before_current_needs_routing_links: before,
  after_current_needs_routing_links: after,
  scanned_subjects: scanned,
  candidate_subjects: candidates.length,
  movable_subjects: movable,
  moved_events: moved,
  suppressed_subjects: suppressedSubjects,
  suppressed_events: suppressed,
  skipped_no_topic: skippedNoTopic,
  stale_topics: staleTopics,
  examples,
  moved_examples: movedExamples,
  suppressed_examples: suppressedExamples,
  skipped_examples: skippedExamples,
};

if (RESULT_FILE) atomicWriteJson(RESULT_FILE, output);

if (JSON_MODE) console.log(JSON.stringify(output, null, 2));
else {
  console.log(`[memory-refocus] applied=${output.applied} partial=${output.partial}`);
  console.log(`[memory-refocus] current needs-routing links ${before} -> ${after}`);
  console.log(`[memory-refocus] scanned=${scanned} movable_subjects=${movable} moved_events=${moved} suppressed_subjects=${suppressedSubjects} suppressed_events=${suppressed} skipped_no_topic=${skippedNoTopic}`);
  if (partial) console.log('[memory-refocus] done (partial slice)');
  else console.log('[memory-refocus] done');
}
