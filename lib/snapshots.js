// lib/snapshots.js - dated official and inferred views over memory_events.
//
// Snapshots are not mutable notes. They are immutable memory events that mark
// what the system believed the user's view was at a point in time. Official
// snapshots come from explicit user/agent instruction; inferred snapshots come
// from reconstruction and remain marked inferred until superseded or promoted.

import crypto from 'node:crypto';
import {
  appendMemoryEvent,
  ensureMemoryEventsSchema,
  stableJson,
} from './memory-events.js';

export const SNAPSHOT_EVENT_TYPES = [
  'snapshot.created',
  'snapshot.inferred',
  'snapshot.promoted',
];

export const MEMORY_CONFLICT_EVENT_TYPES = [
  'memory.conflict.detected',
  'memory.conflict.resolved',
];

const SNAPSHOT_INFERABLE_EVENT_TYPES = [
  'workbench.synthesis.generated',
  'workbench.source.captured',
  'topic.identity.seeded',
  'topic.context.updated',
  'session.bookmark',
];

const SNAPSHOT_CUE_RE = /\b(snapshot|official view|current thesis|hypothesis|framework|decision|decided|belief|view changed|we now think|i now think|my view)\b/i;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function clip(text, max = 1000) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function firstUsefulLine(text, max = 520) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^[-*#>\s]+/, '').trim();
    if (/^(summary|current thesis|current question|latest state|latest thinking \/ decisions|next action|open questions? \/ next steps|open decisions?|unresolved questions?|evolution timeline|source watermark)$/i.test(line)) continue;
    if (line) return clip(line, max);
  }
  return '';
}

