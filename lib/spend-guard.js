/**
 * lib/spend-guard.js — the brake.
 *
 * st_4312c9c0. Everything else in the spend system observes: the ledger records,
 * the report attributes, the tier gates classify. None of it stops a call. A
 * runaway loop at 3am still produces a surprise invoice, which is the original
 * complaint. This is the only component that refuses.
 *
 * TWO CEILINGS, deliberately (config/spend-limits.json):
 *   pipeline — background work with nobody waiting. Stops FIRST.
 *   total    — everything including interactive chat. The hard stop.
 * A cap that kills the thing the owner is looking at at the same instant it
 * kills an invisible batch job is a cap he disables. Between the two, a runaway
 * background loop goes quiet while the product keeps answering.
 *
 * SPEND IS COUNTED FROM BOTH LEDGERS. pipeline_llm_calls holds application
 * calls; chat_turn_metrics holds interactive turns on the streaming path, which
 * never touches llmCreate. Counting only the first would under-report the bill
 * and make the ceiling a fiction.
 *
 * LATENCY: this runs before every model call including chat, where TTFT is a P0.
 * The window total is cached for CACHE_TTL_MS and refreshed on a miss with two
 * index-covered SUMs. Worst case a call rides a few seconds of stale total —
 * irrelevant against a daily ceiling, and worth far more than a synchronous
 * query on the token path.
 *
 * FAILURE POSTURE: if the ledger cannot be read, the guard ALLOWS and alarms.
 * Fail-closed would let an unreadable bookkeeping table take down chat, which is
 * worse than a bounded overspend. The bypass is counted so it surfaces in the
 * report instead of passing silently.
 */

// INTELLIGENCE_TIER: extraction — deterministic aggregation over spend ledgers.
// Makes no model call.
export const INTELLIGENCE_TIER = 'extraction';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import db from './db.js';

const LIMITS_PATH = join(import.meta.dirname, '..', 'config', 'spend-limits.json');

const CACHE_TTL_MS = 30_000;

const DEFAULT_LIMITS = {
  daily_usd: { pipeline: 5.00, total: 20.00 },
  monthly_usd: { total: 150.00 },
  warn_at_pct: 75,
};

/** Raised when a call would cross a ceiling. Carries the numbers, not just a message. */
export class SpendLimitError extends Error {
  constructor({ scope, window, spentUsd, limitUsd, label }) {
    super(
      scope === 'autonomous'
        ? `background API spend is OFF (ROBOTDOJO_NO_AUTONOMOUS_SPEND=1) — refused: ${label}. `
          + 'Interactive chat still runs. To do this deliberately, re-run with ROBOTDOJO_SPEND_OVERRIDE=1.'
        : `spend limit reached — ${window} ${scope} spend $${spentUsd.toFixed(4)} is at or over the $${limitUsd.toFixed(2)} ceiling `
          + `(blocked: ${label}). Raise it in config/spend-limits.json, or set ROBOTDOJO_SPEND_OVERRIDE=1 for one deliberate run.`,
    );
    this.name = 'SpendLimitError';
    this.scope = scope;
    this.window = window;
    this.spentUsd = spentUsd;
    this.limitUsd = limitUsd;
    this.label = label;
  }
}

let _limits = null;
export function limits() {
  if (_limits) return _limits;
  try {
    _limits = existsSync(LIMITS_PATH)
      ? { ...DEFAULT_LIMITS, ...JSON.parse(readFileSync(LIMITS_PATH, 'utf8')) }
      : DEFAULT_LIMITS;
  } catch {
    // A malformed limits file must not mean "no limit". Fall back to defaults,
    // which are the conservative posture, rather than to unbounded spend.
    _limits = DEFAULT_LIMITS;
  }
  return _limits;
}

let _cache = { at: 0, day: null, month: null };
let _bypassCount = 0;

/**
 * Spend in a window, in USD, across BOTH ledgers.
 * @param {'day'|'month'} window
 * @returns {{pipeline: number, total: number}}
 */
export function spentIn(window) {
  const since = window === 'month'
    ? "datetime('now','start of month')"
    : "datetime('now','start of day')";

  // pipeline_llm_calls stores micro-dollars as INTEGER.
  const pipelineMicros = db.prepare(
    `SELECT COALESCE(SUM(cost_micros), 0) AS m FROM pipeline_llm_calls WHERE created_at >= ${since}`,
  ).get().m;

  // chat_turn_metrics stores cost_cents as REAL, keyed by epoch ms. 1 cent =
  // 10_000 micros. Counted so the ceiling reflects the whole bill rather than
  // the half of it that happens to route through llmCreate.
  let chatMicros = 0;
  try {
    const cents = db.prepare(
      `SELECT COALESCE(SUM(cost_cents), 0) AS c FROM chat_turn_metrics
        WHERE request_start_ms >= CAST(strftime('%s', ${since}) AS INTEGER) * 1000`,
    ).get().c;
    chatMicros = Math.round(Number(cents) * 10_000);
  } catch {
    // Older schemas may lack the table; pipeline spend still bounds the run.
  }

  return {
    pipeline: pipelineMicros / 1_000_000,
    total: (pipelineMicros + chatMicros) / 1_000_000,
  };
}

