#!/usr/bin/env node
/**
 * scripts/qa/ttft-baseline.js — TTFT baseline capture + regression compare
 * (st_df0a8d71 Phase 0 / AC-9).
 *
 * Compute tier: Tier 0 only — deterministic SQL over chat_turn_metrics.
 * No LLM, no writes to any application table.
 *
 * WHY a delta-based reading: a pre-existing timeout defect already breaks
 * absolute TTFT budgets on contended turns (16–22 s "3-second" timeouts under
 * writer load), so an absolute budget would fail for reasons this story does
 * not own. The contract is "no regression vs the pre-story baseline": capture
 * the distribution of real turns from BEFORE the story started (so the build
 * period cannot contaminate the baseline), then compare post-build turns as a
 * delta.
 *
 * Modes:
 *   --capture --story <id> [--force]
 *       Reads chat_turn_metrics rows whose request_start_ms is STRICTLY BEFORE
 *       the story's `started` timestamp (from the story's meta.json) and writes
 *       warm/cold median + p90 ttft_ms to <story dir>/ttft-baseline.json.
 *       WRITE-ONCE: when the file already exists this exits 0 without touching
 *       it (--force recaptures). The capture line is itself a plan criterion,
 *       so a full criteria-runner pass re-invokes it — an overwriting capture
 *       moved the file's timestamps on every run, which emptied compare's
 *       window (the defect Miyagi's independent verification caught).
 *   --mark-built --story <id> [--at <iso>] [--force]
 *       Stamps built_at/built_at_ms — the stable POST-BUILD boundary compare
 *       windows on (the moment the new build went live, e.g. the server
 *       restart). Write-once unless --force; --at pins a known instant.
 *   --compare --story <id> [--max-warm-delta-ms N]
 *       Measures turns recorded AFTER built_at_ms and exits non-zero when the
 *       warm median regressed past the allowed delta (default 200 ms). Fails
 *       loudly when --mark-built has not run — never a silently empty window.
 *
 * Turn classification:
 *   warm = cache_read_input_tokens > 0 (the prompt-cache prefix was read — the
 *          steady-state turn shape AC-9's budget governs)
 *   cold = everything else (first turns, cache-expired turns)
 * Excluded rows: local deterministic answers (provider 'local' — no model TTFT),
 * error turns, and rows with no ttft_ms (warmup pings never record one).
 *
 * Read-only on the live DB by construction: the connection is locked with
 * PRAGMA query_only=1 immediately after open, before any query runs.
 */
export const INTELLIGENCE_TIER = 'extraction';

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, fallback = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const story = val('--story');
const capture = has('--capture');
const compare = has('--compare');
const markBuilt = has('--mark-built');
const force = has('--force');
const maxWarmDeltaMs = Number(val('--max-warm-delta-ms', '200'));

const modeCount = [capture, compare, markBuilt].filter(Boolean).length;
if (!story || modeCount !== 1) {
  console.error('usage: ttft-baseline.js (--capture [--force] | --mark-built [--at <iso>] [--force] | --compare [--max-warm-delta-ms N]) --story <st_id>');
  process.exit(2);
}

const STORY_DIR = resolve(
  homedir(),
  'robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories',
  story,
);
const BASELINE_PATH = resolve(STORY_DIR, 'ttft-baseline.json');

// The shared connection is the application's normal open path (idempotent
// migrations included, exactly like every other script); query_only then locks
// this process out of ANY write for the rest of its life — the read-only
// guarantee the story brief requires for Phase 0.
const { default: db } = await import('../../lib/db.js');
db.pragma('query_only = 1');

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
  };
}

/**
 * Fetch classified ttft samples in a time window. `sinceMs`/`beforeMs` are
 * epoch-ms bounds on request_start_ms (either may be null).
 */
function fetchSamples({ sinceMs = null, beforeMs = null }) {
  const rows = db.prepare(`
    SELECT ttft_ms, cache_read_input_tokens
    FROM chat_turn_metrics
    WHERE operation_name = 'chat'
      AND ttft_ms IS NOT NULL
      AND error_type IS NULL
      AND COALESCE(provider_name, '') != 'local'
      AND (COALESCE(response_model, '') NOT LIKE 'local-%')
      AND (? IS NULL OR request_start_ms >= ?)
      AND (? IS NULL OR request_start_ms < ?)
  `).all(sinceMs, sinceMs, beforeMs, beforeMs);
  const warm = [];
  const cold = [];
  for (const r of rows) {
    if ((r.cache_read_input_tokens || 0) > 0) warm.push(r.ttft_ms);
    else cold.push(r.ttft_ms);
  }
  return { warm: stats(warm), cold: stats(cold) };
}

