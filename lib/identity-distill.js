// lib/identity-distill.js — programmatic distillation of identity cards
// from the user's full corpus.
//
// White-belt onboarding flow:
//   1. User installs robotdojo, pastes their own API key.
//   2. Data sources come online (existing memory log, emails, iMessages,
//      prior chat exports, pasted extraction dumps from other AIs).
//   3. `distill()` runs — one LLM call per card — producing tight, MECE
//      card bodies grounded in evidence from the user's actual corpus.
//   4. Proposed cards land in the approval UI; user confirms or iterates
//      in chat. Each approved card appends a supersedes entry to the
//      identity log via appendIdentitySection.
//
// MECE rules are enforced in the prompt. The five default cards each answer
// a single verb-question: Who am I? (Identity) · How do I act? (Soul) ·
// How do I reason? (Philosophy) · How do I speak? (Style) · Who am I
// talking to? (User). If a line could fit two cards, the prompt rejects it.

// INTELLIGENCE_TIER: synthesis — distills identity-card prose from the
// user's corpus; this module writes nothing itself (its callers own the
// file write), but the content it produces is the same class of persisted,
// read-back synthesis as entity-card.js and generate-user-md.js.
export const INTELLIGENCE_TIER = 'synthesis';

import { llmCreate } from './llm-gateway.js';
import * as memoryLogSource from './distill-sources/memory-log.js';
import * as identityLogSource from './distill-sources/identity-log.js';
import * as robotdojoChatSource from './distill-sources/robotdojo-chat.js';
import * as emailSource from './distill-sources/email.js';
import { modelFor } from './model-lane.js';

// st_4312c9c0 AC-2 — mechanical, dropped to cheapest. Verified rather than
// assumed: this module writes nothing, and neither of its two callers writes the
// identity-card path (getIdentityCard lives in lib/identity-card.js and reads
// WK_USER_CONTEXT_PATH off disk). Nothing on the prompt-assembly path reads this
// output back, so the substrate argument does not apply.
const DEFAULT_MODEL = modelFor('fast');

const CARDS = [
  { id: 'identity',   verb: 'Who am I?',            focus: "The AI's own name, role, and mission. Stable. TIMELESS." },
  { id: 'soul',       verb: 'How do I act?',        focus: "Behavioral principles. Do/avoid. NOT tone (→ Style). NOT thinking frameworks (→ Philosophy). NOT safety (→ Agents/system). TIMELESS." },
  { id: 'philosophy', verb: 'How do I reason?',     focus: "Decision frameworks + mental models. NOT behavioral rules (→ Soul). NOT tone (→ Style). TIMELESS." },
  { id: 'style',      verb: 'How do I speak?',      focus: "Tone, register, cadence, phrasing — AI→user presentation. Words to prefer/avoid. Stylistic corrections from the user. TIMELESS. ('Voice' reserved for Black Belt BB.2 user-drafting.)" },
  { id: 'user',       verb: 'Who am I talking to?', focus: "TIMELESS anchoring facts: name, family, location, work-style patterns. NOT health state (→ health topic). NOT current job role (→ career topic). NOT active projects (→ project topics)." },
];

// Topics carry time-bounded context that only loads when the topic is
// active — so health numbers don't leak into unrelated coding chats, and
// career exploration doesn't fire during a marathon planning session.
const TOPIC_SLUGS = [
  'health',
  'career',
  'projects',
  'family',
  'finances',
];

/**
 * Gather all available corpus sources.
 * @param {object} [opts]
 * @param {object} [opts.sources] toggle individual sources { memoryLog, identityLog, robotdojoChat, email }
 * @param {object} [opts.limits]  per-source limits
 */
export async function gatherCorpus({ sources = {}, limits = {} } = {}) {
  const enable = {
    memoryLog: sources.memoryLog !== false,
    identityLog: sources.identityLog !== false,
    robotdojoChat: sources.robotdojoChat !== false,
    email: sources.email !== false,
    ...sources,
  };
  const bundles = [];
  if (enable.memoryLog) bundles.push({ name: 'memory-log', items: await memoryLogSource.gather(limits.memoryLog || {}) });
  if (enable.identityLog) bundles.push({ name: 'identity-log', items: await identityLogSource.gather() });
  if (enable.robotdojoChat) bundles.push({ name: 'robotdojo-chat', items: await robotdojoChatSource.gather(limits.robotdojoChat || {}) });
  if (enable.email) bundles.push({ name: 'email', items: await emailSource.gather(limits.email || {}) });
  return bundles;
}

function renderItem(item) {
  const ts = item.timestamp ? `[${item.timestamp}] ` : '';
  const meta = item.type ? `(${item.type}) ` : '';
  const valid = item.validCards && item.validCards.length
    ? ` {validCards: ${item.validCards.join(',')}}`
    : '';
  const desc = item.description ? `${item.description}\n` : '';
  const body = (item.body || '').trim();
  return `### ${ts}${meta}${item.source}${valid}\n${desc}${body}\n`;
}

function renderCorpus(bundles, { maxCharsPerBundle = 100_000 } = {}) {
  const parts = [];
  for (const b of bundles) {
    let block = `# SOURCE: ${b.name} (${b.items.length} entries)\n\n`;
    const lines = [];
    let used = 0;
    for (const it of b.items) {
      const chunk = renderItem(it) + '\n';
      if (used + chunk.length > maxCharsPerBundle) {
        lines.push(`\n_(${b.items.length - lines.length} more entries truncated for length)_\n`);
        break;
      }
      lines.push(chunk);
      used += chunk.length;
    }
    block += lines.join('');
    parts.push(block);
  }
  return parts.join('\n---\n\n');
}

