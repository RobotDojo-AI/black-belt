/**
 * Reasoned log sessions: Decision, Why, next steps.
 *
 * Deterministic seed creates the workbench and never invents facts.
 * This module writes the intelligence layer — the timeline of the owner's
 * thinking, decisions, and next steps — from those sources only.
 *
 * Model: grok-4.3 (balanced / Sonnet-class). Not a reasoning model.
 * Architecture: every topic and every non-noise entity gets a reasoned log.
 * Cost is not a design constraint. A spend ceiling may stop a test run.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getModel } from './config.js';
import { llmCreate } from './llm-gateway.js';
import { SpendLimitError } from './spend-guard.js';
import { REPO_ROOT } from './robotdojo-paths.js';
import {
  isPlaceholderLogSession,
  isScaffoldProjection,
  latestLogSession,
  readLogFile,
  splitLogSessions,
} from './workbench-log.js';
import {
  ensureDefaultEntityWorkbench,
  ensureDefaultTopicWorkbench,
  primaryWorkbenchForTarget,
} from './workbenches.js';
import { listLogSeedTargets } from './workbench-log-seed.js';
import { subjectKey } from './topic-live-thread.js';

export function logReasonModelId() {
  return getModel('xai', 'balanced');
}

const TEMPLATE_RE = /Append-only operational memory|Deep workbench-level distillation|Default topic workbench created|Registered workbench substrate is ready to resume/i;

function clip(text, max = 1800) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max).trimEnd()}\n…`;
}

function readNamed(rootAbs, name, max = 1800) {
  const abs = join(rootAbs, name);
  if (!existsSync(abs)) return '';
  try {
    const body = readFileSync(abs, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim();
    if (!body || TEMPLATE_RE.test(body) || isScaffoldProjection(body)) return '';
    return clip(body, max);
  } catch {
    return '';
  }
}

function interactionLines(db, personId) {
  try {
    const rows = db.prepare(`
      SELECT channel, direction, COUNT(*) n, MAX(date) last
        FROM person_interactions
       WHERE person_id = ?
       GROUP BY channel, direction
       ORDER BY n DESC
    `).all(personId);
    return rows.map((r) => {
      const last = r.last ? String(r.last).slice(0, 10) : '';
      const verb = [r.direction, r.channel].filter(Boolean).join(' ');
      return `- ${r.n} ${verb}${last ? `, last ${last}` : ''}`;
    });
  } catch {
    return [];
  }
}

function formatConvoLine(r) {
  const text = String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  const day = String(r.msg_at || r.created_at || '').slice(0, 10);
  return `- ${day} (${r.role}) ${text}`;
}

function conversationLines(db, target) {
  try {
    let rows = [];
    if (target?.type === 'person') {
      const personKey = `person:${target.id}`;
      rows = db.prepare(`
        SELECT c.id, c.title, c.created_at, m.role, m.content,
               COALESCE(m.created_at, c.created_at) AS msg_at
          FROM conversations c
          JOIN messages m ON m.conversation_id = c.id
         WHERE c.deleted_at IS NULL
           AND c.chat_type = 'chat'
           AND COALESCE(c.topic_slug, '') != 'uncategorized'
           AND (
             c.topic_slug = ?
             OR c.id IN (
               SELECT ch.source_id
                 FROM chunk_entities ce
                 JOIN chunks ch ON ch.id = ce.chunk_id
                WHERE ce.entity_type = 'person' AND ce.entity_id = ?
                  AND ch.source_type IN ('llm_export', 'conversation')
             )
           )
         ORDER BY c.created_at DESC, m.seq ASC
         LIMIT 80
      `).all(personKey, target.id);
    } else {
      const slug = target?.id || target;
      if (!slug || slug === 'uncategorized') return [];
      rows = db.prepare(`
        SELECT c.id, c.title, c.created_at, m.role, m.content,
               COALESCE(m.created_at, c.created_at) AS msg_at
          FROM conversations c
          JOIN messages m ON m.conversation_id = c.id
         WHERE c.topic_slug = ?
           AND c.deleted_at IS NULL
           AND c.chat_type = 'chat'
           AND COALESCE(c.topic_slug, '') != 'uncategorized'
         ORDER BY c.created_at DESC, m.seq ASC
         LIMIT 80
      `).all(slug);
    }
    return rows.map(formatConvoLine).filter((line) => !line.includes('<task-notification>'));
  } catch {
    return [];
  }
}

export function listHistoricalImportConversations(db, target, { limit = 40 } = {}) {
  try {
    if (target?.type === 'person') {
      const personKey = `person:${target.id}`;
      return db.prepare(`
        SELECT DISTINCT c.id, c.title, c.created_at, c.topic_slug, c.file_path
          FROM conversations c
         WHERE c.deleted_at IS NULL
           AND c.chat_type = 'chat'
           AND COALESCE(c.topic_slug, '') != 'uncategorized'
           AND (
             c.topic_slug = ?
             OR c.id IN (
               SELECT ch.source_id
                 FROM chunk_entities ce
                 JOIN chunks ch ON ch.id = ce.chunk_id
                WHERE ce.entity_type = 'person' AND ce.entity_id = ?
                  AND ch.source_type IN ('llm_export', 'conversation')
             )
           )
         ORDER BY c.created_at ASC
         LIMIT ?
      `).all(personKey, target.id, limit);
    }
    const slug = target?.id;
    if (!slug || slug === 'uncategorized') return [];
    return db.prepare(`
      SELECT id, title, created_at, topic_slug, file_path
        FROM conversations
       WHERE topic_slug = ?
         AND deleted_at IS NULL
         AND chat_type = 'chat'
         AND COALESCE(topic_slug, '') != 'uncategorized'
       ORDER BY created_at ASC
       LIMIT ?
    `).all(slug, limit);
  } catch {
    return [];
  }
}

function entityFactLines(db, target) {
  try {
    if (target.type === 'person') {
      const row = db.prepare(`
        SELECT display_name, last_seen, interaction_count
          FROM people WHERE id = ?
      `).get(target.id);
      if (!row) return [];
      return [
        row.display_name && `Name: ${row.display_name}`,
        row.last_seen && `Last seen: ${String(row.last_seen).slice(0, 10)}`,
        row.interaction_count != null && `Interactions: ${row.interaction_count}`,
      ].filter(Boolean);
    }
    if (target.type === 'company') {
      const row = db.prepare(`
        SELECT name, people_count
          FROM companies WHERE id = ?
      `).get(target.id);
      if (!row) return [];
      return [
        row.name && `Name: ${row.name}`,
        row.people_count != null && `People: ${row.people_count}`,
      ].filter(Boolean);
    }
    if (target.type === 'place') {
      const row = db.prepare(`
        SELECT name, years_lived, last_seen, total_visits
          FROM places WHERE CAST(id AS TEXT) = ?
      `).get(String(target.id));
      if (!row) return [];
      return [
        row.name && `Name: ${row.name}`,
        row.years_lived != null && Number(row.years_lived) > 0 && `Years lived: ${row.years_lived}`,
        row.total_visits != null && `Visits: ${row.total_visits}`,
        row.last_seen && `Last seen: ${String(row.last_seen).slice(0, 10)}`,
      ].filter(Boolean);
    }
  } catch {
    /* schema variance */
  }
  return [];
}

