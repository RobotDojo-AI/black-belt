#!/usr/bin/env node
/**
 * Launch D2 chat hot-path probe.
 *
 * Measures the local context assembly path and reports the query plans that
 * matter for launch chat. It is intentionally read-only: no chat turn is sent
 * to a model, and no background work is started.
 */

import db from '../../lib/db.js';
import { cachedBuildLayeredContext, _clearLayeredContextCache } from '../../lib/chat-context.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const check = args.includes('--check');
const maxTotalMs = args.includes('--max-total-ms')
  ? Number(args[args.indexOf('--max-total-ms') + 1])
  : null;
const query = args.includes('--query')
  ? args[args.indexOf('--query') + 1]
  : 'what should I follow up on with Patrick from YC this week?';
const topic = args.includes('--topic')
  ? args[args.indexOf('--topic') + 1]
  : 'general';

function explain(name, sql, params = []) {
  try {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
    return { name, ok: true, plan: rows.map(r => r.detail || JSON.stringify(r)) };
  } catch (err) {
    return { name, ok: false, error: err.message, plan: [] };
  }
}

function metricSummary() {
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS n,
        AVG(first_token_ms - request_start_ms) AS avg_ttft_ms,
        MAX(first_token_ms - request_start_ms) AS max_ttft_ms
      FROM chat_turn_metrics
      WHERE first_token_ms IS NOT NULL
        AND request_start_ms IS NOT NULL
        AND operation_name = 'chat'
    `).get();
    return row || { n: 0, avg_ttft_ms: null, max_ttft_ms: null };
  } catch {
    return { n: 0, avg_ttft_ms: null, max_ttft_ms: null };
  }
}

_clearLayeredContextCache();
const timings = [];
const started = Date.now();
const context = await cachedBuildLayeredContext(query, {
  topic,
  conversation_id: 'probe-conversation',
  user_id: 'probe-user',
  onTiming: (event) => timings.push(event),
});
const total_ms = Date.now() - started;

const plans = [
  explain(
    'topic context',
    'SELECT context_md FROM user_topics WHERE slug = ? AND context_md IS NOT NULL AND length(context_md) > 0',
    [topic],
  ),
  explain(
    'conversation topic scope',
    'SELECT topic_slug FROM conversation_topics WHERE conversation_id = ?',
    ['probe-conversation'],
  ),
  explain(
    'people entity detection',
    `SELECT p.id, p.display_name, p.short_name, p.tier, p.last_seen,
            c.name AS company_name, p.score
       FROM people p
       LEFT JOIN companies c ON c.id = p.company_id
      WHERE p.archived = 0
        AND p.score > 0
        AND p.display_name IS NOT NULL
        AND (LOWER(p.display_name) LIKE ?)
      ORDER BY p.score DESC
      LIMIT 30`,
    ['%patrick%'],
  ),
  explain(
    'company entity detection',
    `SELECT id, name, tier, people_count, industry FROM companies
      WHERE name IS NOT NULL
        AND n2 IS NOT NULL
        AND n2 != ''
        AND (LOWER(name) LIKE ?)
      ORDER BY people_count DESC
      LIMIT 20`,
    ['%yc%'],
  ),
  explain(
    'entity chunks',
    `SELECT ce.chunk_id, c.content, c.source_type, c.created_at
       FROM chunk_entities ce
       JOIN chunks c ON c.id = ce.chunk_id
      WHERE ce.entity_id = ? AND ce.entity_type = ?
      ORDER BY c.created_at DESC
      LIMIT 20`,
    ['probe-entity', 'person'],
  ),
];

const report = {
  ok: true,
  query,
  topic,
  total_ms,
  context_chars: context.length,
  timings,
  ttft_metrics: metricSummary(),
  plans,
};

if (check) {
  const failures = [];
  if (!timings.some(t => t.phase === 'context.build_total')) {
    failures.push('missing context.build_total timing');
  }
  if (!timings.some(t => t.phase === 'layer.rag')) {
    failures.push('missing layer.rag timing');
  }
  if (!plans.every(p => p.ok)) {
    failures.push('one or more EXPLAIN probes failed');
  }
  if (Number.isFinite(maxTotalMs) && total_ms > maxTotalMs) {
    failures.push(`context build ${total_ms}ms exceeds max ${maxTotalMs}ms`);
  }
  if (failures.length) {
    report.ok = false;
    report.failures = failures;
  }
}

if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  console.log(`chat hot path: ${total_ms}ms, context=${context.length} chars`);
  for (const t of timings) console.log(`timing ${t.phase}: ${t.ms}ms`);
  console.log(`ttft rows=${report.ttft_metrics.n} avg=${report.ttft_metrics.avg_ttft_ms ?? 'n/a'} max=${report.ttft_metrics.max_ttft_ms ?? 'n/a'}`);
  for (const p of plans) {
    console.log(`plan ${p.name}: ${p.ok ? p.plan.join(' | ') : p.error}`);
  }
}

if (check && !report.ok) process.exit(1);
