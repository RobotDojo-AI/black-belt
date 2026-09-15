// lib/context-router.js — invisible context assembly for every chat turn.
//
// Called on every user message. Decides — without any user-visible picker —
// what should be injected into the model's system prompt for this turn:
//
//   1. Always: the 5 timeless identity cards (current projection from log)
//   2. Conditionally: topic contexts whose slug matches the user's intent
//   3. Conditionally: prior-session bookmarks when the user references a
//      previous thread or asks "where were we"
//
// Emits a one-line thinking-indicator text describing ONLY what's unique to
// this turn. If the only work is loading the always-on cards, thinkingText
// is null — no visual noise.
//
// The router is fire-and-forget on failure: a bad Haiku call or missing
// topic never blocks chat. Fall back to cards-only.

// INTELLIGENCE_TIER: extraction — CLASSIFIER_MODEL (Haiku) makes a closed
// routing/classification decision for context assembly; it does not write
// freeform prose to a canonical doc.
export const INTELLIGENCE_TIER = 'extraction';

import { currentSnapshot } from './identity-log.js';
import { renderBlock } from './identity-targets/render.js';
import db from './db.js';
import { llmCreate } from './llm-gateway.js';
import { modelFor } from './model-lane.js';
import { recentThreads, latestBookmark } from './session-log.js';
import { readEntryBody } from './memory.js';
import { getVoice } from './voices.js';

const CLASSIFIER_MODEL = modelFor('fast');
const CLASSIFIER_MAX_TOKENS = 300;

/**
 * Route context for a single chat turn.
 *
 * @param {object} opts
 * @param {string} opts.userMessage    the latest user prompt
 * @param {string} [opts.threadId]     current thread id
 * @param {Array<{role, content}>} [opts.history]  recent turns (oldest first)
 * @param {string} [opts.voice_slug]   if set, prepend the voice profile to the system prompt
 * @returns {Promise<{ systemPrompt: string, thinkingText: string|null, pulled: object }>}
 */
export async function route({ userMessage, threadId = null, history = [], voice_slug = null, activeTopic = null }) {
  const snap = await currentSnapshot();
  const cardsBlock = renderBlock(snap, { includeHeader: false });

  const topics = listAvailableTopics();
  let decision = { topics: [], wantBookmark: false, wantEntityUpdate: false, thinkingText: null };

  if (userMessage && (topics.length || threadId)) {
    try {
      decision = await classifyIntent({ userMessage, topics, history, hasThread: !!threadId });
    } catch (err) {
      console.warn('[context-router] classifier failed:', err.message);
    }
  }

  // st_df0a8d71 D4 — the Haiku-initiated entity-fact writer that used to fire
  // here (extractAndWriteEntityFact) is DELETED. It let LLM output drive
  // entity_facts rows — a violation of the LLM-write boundary (LLMs write
  // canonical docs only; deterministic code writes structure). Plain-chat
  // corrections now flow through the deterministic route-side parser
  // (lib/chat/relationship-intent.js) into the code-validated write path
  // (lib/people-write.js). decision.wantEntityUpdate is still classified for
  // observability, but nothing writes from it.

  const topicBlocks = [];
  for (const slug of decision.topics) {
    // Dedup: skip any slug that is already the active topic (Layer 0 in
    // buildLayeredContext handles it — injecting it twice wastes context window).
    if (activeTopic && slug === activeTopic) continue;
    const t = getTopicContent(slug);
    if (t && t.context_md) {
      // Cap to 16K chars — same guard as chat-context.js Layer 0
      topicBlocks.push(`# Topic: ${t.label || slug}\n\n${t.context_md.trim().slice(0, 16000)}`);
    }
  }

  let bookmarkBlock = '';
  if (decision.wantBookmark) {
    const bk = await latestBookmark();
    if (bk) {
      const body = await readEntryBody(bk.path);
      bookmarkBlock = `# Where we left off (prior session)\n\n${body.trim()}`;
    }
  }

  const voiceContent = voice_slug ? getVoice(voice_slug) : null;

  const parts = [];
  if (voiceContent) parts.push('## Writing Voice', '', voiceContent, '');
  parts.push('## Identity', '', cardsBlock);
  if (topicBlocks.length) parts.push('', '## Active topics for this turn', '', ...topicBlocks);
  if (bookmarkBlock) parts.push('', bookmarkBlock);

  const systemPrompt = parts.join('\n').trim();

  return {
    systemPrompt,
    thinkingText: decision.thinkingText,
    pulled: {
      cards: snap.order.filter((k) => (snap.sections[k]?.body || '').trim()),
      topics: decision.topics,
      bookmark: decision.wantBookmark,
    },
  };
}

