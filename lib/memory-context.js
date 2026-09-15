// lib/memory-context.js - deterministic memory read model for chat/build.
//
// Event sourcing shape: immutable logs remain the source of truth; this module
// materializes a compact read packet. Launch chat is literal by default:
// generated synthesis and inferred claims are opt-in, not ambient facts.
// No LLM writes here.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { getLogIndex, readEntryBody, verifyChain } from './memory.js';
import { latestProjectionRuns, listMemoryEvents } from './memory-events.js';
import { listMemoryConflicts, listSnapshots } from './snapshots.js';
import { parseResumeIndex } from './workbench-files.js';
import { PIPELINE_STORIES_DIR, REPO_ROOT } from './robotdojo-paths.js';
import { hedgePolicy, SOURCE_CLASS } from './provenance.js';
import { isScaffoldProjection, projectionFromLog } from './workbench-log.js';

export const MEMORY_CONTEXT_DEFAULT_CHAR_BUDGET = 4000;
export const MEMORY_CONTEXT_TIERS = Object.freeze({
  micro: Object.freeze({
    maxChars: 1000,
    workbenches: 1,
    memoryEntries: 2,
    stageEvents: 2,
    timelineEvents: 2,
    eventLedger: 3,
    projectionWatermarks: 1,
    snapshots: 2,
    conflicts: 1,
  }),
  standard: Object.freeze({
    maxChars: MEMORY_CONTEXT_DEFAULT_CHAR_BUDGET,
    workbenches: 4,
    memoryEntries: 8,
    stageEvents: 12,
    timelineEvents: 6,
    eventLedger: 8,
    projectionWatermarks: 5,
    snapshots: 8,
    conflicts: 4,
  }),
  workbench: Object.freeze({
    maxChars: 12_000,
    workbenches: 8,
    memoryEntries: 12,
    stageEvents: 16,
    timelineEvents: 8,
    eventLedger: 16,
    projectionWatermarks: 8,
    snapshots: 12,
    conflicts: 8,
  }),
  recall: Object.freeze({
    maxChars: 16_000,
    workbenches: 10,
    memoryEntries: 16,
    stageEvents: 24,
    timelineEvents: 12,
    eventLedger: 24,
    projectionWatermarks: 10,
    snapshots: 16,
    conflicts: 10,
  }),
});

const GENERATED_MEMORY_EVENT_TYPES = new Set([
  'snapshot.inferred',
  'workbench.synthesis.generated',
]);

export function resolveMemoryContextLiteralMode({ literal = null, includeSynthesis = false } = {}) {
  if (includeSynthesis) return false;
  if (literal != null) return Boolean(literal);
  return process.env.ROBOTDOJO_MEMORY_CONTEXT_ALLOW_SYNTHESIS !== '1';
}

function isGeneratedMemoryEvent(row) {
  return GENERATED_MEMORY_EVENT_TYPES.has(String(row?.event_type || ''));
}

function isLiteralSnapshot(snapshot) {
  return Boolean(snapshot && !snapshot.inferred && snapshot.source_kind !== 'retroactive_reconstruction');
}

// Continuity is the project/workbench/timeline read model, not the saved-fact
// store. Plain "remember/recall" queries are served by user-fact RAG and the
// fast memory fallback; routing them here walks memory logs, story events, and
// timeline rows for a question that only needs saved facts.
const CONTINUITY_INTENT_RE = /\b(where (are|were) we|latest|next steps?|decision|decided|history|timeline|sequence|evolution|trend|snapshot|official view|workbench|story|build|what happened|over time)\b/i;

function asTopicList(topic) {
  if (!topic) return [];
  return Array.isArray(topic) ? topic.filter(Boolean).map(String) : [String(topic)];
}

export function shouldInjectMemoryContext(query, { topic = null } = {}) {
  if (CONTINUITY_INTENT_RE.test(String(query || ''))) return true;
  return asTopicList(topic).length > 0;
}

function hasMemoryIntent(query) {
  return CONTINUITY_INTENT_RE.test(String(query || ''));
}

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

function clip(text, max = 240) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
}

function normalizeTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const d = new Date(raw.includes('T') || raw.length === 10 ? raw : raw.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

function atOrBefore(value, asOf) {
  if (!asOf) return true;
  const t = normalizeTime(value);
  return !!t && t <= asOf;
}

function memoryTierFor(tier, explicitRecall) {
  const key = String(tier || '').trim().toLowerCase();
  if (MEMORY_CONTEXT_TIERS[key]) return { name: key, ...MEMORY_CONTEXT_TIERS[key] };
  return explicitRecall
    ? { name: 'recall', ...MEMORY_CONTEXT_TIERS.recall }
    : { name: 'standard', ...MEMORY_CONTEXT_TIERS.standard };
}

function normalizeEntityTargets(entities = []) {
  const list = Array.isArray(entities) ? entities : [entities];
  return list.map((entity) => {
    if (!entity) return null;
    if (typeof entity === 'string') return { targetType: 'entity', targetId: entity };
    const targetType = entity.targetType || entity.target_type || entity.entityType || entity.entity_type || entity.type || 'entity';
    const targetId = entity.targetId || entity.target_id || entity.entityId || entity.entity_id || entity.id;
    if (!targetType || !targetId) return null;
    return { targetType: String(targetType), targetId: String(targetId) };
  }).filter(Boolean);
}

function normalizeTargetRefs({ topic = null, entities = [] } = {}) {
  const refs = [
    ...asTopicList(topic).map((targetId) => ({ targetType: 'topic', targetId })),
    ...normalizeEntityTargets(entities),
  ];
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.targetType}\0${ref.targetId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function firstUsefulLine(text, max = 260) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^[-*#>\s]+/, '').trim();
    if (line) return clip(line, max);
  }
  return '';
}

function parseWorkbenchSynthesisText(text) {
  const raw = String(text || '');
  const nextMatch = raw.match(/(?:^|\n)\s*(?:[-*]\s*)?next action\s*:\s*(.+?)(?=\n|$)/i);
  const bodyLines = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !/^next action\s*:/i.test(line));
  return {
    latest_state: clip(bodyLines[0] || '', 420),
    next_action: nextMatch ? clip(nextMatch[1], 280) : '',
  };
}

function repoRead(repoRoot, repoPath, maxBytes = 24_000) {
  if (!repoPath) return '';
  const abs = resolve(repoRoot, repoPath);
  if (!existsSync(abs)) return '';
  const st = statSync(abs);
  if (!st.isFile()) return '';
  return readFileSync(abs).subarray(0, maxBytes).toString('utf8');
}

async function collectMemoryEntries({ limit = 8, asOf = '' } = {}) {
  let chain = null;
  try {
    chain = await verifyChain();
  } catch (err) {
    chain = { ok: false, error: err.message };
  }

  let index = [];
  try {
    index = await getLogIndex();
  } catch {
    index = [];
  }

  const entries = [];
  for (const item of index.filter((entry) => atOrBefore(entry.timestamp, asOf)).slice(0, limit)) {
    let body = '';
    try { body = await readEntryBody(item.path); } catch {}
    entries.push({
      timestamp: item.timestamp || '',
      type: item.type || '',
      name: item.name || basename(item.path || ''),
      description: item.description || '',
      source: `memory-log:${basename(item.path || item.name || '')}`,
      body: firstUsefulLine(body),
      sourceClass: item.sourceClass || null,
      status: item.status || null,
    });
  }

  return { chain, entries };
}

function collectWorkbenchRows(db, targets, limit) {
  if (!db || !hasTable(db, 'workbenches')) return [];
  try {
    if (targets.length && hasTable(db, 'workbench_attachments')) {
      const rows = [];
      const stmt = db.prepare(`
        SELECT DISTINCT w.*
        FROM workbenches w
        JOIN workbench_attachments a ON a.workbench_id = w.id
        WHERE w.status != 'archived'
          AND a.target_type = ?
          AND a.target_id = ?
        ORDER BY COALESCE(w.last_activity_at, w.updated_at, w.created_at) DESC
        LIMIT ?
      `);
      for (const target of targets) rows.push(...stmt.all(target.targetType, target.targetId, limit));
      const seen = new Set();
      return rows.filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      }).slice(0, limit);
    }
    return db.prepare(`
      SELECT *
      FROM workbenches
      WHERE status != 'archived'
      ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC
      LIMIT ?
    `).all(limit);
  } catch {
    return [];
  }
}