const SYSTEM_PROMPT = `You are distilling a user's identity for Robot Dojo, a personal AI. You are reading their corpus — memory log entries, current identity cards, their own prompts to AI chats, and sent emails — and producing TWO kinds of output:

1. **The 5 default cards** (Identity, Soul, Philosophy, Style, User) — **TIMELESS** content that describes who the user fundamentally IS. Loads on every message.
2. **Topic-context suggestions** — TIME-BOUNDED content that only loads when the relevant topic is active in a conversation.

**The TIMELESS rule — critical:**
The 5 cards describe stable identity. If a fact has a date, a current medication, a current job title, a specific project name, or a career move — it is TIME-BOUNDED and does NOT belong in any card. Route it to the appropriate topic.

Timeless examples (✓ card):
- "The user is a first-principles thinker"
- "The user prefers short responses and direct feedback"
- "The user's family includes a spouse and a young child"
- "The user is cost-conscious and builds systems over processes"

Time-bounded examples (✗ card → ✓ topic):
- "Currently building Robot Dojo" → projects topic
- "Taking chlorthalidone for kidney stones" → health topic
- "Wound down a previous company in Dec 2025" → career topic
- "Exploring PE/VC operating roles" → career topic
- "24-hr urine calcium elevated at 317 mg/dL" → health topic

**Source → card routing — enforce strictly:**
Every corpus entry carries a \`validCards\` list. Ignore an entry when writing a card it's not valid for.

- Memory-log **feedback** entries → valid for all cards (explicit AI-directives).
- Memory-log **user / project / reference** entries → User card only, AND only the TIMELESS parts. Time-bounded content goes to topics.
- Identity-log current → baseline for the same section.
- Robotdojo chat (user prompts) → Soul, Style, User + topics.
- Sent emails / iMessage → User (timeless only) + topics. Explicitly NOT Style or Soul — how someone writes to humans ≠ how they want an AI to speak.

**MECE rules for cards:**
- Each card answers exactly one verb-question.
- If a line fits two cards, rewrite or move it.
- Prefer the user's own words when evidenced.
- No generic slop. No invented content. No time-bounded facts.
- Each card: 150–500 words. Markdown, no top-level heading.

**Topics to produce (if the corpus has signal):**
Return a \`topics\` object keyed by slug. Allowed slugs: ${TOPIC_SLUGS.map((s) => `"${s}"`).join(', ')}.

Each topic body is a self-contained briefing that should make sense when loaded into a conversation about that topic. Typical length 200–1000 words. Include dates when relevant; topic contexts are explicitly time-aware.

**Output format — respond with valid JSON and NOTHING else:**
{
  "identity":   "<body>",
  "soul":       "<body>",
  "philosophy": "<body>",
  "style":      "<body>",
  "user":       "<body>",
  "topics": {
    "health":   "<body or omit if no signal>",
    "career":   "<body or omit>",
    "projects": "<body or omit>",
    "family":   "<body or omit>",
    "finances": "<body or omit>"
  },
  "notes": "<optional: confidence notes, contradictions, signal density per source>"
}`;

function buildUserPrompt(bundles) {
  const cardSpec = CARDS.map((c) => `- **${c.id}** ("${c.verb}") — ${c.focus}`).join('\n');
  const corpus = renderCorpus(bundles);
  return `# CARDS TO PRODUCE

${cardSpec}

# USER CORPUS

${corpus}

# TASK

Return valid JSON with bodies for all five cards per the MECE rules. Do not wrap in markdown code fences.`;
}

/**
 * Run the distillation. Returns proposed card bodies; caller decides whether
 * to append supersedes.
 *
 * @param {object} [opts]
 * @param {string} [opts.model]        default Opus
 * @param {object} [opts.sources]      source toggles
 * @param {object} [opts.limits]       per-source limits
 * @param {object} [opts.corpus]       pre-gathered bundles (skip gather step)
 * @param {number} [opts.maxTokens]    output cap, default 8000
 * @returns {Promise<{ cards: Record<string,string>, notes?: string, usage: object, bundles: Array }>}
 */
export async function distill({
  model = DEFAULT_MODEL,
  sources,
  limits,
  corpus,
  maxTokens = 8000,
} = {}) {
  const bundles = corpus || await gatherCorpus({ sources, limits });
  const userPrompt = buildUserPrompt(bundles);

  const res = await llmCreate({
    model,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  }, 'identity-distill');

  const textBlock = res.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('distill: model returned no text block');
  const raw = textBlock.text.trim();

  // Tolerate occasional code-fence wrapping.
  const jsonStr = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch (err) {
    throw new Error(`distill: JSON parse failed: ${err.message}\n\nFirst 500 chars:\n${raw.slice(0, 500)}`);
  }

  const cards = {};
  for (const c of CARDS) cards[c.id] = (parsed[c.id] || '').trim();

  const topics = {};
  const rawTopics = parsed.topics || {};
  for (const slug of TOPIC_SLUGS) {
    const body = (rawTopics[slug] || '').trim();
    if (body) topics[slug] = body;
  }

  return {
    cards,
    topics,
    notes: parsed.notes || null,
    usage: res.usage,
    bundles: bundles.map((b) => ({ name: b.name, items: b.items.length })),
  };
}

export { CARDS, TOPIC_SLUGS };
