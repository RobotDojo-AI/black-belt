/**
 * Public chat — shared core (runtime-agnostic).
 *
 * Owns the LLM-prompt contract for the public Robot Dojo doc chat:
 *   - message sanitization
 *   - public truth loading (static ESM import — works in Edge + Node)
 *   - system-prompt assembly
 *   - tunable constants (model, limits, allowed contexts)
 *
 * Intentionally has NO runtime-specific imports:
 *   - no `node:fs`, no `node:path`, no `node:crypto`
 *   - no Hono, no Anthropic SDK, no `ai` SDK
 *
 * Both the Edge function (api/public-chat.js) and the local Hono route
 * (routes/public-chat.js) import from here so logic lives exactly once.
 *
 * Public truth is generated at build time from canonical docs and registered
 * public source summaries. Runtime never reads local/private user data.
 */

// INTELLIGENCE_TIER: orchestration — assembles the public-chat prompt and
// streams the live answer to the visitor; nothing here is persisted as a
// separate canonical doc.
export const INTELLIGENCE_TIER = 'orchestration';

import { publicTruth, truthVersion } from './public-truth.js';
import { MODELS } from '../compute-tier.js';

// --- Constants -------------------------------------------------------------

// st_85ca4f3c AC 13 — Haiku for the public FAQ. Sonnet's added quality is
// not the constraint here (the answers come from a fixed, hand-curated corpus
// cached in the prompt); the constraint is warm TTFT ≤ 2.5s. Haiku's lower
// per-token latency + the cached system prefix is what makes the AC budget
// reachable. Other public-chat callers continue to import MODEL and inherit
// this default — the legacy /ask path is being replaced by /faq.
//
// Edge-safe: do not import model-lane.js here. That module reads config from
// disk (node:fs) and Vercel Edge refuses the bundle. Public chat on Vercel
// uses the Anthropic SDK, so this stays MODELS.haiku.
export const MODEL = MODELS.haiku;
export const MAX_TOKENS = 1024;
export const MAX_HISTORY = 8;
export const MAX_MESSAGE_CHARS = 8000;
export const MAX_TRANSCRIPT_MESSAGES = 500;
export const DAILY_LIMIT = 50; // matches config.dailyPublicChatLimit — keep in sync
export const MAX_SOURCE_LEN = 32;

export const DEFAULT_CONTEXT = 'faq-context';
export const TRUTH_VERSION = truthVersion;
export { publicTruth, truthVersion };

export const ALLOWED_CONTEXTS = new Set([
  'ask',
  'faq-context',
  'install-guide',
  'setup-guide',
  'faq-how-it-works',
  'faq-privacy',
  'faq-your-data',
  'faq-pricing',
  'faq-open-source',
  'repo-structure',
]);

// Category-scoped contexts served out of core.json. `context=core:<category>`
// loads only that category's Q&As; `context=core` loads all 30.
export const CORE_CATEGORIES = new Set([
  'product',
  'install',
  'privacy',
  'belts',
  'repo',
  'identity',
  'public-chat',
]);

// Aggregate constants for callers that want a single namespace.
export const core = {
  MODEL,
  MAX_TOKENS,
  MAX_HISTORY,
  MAX_MESSAGE_CHARS,
  MAX_TRANSCRIPT_MESSAGES,
  DAILY_LIMIT,
  MAX_SOURCE_LEN,
  DEFAULT_CONTEXT,
  ALLOWED_CONTEXTS,
  CORE_CATEGORIES,
};

// Rendered-context cache. Public truth is module-scoped; category renderings
// vary per request and are cheap to memoize.
const contextCache = new Map();

// NOTE (st_7b4a0abb AC15): there is deliberately no deterministic
// question→answer FAQ matcher here. The public chat answers every question
// with the LLM over the correct FAQ context (loadContext → buildSystemPrompt).
// A token-overlap matcher that returns a single canned FAQ answer can answer
// the WRONG question (a generic "What is Robot Dojo?" entry matched anything
// mentioning "Robot Dojo"); correctness comes from correct context, not a lookup.

function renderCoreContext(category) {
  const categories = {};
  for (const qa of publicTruth.faq || []) {
    const key = qa.category || 'general';
    if (!categories[key]) categories[key] = [];
    categories[key].push(qa);
  }
  const entries = category
    ? [[category, categories[category] || []]]
    : Object.entries(categories);
  const sections = entries.map(([cat, items]) => {
    const lines = items.map((i) => `Q: ${i.q}\nA: ${i.a}\nSource: ${i.source}`).join('\n\n');
    return `## ${cat}\n\n${lines}`;
  });
  return {
    system: publicTruth.contexts?.core?.system || 'You answer Robot Dojo questions from the current public repo projection.',
    context: [
      `Public truth version: ${truthVersion}`,
      `Sources: ${(publicTruth.sources || []).map((s) => s.path).join(', ')}`,
      sections.join('\n\n'),
    ].filter(Boolean).join('\n\n'),
  };
}

