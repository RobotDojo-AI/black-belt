// lib/workbench-synthesis.js - deterministic replay/projection for workbench memory.
//
// This is the close/replay layer for the memory architecture: immutable event
// and source records stay authoritative; SYNTHESIS.md, topic context, and DB
// latest_state/next_action are rebuildable projections.

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { applyTopicContext } from './topic-context-apply.js';
import { collectAttachedEntityFactBullets, injectFactsSection, injectPromotionIntoSummary } from './workbench-distill.js';
import { buildEntityFloor, formatEntityFactBullets } from './entity-floor.js';
import { entityContextPath } from './context-paths.js';
import {
  appendMemoryEvent,
  ensureMemoryEventsSchema,
  listMemoryEvents,
  memorySourceSetHash,
  recordProjectionRun,
  stableJson,
} from './memory-events.js';
import { inferSnapshotFromMemoryEvent } from './snapshots.js';
import { ensureWorkbenchMemoryFiles, getWorkbench, resolveWorkbench, workbenchPublicUrl } from './workbenches.js';
import { parseResumeIndex, scanWorkbenchRoot, toRepoPath } from './workbench-files.js';
import { REPO_ROOT } from './robotdojo-paths.js';
import { viewerCorrectionSummary } from './viewer-corrections.js';

export const WORKBENCH_SYNTHESIS_VERSION = 'deterministic-v1';
const TOPIC_CONTEXT_CHAR_BUDGET = 4000;
const TOPIC_IDENTITY_CHAR_BUDGET = 1000;
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.tsv', '.html', '.js', '.mjs', '.sql']);
const STRUCTURED_WORKBENCH_MEMORY_FILES = new Set(['INDEX.md', 'LOG.md', 'SYNTHESIS.md']);
const FILE_SOURCE_DATE_RE = /(?:^|\n)\s*(?:source_date|source date|valid_at|valid at|occurred_at|occurred at|event_date|event date|date)\s*:\s*['"]?(\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-Z]+)?)/i;
const PATH_DATE_RE = /(?:^|[/_-])(\d{4})[-_/](\d{2})[-_/](\d{2})(?:$|[^\d])/;
const PROJECT_SIGNAL_RE = /\b(workbench|pipeline|story|defect|scope|criteria|bunshin|katagami|miyagi|branch|memory|recalc|synthesis|projection|timeline|event log|stage gate|stage event)\b|\/(?:story|defect|work|build|qa|research|scope|plan|close)\b/i;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function clip(text, max = 260) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
}

function firstUsefulLine(text, max = 260) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (/^\s*---\s*$/.test(raw)) continue;
    if (/^\s*(source_date|source date|valid_at|valid at|occurred_at|occurred at|event_date|event date|date)\s*:/i.test(raw)) continue;
    const line = raw.replace(/^[-*#>\s]+/, '').trim();
    if (isMeaningfulMemoryLine(line)) return clip(line, max);
  }
  return '';
}

function isMeaningfulMemoryLine(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (/^none recorded\.?$/i.test(s)) return false;
  if (/^(summary|current thesis|current question|latest state|latest thinking \/ decisions|next action|open questions \/ next steps|open decisions?|unresolved questions?|evolution timeline|source watermark|related entities|canonical promotion targets)$/i.test(s)) return false;
  return true;
}

function isScaffoldMemoryText(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return true;
  if (/Default topic workbench created as the canonical landing zone for deep work/i.test(s)) return true;
  if (/Registered workbench substrate is ready to resume/i.test(s)) return true;
  if (/Use this workbench for research, analysis, todos, renderings, and long-form synthesis; promote durable compact truth into the topic context/i.test(s)) return true;
  return /^Default topic workbench created as the canonical landing zone for deep work\.?$/i.test(s)
    || /^Registered workbench substrate is ready to resume\.?$/i.test(s)
    || /^Use this workbench for research, analysis, todos, renderings, and long-form synthesis; promote durable compact truth into the topic context\.?$/i.test(s)
    || /^Resolve the workbench and inspect indexed substrate\.?$/i.test(s)
    || /^Continue from the newest source-backed synthesis\.?$/i.test(s);
}

