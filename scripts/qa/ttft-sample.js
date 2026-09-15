#!/usr/bin/env node
/**
 * scripts/qa/ttft-sample.js — gate chat TTFT against p50/p90 budgets on the
 * HONEST metric (st_2cd1af73 Phase 6, AC-1).
 *
 * The bug this guards against: request_start_ms and first_token_ms in
 * chat_turn_metrics are both absolute epochs. Reading first_token_ms as if it
 * were a duration reports garbage, and warmup-ping rows (operation_name=
 * 'warmup-ping') write first_token_ms = completion_ms — a whole 1-token round
 * trip that would poison any aggregate. So this script:
 *   - reads the materialized ttft_ms column when present, else falls back to
 *     first_token_ms - request_start_ms for rows the migration hasn't backfilled
 *   - samples real chat rows only, excluding warmup-ping / non-chat operations
 *     and any row missing first_token_ms / a positive duration
 *   - requires at least --min-n real turns (a single fast turn cannot pass)
 *   - asserts p50 <= --p50 and p90 <= --p90
 *   - PRINTS the numbers either way (honest report on pass AND fail)
 *
 * Exit 0 only when n >= min-n AND p50/p90 are within budget. Exit 1 otherwise.
 * This is a Tier-0 deterministic check — no LLM, SQL only, against the live DB.
 *
 * Usage:
 *   cd ~/robotdojo && ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node ~/robotdojo/scripts/qa/ttft-sample.js --min-n 20 --p50 2500 --p90 4000
 *
 * Optional --window N limits the sample to the most recent N turns (by
 * request_start_ms); default is all real turns.
 * Optional --model default|<key-or-id> filters to a single request_model so
 * launch checks can isolate the fast-default path from Sonnet/Opus work turns.
 * Optional --since-ms EPOCH_MS or --since ISO_TIMESTAMP cuts pre-fix history
 * out of the sample without mutating chat_turn_metrics.
 *
 * INTELLIGENCE_TIER: extraction (deterministic SQL aggregate; no LLM).
 */
export const INTELLIGENCE_TIER = 'extraction';

import { fileURLToPath } from 'node:url';
import db from '../../lib/db.js';
import { DEFAULT_CHAT_MODEL_KEY, resolveChatModelId } from '../../lib/chat-models.js';

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i === process.argv.length - 1) return dflt;
  return process.argv[i + 1];
}

/**
 * Nearest-rank percentile on an ascending-sorted array of finite numbers.
 * p in [0,100]. Returns null for an empty array.
 */
export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length, Math.max(1, rank)) - 1;
  return sortedAsc[idx];
}

function sampleOptions(input = null) {
  if (typeof input === 'number') return { window: input };
  if (!input || typeof input !== 'object') return {};
  return input;
}

export function resolveModelFilter(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (value === 'default' || value === 'fast-default') {
    return resolveChatModelId(DEFAULT_CHAT_MODEL_KEY);
  }
  return resolveChatModelId(value);
}

function parseSinceMs(raw) {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pull the honest TTFT sample (ms) for real, non-warmup chat turns.
 * COALESCE(ttft_ms, first_token_ms - request_start_ms) so the gate works
 * before AND after the backfill migration runs. Rows are filtered to a
 * strictly positive duration so a NULL/zero/negative value never enters the
 * sample.
 *
 * @param {import('better-sqlite3').Database} database
 * @param {number|{window?: number|null, model?: string|null, sinceMs?: number|null}|null} options
 * @returns {number[]} ascending TTFT values in ms
 */
export function sampleTtftMs(database, options = null) {
  const opts = sampleOptions(options);
  const window = Number(opts.window);
  const model = opts.model || null;
  const sinceMs = Number(opts.sinceMs);
  const where = [
    "operation_name = 'chat'",
    'first_token_ms IS NOT NULL',
    'request_start_ms IS NOT NULL',
    'COALESCE(ttft_ms, first_token_ms - request_start_ms) > 0',
  ];
  const params = [];
  if (model) {
    where.push('request_model = ?');
    params.push(model);
  }
  if (Number.isFinite(sinceMs) && sinceMs > 0) {
    where.push('request_start_ms >= ?');
    params.push(Math.floor(sinceMs));
  }
  const limitClause = Number.isFinite(window) && window > 0 ? 'LIMIT ?' : '';
  if (limitClause) params.push(Math.floor(window));
  // Subquery selects the most recent `window` rows, then we sort ascending for
  // percentile math. operation_name='chat' keeps warmups and future non-chat
  // operations out of the aggregate.
  const rows = database.prepare(`
    SELECT ttft FROM (
      SELECT COALESCE(ttft_ms, first_token_ms - request_start_ms) AS ttft,
             request_start_ms
      FROM chat_turn_metrics
      WHERE ${where.join('\n        AND ')}
      ORDER BY request_start_ms DESC
      ${limitClause}
    )
    ORDER BY ttft ASC
  `).all(...params);
  return rows.map(r => r.ttft);
}

function ttftColumnExists(database) {
  return database.prepare(
    "SELECT COUNT(*) n FROM pragma_table_info('chat_turn_metrics') WHERE name='ttft_ms'",
  ).get().n === 1;
}

export function main() {
  const minN = parseInt(arg('--min-n', '20'), 10);
  const p50Budget = parseInt(arg('--p50', '2500'), 10);
  const p90Budget = parseInt(arg('--p90', '4000'), 10);
  const windowRaw = arg('--window', null);
  const window = windowRaw == null ? null : parseInt(windowRaw, 10);
  const model = resolveModelFilter(arg('--model', null));
  const sinceMs = parseSinceMs(arg('--since-ms', null) || arg('--since', null));

  const hasCol = ttftColumnExists(db);
  const sample = sampleTtftMs(db, { window, model, sinceMs });
  const n = sample.length;
  const p50 = percentile(sample, 50);
  const p90 = percentile(sample, 90);
  const minV = n ? sample[0] : null;
  const maxV = n ? sample[n - 1] : null;

  // Honest report — always printed, pass or fail.
  console.log(`[ttft-sample] ttft_ms column: ${hasCol ? 'present' : 'MISSING (using first_token_ms - request_start_ms fallback)'}`);
  console.log(`[ttft-sample] real chat turns sampled: n=${n}${window ? ` (window=${window})` : ''}${model ? ` model=${model}` : ''}${sinceMs ? ` since_ms=${sinceMs}` : ''}`);
  console.log(`[ttft-sample] p50=${p50 ?? 'n/a'}ms (budget <=${p50Budget}ms)`);
  console.log(`[ttft-sample] p90=${p90 ?? 'n/a'}ms (budget <=${p90Budget}ms)`);
  console.log(`[ttft-sample] min=${minV ?? 'n/a'}ms max=${maxV ?? 'n/a'}ms`);

  const reasons = [];
  if (n < minN) reasons.push(`n=${n} < min-n=${minN}`);
  if (p50 == null || p50 > p50Budget) reasons.push(`p50=${p50 ?? 'n/a'}ms > ${p50Budget}ms`);
  if (p90 == null || p90 > p90Budget) reasons.push(`p90=${p90 ?? 'n/a'}ms > ${p90Budget}ms`);

  if (reasons.length) {
    console.log(`FAIL: ${reasons.join('; ')}`);
    return 1;
  }
  console.log(`PASS: n=${n} p50=${p50}ms p90=${p90}ms within budget`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