/**
 * Load a context pack by name.
 *
 * Returns `{ system, context }` for the named pack. Unknown names fall back
 * to DEFAULT_CONTEXT rather than throwing — keeps the public endpoint
 * tolerant of stale client-side context strings.
 *
 * Synchronous: no I/O. Static imports resolved at module load.
 */
export function loadContext(name) {
  // Core FAQ: `core` = all categories, `core:<category>` = one category.
  if (typeof name === 'string' && name.startsWith('core')) {
    const parts = name.split(':');
    const category = parts[1];
    const safeCategory = category && CORE_CATEGORIES.has(category) ? category : null;
    const cacheKey = safeCategory ? `core:${safeCategory}` : 'core';
    const cached = contextCache.get(cacheKey);
    if (cached) return cached;
    const rendered = renderCoreContext(safeCategory);
    contextCache.set(cacheKey, rendered);
    return rendered;
  }

  // Legacy context names resolve into the generated public truth contexts.
  const key = ALLOWED_CONTEXTS.has(name) ? name : DEFAULT_CONTEXT;
  return {
    system: publicTruth.contexts?.[key]?.system || 'You answer Robot Dojo questions from the current public repo projection.',
    context: [
      `Public truth version: ${truthVersion}`,
      `Sources: ${(publicTruth.sources || []).map((s) => s.path).join(', ')}`,
      publicTruth.contexts?.[key]?.context || publicTruth.contexts?.[DEFAULT_CONTEXT]?.context || '',
    ].filter(Boolean).join('\n\n'),
  };
}

// Hard restriction appended to every system prompt. The FAQ corpus is the
// only ground truth — refuse anything outside Robot Dojo scope completely.
const FAQ_ONLY_RESTRICTION = `

STRICT SCOPE: You may ONLY answer questions about Robot Dojo from the public repo projection above. You have no access to local/private user data, local files, email, messages, calendar, health data, account data, or authenticated chat history. If the user asks about anything outside Robot Dojo or asks for private/local data, say you can only answer from the public Robot Dojo repo projection and cannot access private local data. Do not invent unsupported claims.`;

/**
 * Assemble the system prompt from a loaded context pack.
 *
 * Returns a SystemBlock[] (an array of Anthropic system blocks) so the
 * provider can attach `cache_control` per block and the canonical corpus
 * stays in a cached prefix across requests (st_85ca4f3c AC 13).
 *
 * Block layout:
 *   1. Canonical corpus + STRICT SCOPE  (cache_control: ephemeral)
 *   2. Owner FAQ notes                  (cache_control: ephemeral, optional)
 *
 * Layer 1 is stable for the life of the deploy + truthVersion. Layer 2 is
 * present only when the caller injects `ownerNotes` (the local Node server
 * path); the Edge function never injects notes and therefore never includes
 * Layer 2 — by design, since the Edge runtime cannot read the operator's
 * local disk. Both layers fit into the cached prefix, so the only uncached
 * prompt fragment per request is the user message itself.
 *
 * Owner notes are deliberately NOT read inside core.js: this module is
 * runtime-agnostic (Edge + Node) and must contain ZERO node built-in imports
 * (see line-11 contract). The node-only loader lives in
 * `lib/public-chat/owner-notes.js` and the local route injects its result
 * here via the second argument (st_85ca4f3c AC 15).
 *
 * Callers that need the legacy string shape (tests, debug dumps) can call
 * `buildSystemPromptString()` instead.
 */
export function buildSystemPrompt(ctx, { ownerNotes } = {}) {
  const blocks = [
    {
      type: 'text',
      text: `${ctx.system}\n\n${ctx.context}${FAQ_ONLY_RESTRICTION}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (typeof ownerNotes === 'string' && ownerNotes.trim()) {
    blocks.push({
      type: 'text',
      text: `## Operator notes (supplemental, layered beneath the docs above)\n\n${ownerNotes}`,
      cache_control: { type: 'ephemeral' },
    });
  }
  return blocks;
}

/** Legacy string-shape variant — kept for tests and debug callers. */
export function buildSystemPromptString(ctx) {
  return `${ctx.system}\n\n${ctx.context}${FAQ_ONLY_RESTRICTION}`;
}

// --- Input sanitization ----------------------------------------------------

/**
 * Normalize incoming `messages[]` to the `{ role, content }` shape the LLM
 * expects. Drops malformed entries, non-user/assistant roles, empty strings,
 * and trims each message to MAX_MESSAGE_CHARS.
 *
 * Returns `null` if the input isn't an array at all — callers treat that as
 * a 400. An empty array is valid output (caller still rejects on length 0).
 */
export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return null;
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.trim()) continue;
    out.push({ role: m.role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  return out;
}

/** UTC YYYY-MM-DD — used as the rate-limit bucket key. */
export function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
