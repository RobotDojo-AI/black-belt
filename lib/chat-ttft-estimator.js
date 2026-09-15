/**
 * Rolling TTFT estimator (st_8c7b7a6b D5 — ported from old dojo `routes/chat.js:22–34`).
 *
 * In-process per-model rolling window of the last N TTFT measurements. The
 * estimate is the average of the window when ≥3 samples exist, else the
 * static default from `DEFAULT_ESTIMATES`. The frontend reads this on input
 * focus to render "~2.3s expected" in the loading indicator — chat feels
 * faster when the user knows what to expect.
 *
 * Contract:
 *   recordTTFT(model, ms): pushes ms onto the per-model window; trims to MAX.
 *   estimateTTFT(model):   returns { model, estimate_ms, sample_size }.
 *
 * State is module-local. Each process start begins fresh — that is correct:
 * the estimate should reflect recent network conditions, not stale data
 * carried across deploys.
 *
 * No DB. No network. No imports beyond stdlib + the canonical MODELS table.
 */

// INTELLIGENCE_TIER: orchestration — MODELS keys here are only a static
// latency-lookup table; this module makes no LLM call of its own.
export const INTELLIGENCE_TIER = 'orchestration';

import { MODELS } from './compute-tier.js';

const MAX_TTFT_HISTORY = 20;

// Default estimates by model id. New unmapped models fall back to 3000 ms.
// Numbers are the engineering judgment baselines from old dojo; refined by
// the rolling window once ≥3 real samples exist. Model strings come from
// MODELS (single source of truth) — no hardcoded versioned model names here.
export const DEFAULT_ESTIMATES = {
  [MODELS.sonnet]: 3000,
  [MODELS.haiku_v4]: 1800,
};

// Per-model rolling buffer. Map<modelId, number[]>.
const _histories = new Map();

/**
 * Record a first-token latency for the given model. Trims the rolling
 * window to MAX_TTFT_HISTORY entries (oldest first).
 *
 * @param {string} model - model id (e.g. 'claude-sonnet-4-6')
 * @param {number} ms - time-to-first-token in milliseconds
 * @returns {void}
 */
export function recordTTFT(model, ms) {
  if (!model || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
  const key = String(model);
  let arr = _histories.get(key);
  if (!arr) { arr = []; _histories.set(key, arr); }
  arr.push(ms);
  // Trim oldest while over the window. Loop rather than shift-once so a
  // mis-set MAX (or replay) still self-corrects.
  while (arr.length > MAX_TTFT_HISTORY) arr.shift();
}

/**
 * Estimate the TTFT for the given model. Returns the rolling average when
 * the window has ≥3 samples; otherwise the static default.
 *
 * Always returns the full envelope — the route handler returns this object
 * directly as the JSON body of `GET /api/chat/ttft-estimate`.
 *
 * @param {string} model - model id
 * @returns {{model: string, estimate_ms: number, sample_size: number}}
 */
export function estimateTTFT(model) {
  const key = model ? String(model) : MODELS.sonnet;
  const arr = _histories.get(key) || [];
  const sample_size = arr.length;
  // WHY ≥3: a single anomalous sample (e.g. cold-boot 8s outlier) would
  // skew the estimate badly. Three samples is enough to median out the
  // worst single-point noise while still reacting within a few turns to
  // sustained network changes.
  if (sample_size >= 3) {
    const sum = arr.reduce((a, b) => a + b, 0);
    const estimate_ms = Math.round(sum / sample_size);
    return { model: key, estimate_ms, sample_size };
  }
  const fallback = DEFAULT_ESTIMATES[key] ?? 3000;
  return { model: key, estimate_ms: fallback, sample_size };
}

/**
 * Test-only helper. Drops all recorded history so unit tests don't leak
 * state across cases.
 */
export function _resetTTFTHistory() {
  _histories.clear();
}

// Exported for tests that want to assert on the cap.
export const _MAX_TTFT_HISTORY = MAX_TTFT_HISTORY;
