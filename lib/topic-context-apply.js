/**
 * lib/topic-context-apply.js — DB write surface for topic context_md.
 *
 * Generalized from a per-topic seeder script. Paired with
 * lib/topic-context.js (read side); together they define the DB-resident
 * topic-context-md round-trip.
 *
 * Transactional: history capture FIRST so a failed UPDATE doesn't lose
 * audit. Then UPDATE user_topics, optional timeline_events INSERT, and
 * canonical memory-event append.
 *
 * Idempotent on user_topics — same contextMd written twice yields the same
 * row. History is an unconditional audit trail; every call appends.
 *
 * Precedence guard (st_5184eb86): two independent writers race on
 * `user_topics.context_md` — the Sonnet-authored `generateTopicContext()`
 * synthesis path (writes `context_md` directly, tags its own
 * `topic_context_history` row `source='synthesis'`) and this module's
 * lower-trust callers, chiefly `/work` close's raw session-note write
 * (`source='work-close'`). Both are unconditional last-write-wins today, so
 * a terse close note can clobber a much richer synthesis minutes old. This
 * module can't arbitrate the other writer's direct UPDATE, but it CAN make
 * ITS OWN write non-destructive: before applying, it reads the current
 * `context_md` and the most recent `topic_context_history.source` for the
 * slug (provenance of "what's live now" — every writer, including the
 * direct synthesis path, pairs its UPDATE with a history insert) and skips
 * the `user_topics` UPDATE when the incoming write is lower-precedence AND
 * the existing content is substantially longer. The incoming write is still
 * recorded to `topic_context_history` and to the memory-event log either
 * way — nothing is lost, the richer surface is just not overwritten. See
 * `resolveContextWritePrecedence()` for the pure decision function.
 *
 * Story: st_4a7d6b1f (topic-skill-vertical-corpus). Precedence guard added
 * in st_5184eb86 (memory-architecture).
 */

// INTELLIGENCE_TIER = 'extraction' — deterministic, no LLM, writes structured store.
export const INTELLIGENCE_TIER = 'extraction';

import crypto from 'node:crypto';
import {
  appendMemoryEvent,
  ensureMemoryEventsSchema,
  memorySourceSetHash,
  recordProjectionRun,
} from './memory-events.js';
import { UNCATEGORIZED_T1 } from './topic-routing-policy.js';