function latestWorkbenchSynthesisAt(db, workbenchId, asOf) {
  if (!asOf || !db || !hasTable(db, 'memory_events')) return null;
  try {
    const row = db.prepare(`
      SELECT event_id, valid_at, payload_json
      FROM memory_events
      WHERE event_type = 'workbench.synthesis.generated'
        AND subject_type = 'workbench'
        AND subject_id = ?
        AND valid_at <= ?
      ORDER BY valid_at DESC, global_sequence DESC
      LIMIT 1
    `).get(workbenchId, asOf);
    if (!row) return null;
    let payload = {};
    try { payload = JSON.parse(row.payload_json || '{}'); } catch {}
    return {
      eventId: row.event_id,
      validAt: row.valid_at,
      latestState: payload.latest_state || '',
      nextAction: payload.next_action || '',
      source: `memory_events:${row.event_id}`,
    };
  } catch {
    return null;
  }
}

function collectWorkbenches(db, { topic = null, entities = [], targets = null, repoRoot = REPO_ROOT, limit = 4, asOf = '' } = {}) {
  const rows = collectWorkbenchRows(db, targets || normalizeTargetRefs({ topic, entities }), limit);
  return rows.map((row) => {
    const rootPath = row.root_path || '';
    const resumePath = row.resume_path || (rootPath ? `${rootPath}/INDEX.md` : '');
    const synthesisPath = rootPath ? `${rootPath}/SYNTHESIS.md` : '';
    const asOfProjection = latestWorkbenchSynthesisAt(db, row.id, asOf);
    const resumeMd = asOf ? '' : repoRead(repoRoot, resumePath);
    const parsed = asOf ? {} : parseResumeIndex(resumeMd);
    const synthesisMd = asOf ? '' : repoRead(repoRoot, synthesisPath, 16_000);
    const synthesisParsed = asOf ? { latest_state: '', next_action: '' } : parseWorkbenchSynthesisText(synthesisMd);
    const fromLog = asOf ? { latestState: '', nextAction: '' } : projectionFromLog(rootPath, repoRoot);
    const logState = fromLog.latestState && !isScaffoldProjection(fromLog.latestState)
      ? fromLog.latestState
      : '';
    const logNext = fromLog.nextAction && !isScaffoldProjection(fromLog.nextAction)
      ? fromLog.nextAction
      : '';
    const synthesis = asOfProjection?.latestState || synthesisParsed.latest_state || firstUsefulLine(synthesisMd);
    const log = logState || (asOf ? '' : firstUsefulLine(repoRead(repoRoot, rootPath ? `${rootPath}/LOG.md` : '', 16_000)));
    const latestFromLog = !!logState;
    const latestFromSynthesis = !latestFromLog && !!synthesisParsed.latest_state;
    const nextFromLog = !!logNext;
    const nextFromSynthesis = !nextFromLog && !!synthesisParsed.next_action;
    const projectionSource = asOfProjection?.source || '';
    const logPath = rootPath ? `${rootPath}/LOG.md` : '';
    return {
      id: row.id,
      title: row.title || row.slug || row.id,
      status: row.status || 'active',
      updatedAt: asOfProjection?.validAt || row.last_activity_at || row.updated_at || row.created_at || '',
      source: resumePath || rootPath,
      latestSource: projectionSource || (latestFromLog ? logPath : (latestFromSynthesis ? synthesisPath : (resumePath || rootPath))),
      nextSource: projectionSource || (nextFromLog ? logPath : (nextFromSynthesis ? synthesisPath : (resumePath || rootPath))),
      decisionSource: latestFromLog ? logPath : (resumePath || rootPath),
      latestState: asOf ? (asOfProjection?.latestState || '') : (logState || synthesisParsed.latest_state || parsed.latest_state || row.latest_state || row.summary || log),
      nextAction: asOf ? (asOfProjection?.nextAction || '') : (logNext || synthesisParsed.next_action || parsed.next_action || row.next_action || ''),
      currentQuestion: asOf ? '' : (parsed.current_question || row.current_question || ''),
      openDecisions: asOf ? [] : (parsed.open_decisions || []),
      unresolvedQuestions: asOf ? [] : (parsed.unresolved_questions || []),
      synthesis,
      log,
    };
  }).filter((w) => w.latestState || w.nextAction || w.currentQuestion || w.synthesis || w.log);
}