function readRepoFile(repoRoot, repoPath, maxBytes = 40_000) {
  if (!repoPath) return '';
  const ext = extname(repoPath).toLowerCase();
  if (ext && !TEXT_EXTENSIONS.has(ext)) return '';
  const abs = resolve(repoRoot, repoPath);
  if (!existsSync(abs)) return '';
  return readFileSync(abs).subarray(0, maxBytes).toString('utf8');
}

function parseNextAction(text) {
  const match = String(text || '').match(/(?:^|\n)\s*(?:[-*]\s*)?next action\s*:\s*(.+?)(?=\n|$)/i);
  return match ? clip(match[1], 260) : '';
}

function parseLatestState(text) {
  const inline = String(text || '').match(/(?:^|\n)\s*(?:[-*]\s*)?latest state\s*:\s*(.+?)(?=\n|$)/i);
  if (inline) return clip(inline[1], 420);
  const section = String(text || '').match(/(?:^|\n)##\s+Latest State\s*\n([\s\S]*?)(?=\n##\s+|\s*$)/i);
  return section ? firstUsefulLine(section[1], 420) : '';
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withTime = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const date = new Date(withTime.length === 10 ? `${withTime}T00:00:00.000Z` : withTime);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toISOString();
}

function sourceDateFromText(text, path = '') {
  const match = String(text || '').match(FILE_SOURCE_DATE_RE);
  if (match) return normalizeDate(match[1]);
  const pathMatch = String(path || '').match(PATH_DATE_RE);
  if (pathMatch) return `${pathMatch[1]}-${pathMatch[2]}-${pathMatch[3]}T00:00:00.000Z`;
  return '';
}

function parseDecisionLines(text, limit = 8) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^[-*#>\s]+/, '').trim();
    if (!isMeaningfulMemoryLine(line)) continue;
    if (/\b(decided|decision|approved|blocked|accepted|rejected|ship|next action|open question|unresolved)\b/i.test(line)) {
      out.push(clip(line, 260));
    }
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeAttachments(workbench) {
  return (workbench.attachments || [])
    .filter((a) => a.target_type && a.target_id)
    .map((a) => ({ targetType: a.target_type, targetId: a.target_id, role: a.role || 'attachment' }));
}

function sourceSetHash(sources) {
  return sha256(stableJson(sources.map((source) => ({
    kind: source.kind,
    source: source.source,
    valid_at: source.valid_at || '',
    hash: source.hash || '',
    event_hash: source.event?.event_hash || '',
  }))));
}

function canProvideFallbackLatest(source) {
  if (!source?.summary || isScaffoldMemoryText(source.summary)) return false;
  if (source.kind === 'memory_event' && !source.fallback_latest) return false;
  return !['workbench_index', 'workbench_log'].includes(source.kind);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeWorkbenchItems(workbench, repoRoot, options = {}) {
  const rows = [];
  try {
    if (options.scanDisk !== false && workbench.root_path) {
      rows.push(...scanWorkbenchRoot(workbench.root_path, {
        repoRoot,
        maxBytes: options.scanMaxBytes || 2_000_000,
      }));
    }
  } catch {}
  rows.push(...(workbench.items || []));
  return uniqueBy(rows, (item) => item.path);
}

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function signalTermsForWorkbench(workbench) {
  const text = [
    workbench.id,
    workbench.slug,
    workbench.title,
    ...(workbench.attachments || []).map((a) => `${a.target_id} ${a.label || ''}`),
  ].join(' ').toLowerCase();
  return uniqueBy(
    text
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 4 && !['workbench', 'topic', 'primary', 'related'].includes(term)),
    (term) => term,
  );
}

function isConversationSourceRelevant(row, workbench) {
  const text = String(row.content || '').toLowerCase();
  if (!text.trim()) return false;
  if (PROJECT_SIGNAL_RE.test(text)) return true;
  return signalTermsForWorkbench(workbench).some((term) => text.includes(term));
}

function isDurableConversationSource(row) {
  const text = String(row.content || '').trim();
  if (!text) return false;
  if (/^cd\s+robotdojo$/i.test(text)) return false;
  return PROJECT_SIGNAL_RE.test(text)
    || parseDecisionLines(text, 1).length > 0
    || Boolean(parseNextAction(text));
}

function collectEventSources(db, workbench, limit) {
  ensureMemoryEventsSchema(db);
  const rows = [
    ...listMemoryEvents(db, { targetType: 'workbench', targetId: workbench.id, limit }),
  ];
  for (const attachment of workbench.attachments || []) {
    if (!attachment.target_type || !attachment.target_id) continue;
    rows.push(...listMemoryEvents(db, {
      targetType: attachment.target_type,
      targetId: attachment.target_id,
      limit,
    }));
  }
  return uniqueBy(rows, (row) => row.event_id)
    .filter((row) => !isProjectionOutputEvent(row))
    .map((row) => {
      const payloadSummary = row.event_type === 'viewer.correction.recorded'
        ? viewerCorrectionSummary(row)
        : row.payload?.summary || row.payload?.latest_state || row.payload?.title || '';
      return {
        kind: 'memory_event',
        valid_at: row.valid_at,
        source: `memory_events:${row.event_id}`,
        summary: payloadSummary
          ? clip(payloadSummary, 260)
          : `${row.event_type} ${row.stream_type}/${row.stream_id}#${row.stream_sequence} by ${row.actor}`,
        fallback_latest: Boolean(payloadSummary && isMeaningfulMemoryLine(payloadSummary)),
        hash: row.event_hash,
        event: row,
      };
    });
}

function isProjectionOutputEvent(row) {
  if (!row) return false;
  if (row.event_type === 'workbench.synthesis.generated') return true;
  if (row.event_type === 'snapshot.inferred') return true;
  if (row.event_type === 'memory.conflict.detected') return true;
  if (row.event_type === 'memory.conflict.resolved') return true;
  if (row.event_type === 'topic.identity.seeded' && row.actor === 'workbench-synthesis') return true;
  if (row.event_type === 'topic.context.updated') {
    if (row.actor === 'workbench-synthesis') return true;
    if (String(row.source || '').startsWith('workbench-synthesis:')) return true;
    if (row.payload?.source_type === 'workbench_synthesis') return true;
  }
  return false;
}

function collectConversationSources(db, workbench, limit) {
  if (!hasTable(db, 'conversations') || !hasTable(db, 'messages')) return [];
  const topics = (workbench.attachments || [])
    .filter((a) => a.target_type === 'topic')
    .map((a) => a.target_id);
  if (!topics.length) return [];
  const placeholders = topics.map(() => '?').join(',');
  const hasConversationTopics = hasTable(db, 'conversation_topics');
  const hasConversationTopicSlug = hasColumn(db, 'conversations', 'topic_slug');
  const topicClauses = [];
  const params = [];
  if (hasConversationTopicSlug) {
    topicClauses.push(`c.topic_slug IN (${placeholders})`);
    params.push(...topics);
  }
  if (hasConversationTopics) {
    topicClauses.push(`
      EXISTS (
        SELECT 1 FROM conversation_topics ct
        WHERE ct.conversation_id = c.id AND ct.topic_slug IN (${placeholders})
      )
    `);
    params.push(...topics);
  }
  if (!topicClauses.length) return [];
  try {
    const rows = db.prepare(`
      SELECT m.id AS message_id, m.conversation_id, m.role, m.content, m.seq, m.created_at
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE (${topicClauses.map((clause) => `(${clause})`).join(' OR ')})
        AND m.role IN ('user', 'assistant')
      ORDER BY COALESCE(m.created_at, '') DESC, m.id DESC
      LIMIT ?
    `).all(...params, limit);
    return rows
      .filter((row) => isConversationSourceRelevant(row, workbench))
      .map((row) => ({
        kind: 'chat_message',
        valid_at: row.created_at || '',
        source: `messages:${row.message_id}`,
        summary: clip(row.content, 220),
        hash: sha256(`${row.message_id}|${row.content || ''}`),
        decisions: parseDecisionLines(row.content, 3),
        next_action: parseNextAction(row.content),
        durable: isDurableConversationSource(row),
      }));
  } catch {
    return [];
  }
}

function isWorkbenchSynthesisTopicHistory(row) {
  return String(row?.source || '').startsWith('workbench-synthesis:');
}

function isCurrentTopicContextProjection(db, slug, contextMd) {
  if (!hasTable(db, 'topic_context_history')) return false;
  try {
    const row = db.prepare(`
      SELECT content, source
      FROM topic_context_history
      WHERE topic_slug = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(slug);
    return Boolean(
      row
      && isWorkbenchSynthesisTopicHistory(row)
      && String(row.content || '').trim() === String(contextMd || '').trim(),
    );
  } catch {
    return false;
  }
}

function ensureTopicContextSourceSnapshot(db, slug, contextMd, workbenchId) {
  const content = String(contextMd || '');
  if (!content.trim() || !hasTable(db, 'topic_context_history')) return false;
  if (isCurrentTopicContextProjection(db, slug, content)) return false;
  try {
    const existing = db.prepare(`
      SELECT id
      FROM topic_context_history
      WHERE topic_slug = ?
        AND content = ?
        AND source NOT LIKE 'workbench-synthesis:%'
      LIMIT 1
    `).get(slug, content);
    if (existing) return false;
    db.prepare(`
      INSERT INTO topic_context_history (topic_slug, content, source, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(slug, content, `workbench-source-snapshot:${workbenchId}`);
    return true;
  } catch {
    return false;
  }
}

function collectTopicContextSources(db, workbench, limit) {
  if (!hasTable(db, 'user_topics')) return [];
  const topics = (workbench.attachments || [])
    .filter((a) => a.target_type === 'topic')
    .map((a) => a.target_id);
  if (!topics.length) return [];

  const sources = [];
  const topicStmt = db.prepare(`
    SELECT slug, label, description, context_md, updated_at
    FROM user_topics
    WHERE slug = ?
  `);
  const hasHistory = hasTable(db, 'topic_context_history');
  const historyStmt = hasHistory ? db.prepare(`
    SELECT id, topic_slug, content, source, created_at
    FROM topic_context_history
    WHERE topic_slug = ?
    ORDER BY id DESC
    LIMIT ?
  `) : null;

  for (const topic of topics) {
    const row = topicStmt.get(topic);
    if (!row) continue;
    const historyRows = historyStmt ? historyStmt.all(topic, limit) : [];
    const latestHistory = historyRows[0] || null;
    const currentContext = String(row.context_md || '').trim();
    const currentIsProjection = currentContext
      && latestHistory
      && isWorkbenchSynthesisTopicHistory(latestHistory)
      && String(latestHistory.content || '').trim() === currentContext;
    if (currentContext && !currentIsProjection) {
      sources.push({
        kind: 'topic_context',
        valid_at: row.updated_at || '',
        source: `user_topics:${row.slug}:context_md`,
        summary: firstUsefulLine(currentContext) || `Topic context for ${row.label || row.slug}`,
        hash: sha256(currentContext),
        latest_state: parseLatestState(currentContext),
        decisions: parseDecisionLines(currentContext, 6),
        next_action: parseNextAction(currentContext),
      });
    }
    if (String(row.description || '').trim()) {
      sources.push({
        kind: 'topic_identity',
        valid_at: row.updated_at || '',
        source: `user_topics:${row.slug}:description`,
        summary: clip(row.description, 260),
        hash: sha256(row.description),
      });
    }
    for (const history of historyRows.filter((item) => !isWorkbenchSynthesisTopicHistory(item))) {
      const content = String(history.content || '').trim();
      if (!content) continue;
      sources.push({
        kind: 'topic_context_history',
        valid_at: history.created_at || '',
        source: `topic_context_history:${history.id}`,
        summary: firstUsefulLine(content) || `Topic context history for ${row.label || row.slug}`,
        hash: sha256(`${history.id}|${history.source || ''}|${content}`),
        latest_state: parseLatestState(content),
        decisions: parseDecisionLines(content, 6),
        next_action: parseNextAction(content),
      });
    }
  }
  return sources;
}

function isPublishedProjectionPath(path) {
  const p = String(path || '').replace(/\\/g, '/');
  if (basename(p) === 'REPORTS.md') return true;
  return /\/reports\//i.test(p);
}

function collectItemSources(workbench, repoRoot, limit) {
  const rows = [];
  for (const item of (workbench.items || []).slice(0, limit)) {
    if (STRUCTURED_WORKBENCH_MEMORY_FILES.has(basename(item.path || ''))) continue;
    if (isPublishedProjectionPath(item.path)) continue;
    const text = readRepoFile(repoRoot, item.path, 24_000);
    const first = firstUsefulLine(text) || item.title || basename(item.path || '');
    rows.push({
      kind: `workbench_item:${item.kind || 'source'}`,
      valid_at: sourceDateFromText(text, item.path) || item.updated_at || item.last_seen_at || '',
      source: item.path,
      summary: first,
      hash: item.content_hash || sha256(text || item.path),
      latest_state: parseLatestState(text),
      decisions: parseDecisionLines(text, 4),
      next_action: parseNextAction(text),
    });
  }
  return rows;
}

function collectFileSources(workbench, repoRoot) {
  const root = workbench.root_path || '';
  const files = [
    { kind: 'workbench_log', path: `${root}/LOG.md` },
    { kind: 'workbench_index', path: workbench.resume_path || `${root}/INDEX.md` },
  ];
  return files.map((file) => {
    const text = readRepoFile(repoRoot, file.path, 64_000);
    if (!text) return null;
    return {
      kind: file.kind,
      valid_at: sourceDateFromText(text, file.path),
      source: file.path,
      summary: firstUsefulLine(text),
      hash: sha256(text),
      latest_state: parseLatestState(text),
      decisions: parseDecisionLines(text, 10),
      next_action: parseNextAction(text),
      text,
    };
  }).filter(Boolean);
}

// Exported (not just internal to synthesizeWorkbench) so lib/topic-distill.js's
// Stage A can reuse the exact same deterministic replay + markdown formatting
// as its grounding skeleton (design-unified-architecture.md §2.2) instead of
// duplicating it — read-only, no DB/file writes happen in either function.
export function synthesizeDeterministically(workbench, sources, repoRoot) {
  const indexText = readRepoFile(repoRoot, workbench.resume_path || `${workbench.root_path}/INDEX.md`, 64_000);
  const index = parseResumeIndex(indexText);
  const sortedDesc = [...sources].sort((a, b) => String(b.valid_at || '').localeCompare(String(a.valid_at || '')));
  const sortedAsc = [...sources].sort((a, b) => String(a.valid_at || '').localeCompare(String(b.valid_at || '')));

  const latestSource = sortedDesc.find(canProvideFallbackLatest)
    || sources.find(canProvideFallbackLatest);
  const sourceLatest = sortedDesc.find((source) => source.latest_state && !isScaffoldMemoryText(source.latest_state) && source.kind !== 'workbench_index')
    || sortedDesc.find((source) => source.latest_state && !isScaffoldMemoryText(source.latest_state));
  const sourceNext = sortedDesc.find((source) => source.next_action && !isScaffoldMemoryText(source.next_action) && source.kind !== 'workbench_index')
    || sortedDesc.find((source) => source.next_action && !isScaffoldMemoryText(source.next_action));
  const latestState = clip(
    sourceLatest?.latest_state
      || (!isScaffoldMemoryText(index.latest_state) ? index.latest_state : '')
      || (!isScaffoldMemoryText(workbench.latest_state) ? workbench.latest_state : '')
      || (!isScaffoldMemoryText(workbench.summary) ? workbench.summary : '')
      || latestSource?.summary
      || `Workbench ${workbench.title || workbench.id} has ${sources.length} replayable source records.`,
    420,
  );

  const nextAction = clip(
    sourceNext?.next_action
      || (!isScaffoldMemoryText(index.next_action) ? index.next_action : '')
      || (!isScaffoldMemoryText(workbench.next_action) ? workbench.next_action : '')
      || 'Continue from the newest source-backed synthesis.',
    280,
  );

  const decisionLines = uniqueBy(
    [
      ...(index.open_decisions || []).map((summary) => ({ summary, source: workbench.resume_path || 'INDEX.md' })),
      ...sources.flatMap((source) => (source.decisions || []).map((summary) => ({ summary, source: source.source }))),
    ],
    (item) => item.summary,
  ).filter((item) => isMeaningfulMemoryLine(item.summary)).slice(0, 12);

  const openLoops = uniqueBy(
    [
      ...(index.unresolved_questions || []).map((summary) => ({ summary, source: workbench.resume_path || 'INDEX.md' })),
      ...sources
        .filter((source) => source.kind !== 'chat_message' || /\b(open question|unresolved|next action)\b/i.test(source.summary || ''))
        .filter((source) => /\b(open question|unresolved|next action)\b/i.test(source.summary || ''))
        .map((source) => ({ summary: source.summary, source: source.source })),
    ],
    (item) => item.summary,
  ).filter((item) => isMeaningfulMemoryLine(item.summary)).slice(0, 12);

  const timeline = sortedAsc
    .filter((source) => source.summary)
    .filter((source) => source.kind !== 'chat_message' || source.durable)
    .slice(-30)
    .map((source) => ({
      time: source.valid_at || 'unknown time',
      summary: source.summary,
      source: source.source,
    }));

  return { latestState, nextAction, decisionLines, openLoops, timeline };
}

export function formatSynthesisMarkdown({ workbench, synthesis, sources, sourceHash, events }) {
  const eventSequences = events.map((source) => source.event?.global_sequence).filter(Number.isFinite);
  const sourceEventFrom = eventSequences.length ? Math.min(...eventSequences) : null;
  const sourceEventTo = eventSequences.length ? Math.max(...eventSequences) : null;
  const generatedAt = new Date().toISOString();
  const lines = [
    `# ${workbench.title || workbench.id} Synthesis`,
    '',
    synthesis.latestState,
    '',
    `Next action: ${synthesis.nextAction}`,
    '',
    `<!-- memory_projection: workbench-synthesis ${WORKBENCH_SYNTHESIS_VERSION}; source_event_from=${sourceEventFrom ?? ''}; source_event_to=${sourceEventTo ?? ''}; source_set_hash=${sourceHash} -->`,
    '',
    '## Current Thesis',
    '',
    synthesis.latestState,
    '',
    '## Latest Thinking / Decisions',
    '',
    ...(synthesis.decisionLines.length
      ? synthesis.decisionLines.map((item) => `- ${item.summary} Source: ${item.source}.`)
      : ['- No explicit decisions found in replayed sources.']),
    '',
    '## Open Questions / Next Steps',
    '',
    ...(synthesis.openLoops.length
      ? synthesis.openLoops.map((item) => `- ${item.summary} Source: ${item.source}.`)
      : [`- ${synthesis.nextAction} Source: synthesis.`]),
    '',
    '## Evolution Timeline',
    '',
    ...(synthesis.timeline.length
      ? synthesis.timeline.map((item) => `- ${item.time}: ${item.summary} Source: ${item.source}.`)
      : ['- No replayable source events found yet.']),
    '',
    '## Source Watermark',
    '',
    `- Projection version: ${WORKBENCH_SYNTHESIS_VERSION}`,
    `- Source records: ${sources.length}`,
    `- Source event range: ${sourceEventFrom ?? 'none'}..${sourceEventTo ?? 'none'}`,
    `- Source set hash: ${sourceHash}`,
    '',
  ];
  return {
    markdown: `${lines.join('\n')}\n`,
    generatedAt,
    sourceEventFrom,
    sourceEventTo,
  };
}

function topicContextFromSynthesis(markdown, synthesis = null, entityFacts = []) {
  const stripped = String(markdown || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^# .+$/m, '')
    .trim();
  const facts = [
    ...entityFacts,
    synthesis?.latestState,
    ...((synthesis?.decisionLines || []).slice(0, 5).map((item) => item.summary)),
  ].filter(Boolean);
  const factsBlock = facts.length
    ? `## Facts\n\n${facts.map((fact) => `- ${clip(fact, 280)}`).join('\n')}\n\n`
    : '';
  return `${factsBlock}## Summary\n\n${stripped.slice(0, TOPIC_CONTEXT_CHAR_BUDGET).trim()}\n`;
}

function identityFromSynthesis(workbench, synthesis) {
  return clip(
    [
      workbench.title || workbench.id,
      synthesis.latestState,
      `Next: ${synthesis.nextAction}`,
    ].filter(Boolean).join(' - '),
    TOPIC_IDENTITY_CHAR_BUDGET,
  );
}

export function collectWorkbenchSynthesisSources(db, workbench, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const eventLimit = Number(options.eventLimit || 120);
  const messageLimit = Number(options.messageLimit || 80);
  const itemLimit = Number(options.itemLimit || 120);
  const topicContextLimit = Number(options.topicContextLimit || 20);
  const items = mergeWorkbenchItems(workbench, repoRoot, options);
  return [
    ...collectEventSources(db, workbench, eventLimit),
    ...collectTopicContextSources(db, workbench, topicContextLimit),
    ...collectConversationSources(db, workbench, messageLimit),
    ...collectFileSources(workbench, repoRoot),
    ...collectItemSources({ ...workbench, items }, repoRoot, itemLimit),
  ];
}

export async function synthesizeWorkbench(db, args = {}, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const lookupId = args.id || args.workbench_id || '';
  const workbench = (lookupId ? getWorkbench(db, lookupId) : null)
    || resolveWorkbench(db, { id: args.id, target: args.target, query: args.query }, { repoRoot });
  const fullWorkbench = workbench.items ? workbench : getWorkbench(db, workbench.workbench_id);
  if (!fullWorkbench) throw new Error(`workbench not found: ${args.id || args.workbench_id || args.target || args.query}`);

  ensureWorkbenchMemoryFiles(fullWorkbench.root_path, fullWorkbench, { repoRoot });
  const sources = collectWorkbenchSynthesisSources(db, fullWorkbench, { ...options, repoRoot });
  const events = sources.filter((source) => source.event);
  const sourceHash = sourceSetHash(sources);
  const synthesis = synthesizeDeterministically(fullWorkbench, sources, repoRoot);
  const formatted = formatSynthesisMarkdown({
    workbench: fullWorkbench,
    synthesis,
    sources,
    sourceHash,
    events,
  });

  const synthesisPath = `${fullWorkbench.root_path}/SYNTHESIS.md`;
  const absSynthesisPath = resolve(repoRoot, synthesisPath);
  mkdirSync(dirname(absSynthesisPath), { recursive: true });
  writeFileSync(absSynthesisPath, formatted.markdown);

  const reportDay = String(formatted.generatedAt || new Date().toISOString()).slice(0, 10);
  const reportRel = `${fullWorkbench.root_path}/reports/${reportDay}-synthesis.md`;
  const absReportPath = resolve(repoRoot, reportRel);
  mkdirSync(dirname(absReportPath), { recursive: true });
  const reportBody = [
    '---',
    `workbench_id: ${fullWorkbench.id}`,
    `slug: ${fullWorkbench.slug || fullWorkbench.id}`,
    `published_at: ${formatted.generatedAt}`,
    `source_set_hash: ${sourceHash}`,
    `url: ${workbenchPublicUrl(fullWorkbench)}/reports/${reportDay}-synthesis`,
    '---',
    '',
    formatted.markdown,
  ].join('\n');
  writeFileSync(absReportPath, reportBody);
  const reportsIndexPath = resolve(repoRoot, `${fullWorkbench.root_path}/REPORTS.md`);
  const existingIndex = existsSync(reportsIndexPath) ? readFileSync(reportsIndexPath, 'utf8') : '# Reports\n';
  const reportLine = `- [${reportDay} synthesis](reports/${reportDay}-synthesis.md)`;
  if (!existingIndex.includes(`reports/${reportDay}-synthesis.md`)) {
    writeFileSync(reportsIndexPath, `${existingIndex.replace(/\s*$/, '')}\n\n${reportLine}\n`);
  }

  db.prepare(`
    UPDATE workbenches
       SET latest_state = ?,
           next_action = ?,
           last_activity_at = COALESCE(last_activity_at, datetime('now')),
           updated_at = datetime('now')
     WHERE id = ?
  `).run(synthesis.latestState, synthesis.nextAction, fullWorkbench.id);

  const outputHash = sha256(formatted.markdown);
  const eventResult = appendMemoryEvent(db, {
    streamType: 'workbench',
    streamId: fullWorkbench.id,
    eventType: 'workbench.synthesis.generated',
    actor: 'workbench-synthesis',
    source: 'workbench:synthesis',
    subjectType: 'workbench',
    subjectId: fullWorkbench.id,
    validAt: formatted.generatedAt,
    idempotencyKey: `workbench-synthesis:${fullWorkbench.id}:${outputHash}`,
    payload: {
      synthesis_path: synthesisPath,
      report_path: reportRel,
      output_hash: outputHash,
      source_records: sources.length,
      source_set_hash: sourceHash,
      latest_state: synthesis.latestState,
      next_action: synthesis.nextAction,
    },
    links: normalizeAttachments(fullWorkbench),
  });
  const snapshotResult = inferSnapshotFromMemoryEvent(db, eventResult.event, {
    sourceKind: 'workbench_synthesis',
    source: 'snapshot:workbench-synthesis',
    actor: 'workbench-synthesis',
  });

  const sourceEventRows = events.map((source) => source.event);
  const projectionSourceHash = sourceEventRows.length ? memorySourceSetHash(sourceEventRows) : sourceHash;
  recordProjectionRun(db, {
    projectionName: 'workbench-synthesis',
    targetType: 'workbench',
    targetId: fullWorkbench.id,
    sourceEventFrom: formatted.sourceEventFrom,
    sourceEventTo: formatted.sourceEventTo,
    sourceSetHash: projectionSourceHash,
    projectionVersion: WORKBENCH_SYNTHESIS_VERSION,
    promptVersion: 'deterministic',
    model: 'none',
    generatedAt: formatted.generatedAt,
    generatedBy: 'workbench-synthesis',
    outputHash,
    metadata: { synthesis_path: synthesisPath, source_records: sources.length },
  });

  const topicResults = [];
  for (const attachment of fullWorkbench.attachments || []) {
    if (attachment.target_type !== 'topic') continue;
    const contextMd = topicContextFromSynthesis(
      formatted.markdown,
      synthesis,
      collectAttachedEntityFactBullets(db, fullWorkbench),
    );
    const topicRow = db.prepare('SELECT context_md, description FROM user_topics WHERE slug = ?').get(attachment.target_id);
    ensureTopicContextSourceSnapshot(db, attachment.target_id, topicRow?.context_md, fullWorkbench.id);
    const applied = String(topicRow?.context_md || '') === contextMd
      ? {
          slug: attachment.target_id,
          chars: contextMd.length,
          events: 0,
          memory_event_id: null,
          skipped: true,
        }
      : await applyTopicContext(db, {
          slug: attachment.target_id,
          contextMd,
          sourceType: 'workbench_synthesis',
          source: `workbench-synthesis:${fullWorkbench.id}`,
          events: [{
            date: formatted.generatedAt,
            summary: `Workbench synthesis regenerated for ${fullWorkbench.title || fullWorkbench.id}`,
            metadata: {
              workbench_id: fullWorkbench.id,
              synthesis_path: synthesisPath,
              source_set_hash: sourceHash,
            },
          }],
        });
    topicResults.push({ slug: attachment.target_id, context: applied, identity_updated: false });
  }

  const entityResults = [];
  for (const attachment of fullWorkbench.attachments || []) {
    if (!['person', 'company', 'place'].includes(attachment.target_type)) continue;
    const rel = entityContextPath(attachment.target_type, attachment.target_id, db);
    const abs = resolve(repoRoot, rel);
    let existing = '';
    try { if (existsSync(abs)) existing = readFileSync(abs, 'utf8'); } catch { existing = ''; }
    let entityFactBullets = [];
    try {
      const floor = buildEntityFloor(db, {
        id: attachment.target_id,
        type: attachment.target_type,
        name: attachment.label,
        display_name: attachment.label,
      });
      entityFactBullets = formatEntityFactBullets(floor);
    } catch { entityFactBullets = []; }
    const withFacts = injectFactsSection(existing, [
      ...entityFactBullets,
      synthesis.latestState,
      ...((synthesis.decisionLines || []).slice(0, 5).map((item) => item.summary)),
    ]);
    const updated = injectPromotionIntoSummary(withFacts, synthesis.latestState);
    if (updated !== existing) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, updated);
    }
    entityResults.push({
      type: attachment.target_type,
      id: attachment.target_id,
      path: rel,
      changed: updated !== existing,
    });
  }

  return {
    ok: true,
    workbench_id: fullWorkbench.id,
    synthesis_path: toRepoPath(absSynthesisPath, repoRoot),
    report_path: toRepoPath(absReportPath, repoRoot),
    latest_state: synthesis.latestState,
    next_action: synthesis.nextAction,
    source_records: sources.length,
    source_set_hash: sourceHash,
    output_hash: outputHash,
    memory_event_id: eventResult.event?.event_id || null,
    snapshot: snapshotResult?.snapshot || null,
    snapshot_inserted: Boolean(snapshotResult?.inserted),
    topic_results: topicResults,
    entity_results: entityResults,
  };
}