function sha256(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// Source-precedence tiers for user_topics.context_md writers. Higher wins.
// Resolved from the source string's prefix before ':' so per-call suffixes
// (e.g. `workbench-synthesis:${workbenchId}`) still match their class.
//   3 — synthesis-class: LLM/deterministic engines that read the full corpus
//       ('synthesis' is generateTopicContext()'s direct-write tag; 'curated'
//       reserved for future explicit curation; 'workbench-synthesis' is this
//       repo's deterministic replay engine, lib/workbench-synthesis.js;
//       'topic-distill' is the unified grounded distiller, lib/topic-distill.js
//       (st_5184eb86 chunk 4) — same tier as the two engines it collapses).
//   2 — deliberate but narrower: a human-reviewed promotion (workbench-distill's
//       `workbench:{id}`) or an explicit in-chat user edit (`chat:*`).
//   1 — raw session dumps: `/work` close's terse synthesis note (`work-close`)
//       and the documented default (`skill-close`). Unknown sources fall back
//       here too — conservative, since we can't verify an unknown writer's
//       trust level, but we also don't want it to unconditionally out-rank
//       everything.
const SOURCE_PRECEDENCE = {
  synthesis: 3,
  curated: 3,
  'workbench-synthesis': 3,
  'topic-distill': 3,
  'monarch-compact': 3,
  workbench: 2,
  chat: 2,
  'work-close': 1,
  'skill-close': 1,
};
const DEFAULT_SOURCE_PRECEDENCE = 1;

// A lower-precedence incoming write is blocked only when the existing
// content is ALSO substantially longer — precedence alone isn't enough,
// otherwise a legitimate same-length correction from a lower-tier source
// could never land. 1.5x mirrors the real clobber this guard was built for
// (15,923-char synthesis vs a 2,969-char work-close note — 5.4x).
const SUBSTANTIAL_LENGTH_RATIO = 1.5;

function sourcePrecedence(source) {
  const key = String(source || '').split(':')[0];
  return SOURCE_PRECEDENCE[key] ?? DEFAULT_SOURCE_PRECEDENCE;
}

/**
 * Decide whether an incoming context_md write should be applied to
 * user_topics, given the content currently live and its provenance.
 *
 * Pure function — no DB access, no I/O — independently testable.
 *
 * @param {Object} incoming              { source, contextMd }
 * @param {Object|null} existing         { source, contextMd } for what's
 *   currently live, or null/undefined when there is no prior content.
 * @returns {{ apply: boolean, reason: string }}
 */
export function resolveContextWritePrecedence(incoming, existing) {
  if (!existing || !existing.contextMd) {
    return { apply: true, reason: 'no-existing-content' };
  }
  const incomingRank = sourcePrecedence(incoming?.source);
  const existingRank = sourcePrecedence(existing.source);
  if (incomingRank >= existingRank) {
    return { apply: true, reason: 'incoming-precedence-gte-existing' };
  }
  const existingLen = existing.contextMd.length;
  const incomingLen = String(incoming?.contextMd || '').length;
  if (existingLen >= incomingLen * SUBSTANTIAL_LENGTH_RATIO) {
    return { apply: false, reason: 'existing-higher-precedence-and-substantially-longer' };
  }
  return { apply: true, reason: 'incoming-not-substantially-shorter' };
}

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

async function queueHealthIntelForTopicUpdate(slug, reason) {
  if (slug !== 'health') return null;
  try {
    const { queueHealthIntelRegeneration } = await import('./health-intel-regeneration.js');
    return queueHealthIntelRegeneration({ reason, inserted: 1 });
  } catch (err) {
    console.warn(`[topic-context-apply] health intel regeneration queue failed: ${err.message}`);
    return null;
  }
}

/**
 * Upsert the canonical topic context_md for a slug.
 *
 * Schema notes (verified live):
 *   topic_context_history(id INTEGER, topic_slug TEXT, content TEXT,
 *                         source TEXT, created_at TEXT)
 *   user_topics(slug PRIMARY KEY, context_md TEXT, updated_at TEXT, ...)
 *
 * If user_topics row for slug does not exist, this function inserts a
 * minimal row under Uncategorized so close-time writes for newly-named slugs
 * do not silently fail or file ambiguous material under Personal. Production
 * callers will always have the row pre-seeded via migrations.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} args
 * @param {string} args.slug                          user_topics.slug
 * @param {string} args.contextMd                     canonical context_md string
 * @param {string} args.sourceType                    timeline_events.source_type
 * @param {Array<{date,summary,metadata}>} [args.events]
 * @param {string} [args.source='skill-close']        topic_context_history.source
 * @returns {Promise<{slug: string, chars: number, events: number, memory_event_id: string|null, applied: boolean, precedence_reason: string}>}
 */
export async function applyTopicContext(db, args) {
  const { slug, contextMd, sourceType, events = [], source = 'skill-close' } = args || {};
  if (!slug) throw new Error('topic-context-apply: slug required');
  if (!contextMd) throw new Error('topic-context-apply: contextMd required');
  if (!sourceType) throw new Error('topic-context-apply: sourceType required');

  ensureMemoryEventsSchema(db);
  const contextHash = sha256(contextMd);
  const validAt = new Date().toISOString();

  const tx = db.transaction(() => {
    // Ensure user_topics row exists. Production rows are seeded via migration;
    // ad-hoc slugs (spec tests) need a row before the UPDATE has anywhere to land.
    const existingRow = db.prepare('SELECT slug, context_md FROM user_topics WHERE slug = ?').get(slug);
    if (!existingRow) {
      db.prepare(`INSERT INTO user_topics
        (slug, label, parent_slug, visible, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, 1, 0, datetime('now'), datetime('now'))`).run(slug, slug, UNCATEGORIZED_T1);
    }

    // Precedence guard (st_5184eb86): read what's live and its provenance
    // BEFORE this write's own history row lands, so the comparison reflects
    // the prior writer, not this call. The most recent topic_context_history
    // row is the provenance proxy — every writer (this function and the
    // direct generateTopicContext() synthesis path) pairs its UPDATE with a
    // history insert, so the latest row's `source` names whoever produced
    // the content currently in `context_md`.
    const lastHistory = db.prepare(
      `SELECT source FROM topic_context_history WHERE topic_slug = ? ORDER BY id DESC LIMIT 1`
    ).get(slug);
    const priorContent = existingRow?.context_md
      ? { source: lastHistory?.source, contextMd: existingRow.context_md }
      : null;
    const decision = resolveContextWritePrecedence({ source, contextMd }, priorContent);

    // History capture FIRST — audit trail survives any later failure, and
    // records the incoming attempt even when the write below is skipped.
    db.prepare(`INSERT INTO topic_context_history (topic_slug, content, source, created_at)
                VALUES (?, ?, ?, datetime('now'))`).run(slug, contextMd, source);

    if (decision.apply) {
      db.prepare(`UPDATE user_topics SET context_md = ?, updated_at = datetime('now')
                  WHERE slug = ?`).run(contextMd, slug);
    } else {
      console.log(
        `[topic-context-apply] clobber prevented for topic "${slug}": ` +
        `incoming source="${source}" (${contextMd.length} chars) blocked — ` +
        `preserving existing source="${priorContent.source}" (${priorContent.contextMd.length} chars). ` +
        `reason=${decision.reason}`
      );
    }

    let insertedEvents = 0;
    if (events.length && hasTable(db, 'timeline_events')) {
      const insertEvent = db.prepare(`INSERT OR IGNORE INTO timeline_events
        (id, source_type, source_id, event_date, event_type, summary, content_hash, metadata)
        VALUES (?, ?, ?, ?, 'context_update', ?, ?, ?)`);
      for (const ev of events) {
        const id = sha256(sourceType, 'context_update', ev.date);
        const ch = sha256(ev.summary, ev.date);
        const result = insertEvent.run(
          id,
          sourceType,
          `${sourceType}-context-${ev.date}`,
          ev.date,
          ev.summary,
          ch,
          JSON.stringify(ev.metadata || {})
        );
        insertedEvents += result.changes || 0;
      }
    }
    const memoryEvent = appendMemoryEvent(db, {
      streamType: 'topic',
      streamId: slug,
      eventType: decision.apply ? 'topic.context.updated' : 'topic.context.write_skipped',
      actor: source || sourceType,
      source: source || sourceType,
      subjectType: 'topic',
      subjectId: slug,
      validAt,
      idempotencyKey: `topic-context:${slug}:${sourceType}:${contextHash}:${decision.apply ? 'applied' : 'skipped'}`,
      payload: {
        chars: contextMd.length,
        context_hash: contextHash,
        history_source: source,
        source_type: sourceType,
        timeline_events_inserted: insertedEvents,
        applied: decision.apply,
        precedence_reason: decision.reason,
      },
      links: [{ targetType: 'topic', targetId: slug, role: 'canonical_context' }],
    }, { useTransaction: false });

    if (memoryEvent.event && decision.apply) {
      recordProjectionRun(db, {
        projectionName: 'topic-context',
        targetType: 'topic',
        targetId: slug,
        sourceEventFrom: memoryEvent.event.global_sequence,
        sourceEventTo: memoryEvent.event.global_sequence,
        sourceSetHash: memorySourceSetHash([memoryEvent.event]),
        projectionVersion: sourceType,
        promptVersion: 'deterministic',
        model: 'none',
        generatedAt: validAt,
        generatedBy: source || sourceType,
        outputHash: contextHash,
        metadata: { source_type: sourceType, source },
      });
    }

    return { insertedEvents, memoryEventId: memoryEvent.event?.event_id || null, applied: decision.apply, reason: decision.reason };
  });

  const { insertedEvents, memoryEventId, applied, reason } = tx();
  await queueHealthIntelForTopicUpdate(slug, 'health_context_updated');
  return {
    slug,
    chars: contextMd.length,
    events: insertedEvents,
    memory_event_id: memoryEventId,
    applied,
    precedence_reason: reason,
  };
}
