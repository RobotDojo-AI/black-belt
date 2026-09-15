/**
 * lib/model-allowlists.js — leaf module for model-lane curation.
 *
 * WHY a dedicated leaf module: both the reader side (lib/config.js's
 * retired-ID fallback resolver) and the writer side (scripts/update-models.js's
 * lane assignment) need the SAME two facts — the ordered per-lane preferred-ID
 * allowlist and the "is this a stable chat model id" predicate. Housing them
 * here, importing NOTHING from lib/, guarantees no import cycle: config.js may
 * import this, and update-models.js may import this, without either pulling the
 * other in. Keep this file dependency-free.
 *
 * The two-layer model (defect df_a00a336b): AVAILABILITY (the callable-ID set a
 * provider currently returns) is separate from LANE ASSIGNMENT (best/balanced/
 * fast). A lane may bind only to an id that is BOTH in the live availability set
 * AND passes isStableChatId — never "newest by date". That is the single AC5
 * enforcement point, applied uniformly to all four providers.
 */

// Ordered, most-preferred first, per provider per lane. Lane assignment
// (update-models.js) walks the lane list; the fallback resolver (config.js)
// walks the flattened union. A brand-new flagship enters a lane only once its
// id is prepended here — the deliberate, curated cost of "never newest-by-date"
// (see df_a00a336b failure manifest: Anthropic auto-promotion regresses, named).
// Lane heads verified live against each provider on 2026-08-10 (real completion
// returned, non-empty, through lib/llm's own seam). OpenAI `*-pro` ids are
// deliberately absent from every lane: they are Responses-API only and 400 on
// /v1/chat/completions. Google has no stable non-preview 3.x Pro, so its best
// lane heads on the newest stable 3.x flash with 2.5-pro behind it.
export const PREFERRED_IDS = {
  anthropic: {
    best:     ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-opus-4-1'],
    balanced: ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4'],
    fast:     ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-haiku-4'],
  },
  openai: {
    best:     ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o3'],
    balanced: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o'],
    fast:     ['gpt-5.4-nano', 'gpt-5-nano', 'gpt-4o-mini', 'gpt-4.1-mini'],
  },
  google: {
    best:     ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-2.0-pro'],
    balanced: ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    fast:     ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'],
  },
  xai: {
    best:     ['grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning'],
    balanced: ['grok-4.3', 'grok-4.20-0309-reasoning'],
    fast:     ['grok-4.20-0309-non-reasoning', 'grok-4.3'],
  },
};

const LANES = ['best', 'balanced', 'fast'];

// Unstable channel markers: an id carrying any of these is a moving pointer or a
// pre-release, never a default lane. Substring match is intentional — it catches
// '-preview', 'claude-3-latest', 'gemini-*-experimental', etc.
const UNSTABLE_MARKERS = ['latest', 'preview', 'experimental'];

// Specialized (non-chat) OpenAI families that appear in /v1/models but must
// never bind a chat lane. The four the defect names — search/audio/realtime/
// image — plus unambiguous non-chat families that share the same list endpoint.
const SPECIALIZED_MARKERS = [
  'search', 'audio', 'realtime', 'image',
  'transcribe', 'whisper', 'tts', 'embedding', 'moderation', 'dall-e',
];

/**
 * True when `id` is a stable, chat-capable model id fit for a default lane.
 * Rejects preview/experimental/latest pointers, the `-exp` shorthand, and the
 * specialized (non-chat) families. This is the AC5 predicate — every lane
 * assignment and every fallback candidate passes through it.
 */
export function isStableChatId(id) {
  if (!id || typeof id !== 'string') return false;
  const s = id.toLowerCase();
  for (const marker of UNSTABLE_MARKERS) if (s.includes(marker)) return false;
  // `-exp` / `.exp` shorthand for experimental (e.g. gemini-2.0-flash-exp).
  if (/(?:^|[-_.])exp(?:[-_.]|$)/.test(s)) return false;
  for (const marker of SPECIALIZED_MARKERS) if (s.includes(marker)) return false;
  return true;
}

/**
 * Pick the model id for one lane: the first entry in `preferredIds` that is
 * BOTH present in `availabilitySet` AND passes isStableChatId. Returns null when
 * none qualifies (caller preserves the last-known lane rather than writing null).
 *
 * @param {Set<string>} availabilitySet - live callable-ID set for the provider
 * @param {string[]} preferredIds - ordered allowlist for this lane
 * @returns {string|null}
 */
export function pickLane(availabilitySet, preferredIds) {
  if (!availabilitySet || typeof availabilitySet.has !== 'function') return null;
  for (const id of (preferredIds || [])) {
    if (availabilitySet.has(id) && isStableChatId(id)) return id;
  }
  return null;
}

/**
 * Flattened, de-duplicated union of a provider's per-lane allowlists, best-tier
 * first. The fallback resolver appends this after the current config lanes so a
 * retired pinned id resolves to the most-preferred present, stable alternative.
 *
 * @param {string} provider
 * @returns {string[]}
 */
export function flatPreferred(provider) {
  const pref = PREFERRED_IDS[provider];
  if (!pref) return [];
  const out = [];
  const seen = new Set();
  for (const lane of LANES) {
    for (const id of (pref[lane] || [])) {
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}