function ensureWorkbench(db, target, repoRoot) {
  if (target.type === 'topic') {
    return ensureDefaultTopicWorkbench(db, target.id, { repoRoot });
  }
  return ensureDefaultEntityWorkbench(db, target.type, target.id, { repoRoot });
}

export function collectLogSources(db, target, repoRoot = REPO_ROOT) {
  const wb = primaryWorkbenchForTarget(db, target.type, target.id)
    || ensureWorkbench(db, target, repoRoot);
  const rootPath = wb?.root_path || '';
  const rootAbs = rootPath ? resolve(repoRoot, rootPath) : '';
  const key = subjectKey(target.type, target.id);
  const citations = [];
  const blocks = [];

  if (rootPath) citations.push(`- workbench ${rootPath}`);

  const index = rootAbs ? readNamed(rootAbs, 'INDEX.md') : '';
  if (index) {
    citations.push(`- ${rootPath}/INDEX.md`);
    blocks.push(`INDEX.md\n${index}`);
  }
  const synthesis = rootAbs ? readNamed(rootAbs, 'SYNTHESIS.md') : '';
  if (synthesis) {
    citations.push(`- ${rootPath}/SYNTHESIS.md`);
    blocks.push(`SYNTHESIS.md\n${synthesis}`);
  }
  const status = rootAbs ? readNamed(rootAbs, 'SESSION-STATUS.md', 800) : '';
  if (status) {
    citations.push(`- ${rootPath}/SESSION-STATUS.md`);
    blocks.push(`SESSION-STATUS.md\n${status}`);
  }

  const sessions = rootPath ? splitLogSessions(readLogFile(rootPath, repoRoot)) : [];
  const realSessions = sessions.filter((s) => !isPlaceholderLogSession(s));
  if (realSessions.length) {
    citations.push(`- ${rootPath}/LOG.md (${realSessions.length} sessions)`);
    const recent = realSessions.slice(-6).map((s) => {
      const head = [s.date, s.title].filter(Boolean).join(' — ');
      const body = [s.decision && `Decision: ${s.decision}`, s.why && `Why: ${s.why}`, s.next && `Next: ${s.next}`]
        .filter(Boolean).join('\n');
      return clip(`${head}\n${body}`, 900);
    });
    blocks.push(`Existing log sessions\n${recent.join('\n\n')}`);
  }

  const facts = entityFactLines(db, target);
  const materialFacts = facts.filter((line) => !/^Name:/.test(line) && !/^Interactions: 0$/.test(line));
  if (facts.length) {
    citations.push(`- ${target.type} record ${target.id}`);
    blocks.push(`Recorded facts\n${facts.join('\n')}`);
  }

  const interactions = target.type === 'person' ? interactionLines(db, target.id) : [];
  if (interactions.length) {
    citations.push(`- person_interactions ${target.id}`);
    blocks.push(`Interactions\n${interactions.join('\n')}`);
  }

  const convos = conversationLines(db, target);
  if (convos.length) {
    citations.push(`- conversations ${key}`);
    blocks.push(`Conversation excerpts\n${convos.join('\n')}`);
  }

  const last = latestLogSession(sessions);
  // Facts and interaction counts are timeline, not a Decision. Reason only when
  // there is a last conversation, a real log session, or live INDEX/SYNTHESIS.
  const hasReasonableMaterial = Boolean(
    realSessions.length
    || index
    || synthesis
    || status
    || convos.length,
  );

  return {
    target,
    workbench: wb,
    rootPath,
    key,
    citations,
    packed: blocks.join('\n\n---\n\n'),
    hasReasonableMaterial,
    alreadyReasoned: Boolean(last && !isPlaceholderLogSession(last)),
    last,
  };
}

function parseReasonedJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const SYSTEM = `You write the current state of a personal workbench log.

Return JSON only:
{"decision":"...","why":"...","next":["..."]}

Rules:
- Use only the sources in the user message. Do not invent names, dates, numbers, diagnoses, or decisions.
- decision: 2–5 sentences a principal would read. Current state and what is decided. Prose, not a transcript, not a bullet dump of sources, not a paste of emails or log headings. If the sources include conversation excerpts, that thread is last known state — compress it. Empty string only when there is no conversation and no prior decision.
- why: one or two sentences of reasons present in the sources. Empty string if none.
- next: at most three next steps present in the sources. Empty array if none.
- Do not copy a topic description or a context card as the decision.
- Do not include citations.`;

async function callReasoner(sources, model) {
  const resp = await llmCreate({
    model,
    max_tokens: 700,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Subject: ${sources.target.type} ${sources.target.label || sources.target.id}\n\nSources:\n${sources.packed || '(none)'}`,
    }],
  }, 'workbench-log-reason');
  const text = resp?.content?.[0]?.text || resp?.content || '';
  return parseReasonedJson(text);
}

function formatNext(next) {
  if (Array.isArray(next)) {
    return next.map((line) => String(line || '').replace(/^[-*]\s*/, '').trim()).filter(Boolean)
      .map((line) => `- ${line}`);
  }
  return String(next || '').split('\n').map((line) => line.replace(/^[-*]\s*/, '').trim()).filter(Boolean)
    .map((line) => `- ${line}`);
}

function appendReasonedSession(rootPath, { title, decision, why, next, citations, date: dateOpt }, repoRoot = REPO_ROOT) {
  const abs = join(repoRoot, rootPath, 'LOG.md');
  if (!existsSync(abs)) return false;
  const date = String(dateOpt || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const nextLines = formatNext(next);
  const citeLines = (citations || []).filter(Boolean);
  const block = [
    '',
    `## Work session ${date}`,
    '',
    `# ${title}`,
    '',
    '## Decision',
    decision,
    '',
    why ? `## Why\n${why}\n` : '',
    citeLines.length ? `## Citations\n${citeLines.join('\n')}\n` : '',
    nextLines.length ? `## Next-session anchors\n${nextLines.join('\n')}\n` : '',
  ].filter((line) => line !== '').join('\n');
  appendFileSync(abs, block.endsWith('\n') ? block : `${block}\n`);
  return true;
}

export async function reasonOneLog(db, target, { repoRoot = REPO_ROOT, reasoner = null, model = null, force = false } = {}) {
  const sources = collectLogSources(db, target, repoRoot);
  if (!sources.workbench?.root_path) return { reasoned: false, reason: 'no_workbench' };
  if (sources.alreadyReasoned && !force) return { reasoned: false, reason: 'already_reasoned', id: sources.workbench.id };
  if (!sources.hasReasonableMaterial) return { reasoned: false, reason: 'no_material', id: sources.workbench.id };

  const parsed = reasoner
    ? await reasoner(sources)
    : await callReasoner(sources, model || logReasonModelId());
  const decision = String(parsed?.decision || '').trim();
  if (!decision || isScaffoldProjection(decision)) {
    return { reasoned: false, reason: 'no_decision_in_sources', id: sources.workbench.id };
  }
  const why = String(parsed?.why || '').trim();
  const next = parsed?.next || [];
  const wrote = appendReasonedSession(sources.rootPath, {
    title: target.label || target.id,
    decision,
    why,
    next,
    citations: sources.citations,
  }, repoRoot);
  return { reasoned: wrote, id: sources.workbench.id, reason: wrote ? 'ok' : 'write_failed' };
}

export async function reasonHistoricalImportLogs(db, target, {
  repoRoot = REPO_ROOT,
  reasoner = null,
  model = null,
  maxSessions = 20,
} = {}) {
  const base = collectLogSources(db, target, repoRoot);
  if (!base.workbench?.root_path) return { reasoned: 0, skipped: 0, reason: 'no_workbench' };
  const logText = readLogFile(base.rootPath, repoRoot);
  const convos = listHistoricalImportConversations(db, target, { limit: Math.max(1, maxSessions) * 3 });
  let reasoned = 0;
  let skipped = 0;
  const msgStmt = db.prepare(`
    SELECT role, content, created_at FROM messages
     WHERE conversation_id = ? ORDER BY seq LIMIT 12
  `);
  for (const conv of convos) {
    if (reasoned >= maxSessions) break;
    if (logText.includes(conv.id)) { skipped += 1; continue; }
    if (!conv.topic_slug || conv.topic_slug === 'uncategorized') { skipped += 1; continue; }
    const excerpt = msgStmt.all(conv.id).map((r) => {
      const text = String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 280);
      return `- ${String(r.created_at || conv.created_at || '').slice(0, 10)} (${r.role}) ${text}`;
    }).join('\n');
    if (!excerpt.trim()) { skipped += 1; continue; }
    const packed = {
      ...base,
      citations: [`- conversation ${conv.id}`, ...(base.citations || [])],
      packed: `Imported conversation ${conv.created_at || ''}\nTitle: ${conv.title || ''}\n${excerpt}`,
    };
    const parsed = reasoner
      ? await reasoner(packed)
      : await callReasoner(packed, model || logReasonModelId());
    const decision = String(parsed?.decision || '').trim();
    if (!decision || isScaffoldProjection(decision)) { skipped += 1; continue; }
    const wrote = appendReasonedSession(base.rootPath, {
      title: conv.title || target.label || target.id,
      decision,
      why: String(parsed?.why || '').trim(),
      next: parsed?.next || [],
      citations: packed.citations,
      date: String(conv.created_at || '').slice(0, 10),
    }, repoRoot);
    if (wrote) reasoned += 1;
    else skipped += 1;
  }
  return { reasoned, skipped, id: base.workbench.id };
}

