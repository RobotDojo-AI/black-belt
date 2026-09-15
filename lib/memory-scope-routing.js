// Current-scope projection helpers for immutable memory events.
//
// memory_events never change. memory_event_links are the current routing
// projection over those events. When recalc learns a sharper scope, we move the
// link and append a separate refocus event so the historical sequence remains
// reconstructable.

import crypto from 'node:crypto';
import { appendMemoryEvent, ensureMemoryEventsSchema, stableJson } from './memory-events.js';
import { NEEDS_ROUTING_TOPIC, normalizeMemoryTopicSlug } from './topic-routing-policy.js';

function shaKey(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16);
}

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

function eventExists(db, eventId) {
  return !!db.prepare('SELECT 1 FROM memory_events WHERE event_id = ?').get(eventId);
}

function currentTopicLinks(db, eventId, topic) {
  return db.prepare(`
    SELECT id, role
    FROM memory_event_links
    WHERE event_id = ?
      AND target_type = 'topic'
      AND target_id = ?
      AND role IN ('scope', 'needs-routing')
    ORDER BY id
  `).all(eventId, topic);
}

function topicLinksWithRole(db, eventId, topic, role) {
  return db.prepare(`
    SELECT id, role
    FROM memory_event_links
    WHERE event_id = ?
      AND target_type = 'topic'
      AND target_id = ?
      AND role = ?
    ORDER BY id
  `).all(eventId, topic, role);
}

function appendRefocusEvent(db, {
  eventId,
  fromTopic,
  toTopic,
  actor,
  reason,
  validAt,
  correlationId,
}) {
  return appendMemoryEvent(db, {
    streamType: 'memory_scope',
    streamId: toTopic,
    eventType: 'memory.scope.refocused',
    actor: actor || 'memory-recalc',
    source: 'memory-scope-routing',
    subjectType: 'memory_event',
    subjectId: eventId,
    validAt: validAt || new Date().toISOString(),
    correlationId: correlationId || null,
    idempotencyKey: `memory-scope-refocus:${eventId}:${fromTopic}:${toTopic}:${shaKey(reason || '')}`,
    payload: {
      source_event_id: eventId,
      from_topic: fromTopic,
      to_topic: toTopic,
      reason: reason || null,
    },
    links: [
      { targetType: 'memory_event', targetId: eventId, role: 'source' },
      { targetType: 'topic', targetId: fromTopic, role: 'previous_scope' },
      { targetType: 'topic', targetId: toTopic, role: 'current_scope' },
    ],
  }, { useTransaction: false });
}

function appendSuppressEvent(db, {
  eventId,
  fromTopic,
  actor,
  reason,
  validAt,
  correlationId,
}) {
  return appendMemoryEvent(db, {
    streamType: 'memory_scope',
    streamId: fromTopic,
    eventType: 'memory.scope.suppressed',
    actor: actor || 'memory-recalc',
    source: 'memory-scope-routing',
    subjectType: 'memory_event',
    subjectId: eventId,
    validAt: validAt || new Date().toISOString(),
    correlationId: correlationId || null,
    idempotencyKey: `memory-scope-suppress:${eventId}:${fromTopic}:${shaKey(reason || '')}`,
    payload: {
      source_event_id: eventId,
      from_topic: fromTopic,
      reason: reason || null,
    },
    links: [
      { targetType: 'memory_event', targetId: eventId, role: 'source' },
      { targetType: 'topic', targetId: fromTopic, role: 'suppressed-noise' },
    ],
  }, { useTransaction: false });
}

export function refocusMemoryScopes(db, {
  eventIds = [],
  fromTopic = NEEDS_ROUTING_TOPIC,
  toTopic,
  actor = 'memory-recalc',
  reason = '',
  validAt = null,
  correlationId = null,
} = {}) {
  ensureMemoryEventsSchema(db);
  if (!hasTable(db, 'memory_event_links')) {
    return { scanned: 0, moved: 0, skipped: 0, events: [] };
  }
  const from = normalizeMemoryTopicSlug(fromTopic, { fallback: true });
  const to = normalizeMemoryTopicSlug(toTopic, { fallback: false });
  if (!to) throw new Error('refocusMemoryScopes: toTopic is required');
  if (from === to) return { scanned: eventIds.length, moved: 0, skipped: eventIds.length, events: [] };

  const ids = [...new Set((eventIds || []).filter(Boolean).map(String))];
  const movedEvents = [];
  const tx = db.transaction(() => {
    for (const eventId of ids) {
      if (!eventExists(db, eventId)) continue;
      const links = currentTopicLinks(db, eventId, from);
      if (!links.length) continue;

      const hasTarget = currentTopicLinks(db, eventId, to).length > 0;
      if (hasTarget) {
        db.prepare(`
          DELETE FROM memory_event_links
          WHERE event_id = ? AND target_type = 'topic' AND target_id = ? AND role IN ('scope', 'needs-routing')
        `).run(eventId, from);
      } else {
        db.prepare(`
          UPDATE memory_event_links
             SET target_id = ?, role = 'scope'
           WHERE id = ?
        `).run(to, links[0].id);
        for (const extra of links.slice(1)) {
          db.prepare('DELETE FROM memory_event_links WHERE id = ?').run(extra.id);
        }
      }

      const result = appendRefocusEvent(db, {
        eventId,
        fromTopic: from,
        toTopic: to,
        actor,
        reason,
        validAt,
        correlationId,
      });
      movedEvents.push(result.event);
    }
  });
  tx();

  return {
    scanned: ids.length,
    moved: movedEvents.length,
    skipped: ids.length - movedEvents.length,
    events: movedEvents,
  };
}

