#!/usr/bin/env node
/**
 * scripts/qa/blocked-turn-audit.js — proves context budgets actually bind
 * (st_df0a8d71 AC-11).
 *
 * Compute tier: Tier 0 only — deterministic SQL over chat_turn_metrics.
 * No LLM, no writes (query_only-locked connection).
 *
 * THE CLASS THIS AUDITS: before this story, "3-second" context budgets were
 * observed running 16–22 s under embed-daemon writer contention (live turns
 * 8215c17e at 16,090 ms, 70c6f762 at 21,625 ms recorded as fast_context
 * "timeout") because sync better-sqlite3 SQL pinned the main thread and the
 * JS race timer could not fire. With the context worker (D5) that class is
 * structurally impossible — this audit is the standing proof: it walks every
 * turn's enrichment_health_json in the window and exits non-zero if ANY
 * context layer's recorded duration exceeded its mode budget + grace.
 *
 * CLI:
 *   node scripts/qa/blocked-turn-audit.js --since-hours 24 --budget-grace-ms 1500
 */
export const INTELLIGENCE_TIER = 'extraction';

const args = process.argv.slice(2);
const val = (f, fallback) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const SINCE_HOURS = Number(val('--since-hours', '24'));
const GRACE_MS = Number(val('--budget-grace-ms', '1500'));
if (!Number.isFinite(SINCE_HOURS) || SINCE_HOURS <= 0 || !Number.isFinite(GRACE_MS) || GRACE_MS < 0) {
  console.error('usage: blocked-turn-audit.js [--since-hours N] [--budget-grace-ms N]');
  process.exit(2);
}

const { default: db } = await import('../../lib/db.js');
db.pragma('query_only = 1');

// Mode → budget (ms). Mirrors lib/chat.js modeBudget() including the env
// overrides, so the audit judges turns against the budgets they actually ran
// under.
function envInt(name, fallback) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}
const BUDGETS = {
  fast: envInt('ROBOTDOJO_CHAT_CONTEXT_TIMEOUT_MS', 700),
  context: envInt('ROBOTDOJO_CHAT_CONTEXT_RICH_TIMEOUT_MS', 3_000),
  deep: envInt('ROBOTDOJO_SOURCE_BOUND_CONTEXT_TIMEOUT_MS', 8_000),
};
const DIRECT_ENTITY_BUDGET = envInt('ROBOTDOJO_CHAT_DIRECT_ENTITY_TIMEOUT_MS', 1_800);

// The context layers whose recorded duration must respect the turn budget.
// Provider/model layers are excluded — their time is the model's, not context
// assembly's; response_mode/model_policy/ego_block are status markers (ms=0).
const CONTEXT_LAYERS = new Set([
  'fast_context', 'rag', 'fast_memory', 'fast_entities',
  'cache', 'inline_recognition', 'router', 'stable_context',
]);

function budgetForLayer(layer, mode) {
  if (layer === 'direct_entity') return DIRECT_ENTITY_BUDGET;
  return BUDGETS[mode] ?? BUDGETS.context;
}

const sinceMs = Date.now() - SINCE_HOURS * 3_600_000;
const rows = db.prepare(`
  SELECT turn_id, request_start_ms, enrichment_health_json
  FROM chat_turn_metrics
  WHERE operation_name = 'chat'
    AND request_start_ms >= ?
    AND enrichment_health_json IS NOT NULL
`).all(sinceMs);

const violations = [];
let turnsAudited = 0;
for (const row of rows) {
  let events;
  try { events = JSON.parse(row.enrichment_health_json); } catch { continue; }
  if (!Array.isArray(events) || !events.length) continue;
  turnsAudited++;
  const mode = events.find((e) => e?.layer === 'response_mode')?.status || 'context';
  for (const e of events) {
    const layer = String(e?.layer || '');
    if (!CONTEXT_LAYERS.has(layer) && layer !== 'direct_entity') continue;
    const ms = Number(e?.ms) || 0;
    const budget = budgetForLayer(layer, mode);
    if (ms > budget + GRACE_MS) {
      violations.push({
        turn_id: row.turn_id,
        at: new Date(row.request_start_ms).toISOString(),
        layer,
        status: e.status,
        ms,
        budget,
        mode,
      });
    }
  }
}

for (const v of violations) {
  console.error(
    `[blocked-turn-audit] VIOLATION turn=${v.turn_id} at=${v.at} layer=${v.layer} status=${v.status} ms=${v.ms} > budget=${v.budget}+${GRACE_MS} (mode=${v.mode})`,
  );
}
console.log(
  `[blocked-turn-audit] window=${SINCE_HOURS}h turns_audited=${turnsAudited} grace=${GRACE_MS}ms violations=${violations.length}`,
);
process.exit(violations.length ? 1 : 0);