if (capture) {
  // WRITE-ONCE: the baseline is a fact about the pre-story world; a re-run
  // (the criteria runner re-executes this line on every full pass) must never
  // move its timestamps or stats. Existing file → success, untouched.
  if (existsSync(BASELINE_PATH) && !force) {
    const existing = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    console.log(`[ttft-baseline] already captured ${existing.captured_at} (write-once; --force to recapture) → ${BASELINE_PATH}`);
    console.log(`  warm: n=${existing.warm?.n} median=${existing.warm?.median}ms p90=${existing.warm?.p90}ms`);
    console.log(`  cold: n=${existing.cold?.n} median=${existing.cold?.median}ms p90=${existing.cold?.p90}ms`);
    process.exit(0);
  }
  const metaPath = resolve(STORY_DIR, 'meta.json');
  if (!existsSync(metaPath)) {
    console.error(`[ttft-baseline] story meta.json not found: ${metaPath}`);
    process.exit(1);
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const startedMs = Date.parse(meta.started);
  if (!Number.isFinite(startedMs)) {
    console.error(`[ttft-baseline] story meta.json has no parseable "started": ${meta.started}`);
    process.exit(1);
  }
  const { warm, cold } = fetchSamples({ beforeMs: startedMs });
  if (!warm.n && !cold.n) {
    console.error('[ttft-baseline] no pre-story turns found — cannot capture a baseline');
    process.exit(1);
  }
  const baseline = {
    story,
    cutoff: meta.started,
    cutoff_ms: startedMs,
    captured_at: new Date().toISOString(),
    captured_at_ms: Date.now(),
    warm,
    cold,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  console.log(`[ttft-baseline] captured → ${BASELINE_PATH}`);
  console.log(`  warm: n=${warm.n} median=${warm.median}ms p90=${warm.p90}ms`);
  console.log(`  cold: n=${cold.n} median=${cold.median}ms p90=${cold.p90}ms`);
  process.exit(0);
}

if (markBuilt) {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`[ttft-baseline] baseline missing: ${BASELINE_PATH} — run --capture first`);
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  if (baseline.built_at_ms && !force) {
    console.log(`[ttft-baseline] built boundary already marked ${baseline.built_at} (write-once; --force to re-mark)`);
    process.exit(0);
  }
  const atRaw = val('--at', null);
  const atMs = atRaw ? Date.parse(atRaw) : Date.now();
  if (!Number.isFinite(atMs)) {
    console.error(`[ttft-baseline] --at is not a parseable instant: ${atRaw}`);
    process.exit(1);
  }
  baseline.built_at = new Date(atMs).toISOString();
  baseline.built_at_ms = atMs;
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  console.log(`[ttft-baseline] built boundary marked ${baseline.built_at} → compare windows on turns after this instant`);
  process.exit(0);
}

// ── --compare ────────────────────────────────────────────────────────────────
if (!existsSync(BASELINE_PATH)) {
  console.error(`[ttft-baseline] baseline missing: ${BASELINE_PATH} — run --capture first`);
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
// The post-build window starts at the STABLE built boundary — never the
// capture stamp (a re-capture instant is meaningless and, when capture ran
// moments earlier in the same criteria pass, empties the window).
if (!Number.isFinite(baseline.built_at_ms)) {
  console.error('[ttft-baseline] FAIL — no built boundary in the baseline; run --mark-built --story ' + story + ' (optionally --at <iso>) at the moment the new build went live');
  process.exit(1);
}
const post = fetchSamples({ sinceMs: baseline.built_at_ms });

console.log(`[ttft-baseline] baseline warm median=${baseline.warm.median}ms (n=${baseline.warm.n}); post-build warm median=${post.warm.median}ms (n=${post.warm.n})`);
console.log(`[ttft-baseline] baseline cold median=${baseline.cold.median}ms (n=${baseline.cold.n}); post-build cold median=${post.cold.median}ms (n=${post.cold.n})`);

// Fail loud on insufficient evidence — a green exit must mean "measured and
// within bound", never "nothing to measure".
const MIN_POST_TURNS = 5;
if (post.warm.n < MIN_POST_TURNS) {
  console.error(`[ttft-baseline] FAIL — only ${post.warm.n} post-build warm turns (< ${MIN_POST_TURNS}); generate real turns (e.g. the memory fact quiz) and re-run`);
  process.exit(1);
}
if (baseline.warm.median == null) {
  console.error('[ttft-baseline] FAIL — baseline has no warm median to compare against');
  process.exit(1);
}

const delta = post.warm.median - baseline.warm.median;
console.log(`[ttft-baseline] warm median delta = ${delta >= 0 ? '+' : ''}${delta}ms (allowed ≤ ${maxWarmDeltaMs}ms)`);
if (delta > maxWarmDeltaMs) {
  console.error(`[ttft-baseline] FAIL — warm median regressed ${delta}ms > ${maxWarmDeltaMs}ms`);
  process.exit(1);
}
console.log('[ttft-baseline] OK — no warm TTFT regression past the allowed delta');
process.exit(0);
