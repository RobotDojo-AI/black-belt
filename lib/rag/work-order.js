/**
 * lib/rag/work-order.js — the embed daemon's value-first work-order contract.
 *
 * Compute tier: extraction. This module is a PURE deterministic read: it runs one
 * covering-index GROUP BY over ranked pending `chunks`, a narrow unranked fallback,
 * derives each topic's value/priority from precomputed columns, and sorts. No LLM,
 * no write, no schema change.
 *
 * WHY this module exists (df_969e7d39 AC-4): the work-order derive is the single
 * coarse, shared-connection unit the daemon ran synchronously on its main thread —
 * a GROUP BY that scans every pending row's content blob for LENGTH(), measured at
 * 38–95s under the live 318k backlog. A blocked main thread cannot fire the
 * heartbeat/watchdog timers, so the heartbeat gaps blew the ≤35s ceiling. The fix
 * is to run that derive OFF the main thread, in a short-lived read-only child
 * process. For the child to do the SAME derive without dragging in lib/db.js
 * (which runs migrate() + opens a writer at import — too heavy and write-contending
 * for a child), the ordering logic must be reachable WITHOUT importing lib/db.js or
 * lib/chunk-worker.js (which imports db.js). So it lives HERE.
 *
 * HARD CONTRACT: this module imports NOTHING from lib/db.js or lib/chunk-worker.js.
 * It is the single source of truth for the ordering — both the daemon's
 * daemonWorkOrder() wrapper and the child script call computeWorkOrder(), so the
 * SQL + scoring can never drift between the two (Stonebraker: the ordering is an
 * interface, defined once).
 */

import {
  EMBED_SLA_CHAT_HISTORY_SOURCE_TYPES,
  EMBED_SLA_DIRECT_SOURCE_TYPES,
  classifyEmbeddingSlaTier,
  embeddingSlaTierRank,
} from './embed-sla.js';

// ──────────────────────────────────────────────────────────────────────────────
// Pure scorers — the canonical home (copied here, db.js-free). lib/chunk-worker.js
// keeps its own copies for its live correlated-subquery path; both feed the SAME
// arithmetic, so the value/priority math is identical whichever caller derives it.
// These mirror lib/chunk-worker.js valueScoreFromCounts / embedPriorityFromScore.
// ──────────────────────────────────────────────────────────────────────────────

// Base priority floor + value span. Env-overridable per the no-hardcoded-tunables
// rule, and read with the EXACT names lib/chunk-worker.js uses so a box that tunes
// one tunes both (the daemon and child both honor these).
const EMBED_PRIORITY_BASE = positiveIntEnv(process.env.ROBOTDOJO_EMBED_PRIORITY_BASE, 40);
const VALUE_PRIORITY_SPAN = positiveIntEnv(process.env.ROBOTDOJO_EMBED_PRIORITY_SPAN, 40);
const VALUE_RANK_BASE = 1;
const VALUE_RANK_LENGTH_MOD = 1_000_000;
const DIRECT_SOURCE_TYPE_SQL = EMBED_SLA_DIRECT_SOURCE_TYPES
  .map((sourceType) => `'${String(sourceType).replace(/'/g, "''")}'`)
  .join(', ');
const CHAT_HISTORY_SOURCE_TYPE_SQL = EMBED_SLA_CHAT_HISTORY_SOURCE_TYPES
  .map((sourceType) => `'${String(sourceType).replace(/'/g, "''")}'`)
  .join(', ');

