#!/usr/bin/env node
/**
 * Update config/models.json from each provider's models API.
 * Called daily by the maint_models_refresh routine. Falls back to existing
 * values on any fetch failure.
 * Never breaks the server — worst case: stale model IDs stay in place.
 *
 * df_a00a336b: covers all four wired providers (Anthropic, OpenAI, Google, xAI)
 * and writes a two-layer catalog — layer 2 `providers` (best/balanced/fast
 * lanes) plus layer 1 `available` (the raw callable-ID set per provider). Lane
 * assignment is unified on the ordered preferred-ID allowlist (never
 * newest-by-date), so no preview/experimental/latest/specialized id can land in
 * a default slot (AC5). Ollama is intentionally NOT indexed here — local models
 * have no retirement concept and /api/tags is the live signal at request time.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { PREFERRED_IDS, pickLane } from '../lib/model-allowlists.js';

// Deterministic: reads provider list endpoints and writes a config file. No LLM
// call, no DB rows. Declared so check-structure.js stays satisfied if a MODELS.*
// reference ever creeps in.
export const INTELLIGENCE_TIER = 'extraction';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_JSON = resolve(ROOT, 'config', 'models.json');

// Load current config or start from defaults
function loadCurrent() {
  try {
    if (existsSync(MODELS_JSON)) return JSON.parse(readFileSync(MODELS_JSON, 'utf8'));
  } catch {}
  return { providers: {}, available: {}, updated_at: null };
}

// Assign the three lanes for a provider from its live availability set, using
// the ordered preferred-ID allowlist. Only lanes that resolve to a present,
// stable id are included — a lane pickLane can't fill is omitted so the merge
// preserves the last-known lane instead of writing null.
export function assignLanes(provider, availabilitySet) {
  const pref = PREFERRED_IDS[provider] || {};
  const lane = {};
  for (const tier of ['best', 'balanced', 'fast']) {
    const id = pickLane(availabilitySet, pref[tier]);
    if (id) lane[tier] = id;
  }
  return lane;
}

// Each fetcher returns { lane, available } — the derived lane object AND the raw
// callable-ID list — or null on any failure (a null keeps last-known lanes AND
// availability downstream). Lane assignment goes through the shared allowlist,
// never newest-by-date, so AC5 holds uniformly across providers.

async function fetchAnthropicModels(apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=50', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    const available = (data || [])
      .map(m => m.id)
      .filter(id => typeof id === 'string' && id.startsWith('claude-'));
    if (available.length === 0) return null;
    return { lane: assignLanes('anthropic', new Set(available)), available };
  } catch { return null; }
}

async function fetchOpenAIModels(apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    const available = (data || []).map(m => m.id).filter(Boolean);
    if (available.length === 0) return null;
    return { lane: assignLanes('openai', new Set(available)), available };
  } catch { return null; }
}

async function fetchGoogleModels(apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const { models } = await res.json();
    // Availability = ids that can generate chat content, with the models/ prefix
    // stripped so they match the ids the provider module sends.
    const available = (models || [])
      .filter(m => Array.isArray(m.supportedGenerationMethods)
        && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
    if (available.length === 0) return null;
    return { lane: assignLanes('google', new Set(available)), available };
  } catch { return null; }
}

async function fetchXaiModels(apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.x.ai/v1/models', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const { data } = await res.json();
    // Availability = the union of each model's id AND its aliases. xAI pins the
    // dated id but our config references aliases (e.g. grok-4.3), so an alias
    // must count as present or the resolver would fire spuriously.
    const ids = [];
    for (const m of (data || [])) {
      if (m.id) ids.push(m.id);
      if (Array.isArray(m.aliases)) ids.push(...m.aliases);
    }
    const available = [...new Set(ids)].filter(Boolean);
    if (available.length === 0) return null;
    return { lane: assignLanes('xai', new Set(available)), available };
  } catch { return null; }
}

// st_862d73d1 AC10 / df_a00a336b — fold fetched provider lanes into the current
// providers object. Pure: no I/O, deterministic, testable. Widened to four
// providers; every provider key is OPTIONAL so the sealed 2-key stamp test's
// `mergeProviders(CURRENT, { anthropic, openai })` calls stay byte-for-byte
// unaffected (an absent google/xai stays undefined → current lane preserved).
export function mergeProviders(current, { anthropic, openai, google, xai } = {}) {
  const providers = { ...(current?.providers || {}) };
  if (anthropic) providers.anthropic = { ...current?.providers?.anthropic, ...anthropic };
  if (openai)    providers.openai    = { ...current?.providers?.openai, ...openai };
  if (google)    providers.google    = { ...current?.providers?.google, ...google };
  if (xai)       providers.xai       = { ...current?.providers?.xai, ...xai };
  return providers;
}

// df_a00a336b Decision C — fold fetched availability lists into the current
// `available` index. A null/empty list keeps the last-known set for that
// provider (never overwrite a good availability set with empty on a fetch
// failure), mirroring the lane-preservation above.
export function mergeAvailable(current, { anthropic, openai, google, xai } = {}) {
  const available = { ...(current?.available || {}) };
  const next = { anthropic, openai, google, xai };
  for (const [provider, list] of Object.entries(next)) {
    if (Array.isArray(list) && list.length > 0) available[provider] = list;
  }
  return available;
}

// st_862d73d1 AC10 / df_a00a336b — decide whether to write + what to write.
// Returns { changed, next } where `changed` is false when BOTH the merged
// providers AND the merged availability deep-equal the current ones (no date
// churn). `available` is a DEFAULTED 4th param (`current?.available`) placed
// AFTER `today` so the sealed 3-arg `applyModelsUpdate(current, providers, date)`
// calls are unaffected. An availability-only change (a retirement with no lane
// move) still writes.
export function applyModelsUpdate(
  current,
  providers,
  today = new Date().toISOString().split('T')[0],
  available = current?.available,
) {
  const providersChanged = JSON.stringify(providers) !== JSON.stringify(current?.providers || {});
  const availChanged = JSON.stringify(available || {}) !== JSON.stringify(current?.available || {});
  if (!providersChanged && !availChanged) return { changed: false, next: current };
  const next = { ...current, providers, updated_at: today };
  if (available !== undefined) next.available = available;
  return { changed: true, next };
}

async function main() {
  const current = loadCurrent();
  const { secret } = await import('../lib/config.js');

  const [anthropic, openai, google, xai] = await Promise.all([
    fetchAnthropicModels(secret('ANTHROPIC_API_KEY')),
    fetchOpenAIModels(secret('OPENAI_API_KEY')),
    fetchGoogleModels(secret('GOOGLE_AI_API_KEY') || secret('GOOGLE_API_KEY')),
    fetchXaiModels(secret('XAI_API_KEY') || secret('GROK_API_KEY')),
  ]);

  const providers = mergeProviders(current, {
    anthropic: anthropic?.lane,
    openai: openai?.lane,
    google: google?.lane,
    xai: xai?.lane,
  });
  const available = mergeAvailable(current, {
    anthropic: anthropic?.available,
    openai: openai?.available,
    google: google?.available,
    xai: xai?.available,
  });
  for (const p of ['anthropic', 'openai', 'google', 'xai']) {
    if (providers[p]) console.log(`[update-models] ${p}:`, providers[p]);
  }

  const { changed, next } = applyModelsUpdate(current, providers, undefined, available);
  if (!changed) {
    console.log('[update-models] no model changes — leaving', MODELS_JSON, 'untouched (no date churn)');
    return;
  }

  // Atomic temp-then-rename (atomic on POSIX): a reader that catches this
  // mid-write never sees a torn file; it pairs with config.js's keep-last-known.
  const tmp = `${MODELS_JSON}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, MODELS_JSON);
  console.log('[update-models] wrote', MODELS_JSON);
}

// Only run the network path when invoked directly (so the pure functions above
// can be imported by tests without triggering a live fetch).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error('[update-models] failed:', err.message); process.exit(0); }); // never fail the routine
}