export function suppressMemoryScopes(db, {
  eventIds = [],
  fromTopic = NEEDS_ROUTING_TOPIC,
  actor = 'memory-recalc',
  reason = '',
  validAt = null,
  correlationId = null,
} = {}) {
  ensureMemoryEventsSchema(db);
  if (!hasTable(db, 'memory_event_links')) {
    return { scanned: 0, suppressed: 0, skipped: 0, events: [] };
  }
  const from = normalizeMemoryTopicSlug(fromTopic, { fallback: true });
  const ids = [...new Set((eventIds || []).filter(Boolean).map(String))];
  const suppressedEvents = [];
  const tx = db.transaction(() => {
    for (const eventId of ids) {
      if (!eventExists(db, eventId)) continue;
      const links = currentTopicLinks(db, eventId, from);
      if (!links.length) continue;

      const hasSuppressed = topicLinksWithRole(db, eventId, from, 'suppressed-noise').length > 0;
      if (hasSuppressed) {
        for (const link of links) db.prepare('DELETE FROM memory_event_links WHERE id = ?').run(link.id);
      } else {
        db.prepare(`
          UPDATE memory_event_links
             SET role = 'suppressed-noise'
           WHERE id = ?
        `).run(links[0].id);
        for (const extra of links.slice(1)) {
          db.prepare('DELETE FROM memory_event_links WHERE id = ?').run(extra.id);
        }
      }

      const result = appendSuppressEvent(db, {
        eventId,
        fromTopic: from,
        actor,
        reason,
        validAt,
        correlationId,
      });
      suppressedEvents.push(result.event);
    }
  });
  tx();

  return {
    scanned: ids.length,
    suppressed: suppressedEvents.length,
    skipped: ids.length - suppressedEvents.length,
    events: suppressedEvents,
  };
}

export function refocusMemoryScopesForSubject(db, {
  subjectType,
  subjectId,
  fromTopic = NEEDS_ROUTING_TOPIC,
  toTopic,
  actor = 'memory-recalc',
  reason = '',
  validAt = null,
  correlationId = null,
} = {}) {
  ensureMemoryEventsSchema(db);
  if (!subjectType || !subjectId || !toTopic || !hasTable(db, 'memory_events')) {
    return { scanned: 0, moved: 0, skipped: 0, events: [] };
  }
  const from = normalizeMemoryTopicSlug(fromTopic, { fallback: true });
  const rows = db.prepare(`
    SELECT e.event_id
    FROM memory_events e
    JOIN memory_event_links l ON l.event_id = e.event_id
    WHERE e.subject_type = ?
      AND e.subject_id = ?
      AND l.target_type = 'topic'
      AND l.target_id = ?
      AND l.role IN ('scope', 'needs-routing')
    ORDER BY e.global_sequence
  `).all(String(subjectType), String(subjectId), from);
  return refocusMemoryScopes(db, {
    eventIds: rows.map((row) => row.event_id),
    fromTopic: from,
    toTopic,
    actor,
    reason,
    validAt,
    correlationId,
  });
}

export function suppressMemoryScopesForSubject(db, {
  subjectType,
  subjectId,
  fromTopic = NEEDS_ROUTING_TOPIC,
  actor = 'memory-recalc',
  reason = '',
  validAt = null,
  correlationId = null,
} = {}) {
  ensureMemoryEventsSchema(db);
  if (!subjectType || !subjectId || !hasTable(db, 'memory_events')) {
    return { scanned: 0, suppressed: 0, skipped: 0, events: [] };
  }
  const from = normalizeMemoryTopicSlug(fromTopic, { fallback: true });
  const rows = db.prepare(`
    SELECT e.event_id
    FROM memory_events e
    JOIN memory_event_links l ON l.event_id = e.event_id
    WHERE e.subject_type = ?
      AND e.subject_id = ?
      AND l.target_type = 'topic'
      AND l.target_id = ?
      AND l.role IN ('scope', 'needs-routing')
    ORDER BY e.global_sequence
  `).all(String(subjectType), String(subjectId), from);
  return suppressMemoryScopes(db, {
    eventIds: rows.map((row) => row.event_id),
    fromTopic: from,
    actor,
    reason,
    validAt,
    correlationId,
  });
}