function collectStageEvents({ storiesDir = PIPELINE_STORIES_DIR, limit = 12, asOf = '' } = {}) {
  if (!existsSync(storiesDir)) return [];
  const events = [];
  for (const storyId of readdirSync(storiesDir)) {
    if (!/^st_[a-z0-9]+/.test(storyId)) continue;
    const path = join(storiesDir, storyId, 'stage-events.jsonl');
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!atOrBefore(parsed.timestamp, asOf)) continue;
        events.push({
          storyId,
          stage: parsed.stage || '',
          agent: parsed.agent || '',
          event: parsed.event || '',
          timestamp: parsed.timestamp || '',
          source: `story:${storyId}/stage-events.jsonl`,
        });
      } catch {}
    }
  }
  events.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return events.slice(0, limit);
}

function collectTimelineEvents(db, { query = '', limit = 6, asOf = '' } = {}) {
  if (!db || !hasTable(db, 'timeline_events')) return [];
  const includeCalendar = /\b(calendar|schedule|meeting|event)\b/i.test(String(query || ''));
  try {
    return db.prepare(`
      SELECT event_date, event_type, summary, source_type, source_id
      FROM timeline_events
      WHERE event_date <= ?
        AND (? = 1 OR COALESCE(source_type, '') NOT LIKE 'calendar%')
      ORDER BY event_date DESC, rowid DESC
      LIMIT ?
    `).all(asOf || new Date().toISOString(), includeCalendar ? 1 : 0, limit).map((row) => ({
      timestamp: row.event_date || '',
      eventType: row.event_type || '',
      summary: row.summary || '',
      source: `timeline:${row.source_type || 'unknown'}:${row.source_id || ''}`,
    }));
  } catch {
    return [];
  }
}

function collectEventLedger(db, { topic = null, entities = [], targets = null, explicitRecall = false, limit = 8, asOf = '' } = {}) {
  if (!db || !hasTable(db, 'memory_events')) return [];
  const targetRefs = targets || normalizeTargetRefs({ topic, entities });
  const rows = [];
  try {
    if (targetRefs.length) {
      for (const target of targetRefs) {
        rows.push(...listMemoryEvents(db, { targetType: target.targetType, targetId: target.targetId, limit, asOf }));
      }
    } else if (explicitRecall) {
      rows.push(...listMemoryEvents(db, { limit, asOf }));
    }
  } catch {
    return [];
  }
  const seen = new Set();
  return rows
    .filter((row) => {
      if (!row?.event_id || seen.has(row.event_id)) return false;
      seen.add(row.event_id);
      return true;
    })
    .sort((a, b) => {
      const t = String(b.valid_at || '').localeCompare(String(a.valid_at || ''));
      return t || Number(b.global_sequence || 0) - Number(a.global_sequence || 0);
    })
    .slice(0, limit);
}

function collectProjectionWatermarks(db, { topic = null, entities = [], targets = null, explicitRecall = false, limit = 5, asOf = '' } = {}) {
  if (!db || !hasTable(db, 'memory_projection_runs')) return [];
  const targetRefs = targets || normalizeTargetRefs({ topic, entities });
  const rows = [];
  try {
    if (targetRefs.length) {
      for (const target of targetRefs) {
        rows.push(...latestProjectionRuns(db, { targetType: target.targetType, targetId: target.targetId, limit, asOf }));
      }
    } else if (explicitRecall) {
      rows.push(...latestProjectionRuns(db, { limit, asOf }));
    }
  } catch {
    return [];
  }
  return rows
    .sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')))
    .slice(0, limit);
}