function normalizedBody(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isoNow() {
  return new Date().toISOString();
}

function requireText(value, name) {
  const out = String(value || '').trim();
  if (!out) throw new Error(`snapshot: ${name} is required`);
  return out;
}

function normalizeTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return isoNow();
  const d = new Date(raw.includes('T') || raw.length === 10 ? raw : raw.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

function normalizeScope(args = {}) {
  const scope = args.scope || {};
  const scopeType = requireText(
    args.scopeType || args.scope_type || scope.type || args.targetType || args.target_type,
    'scopeType',
  );
  const scopeId = requireText(
    args.scopeId || args.scope_id || scope.id || args.targetId || args.target_id,
    'scopeId',
  );
  return { scopeType, scopeId };
}

function normalizeLinks(scopeType, scopeId, links = []) {
  const out = [{ targetType: scopeType, targetId: scopeId, role: 'snapshot_scope' }];
  for (const link of links || []) {
    const targetType = link.targetType || link.target_type;
    const targetId = link.targetId || link.target_id;
    if (!targetType || !targetId) continue;
    out.push({
      targetType: String(targetType),
      targetId: String(targetId),
      role: String(link.role || 'related'),
    });
  }
  const seen = new Set();
  return out.filter((link) => {
    const key = `${link.targetType}\0${link.targetId}\0${link.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeCitations(citations = []) {
  return (citations || [])
    .map((citation) => {
      if (typeof citation === 'string') return { source: citation };
      if (!citation || typeof citation !== 'object') return null;
      const source = citation.source || citation.ref || citation.path || citation.eventId || citation.event_id || '';
      if (!source) return null;
      return {
        source: String(source),
        label: citation.label ? String(citation.label) : undefined,
        event_id: citation.eventId || citation.event_id || undefined,
      };
    })
    .filter(Boolean);
}

function normalizeSupersedes(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value) return [String(value)];
  return [];
}

function snapshotIdFor(payload) {
  return `snap_${sha256(stableJson(payload)).slice(0, 20)}`;
}

function parsePayload(row) {
  try { return JSON.parse(row?.payload_json || '{}'); } catch { return {}; }
}

function rowToEvent(row) {
  if (!row) return null;
  return { ...row, payload: parsePayload(row) };
}

export function eventToSnapshot(event) {
  if (!event) return null;
  const payload = event.payload || parsePayload(event);
  const inferred = Boolean(payload.inferred || event.event_type === 'snapshot.inferred');
  const scope = payload.scope || {
    type: event.subject_type || null,
    id: event.subject_id || null,
  };
  return {
    event_id: event.event_id,
    global_sequence: event.global_sequence,
    snapshot_id: payload.snapshot_id || event.stream_id,
    title: payload.title || 'Untitled snapshot',
    body: payload.body || payload.summary || '',
    snapshot_type: payload.snapshot_type || 'view',
    status: payload.status || 'active',
    inferred,
    official: !inferred,
    confidence: Number(payload.confidence ?? (inferred ? 0.55 : 0.95)),
    source_kind: payload.source_kind || (inferred ? 'retroactive_reconstruction' : 'user_countersigned'),
    valid_at: event.valid_at,
    recorded_at: event.recorded_at,
    scope,
    supersedes: payload.supersedes || [],
    citations: normalizeCitations(payload.citations || []),
    payload,
  };
}

function applySupersession(snapshots) {
  const superseded = new Set();
  for (const snapshot of snapshots || []) {
    for (const id of snapshot.supersedes || []) {
      if (id) superseded.add(String(id));
    }
  }
  return (snapshots || []).map((snapshot) => ({
    ...snapshot,
    status: snapshot.status === 'active' && superseded.has(snapshot.snapshot_id)
      ? 'superseded'
      : snapshot.status,
  }));
}

export function createSnapshot(db, args = {}) {
  ensureMemoryEventsSchema(db);
  const { scopeType, scopeId } = normalizeScope(args);
  const title = requireText(args.title, 'title');
  const body = requireText(args.body || args.summary || args.markdown, 'body');
  const validAt = normalizeTime(args.validAt || args.valid_at || args.asOf || args.as_of || args.effectiveAt);
  const inferred = Boolean(args.inferred);
  const snapshotType = String(args.snapshotType || args.snapshot_type || 'view');
  const sourceKind = String(args.sourceKind || args.source_kind || (inferred ? 'retroactive_reconstruction' : 'user_countersigned'));
  const confidence = Number(args.confidence ?? (inferred ? 0.55 : 0.95));
  const supersedes = normalizeSupersedes(args.supersedes);
  const citations = normalizeCitations(args.citations || []);
  const basePayload = {
    scope: { type: scopeType, id: scopeId },
    title,
    body,
    snapshot_type: snapshotType,
    status: String(args.status || 'active'),
    inferred,
    confidence,
    source_kind: sourceKind,
    valid_at: validAt,
    supersedes,
    citations,
  };
  const snapshotId = String(args.snapshotId || args.snapshot_id || snapshotIdFor(basePayload));
  const payload = {
    ...basePayload,
    snapshot_id: snapshotId,
  };
  const eventType = String(args.eventType || args.event_type || (inferred ? 'snapshot.inferred' : 'snapshot.created'));
  const result = appendMemoryEvent(db, {
    streamType: 'snapshot',
    streamId: `${scopeType}:${scopeId}`,
    eventType,
    actor: args.actor || (inferred ? 'memory-reconstruction' : 'user'),
    source: args.source || (inferred ? 'snapshot:reconstruction' : 'snapshot:user'),
    subjectType: scopeType,
    subjectId: scopeId,
    validAt,
    recordedAt: args.recordedAt || args.recorded_at || isoNow(),
    causationId: args.causationId || args.causation_id || null,
    correlationId: args.correlationId || args.correlation_id || null,
    idempotencyKey: args.idempotencyKey || args.idempotency_key || `${eventType}:${snapshotId}`,
    payload,
    links: normalizeLinks(scopeType, scopeId, args.links),
  });
  if (result.inserted && !inferred) {
    recordSnapshotConflictsForNewSnapshot(db, eventToSnapshot(result.event));
  }
  return {
    inserted: result.inserted,
    event: result.event,
    snapshot: eventToSnapshot(result.event),
  };
}

export function promoteSnapshot(db, args = {}) {
  const original = findSnapshot(db, args);
  if (!original) throw new Error('snapshot: snapshot to promote not found');
  const extraSupersedes = normalizeSupersedes(args.supersedes);
  return createSnapshot(db, {
    scopeType: original.scope?.type,
    scopeId: original.scope?.id,
    title: args.title || original.title,
    body: args.body || original.body,
    snapshotType: args.snapshotType || args.snapshot_type || original.snapshot_type,
    validAt: args.validAt || args.valid_at || args.asOf || args.as_of || isoNow(),
    inferred: false,
    eventType: 'snapshot.promoted',
    sourceKind: args.sourceKind || args.source_kind || 'user_countersigned',
    actor: args.actor || 'agent',
    source: args.source || 'snapshot:promotion',
    supersedes: [original.snapshot_id, ...extraSupersedes],
    citations: [
      { source: `memory_events:${original.event_id}`, event_id: original.event_id, label: 'promoted_snapshot' },
      ...(original.citations || []),
      ...(args.citations || []),
    ],
    idempotencyKey: args.idempotencyKey || args.idempotency_key || `snapshot-promoted:${original.event_id}:${sha256(stableJson({
      title: args.title || original.title,
      body: args.body || original.body,
    }))}`,
    links: eventLinks(db, original.event_id),
  });
}

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

export function listSnapshots(db, filters = {}) {
  ensureMemoryEventsSchema(db);
  if (!hasTable(db, 'memory_events')) return [];
  const scopeType = filters.scopeType || filters.scope_type || filters.targetType || filters.target_type || null;
  const scopeId = filters.scopeId || filters.scope_id || filters.targetId || filters.target_id || null;
  const clauses = [`e.event_type IN (${SNAPSHOT_EVENT_TYPES.map((_, i) => `@type${i}`).join(', ')})`];
  const params = {};
  SNAPSHOT_EVENT_TYPES.forEach((type, i) => { params[`type${i}`] = type; });
  let join = '';
  if (scopeType || scopeId) {
    join = 'JOIN memory_event_links l ON l.event_id = e.event_id';
    if (scopeType) {
      clauses.push('l.target_type = @scopeType');
      params.scopeType = String(scopeType);
    }
    if (scopeId) {
      clauses.push('l.target_id = @scopeId');
      params.scopeId = String(scopeId);
    }
  }
  if (filters.asOf || filters.as_of) {
    clauses.push('e.valid_at <= @asOf');
    params.asOf = normalizeTime(filters.asOf || filters.as_of);
  }
  if (filters.inferred === true) {
    clauses.push("e.event_type = 'snapshot.inferred'");
  } else if (filters.inferred === false || filters.official === true) {
    clauses.push("e.event_type != 'snapshot.inferred'");
  }
  params.limit = Math.max(1, Math.min(Number(filters.limit || 20), 2000));
  const rows = db.prepare(`
    SELECT DISTINCT e.*
    FROM memory_events e
    ${join}
    WHERE ${clauses.join(' AND ')}
    ORDER BY e.valid_at DESC, e.global_sequence DESC
    LIMIT @limit
  `).all(params);
  const snapshots = applySupersession(rows.map(rowToEvent).map(eventToSnapshot).filter(Boolean));
  return filters.activeOnly
    ? snapshots.filter((snapshot) => snapshot.status === 'active')
    : snapshots;
}

function findSnapshot(db, args = {}) {
  const eventId = args.eventId || args.event_id || null;
  const snapshotId = args.snapshotId || args.snapshot_id || args.id || null;
  if (eventId && hasTable(db, 'memory_events')) {
    const row = db.prepare(`
      SELECT *
      FROM memory_events
      WHERE event_id = ?
        AND event_type IN (${SNAPSHOT_EVENT_TYPES.map(() => '?').join(', ')})
      LIMIT 1
    `).get(eventId, ...SNAPSHOT_EVENT_TYPES);
    const snapshot = eventToSnapshot(rowToEvent(row));
    if (snapshot) return snapshot;
  }
  const snapshots = listSnapshots(db, { limit: 2000 });
  return snapshots.find((snapshot) => (
    (eventId && snapshot.event_id === eventId)
    || (snapshotId && snapshot.snapshot_id === snapshotId)
  )) || null;
}

function recordMemoryConflict(db, args = {}) {
  const scopeType = requireText(args.scopeType || args.scope_type, 'scopeType');
  const scopeId = requireText(args.scopeId || args.scope_id, 'scopeId');
  const conflictType = String(args.conflictType || args.conflict_type || 'memory_disagreement');
  const validAt = normalizeTime(args.validAt || args.valid_at || isoNow());
  const payload = {
    conflict_type: conflictType,
    status: String(args.status || 'unresolved'),
    summary: clip(args.summary || '', 520),
    confidence: Number(args.confidence ?? 0.75),
    candidates: args.candidates || [],
    resolution: args.resolution || null,
  };
  return appendMemoryEvent(db, {
    streamType: 'memory_conflict',
    streamId: `${scopeType}:${scopeId}`,
    eventType: args.eventType || args.event_type || 'memory.conflict.detected',
    actor: args.actor || 'memory-reconstruction',
    source: args.source || 'memory:conflict-detector',
    subjectType: scopeType,
    subjectId: scopeId,
    validAt,
    idempotencyKey: args.idempotencyKey || args.idempotency_key || `memory-conflict:${conflictType}:${sha256(stableJson(payload))}`,
    payload,
    links: [
      { targetType: scopeType, targetId: scopeId, role: 'conflict_scope' },
      ...(args.links || []),
    ],
  });
}

function recordSnapshotConflictsForNewSnapshot(db, snapshot) {
  if (!snapshot || snapshot.inferred) return [];
  const supersedes = new Set((snapshot.supersedes || []).map(String));
  const peers = listSnapshots(db, {
    targetType: snapshot.scope?.type,
    targetId: snapshot.scope?.id,
    official: true,
    activeOnly: true,
    limit: 50,
  }).filter((peer) => (
    peer.event_id !== snapshot.event_id
    && peer.snapshot_type === snapshot.snapshot_type
    && !supersedes.has(peer.snapshot_id)
    && normalizedBody(peer.body) !== normalizedBody(snapshot.body)
  ));
  return peers.slice(0, 3).map((peer) => recordMemoryConflict(db, {
    scopeType: snapshot.scope.type,
    scopeId: snapshot.scope.id,
    conflictType: 'snapshot_disagreement',
    summary: `Official Snapshot "${snapshot.title}" disagrees with earlier active Snapshot "${peer.title}".`,
    confidence: 0.82,
    validAt: snapshot.valid_at,
    candidates: [
      { snapshot_id: peer.snapshot_id, event_id: peer.event_id, title: peer.title },
      { snapshot_id: snapshot.snapshot_id, event_id: snapshot.event_id, title: snapshot.title },
    ],
    links: [
      { targetType: 'snapshot', targetId: peer.snapshot_id, role: 'candidate' },
      { targetType: 'snapshot', targetId: snapshot.snapshot_id, role: 'candidate' },
    ],
    idempotencyKey: `memory-conflict:snapshot:${peer.event_id}:${snapshot.event_id}`,
  }));
}

export function listMemoryConflicts(db, filters = {}) {
  ensureMemoryEventsSchema(db);
  if (!hasTable(db, 'memory_events')) return [];
  const targetType = filters.targetType || filters.target_type || filters.scopeType || filters.scope_type || null;
  const targetId = filters.targetId || filters.target_id || filters.scopeId || filters.scope_id || null;
  const clauses = [`e.event_type IN (${MEMORY_CONFLICT_EVENT_TYPES.map((_, i) => `@type${i}`).join(', ')})`];
  const params = {};
  MEMORY_CONFLICT_EVENT_TYPES.forEach((type, i) => { params[`type${i}`] = type; });
  let join = '';
  if (targetType || targetId) {
    join = 'JOIN memory_event_links l ON l.event_id = e.event_id';
    if (targetType) {
      clauses.push('l.target_type = @targetType');
      params.targetType = String(targetType);
    }
    if (targetId) {
      clauses.push('l.target_id = @targetId');
      params.targetId = String(targetId);
    }
  }
  if (filters.asOf || filters.as_of) {
    clauses.push('e.valid_at <= @asOf');
    params.asOf = normalizeTime(filters.asOf || filters.as_of);
  }
  params.limit = Math.max(1, Math.min(Number(filters.limit || 20), 200));
  return db.prepare(`
    SELECT DISTINCT e.*
    FROM memory_events e
    ${join}
    WHERE ${clauses.join(' AND ')}
    ORDER BY e.valid_at DESC, e.global_sequence DESC
    LIMIT @limit
  `).all(params).map(rowToEvent).map((event) => ({
    event_id: event.event_id,
    global_sequence: event.global_sequence,
    valid_at: event.valid_at,
    recorded_at: event.recorded_at,
    scope: { type: event.subject_type, id: event.subject_id },
    conflict_type: event.payload?.conflict_type || 'memory_disagreement',
    status: event.payload?.status || 'unresolved',
    summary: event.payload?.summary || '',
    confidence: Number(event.payload?.confidence ?? 0.75),
    candidates: event.payload?.candidates || [],
    source: `memory_events:${event.event_id}`,
  }));
}

function eventLinks(db, eventId) {
  try {
    return db.prepare(`
      SELECT target_type, target_id, role
      FROM memory_event_links
      WHERE event_id = ?
      ORDER BY id ASC
    `).all(eventId).map((row) => ({
      targetType: row.target_type,
      targetId: row.target_id,
      role: row.role || 'related',
    }));
  } catch {
    return [];
  }
}

function inferredBodyFromEvent(event) {
  const payload = event.payload || parsePayload(event);
  if (event.event_type === 'workbench.synthesis.generated') {
    const latest = clip(payload.latest_state || payload.summary || '', 520);
    const next = clip(payload.next_action || '', 260);
    return [
      latest ? `Latest: ${latest}` : '',
      next ? `Next: ${next}` : '',
    ].filter(Boolean).join('\n');
  }
  return clip(payload.latest_state || payload.next_action || payload.summary || payload.body || payload.title || '', 780);
}

function inferredTitleFromEvent(event) {
  if (event.event_type === 'workbench.synthesis.generated') {
    return `Inferred view from ${event.subject_type || 'memory'}/${event.subject_id || event.stream_id}`;
  }
  return `Inferred view from ${event.event_type}`;
}

export function inferSnapshotFromMemoryEvent(db, event, options = {}) {
  ensureMemoryEventsSchema(db);
  const hydrated = event?.payload ? event : rowToEvent(event);
  if (!hydrated || !hydrated.event_id) return null;
  if (!SNAPSHOT_INFERABLE_EVENT_TYPES.includes(hydrated.event_type)) return null;
  const body = inferredBodyFromEvent(hydrated);
  if (!body) return null;
  const scopeType = hydrated.subject_type || options.scopeType || 'memory';
  const scopeId = hydrated.subject_id || options.scopeId || hydrated.stream_id;
  const links = eventLinks(db, hydrated.event_id);
  return createSnapshot(db, {
    scopeType,
    scopeId,
    title: options.title || inferredTitleFromEvent(hydrated),
    body,
    snapshotType: 'view',
    inferred: true,
    confidence: Number(options.confidence ?? 0.62),
    sourceKind: options.sourceKind || 'retroactive_reconstruction',
    source: options.source || 'snapshot:reconstruction',
    actor: options.actor || 'memory-reconstruction',
    validAt: hydrated.valid_at,
    recordedAt: options.recordedAt || options.recorded_at || isoNow(),
    causationId: hydrated.event_id,
    correlationId: hydrated.correlation_id || hydrated.event_id,
    idempotencyKey: `snapshot-inferred:${hydrated.event_id}`,
    citations: [
      { source: `memory_events:${hydrated.event_id}`, event_id: hydrated.event_id },
      ...(hydrated.payload?.synthesis_path ? [{ source: hydrated.payload.synthesis_path, label: 'synthesis' }] : []),
    ],
    links,
  });
}

export function inferSnapshotsFromMemoryEvents(db, filters = {}) {
  ensureMemoryEventsSchema(db);
  const clauses = [`e.event_type IN (${SNAPSHOT_INFERABLE_EVENT_TYPES.map((_, i) => `@eventType${i}`).join(', ')})`];
  const params = {};
  SNAPSHOT_INFERABLE_EVENT_TYPES.forEach((type, i) => { params[`eventType${i}`] = type; });
  let join = '';
  const targetType = filters.targetType || filters.target_type || filters.scopeType || filters.scope_type || null;
  const targetId = filters.targetId || filters.target_id || filters.scopeId || filters.scope_id || null;
  if (targetType || targetId) {
    join = 'JOIN memory_event_links l ON l.event_id = e.event_id';
    if (targetType) {
      clauses.push('l.target_type = @targetType');
      params.targetType = String(targetType);
    }
    if (targetId) {
      clauses.push('l.target_id = @targetId');
      params.targetId = String(targetId);
    }
  }
  if (filters.asOf || filters.as_of) {
    clauses.push('e.valid_at <= @asOf');
    params.asOf = normalizeTime(filters.asOf || filters.as_of);
  }
  params.limit = Math.max(1, Math.min(Number(filters.limit || 500), 2000));
  const rows = db.prepare(`
    SELECT DISTINCT e.*
    FROM memory_events e
    ${join}
    WHERE ${clauses.join(' AND ')}
    ORDER BY e.valid_at ASC, e.global_sequence ASC
    LIMIT @limit
  `).all(params);

  const results = [];
  for (const row of rows) {
    const inferred = inferSnapshotFromMemoryEvent(db, row, filters);
    if (inferred) results.push(inferred);
  }
  return {
    ok: true,
    scanned: rows.length,
    inserted: results.filter((result) => result.inserted).length,
    existing: results.filter((result) => !result.inserted).length,
    snapshots: results.map((result) => result.snapshot).filter(Boolean),
  };
}

function topicContextSnapshotBody(content) {
  const latest = String(content || '').match(/(?:^|\n)\s*(?:##\s*)?(?:Latest State|Current Thesis|Summary)\s*\n+([\s\S]*?)(?=\n##\s+|\s*$)/i);
  if (latest) return firstUsefulLine(latest[1], 780);
  return firstUsefulLine(content, 780);
}

export function inferSnapshotsFromTopicContextHistory(db, filters = {}) {
  if (!db || !hasTable(db, 'topic_context_history')) {
    return { ok: true, scanned: 0, inserted: 0, existing: 0, snapshots: [] };
  }
  const clauses = ['content IS NOT NULL', "TRIM(content) != ''"];
  const params = {};
  const topic = filters.targetType === 'topic' || filters.scopeType === 'topic'
    ? (filters.targetId || filters.target_id || filters.scopeId || filters.scope_id)
    : (filters.topic || filters.topicSlug || filters.topic_slug || null);
  if (topic) {
    clauses.push('topic_slug = @topic');
    params.topic = String(topic);
  }
  if (filters.asOf || filters.as_of) {
    clauses.push('created_at <= @asOf');
    params.asOf = normalizeTime(filters.asOf || filters.as_of);
  }
  params.limit = Math.max(1, Math.min(Number(filters.limit || 500), 2000));
  const rows = db.prepare(`
    SELECT id, topic_slug, content, source, created_at
    FROM topic_context_history
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at ASC, id ASC
    LIMIT @limit
  `).all(params);
  const results = [];
  for (const row of rows) {
    const body = topicContextSnapshotBody(row.content);
    if (!body) continue;
    results.push(createSnapshot(db, {
      scopeType: 'topic',
      scopeId: row.topic_slug,
      title: `Inferred topic view from ${row.topic_slug}`,
      body,
      snapshotType: 'view',
      inferred: true,
      confidence: 0.58,
      sourceKind: 'retroactive_reconstruction',
      source: 'snapshot:topic-context-history',
      actor: 'memory-reconstruction',
      validAt: row.created_at || isoNow(),
      idempotencyKey: `snapshot-inferred:topic-context-history:${row.id}:${sha256(body)}`,
      citations: [{ source: `topic_context_history:${row.id}`, label: row.source || 'topic_context_history' }],
    }));
  }
  return {
    ok: true,
    scanned: rows.length,
    inserted: results.filter((result) => result.inserted).length,
    existing: results.filter((result) => !result.inserted).length,
    snapshots: results.map((result) => result.snapshot).filter(Boolean),
  };
}

export function inferSnapshotsFromCueMessages(db, filters = {}) {
  if (!db || !hasTable(db, 'messages') || !hasTable(db, 'conversations')) {
    return { ok: true, scanned: 0, inserted: 0, existing: 0, snapshots: [] };
  }
  const clauses = ["m.content IS NOT NULL", "TRIM(m.content) != ''"];
  const params = {};
  const topic = filters.targetType === 'topic' || filters.scopeType === 'topic'
    ? (filters.targetId || filters.target_id || filters.scopeId || filters.scope_id)
    : (filters.topic || filters.topicSlug || filters.topic_slug || null);
  if (topic) {
    clauses.push('c.topic_slug = @topic');
    params.topic = String(topic);
  }
  if (filters.asOf || filters.as_of) {
    clauses.push('COALESCE(m.created_at, c.created_at) <= @asOf');
    params.asOf = normalizeTime(filters.asOf || filters.as_of);
  }
  params.limit = Math.max(1, Math.min(Number(filters.limit || 500), 2000));
  const rows = db.prepare(`
    SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title, c.topic_slug
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY COALESCE(m.created_at, c.created_at, '') ASC, m.id ASC
    LIMIT @limit
  `).all(params).filter((row) => SNAPSHOT_CUE_RE.test(row.content));
  const results = [];
  for (const row of rows) {
    const scopeType = row.topic_slug ? 'topic' : 'conversation';
    const scopeId = row.topic_slug || row.conversation_id;
    const body = clip(row.content, 900);
    results.push(createSnapshot(db, {
      scopeType,
      scopeId,
      title: `Inferred chat view from ${row.title || row.conversation_id}`,
      body,
      snapshotType: /\b(hypothesis)\b/i.test(body) ? 'hypothesis' : /\b(framework)\b/i.test(body) ? 'framework' : 'view',
      inferred: true,
      confidence: 0.5,
      sourceKind: 'retroactive_reconstruction',
      source: 'snapshot:chat-message-cue',
      actor: 'memory-reconstruction',
      validAt: row.created_at || isoNow(),
      idempotencyKey: `snapshot-inferred:message:${row.id}:${sha256(body)}`,
      citations: [{ source: `messages:${row.id}`, label: row.role }],
      links: [{ targetType: 'conversation', targetId: row.conversation_id, role: 'source' }],
    }));
  }
  return {
    ok: true,
    scanned: rows.length,
    inserted: results.filter((result) => result.inserted).length,
    existing: results.filter((result) => !result.inserted).length,
    snapshots: results.map((result) => result.snapshot).filter(Boolean),
  };
}

export function reconstructSnapshots(db, filters = {}) {
  const parts = [
    inferSnapshotsFromMemoryEvents(db, filters),
    inferSnapshotsFromTopicContextHistory(db, filters),
    inferSnapshotsFromCueMessages(db, filters),
  ];
  return {
    ok: true,
    scanned: parts.reduce((n, part) => n + (part.scanned || 0), 0),
    inserted: parts.reduce((n, part) => n + (part.inserted || 0), 0),
    existing: parts.reduce((n, part) => n + (part.existing || 0), 0),
    snapshots: parts.flatMap((part) => part.snapshots || []),
  };
}