function listAvailableTopics() {
  try {
    return db.prepare(
      'SELECT slug, label, description FROM user_topics WHERE visible = 1 AND context_md IS NOT NULL AND length(context_md) > 0',
    ).all();
  } catch {
    return [];
  }
}

function getTopicContent(slug) {
  try {
    return db.prepare('SELECT slug, label, context_md FROM user_topics WHERE slug = ?').get(slug);
  } catch {
    return null;
  }
}

const ROUTER_SYSTEM_PROMPT = `You are a silent context router for a personal AI. Given the user's latest message, decide two things:

1. Which topic contexts are relevant to this turn (from a provided list).
2. Whether the user seems to be picking up from a prior session ("where were we", "continue", "following up on last time", etc).

Also produce a one-line "thinking" indicator for the UI — but ONLY if the pull for this turn is unique/interesting. Generic status like "thinking" or "processing" is forbidden. If nothing unique, return null.

**Rules:**
- Output valid JSON only. No code fences. No prose outside JSON.
- \`topics\` must be a subset of the provided slugs. Omit any slug that's not clearly relevant.
- \`wantBookmark\` = true only if the user is explicitly resuming prior work.
- \`thinkingText\` examples: "pulling health topic + last vitals", "reviewing last Claude Code session", "checking marathon context". If pulling nothing but always-on cards, return null.
- Max 80 chars for \`thinkingText\`. No emoji. No trailing ellipsis.

**Output shape:**
{ "topics": [slug, ...], "wantBookmark": boolean, "wantEntityUpdate": boolean, "thinkingText": string | null }

Additional rule:
- \`wantEntityUpdate\` = true only if the user is asserting a fact about a specific named person, company, or place (e.g. "John left Acme", "Sarah is now at Google", "we moved to Austin"). Question forms, vague references ("someone"), and implicit context do NOT trigger this.`;

async function classifyIntent({ userMessage, topics, history, hasThread }) {
  const topicList = topics.length
    ? topics.map((t) => `  - ${t.slug}: ${t.label || t.slug} — ${t.description || '(no description)'}`).join('\n')
    : '  (no topics available)';
  const recentHistory = (history || []).slice(-3)
    .map((h) => `${h.role}: ${String(h.content).slice(0, 400)}`)
    .join('\n');

  const userPrompt = [
    `Available topics:\n${topicList}`,
    hasThread ? '\nCurrent thread is ongoing (multiple turns exchanged).' : '\nNew thread or first turn.',
    recentHistory ? `\nRecent history:\n${recentHistory}` : '',
    `\nLatest user message:\n${userMessage}`,
    '\nReturn JSON only.',
  ].join('\n');

  const res = await llmCreate({
    model: CLASSIFIER_MODEL,
    max_tokens: CLASSIFIER_MAX_TOKENS,
    system: ROUTER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    // st_4312c9c0 — a human is waiting on this turn. Marks it exempt from the
    // pipeline ceiling and from the no-background-spend switch, so turning
    // background work off degrades the invisible jobs and not the product.
    interactive: true,
  }, 'context-router');

  const text = res.content.find((b) => b.type === 'text')?.text || '{}';
  const jsonStr = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch { return { topics: [], wantBookmark: false, wantEntityUpdate: false, thinkingText: null }; }

  const validSlugs = new Set(topics.map((t) => t.slug));
  return {
    topics: Array.isArray(parsed.topics) ? parsed.topics.filter((s) => validSlugs.has(s)) : [],
    wantBookmark: parsed.wantBookmark === true,
    wantEntityUpdate: parsed.wantEntityUpdate === true,
    thinkingText: typeof parsed.thinkingText === 'string' && parsed.thinkingText.trim()
      ? parsed.thinkingText.trim().slice(0, 80)
      : null,
  };
}

// extractAndWriteEntityFact was removed here (st_df0a8d71 D4): it was the one
// path product-wide where LLM output initiated structured-DB writes
// (entity_facts + needs_regen from a Haiku JSON blob), dead behind two
// disabled flags. Deleted rather than kept flagged-off so the LLM-write
// boundary is clean by construction. Its replacement is the deterministic
// correction path: routes/chat.js → lib/chat/relationship-intent.js →
// lib/people-write.js (code-validated, supersede-archived).

export { classifyIntent, listAvailableTopics, getTopicContent };
