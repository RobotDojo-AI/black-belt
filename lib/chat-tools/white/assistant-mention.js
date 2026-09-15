/**
 * @miyagi product guide helpers (st_42799dbe AC 10, launch rename).
 *
 * Authenticated chat uses the mention detector to route product guidance
 * through a code/docs-grounded stream. This is local product help: it reads
 * canonical repo docs, generated public truth, and small source snippets, while
 * never touching local account data, private user files, or tools.
 *
 * The public projection is still included for launch-safe FAQ truth, but the
 * authenticated @miyagi path is allowed to explain the actual product surfaces
 * and help the user get more value from the right Robot Dojo workflow.
 *
 * WHY here in chat-tools/white/: per the plan path. This is callable
 * This is not registered via defineTool() because @miyagi is a routing
 * signal, not an LLM-callable tool.
 */

// INTELLIGENCE_TIER: orchestration — streams a live @mention chat answer
// straight to the user; nothing here is persisted as a separate canonical
// doc or structured row.
export const INTELLIGENCE_TIER = 'orchestration';

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelFor } from '../../model-lane.js';

// st_74f45a1a R2 — route through lib/llm provider abstraction.
import { getProvider } from '../../llm/index.js';
import { loadContext } from '../../public-chat/core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const PRODUCT_GUIDE_SOURCES = [
  { path: 'architecture/product.md' },
  { path: 'architecture/architecture.md' },
  { path: 'architecture/structure.md', maxChars: 12000 },
  { path: 'docs/workbenches.md' },
  { path: 'agents/agents.md', maxChars: 16000 },
  { path: 'agents/personas/Miyagi.md', section: '### Identity' },
  { path: 'agents/personas/Miyagi.md', section: '### Capabilities' },
  { path: 'config/app-inventory.json' },
  {
    path: 'apps/account/app.js',
    label: 'apps/account/app.js — How To Robot',
    between: ['// ===== How To Robot =====', '// ===== Admin ====='],
  },
  {
    path: 'routes/chat.js',
    label: 'routes/chat.js — @miyagi routing',
    snippets: [
      ['// @miyagi product guidance mode.', "import { isFounderFeedbackMention"],
      ['const eventStream = isFounderFeedbackMention(messages)', 'for await (const event of eventStream)'],
    ],
  },
];

const PRODUCT_GUIDE_RESPONSE_CONTRACT = `# Miyagi product-guide contract

You are Miyagi, the Robot Dojo in-app guide, invoked when the user mentions @miyagi in authenticated chat.

You are an opinionated product concierge, not a router. Your job is to help the user understand Robot Dojo's shape and get more value from it.

Response contract:
1. Answer first: give the direct answer in one or two sentences before any routing.
2. Name the best path only when another surface creates more value. Use the label "Best path:".
3. Market the unlock: explain what that surface gives the user, not just where it lives.
4. Explain the design intent with "Why:" when redirecting: Robot Dojo keeps chat fast, uses Account to feed context, uses topic chat for compounding memory, uses apps for specialized views, and uses the coding agent on the same topic for durable outputs.
5. Give the transition:
   - For UI surfaces, use "Do this:" followed by short bullets.
   - For topic, agent, or chat transitions, use "Use this prompt:" followed by one copy-paste prompt.
   - For product/code changes, name the build pipeline path.
6. Know when not to redirect. If chat is already the best surface, stay in chat and say so briefly only if useful.

Keep it concrete, benefits-led, and friendly. Never make the user feel wrong for asking in chat.

Use only the product docs, generated public repo projection, and source snippets below for Robot Dojo claims. If the sources do not support a claim, say it is not covered. Prefer code and architecture docs over older copy if they conflict. Cite source paths naturally when that helps.

@miyagi is product-guidance mode. It has no tools and should not claim to inspect private local data, email, calendar, health records, files, live account state, databases, or current topic contents. For questions about the user's own data, tell them to use normal chat or a topic instead of @miyagi.

Surface guide:
- Chat: fast answers, product guidance, small corrections, and questions about already-indexed personal context.
- Topic chat: focused memory for one area; use it when repeated questions should compound into better future context.
- Account: setup, integrations, imports, API/model keys, identity, agents, skills, referrals, and workbench launching; use it to feed Robot Dojo better source material.
- Health app: health data review and health-specific notes; use it when the value is trends, markers, and personal health context rather than generic advice.
- Network app: people, companies, places, and relationship management; use it when the value is seeing and improving the user's relationship map.
- Workbench with a coding agent: deep research, analysis, datasets, custom dashboards/apps, long-running artifacts, and build-skill work; use it when the user wants a reusable output, not just an answer.
- Public /ask or /faq: logged-out public docs before install; in-app @miyagi after install.
- Build pipeline: shipped product/code changes go through framing, research, scope, plan, build, qa, and close; use it when the value is safely changing the product, not brainstorming in chat.`;