function mergeProjectionWatermarks(rows, limit) {
  const seen = new Set();
  return rows
    .filter((row) => {
      const key = row?.id || `${row?.projection_name}\0${row?.target_type}\0${row?.target_id}\0${row?.source_event_to}\0${row?.source_set_hash}`;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')))
    .slice(0, limit);
}

function collectWorkbenchProjectionWatermarks(db, workbenches = [], { limit = 5, asOf = '' } = {}) {
  if (!db || !hasTable(db, 'memory_projection_runs') || !workbenches.length) return [];
  const rows = [];
  try {
    for (const workbench of workbenches) {
      if (!workbench?.id) continue;
      rows.push(...latestProjectionRuns(db, {
        targetType: 'workbench',
        targetId: workbench.id,
        limit,
        asOf,
      }));
    }
  } catch {
    return [];
  }
  return rows;
}

function collectSnapshots(db, { topic = null, entities = [], targets = null, explicitRecall = false, limit = 8, asOf = '' } = {}) {
  if (!db || !hasTable(db, 'memory_events')) return [];
  const targetRefs = targets || normalizeTargetRefs({ topic, entities });
  const rows = [];
  try {
    if (targetRefs.length) {
      for (const target of targetRefs) {
        rows.push(...listSnapshots(db, {
          targetType: target.targetType,
          targetId: target.targetId,
          limit,
          asOf,
          activeOnly: true,
        }));
      }
    } else if (explicitRecall) {
      rows.push(...listSnapshots(db, { limit, asOf, activeOnly: true }));
    }
  } catch {
    return [];
  }
  const seen = new Set();
  return rows
    .filter((snapshot) => {
      if (!snapshot?.event_id || seen.has(snapshot.event_id)) return false;
      seen.add(snapshot.event_id);
      return true;
    })
    .sort((a, b) => {
      const t = String(b.valid_at || '').localeCompare(String(a.valid_at || ''));
      return t || Number(b.global_sequence || 0) - Number(a.global_sequence || 0);
    })
    .slice(0, limit);
}

function collectConflicts(db, { topic = null, entities = [], targets = null, explicitRecall = false, limit = 4, asOf = '' } = {}) {
  if (!db || !hasTable(db, 'memory_events')) return [];
  const targetRefs = targets || normalizeTargetRefs({ topic, entities });
  const rows = [];
  try {
    if (targetRefs.length) {
      for (const target of targetRefs) {
        rows.push(...listMemoryConflicts(db, {
          targetType: target.targetType,
          targetId: target.targetId,
          limit,
          asOf,
        }));
      }
    } else if (explicitRecall) {
      rows.push(...listMemoryConflicts(db, { limit, asOf }));
    }
  } catch {
    return [];
  }
  const seen = new Set();
  return rows
    .filter((conflict) => {
      if (!conflict?.event_id || seen.has(conflict.event_id)) return false;
      seen.add(conflict.event_id);
      return conflict.status !== 'resolved';
    })
    .sort((a, b) => {
      const t = String(b.valid_at || '').localeCompare(String(a.valid_at || ''));
      return t || Number(b.global_sequence || 0) - Number(a.global_sequence || 0);
    })
    .slice(0, limit);
}

function addLine(lines, line) {
  if (line && String(line).trim()) lines.push(String(line).trimEnd());
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort();
}

export function summarizeMemoryContextPacket(packet, { cacheHit = false, timeout = false } = {}) {
  const text = String(packet || '');
  const sections = [];
  for (const match of text.matchAll(/^###\s+(.+)$/gm)) sections.push(match[1].trim());
  const sourceTypes = [];
  if (/\bSource: memory_events:/i.test(text)) sourceTypes.push('memory_events');
  if (/\bSource: memory_projection_runs\b/i.test(text)) sourceTypes.push('memory_projection_runs');
  if (/\bSource: memory-log:/i.test(text)) sourceTypes.push('memory_log');
  if (/\bSource: timeline:/i.test(text)) sourceTypes.push('timeline');
  if (/\bSource: story:/i.test(text)) sourceTypes.push('story_stage_events');
  if (/\bSource: user\/workbenches\//i.test(text)) sourceTypes.push('workbench_files');

  const targetTypes = [];
  for (const match of text.matchAll(/\b(topic|person|company|place|workbench|user)\/[A-Za-z0-9_.:-]+/g)) {
    targetTypes.push(match[1]);
  }

  const eventTypes = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/\bSource:\s+(?:memory_events|timeline):/i.test(line)) continue;
    const memoryEventMatch = line.match(/^-\s+\S+\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\s+[^:]*\bSource:\s+memory_events:/i);
    const timelineEventMatch = line.match(/^-\s+\S+\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+):\s+.*\bSource:\s+timeline:/i);
    if (memoryEventMatch?.[1]) eventTypes.push(memoryEventMatch[1]);
    if (timelineEventMatch?.[1]) eventTypes.push(timelineEventMatch[1]);
  }

  return {
    present: text.length > 0,
    cache_hit: Boolean(cacheHit),
    timeout: Boolean(timeout),
    tier: text.match(/Context tier:\s*([^.]+)\./i)?.[1]?.trim() || null,
    chars: text.length,
    sections: uniqueSorted(sections),
    source_types: uniqueSorted(sourceTypes),
    target_types: uniqueSorted(targetTypes),
    event_types: uniqueSorted(eventTypes).slice(0, 20),
    has_latest: /^### Latest state \/ next steps$/m.test(text),
    has_snapshots: /^### Snapshots \/ official views$/m.test(text),
    has_conflicts: /^### Conflicts \/ uncertainty$/m.test(text),
    has_chronology: /^### Chronology \/ evolution$/m.test(text),
  };
}

function renderedSections(headerLines, sections, selected) {
  const lines = [...headerLines];
  for (const section of sections) {
    const body = selected.get(section) || [];
    if (!body.length) continue;
    addLine(lines, section.title);
    body.forEach((line) => addLine(lines, line));
  }
  return lines.join('\n').trim();
}

function renderBudgetedSections(headerLines, sections, maxChars) {
  const budget = Math.max(1, Number(maxChars || MEMORY_CONTEXT_DEFAULT_CHAR_BUDGET));
  const active = sections.filter((section) => section?.title && section.lines?.length);
  const selected = new Map(active.map((section) => [section, []]));
  if (!active.length) return headerLines.join('\n').slice(0, budget).trim();

  const trySelect = (section, line) => {
    const selectedLines = selected.get(section);
    selectedLines.push(line);
    if (renderedSections(headerLines, active, selected).length <= budget) return true;
    selectedLines.pop();
    return false;
  };

  // First pass gives each non-empty section a chance to appear. That prevents a
  // long "latest" block from starving snapshots, conflicts, or chronology in
  // micro/standard context windows.
  for (const section of active) {
    trySelect(section, section.lines[0]);
  }

  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const section of active) {
      const selectedLines = selected.get(section);
      const next = section.lines[selectedLines.length];
      if (next && trySelect(section, next)) advanced = true;
    }
  }

  const rendered = renderedSections(headerLines, active, selected);
  return rendered.length <= budget ? rendered : rendered.slice(0, budget).trim();
}