function isSpendTierPerson(target) {
  const p = String(target.personalTier || '');
  const b = String(target.businessTier || '');
  return p === 'core' || p === 'network' || b === 'core' || b === 'network';
}

export function listLogReasonTargets(db) {
  const targets = listLogSeedTargets(db);
  const topics = targets.filter((t) => t.type === 'topic');
  const people = targets.filter((t) => t.type === 'person' && isSpendTierPerson(t))
    .sort((a, b) => {
      const ra = a.rank == null ? 9999 : Number(a.rank);
      const rb = b.rank == null ? 9999 : Number(b.rank);
      return ra - rb;
    });
  return [...topics, ...people];
}

export async function reasonWorldLogs(db, {
  maxReasons = 20,
  repoRoot = REPO_ROOT,
  reasoner = null,
  model = null,
  shouldStop = null,
} = {}) {
  const cap = Math.max(1, Math.min(Number(maxReasons) || 20, 5000));
  const targets = listLogReasonTargets(db);
  let reasoned = 0;
  let skipped = 0;
  let scanned = 0;
  let stopped = null;
  for (const target of targets) {
    if (reasoned >= cap) break;
    if (typeof shouldStop === 'function' && shouldStop()) {
      stopped = 'idle';
      break;
    }
    scanned += 1;
    try {
      const result = await reasonOneLog(db, target, { repoRoot, reasoner, model });
      if (result.reasoned) reasoned += 1;
      else skipped += 1;
    } catch (err) {
      if (err instanceof SpendLimitError || err?.name === 'SpendLimitError') {
        stopped = 'spend_limit';
        break;
      }
      const status = Number(err?.status) || 0;
      if (status === 401 || status === 403 || /credits|spending limit|HTTP 403|HTTP 401/i.test(String(err?.message || ''))) {
        stopped = 'provider_error';
        break;
      }
      skipped += 1;
    }
  }
  return {
    scanned,
    reasoned,
    skipped,
    stopped,
    remaining: Math.max(0, targets.length - scanned),
    total: targets.length,
  };
}