function cleanText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function extractMarkdownSection(markdown, heading) {
  const lines = String(markdown || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';
  const level = (heading.match(/^#+/) || ['#'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function extractBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return '';
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end === -1 ? undefined : end);
}

function truncateText(text, maxChars) {
  if (!maxChars || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}\n\n[truncated at ${maxChars} chars]`;
}

function readGuideSource(spec) {
  const abs = resolve(REPO_ROOT, spec.path);
  let raw = readFileSync(abs, 'utf8');
  let body = raw;
  if (spec.section) {
    body = extractMarkdownSection(raw, spec.section);
  } else if (spec.between) {
    body = extractBetween(raw, spec.between[0], spec.between[1]);
  } else if (spec.snippets) {
    body = spec.snippets
      .map(([start, end]) => extractBetween(raw, start, end))
      .filter(Boolean)
      .join('\n\n...\n\n');
  }
  body = truncateText(cleanText(body), spec.maxChars);
  if (!body) return '';
  return `## ${spec.label || spec.path}${spec.section ? ` ${spec.section}` : ''}\n\n${body}`;
}

function guideSourcesKey() {
  return PRODUCT_GUIDE_SOURCES.map((spec) => {
    try {
      return `${spec.path}:${statSync(resolve(REPO_ROOT, spec.path)).mtimeMs}`;
    } catch {
      return `${spec.path}:missing`;
    }
  }).join('|');
}

/**
 * Compose the product-guide system prompt from canonical source files and the
 * current public repo projection. Source reads are mtime-cached: the first
 * @miyagi request after a docs/code edit refreshes the corpus, then steady-state
 * requests reuse the same cacheable system blocks.
 *
 * WHY: the previous helper interpolated buildSystemPrompt(...) into a string,
 * which collapsed the generated public projection to "[object Object]". The
 * guide now passes explicit Anthropic system blocks and keeps provenance in the
 * prompt.
 */
function buildProductGuideSystemPrompt() {
  const guideSources = PRODUCT_GUIDE_SOURCES
    .map(readGuideSource)
    .filter(Boolean)
    .join('\n\n---\n\n');
  const publicContext = loadContext('faq-context');

  return [
    {
      type: 'text',
      text: `${PRODUCT_GUIDE_RESPONSE_CONTRACT}\n\n# Actual code and documentation sources\n\n${guideSources}`,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `# Current public repo projection\n\n${publicContext.system}\n\n${publicContext.context}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// Cached so the static system prompt is built once per process, not per request.
let _cachedSystemPrompt = null;
export function getProductGuideSystemPrompt() {
  const key = guideSourcesKey();
  if (!_cachedSystemPrompt || _cachedSystemPrompt.key !== key) {
    _cachedSystemPrompt = { key, system: buildProductGuideSystemPrompt() };
  }
  return _cachedSystemPrompt.system;
}

// Back-compat export name for older tests/callers.
export function getFaqSystemPrompt() {
  return getProductGuideSystemPrompt();
}

export function _clearProductGuideSystemPromptCache() {
  _cachedSystemPrompt = null;
}

export function flattenProductGuideSystemPrompt(system = getProductGuideSystemPrompt()) {
  if (Array.isArray(system)) return system.map((block) => block?.text || '').join('\n\n');
  return String(system || '');
}

const MIYAGI_MENTION_RE = /(^|[^A-Za-z0-9_])@miyagi\b\s*/gi;

/**
 * Strip `@miyagi` from a message content wherever the mention appears.
 * The prefix character is preserved so mid-sentence mentions do not glue
 * words together.
 */
export function stripMention(content) {
  if (typeof content !== 'string') return '';
  return content.replace(MIYAGI_MENTION_RE, (_match, prefix) => prefix).trim();
}

/**
 * Detect whether a chat message body should be routed through the
 * @miyagi action/help path. The contract is: the LAST user message contains
 * (case-insensitive) `@miyagi` as a standalone mention. Earlier messages in the
 * conversation can still mention @miyagi in passing without
 * forcing routing.
 *
 * @param {Array<{role, content}>} messages
 * @returns {boolean}
 */
export function isAssistantMention(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = [...messages].reverse().find(m => m.role === 'user');
  if (!last || typeof last.content !== 'string') return false;
  return /(^|[^A-Za-z0-9_])@miyagi\b/i.test(last.content);
}

/**
 * Return a shallow-copied message list with @miyagi removed from the latest
 * user message only. The original message is still persisted by routes/chat.js;
 * this cleaned copy is just what the model sees.
 */
export function stripAssistantMentionFromMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  const out = messages.map(m => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]?.role === 'user' && typeof out[i].content === 'string') {
      out[i].content = stripMention(out[i].content) || 'Help me use Robot Dojo.';
      break;
    }
  }
  return out;
}

/**
 * Stream a response to the user's @miyagi question using Haiku +
 * the code/docs product-guide corpus as the system prompt. Yields the same
 * { type: 'delta', text } / { type: 'done' } shape that streamChat
 * uses, so the route can pass events straight through to SSE.
 *
 * @param {Array<{role, content}>} messages - the full conversation
 * @param {object} [opts]
 *   - provider: optional pre-built llm provider (for testing); else
 *               resolved lazily via getProvider('anthropic')
 *   - maxTokens: response cap (default 1024)
 */
export async function* streamAssistantMention(messages, opts = {}) {
  const maxTokens = opts.maxTokens || 1024;
  const system = getProductGuideSystemPrompt();

  // Strip the @miyagi prefix from the last user message before sending
  // — keeps the request body clean of routing noise, but the route handler
  // still logs the original message verbatim for transcript fidelity.
  const cleanedMessages = stripAssistantMentionFromMessages(messages)
    .filter((m) => m?.role === 'user' || m?.role === 'assistant')
    .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));

  const provider = opts.provider || await getProvider('anthropic');
  // cache: 'system' — the product guide corpus is large + stable, perfect candidate
  // for prompt-cache hit on every subsequent @miyagi call within 5 min.
  for await (const event of provider.streamChat({
    model: modelFor('fast'),
    max_tokens: maxTokens,
    system,
    messages: cleanedMessages,
    cache: 'system',
  })) {
    if (event.type === 'delta') yield { type: 'delta', text: event.text };
  }
}