function renderPacket({
  memory,
  workbenches,
  stageEvents,
  timelineEvents,
  eventLedger,
  projectionWatermarks,
  snapshots,
  conflicts,
  literalMode = true,
  tierName = 'standard',
  asOf = '',
  maxChars = MEMORY_CONTEXT_DEFAULT_CHAR_BUDGET,
}) {
  const compactTier = tierName === 'micro';
  const latestStateMax = compactTier ? 220 : 420;
  const nextActionMax = compactTier ? 180 : 280;
  const snapshotBodyMax = compactTier ? 260 : 520;
  const conflictMax = compactTier ? 260 : 420;
  const headerLines = [];
  addLine(headerLines, '## Memory continuity');
  addLine(headerLines, `- Context tier: ${tierName}.`);
  if (literalMode) {
    addLine(headerLines, '- Literal mode: generated synthesis, inferred snapshots, timeline summaries, and projection text are omitted. Treat implications as current-turn inference, not stored fact.');
  }
  if (asOf) addLine(headerLines, `- As of: ${asOf}.`);
  if (memory?.chain) {
    const status = memory.chain.ok
      ? `chain ok; ${memory.chain.count || 0} entries; head ${memory.chain.head || 'none'}`
      : `chain warning: ${memory.chain.error || 'unverified'}`;
    addLine(headerLines, `- Memory log: ${status}.`);
  }

  const latest = [];
  for (const w of workbenches || []) {
    if (w.latestState || w.nextAction) {
      const parts = [];
      if (w.latestState) parts.push(`Latest: ${clip(w.latestState, latestStateMax)}`);
      if (w.nextAction) parts.push(`Next: ${clip(w.nextAction, nextActionMax)}`);
      latest.push(`- Workbench ${w.title}: ${parts.join(' ')} Source: ${w.latestSource || w.nextSource || w.source}.`);
    }
    if (w.currentQuestion) latest.push(`- Current question: ${clip(w.currentQuestion)} Source: ${w.source}.`);
  }
  for (const entry of memory?.entries || []) {
    const text = entry.description || entry.body;
    if (text) {
      // Chunk 7A (st_5184eb86 §7A): this "Latest state / next steps" block
      // is the authoritative context a chat turn actually reads. An
      // agent-authored memory-log entry (source_class llm-distilled,
      // status provisional) is the agent's own distillation, never a fact
      // the owner stated, and must never render as a settled owner rule.
      // hedgePolicy(sourceClass, undefined) resolves user-stated to
      // 'assert' (rendered plain, unchanged) and llm-distilled to 'hedge'
      // (no numeric confidence exists on a memory entry, so it never
      // resolves to 'omit' here — see provenance.js hedgePolicy).
      const disposition = hedgePolicy(entry.sourceClass || SOURCE_CLASS.LLM_DISTILLED, undefined);
      if (disposition === 'omit') continue;
      const marker = disposition === 'hedge' ? ' (agent-noted, unconfirmed)' : '';
      latest.push(`- ${entry.timestamp || 'unknown time'} ${entry.type}/${entry.name}: ${clip(text)}${marker} Source: ${entry.source}.`);
    }
  }
  const sections = [];
  if (latest.length) sections.push({ title: '### Latest state / next steps', lines: latest.slice(0, 12) });

  const snapshotLines = [];
  if (snapshots?.length) {
    for (const snapshot of snapshots.slice(0, 8)) {
      const marker = snapshot.inferred ? `inferred; confidence ${snapshot.confidence}` : 'official';
      const scope = snapshot.scope?.type && snapshot.scope?.id ? `${snapshot.scope.type}/${snapshot.scope.id}` : 'memory';
      const citation = snapshot.citations?.[0]?.source ? ` Citation: ${snapshot.citations[0].source}.` : '';
      snapshotLines.push(`- ${snapshot.valid_at || 'unknown time'} ${marker} ${snapshot.snapshot_type} for ${scope}: ${clip(snapshot.title, 120)} - ${clip(snapshot.body, snapshotBodyMax)} Source: memory_events:${snapshot.event_id}.${citation}`);
    }
  }
  if (snapshotLines.length) sections.push({ title: '### Snapshots / official views', lines: snapshotLines });

  const conflictLines = [];
  if (conflicts?.length) {
    for (const conflict of conflicts.slice(0, 8)) {
      const scope = conflict.scope?.type && conflict.scope?.id ? `${conflict.scope.type}/${conflict.scope.id}` : 'memory';
      conflictLines.push(`- ${conflict.valid_at || 'unknown time'} ${conflict.status} ${conflict.conflict_type} for ${scope}: ${clip(conflict.summary, conflictMax)} Source: ${conflict.source}.`);
    }
  }
  if (conflictLines.length) sections.push({ title: '### Conflicts / uncertainty', lines: conflictLines });

  const decisions = [];
  for (const w of workbenches || []) {
    for (const decision of w.openDecisions || []) decisions.push(`- ${w.title}: ${clip(decision)} Source: ${w.decisionSource || w.source}.`);
    for (const question of w.unresolvedQuestions || []) decisions.push(`- Open question in ${w.title}: ${clip(question)} Source: ${w.decisionSource || w.source}.`);
  }
  const chronology = [];
  for (const ev of eventLedger || []) {
    if (ev.event_type === 'snapshot.inferred') continue;
    chronology.push(`- ${ev.valid_at || 'unknown time'} ${ev.event_type} ${ev.stream_type}/${ev.stream_id}#${ev.stream_sequence || '?'} by ${ev.actor || 'unknown'}. Source: memory_events:${ev.event_id}.`);
  }
  for (const ev of stageEvents || []) {
    chronology.push(`- ${ev.timestamp || 'unknown time'} ${ev.storyId} ${ev.stage}/${ev.event} by ${ev.agent || 'unknown'}. Source: ${ev.source}.`);
  }
  for (const ev of timelineEvents || []) {
    chronology.push(`- ${ev.timestamp || 'unknown time'} ${ev.eventType}: ${clip(ev.summary)} Source: ${ev.source}.`);
  }
  chronology.sort((a, b) => b.localeCompare(a));
  if (chronology.length) sections.push({ title: '### Chronology / evolution', lines: chronology.slice(0, 12) });

  if (decisions.length) sections.push({ title: '### Decisions / open loops', lines: decisions.slice(0, 8) });

  const projectionLines = [];
  if (projectionWatermarks?.length) {
    for (const run of projectionWatermarks.slice(0, 5)) {
      projectionLines.push(`- ${run.generated_at || 'unknown time'} ${run.projection_name} for ${run.target_type}/${run.target_id}; events ${run.source_event_from || 'start'}..${run.source_event_to || 'latest'}; hash ${String(run.source_set_hash || '').slice(0, 12)}. Source: memory_projection_runs.`);
    }
  }
  if (projectionLines.length) sections.push({ title: '### Projection watermarks', lines: projectionLines });

  return renderBudgetedSections(headerLines, sections, maxChars);
}

