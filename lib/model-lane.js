/**
 * lib/model-lane.js — ask for a lane, get whatever model that lane means today.
 *
 * st_4312c9c0. The system used to name Anthropic models at 40-odd call sites,
 * so changing provider or model generation meant editing 40 files, and the
 * spend policy was written in a vocabulary only one vendor understands.
 *
 * Three lanes, provider-agnostic:
 *
 *   fast      cheapest — extraction, classification, routing, bulk sweeps
 *   balanced  mid      — substrate synthesis, hard mechanical input
 *   best      top      — reserved; nothing runs here by default
 *
 * config/tier-policy.json names the active provider and each call site's lane
 * ceiling. config/models.json maps provider × lane → a concrete model id, and
 * scripts/update-models.js keeps that table current against what each vendor
 * actually serves. So:
 *
 *   - switching the whole application to Google is one field in tier-policy.json
 *   - a new model generation is picked up by update-models.js with no code edit
 *   - a call site never names a vendor or a model
 *
 * MODELS.* is not deprecated: the gateway's reverse map, the pricing table, and
 * the tier gate all need model vocabulary by definition. What changes is that
 * CALL SITES should ask for a lane, and new ones must.
 */

// INTELLIGENCE_TIER: orchestration — resolves which model another tier's call
// will use. Makes no call itself.
export const INTELLIGENCE_TIER = 'orchestration';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getModel } from './config.js';
import { getLlmProvider } from './llm-provider-pref.js';

const POLICY_PATH = join(import.meta.dirname, '..', 'config', 'tier-policy.json');

export const LANES = Object.freeze({ FAST: 'fast', BALANCED: 'balanced', BEST: 'best' });

// config/models.json speaks fast|balanced|best already, so the mapping is the
// identity. Kept explicit rather than implicit: if the catalog ever renames a
// lane, this is the one line that changes instead of every caller.
const LANE_TO_CATALOG_KEY = { fast: 'fast', balanced: 'balanced', best: 'best' };

let _cached = null;
let _cachedMtime = 0;

function policy() {
  try {
    const { mtimeMs } = existsSync(POLICY_PATH) ? { mtimeMs: Date.now() } : { mtimeMs: 0 };
    if (_cached && mtimeMs === _cachedMtime) return _cached;
    _cached = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
    _cachedMtime = mtimeMs;
    return _cached;
  } catch {
    // A missing or malformed policy must not take the application down. Fall
    // back to the cheapest safe posture rather than to the most expensive one:
    // the failure mode of guessing wrong here is a bill, not an outage.
    return { provider: 'xai' };
  }
}

/** The provider every application call currently routes to. */
export function activeProvider() {
  return getLlmProvider() || policy().provider || 'xai';
}

/**
 * modelFor(lane, opts) → concrete model id for the active provider.
 *
 * @param {'fast'|'balanced'|'best'} lane
 * @param {object} [opts]
 * @param {string} [opts.provider] — override the active provider for one call
 *   (the fanout skill compares vendors; nothing else should need this).
 * @returns {string}
 */
export function modelFor(lane, { provider } = {}) {
  const key = LANE_TO_CATALOG_KEY[lane];
  if (!key) throw new Error(`modelFor: unknown lane "${lane}" — expected fast | balanced | best`);
  return getModel(provider || activeProvider(), key);
}

/**
 * laneCeilingFor(path) → the lane a call site is allowed to reach, or null when
 * it is unclassified. Lets a caller self-check rather than discovering its
 * ceiling from a failing commit.
 *
 * @param {string} repoRelativePath e.g. 'lib/entity-enrich.js'
 */
export function laneCeilingFor(repoRelativePath) {
  const sites = policy().app_call_sites || {};
  return sites[repoRelativePath]?.max_lane ?? null;
}