function windowTotals() {
  const now = Date.now();
  if (_cache.at && now - _cache.at < CACHE_TTL_MS) return _cache;
  _cache = { at: now, day: spentIn('day'), month: spentIn('month') };
  return _cache;
}

/** Drop the cached totals. Called after a recorded spend so a burst is seen promptly. */
export function invalidate() {
  _cache = { at: 0, day: null, month: null };
}

/** How many calls have run while the ledger was unreadable. Surfaced by the report. */
export function bypassCount() {
  return _bypassCount;
}

function warn(msg) {
  // eslint-disable-next-line no-console
  console.warn(`[spend-guard] ${msg}`);
}

/**
 * assertWithinBudget — throws SpendLimitError when a call would cross a ceiling.
 *
 * @param {object} args
 * @param {string} args.label            — call-site label, named in the error
 * @param {boolean} [args.interactive]   — true for a turn with a human waiting.
 *   Interactive calls are exempt from the pipeline ceiling and bound only by the
 *   total, so background work degrades before the product does.
 * @throws {SpendLimitError}
 */
export function assertWithinBudget({ label = 'unknown', interactive = false } = {}) {
  if (process.env.ROBOTDOJO_SPEND_OVERRIDE === '1') {
    warn(`OVERRIDE active — ceilings bypassed for ${label}. Unset ROBOTDOJO_SPEND_OVERRIDE to restore.`);
    return;
  }

  // st_4312c9c0 — the kill switch. "No background processes" means: nothing
  // bills the key unless a human is waiting on it (interactive) or the owner
  // said so for this run (the override above).
  //
  // DEFAULT-DENY rather than a per-path allowlist. A list of blocked jobs is
  // only as good as its last update, and the whole failure was a path nobody
  // was watching. Inverting it means a NEW background job is stopped by
  // default instead of discovered on an invoice.
  //
  // Deliberate consequence: a hand-run CLI script is blocked too. That is
  // correct under this flag — an explicit ask is expressed by running it with
  // ROBOTDOJO_SPEND_OVERRIDE=1, which is exactly the "explicit" the owner asked
  // for. The local embedding backlog is unaffected: it runs a local model and
  // never reaches this guard.
  if (process.env.ROBOTDOJO_NO_AUTONOMOUS_SPEND === '1' && !interactive) {
    throw new SpendLimitError({
      scope: 'autonomous', window: 'while background spend is off',
      spentUsd: 0, limitUsd: 0, label,
    });
  }

  let totals;
  try {
    totals = windowTotals();
  } catch (err) {
    _bypassCount++;
    warn(`ledger unreadable (${err.message}) — ALLOWING ${label} uncapped. Spend is unbounded until this is fixed.`);
    return;
  }

  const cfg = limits();
  const checks = [
    !interactive && { scope: 'pipeline', window: 'today', spent: totals.day.pipeline, limit: cfg.daily_usd?.pipeline },
    { scope: 'total', window: 'today', spent: totals.day.total, limit: cfg.daily_usd?.total },
    { scope: 'total', window: 'this month', spent: totals.month.total, limit: cfg.monthly_usd?.total },
  ].filter(Boolean);

  for (const c of checks) {
    if (!Number.isFinite(c.limit) || c.limit <= 0) continue;
    if (c.spent >= c.limit) {
      throw new SpendLimitError({
        scope: c.scope, window: c.window, spentUsd: c.spent, limitUsd: c.limit, label,
      });
    }
    const pct = (c.spent / c.limit) * 100;
    if (pct >= (cfg.warn_at_pct ?? 75)) {
      warn(`${c.window} ${c.scope} spend $${c.spent.toFixed(4)} is ${pct.toFixed(0)}% of the $${c.limit.toFixed(2)} ceiling.`);
    }
  }
}

/** Current status, for the report and the health surface. */
export function status() {
  const cfg = limits();
  let totals;
  try {
    totals = { day: spentIn('day'), month: spentIn('month') };
  } catch (err) {
    return { readable: false, error: err.message, bypasses: _bypassCount };
  }
  const pct = (spent, limit) => (Number.isFinite(limit) && limit > 0 ? (spent / limit) * 100 : null);
  return {
    readable: true,
    bypasses: _bypassCount,
    override: process.env.ROBOTDOJO_SPEND_OVERRIDE === '1',
    today: {
      pipeline: { spent: totals.day.pipeline, limit: cfg.daily_usd?.pipeline, pct: pct(totals.day.pipeline, cfg.daily_usd?.pipeline) },
      total: { spent: totals.day.total, limit: cfg.daily_usd?.total, pct: pct(totals.day.total, cfg.daily_usd?.total) },
    },
    month: {
      total: { spent: totals.month.total, limit: cfg.monthly_usd?.total, pct: pct(totals.month.total, cfg.monthly_usd?.total) },
    },
  };
}