function positiveIntEnv(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Pure value-score formula in [0,1]: the mean of a topic's high-signal share
 * (content_rank <= 1) and its entity-linked density. A topic with no pending
 * chunks scores 0. Identical to lib/chunk-worker.js valueScoreFromCounts.
 *
 * @param {number} total       un-embedded chunk count for the topic
 * @param {number} highValue   count with content_rank <= 1 (high-signal sources)
 * @param {number} entityLinked count linked to a known entity
 * @returns {number} value score in [0,1] (0 when total is 0)
 */
export function valueScoreFromCounts(total, highValue, entityLinked) {
  const t = Number(total) || 0;
  if (t === 0) return 0;
  const highValueShare = (Number(highValue) || 0) / t;
  const entityDensity = (Number(entityLinked) || 0) / t;
  return (highValueShare + entityDensity) / 2;
}

/**
 * Map a value score in [0,1] to a passive-job priority (higher = embeds first).
 * Identical to lib/chunk-worker.js embedPriorityFromScore.
 *
 * @param {number} score value score in [0,1]
 * @returns {number} priority (>= EMBED_PRIORITY_BASE)
 */
export function embedPriorityFromScore(score) {
  return EMBED_PRIORITY_BASE + Math.round((Number(score) || 0) * VALUE_PRIORITY_SPAN);
}

/**
 * Derive the value-first embed work order from the pending `chunks` rows.
 *
 * The hot path is one covering-index GROUP BY over ranked rows, deriving each
 * topic's value from precomputed columns (NOT a per-topic correlated subquery and
 * NOT a full content-blob LENGTH scan): high_n (content_rank<=1) is the
 * high-signal share; entity_n (value_rank >= the entity floor) is the
 * entity-linked share; long_n is derived from the length term already packed into
 * value_rank. Unranked rows (value_rank=0, mainly fixtures or an interrupted
 * backfill) run as a separate fallback so the ranked production path never
 * mentions `content`. When an unrankedScorer is injected, unranked topics still
 * use that scorer's live ordering.
 *
 * Sort: higher priority first; on a tie, the LOWER email-share topic first (push
 * email bulk last); final tiebreak smaller backlog first (a quick high-signal topic
 * surfaces recall before a long tail).
 *
 * @param {object} database better-sqlite3 connection (read-only is fine)
 * @param {object} opts
 * @param {number} opts.longInputChars  the LONG-input char threshold (LENGTH cutoff)
 * @param {number} opts.valueRankFloor  the value_rank floor marking entity-linkedness
 * @param {number} [opts.now]           epoch ms (cooldown evaluation hook)
 * @param {(topic:string, now:number)=>boolean} [opts.cooldownPredicate]
 *        optional: returns true if the topic is currently demoted (filtered out).
 *        When omitted, no cooldown filtering — the daemon re-applies live cooldown
 *        downstream, and the child has no in-process cooldown state to apply.
 * @param {(database:object, topic:string)=>number} [opts.unrankedScorer]
 *        optional: live priority for a topic with value_rank=0 pending chunks. When
 *        omitted, the pure score is used even for unranked rows (production has zero
 *        unranked rows, so the child can safely omit this).
 * @returns {Array<{topic:string, pending:number, priority:number, emailShare:number,
 *   longShare:number, shortPending:number, longPending:number, slaTier:string,
 *   slaRank:number}>}
 */
export function computeWorkOrder(database, {
  now = Date.now(),
  longInputChars,
  valueRankFloor,
  cooldownPredicate,
  unrankedScorer,
} = {}) {
  if (!Number.isFinite(Number(longInputChars))) {
    throw new Error('computeWorkOrder: longInputChars (number) is required');
  }
  if (!Number.isFinite(Number(valueRankFloor))) {
    throw new Error('computeWorkOrder: valueRankFloor (number) is required');
  }
  const longCutoff = Number(longInputChars);
  const entityFloor = Number(valueRankFloor);
  // value_rank = base + entityTerm + sourceSignalTerm + epochDays*1_000_000 +
  // min(length, 999_999). entityTerm, sourceSignalTerm, and recencyTerm are
  // multiples of 1_000_000, so this recovers the materialized content length for
  // ranked rows without reading the content blob.
  const rankedContentChars = `((value_rank - ${VALUE_RANK_BASE}) % ${VALUE_RANK_LENGTH_MOD})`;

  const rankedRows = database.prepare(`
    SELECT topic,
           COUNT(*) AS pending,
           SUM(CASE WHEN source_type = 'email' THEN 1 ELSE 0 END) AS email_n,
           SUM(CASE
                 WHEN ${rankedContentChars} > ${longCutoff} THEN 1 ELSE 0
               END) AS long_n,
           SUM(CASE WHEN content_rank <= 1 THEN 1 ELSE 0 END) AS high_n,
           SUM(CASE WHEN value_rank >= ${entityFloor} THEN 1 ELSE 0 END) AS entity_n,
           SUM(CASE WHEN source_type IN (${DIRECT_SOURCE_TYPE_SQL}) THEN 1 ELSE 0 END) AS direct_n,
           SUM(CASE WHEN source_type IN (${CHAT_HISTORY_SOURCE_TYPE_SQL}) THEN 1 ELSE 0 END) AS chat_history_n,
           0 AS unranked_n
      FROM chunks
     WHERE embedded = 0 AND skip_embed = 0 AND topic > ''
       AND value_rank > 0
       AND ${rankedContentChars} > 0
     GROUP BY topic
  `).all();

  const unrankedRows = database.prepare(`
    SELECT topic,
           COUNT(*) AS pending,
           SUM(CASE WHEN source_type = 'email' THEN 1 ELSE 0 END) AS email_n,
           SUM(CASE WHEN LENGTH(content) > ${longCutoff} THEN 1 ELSE 0 END) AS long_n,
           SUM(CASE WHEN content_rank <= 1 THEN 1 ELSE 0 END) AS high_n,
           0 AS entity_n,
           SUM(CASE WHEN source_type IN (${DIRECT_SOURCE_TYPE_SQL}) THEN 1 ELSE 0 END) AS direct_n,
           SUM(CASE WHEN source_type IN (${CHAT_HISTORY_SOURCE_TYPE_SQL}) THEN 1 ELSE 0 END) AS chat_history_n,
           COUNT(*) AS unranked_n
      FROM chunks
     WHERE embedded = 0 AND skip_embed = 0 AND topic > ''
       AND value_rank = 0
       AND LENGTH(content) > 0
     GROUP BY topic
  `).all();

  const byTopic = new Map();
  for (const row of [...rankedRows, ...unrankedRows]) {
    const existing = byTopic.get(row.topic) || {
      topic: row.topic,
      pending: 0,
      email_n: 0,
      long_n: 0,
      high_n: 0,
      entity_n: 0,
      direct_n: 0,
      chat_history_n: 0,
      unranked_n: 0,
    };
    existing.pending += Number(row.pending) || 0;
    existing.email_n += Number(row.email_n) || 0;
    existing.long_n += Number(row.long_n) || 0;
    existing.high_n += Number(row.high_n) || 0;
    existing.entity_n += Number(row.entity_n) || 0;
    existing.direct_n += Number(row.direct_n) || 0;
    existing.chat_history_n += Number(row.chat_history_n) || 0;
    existing.unranked_n += Number(row.unranked_n) || 0;
    byTopic.set(row.topic, existing);
  }

  const enriched = [...byTopic.values()]
    .filter((r) => (typeof cooldownPredicate === 'function' ? !cooldownPredicate(r.topic, now) : true))
    .map((r) => ({
      topic: r.topic,
      pending: r.pending,
      // Fully-ranked topic → value from the scan's own counts (no extra query).
      // Any unranked pending chunk + an injected unrankedScorer → fall back to the
      // live score so a fresh/un-backfilled topic (and the test fixtures) order
      // exactly as before. Without an unrankedScorer, the pure score is used (the
      // child path — production has zero unranked rows).
      priority: ((r.unranked_n || 0) > 0 && typeof unrankedScorer === 'function')
        ? unrankedScorer(database, r.topic)
        : embedPriorityFromScore(valueScoreFromCounts(r.pending, r.high_n || 0, r.entity_n || 0)),
      chatHistoryPending: r.chat_history_n || 0,
      highValuePending: r.high_n || 0,
      entityLinkedPending: r.entity_n || 0,
      directSourcePending: r.direct_n || 0,
      emailPending: r.email_n || 0,
      emailShare: r.pending ? (r.email_n || 0) / r.pending : 0,
      // Fraction of this topic's pending chunks that are LONG inputs (>cap). Long
      // inputs are uninterruptible multi-second ONNX runs; the daemon gates a
      // long-dominated slice behind a wider quiet window.
      longShare: r.pending ? (r.long_n || 0) / r.pending : 0,
      // Explicit short/long pending counts. The daemon drains SHORT chunks first,
      // so the loop uses shortPending (not longShare) to decide short-vs-long
      // handling — a mixed topic is not treated as long-dominated while short work
      // remains.
      shortPending: r.pending - (r.long_n || 0),
      longPending: (r.long_n || 0),
    }))
    .map((r) => {
      const slaTier = classifyEmbeddingSlaTier(r);
      return {
        ...r,
        slaTier,
        slaRank: embeddingSlaTierRank(slaTier),
      };
    });

  // SLA tier first, then higher priority. This keeps the first-vector slice ahead
  // of historical repair while preserving the original value ordering inside a
  // tier. Chat-history pending chunks are a protected first lane inside the
  // first-vector tier because prior product conversations are the most relevant
  // substrate for the next product conversation. On a priority tie, the LOWER email-share topic goes first (push email
  // bulk last). Final tiebreak: smaller backlog first, so a quick high-signal
  // topic finishes and surfaces recall before a long tail.
  enriched.sort((a, b) => {
    if (b.slaRank !== a.slaRank) return b.slaRank - a.slaRank;
    const aHasChat = (Number(a.chatHistoryPending) || 0) > 0 ? 1 : 0;
    const bHasChat = (Number(b.chatHistoryPending) || 0) > 0 ? 1 : 0;
    if (bHasChat !== aHasChat) return bHasChat - aHasChat;
    if (bHasChat && Number(b.chatHistoryPending) !== Number(a.chatHistoryPending)) {
      return Number(b.chatHistoryPending) - Number(a.chatHistoryPending);
    }
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.emailShare !== b.emailShare) return a.emailShare - b.emailShare;
    return a.pending - b.pending;
  });
  return enriched;
}