export async function buildMemoryContextPacket({
  db = null,
  query = '',
  topic = null,
  entities = [],
  repoRoot = REPO_ROOT,
  storiesDir = PIPELINE_STORIES_DIR,
  tier = '',
  maxChars = null,
  asOf = '',
  literal = null,
  includeSynthesis = false,
} = {}) {
  if (!shouldInjectMemoryContext(query, { topic }) && !normalizeEntityTargets(entities).length) return '';
  const literalMode = resolveMemoryContextLiteralMode({ literal, includeSynthesis });
  const explicitRecall = hasMemoryIntent(query);
  const profile = memoryTierFor(tier, explicitRecall);
  const effectiveMaxChars = Math.max(1, Number(maxChars || profile.maxChars || MEMORY_CONTEXT_DEFAULT_CHAR_BUDGET));
  const targets = normalizeTargetRefs({ topic, entities });
  const normalizedAsOf = normalizeTime(asOf);
  const workbenches = literalMode
    ? []
    : collectWorkbenches(db, { topic, entities, targets, repoRoot, limit: profile.workbenches, asOf: normalizedAsOf });
  const eventLedger = collectEventLedger(db, { topic, entities, targets, explicitRecall, limit: profile.eventLedger, asOf: normalizedAsOf })
    .filter((event) => !literalMode || !isGeneratedMemoryEvent(event));
  const projectionWatermarks = literalMode
    ? []
    : mergeProjectionWatermarks([
        ...collectProjectionWatermarks(db, { topic, entities, targets, explicitRecall, limit: profile.projectionWatermarks, asOf: normalizedAsOf }),
        ...collectWorkbenchProjectionWatermarks(db, workbenches, { limit: profile.projectionWatermarks, asOf: normalizedAsOf }),
      ], profile.projectionWatermarks);
  const snapshots = collectSnapshots(db, { topic, entities, targets, explicitRecall, limit: profile.snapshots, asOf: normalizedAsOf })
    .filter((snapshot) => !literalMode || isLiteralSnapshot(snapshot));
  const conflicts = collectConflicts(db, { topic, entities, targets, explicitRecall, limit: profile.conflicts, asOf: normalizedAsOf });
  if (!explicitRecall && !workbenches.length && !eventLedger.length && !projectionWatermarks.length && !snapshots.length && !conflicts.length) return '';

  const [memory, stageEvents, timelineEvents] = explicitRecall
    ? await Promise.all([
        literalMode
          ? Promise.resolve({ chain: null, entries: [] })
          : collectMemoryEntries({ limit: profile.memoryEntries, asOf: normalizedAsOf }),
        Promise.resolve(collectStageEvents({ storiesDir, limit: profile.stageEvents, asOf: normalizedAsOf })),
        literalMode
          ? Promise.resolve([])
          : Promise.resolve(collectTimelineEvents(db, { query, limit: profile.timelineEvents, asOf: normalizedAsOf })),
      ])
    : [{ chain: null, entries: [] }, [], []];

  if (!memory.entries.length && !workbenches.length && !stageEvents.length && !timelineEvents.length && !eventLedger.length && !projectionWatermarks.length && !snapshots.length && !conflicts.length) return '';
  return renderPacket({
    memory,
    workbenches,
    stageEvents,
    timelineEvents,
    eventLedger,
    projectionWatermarks,
    snapshots,
    conflicts,
    literalMode,
    tierName: profile.name,
    asOf: normalizedAsOf,
    maxChars: effectiveMaxChars,
  });
}
