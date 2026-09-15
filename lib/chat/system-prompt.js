/**
 * Assemble the chat system prompt — pure assembly with one DB read.
 *
 * st_74f45a1a R2 amendment — returns an array of Anthropic content blocks
 * instead of a single concatenated string. This is the load-bearing change
 * that makes prompt caching possible: the last block holds volatile
 * per-turn RAG context (no cache_control), the prior blocks hold stable
 * canonical context (cache_control: ephemeral). Cache hits return 90% of
 * the prompt for ~10% of the cost.
 *
 * For backward compatibility, the return value is still consumable as a
 * string via `flattenSystemBlocks(blocks)`. Callers that don't care about
 * caching can ignore the block shape.
 *
 * Block authoring (in order):
 *   Block 0 (cacheable) — base prompt + owner display + belt footer + router
 *                          + injectedContext + user_settings (when router off)
 *   Block 1 (uncached)  — appended by the caller AFTER assembly returns;
 *                          carries volatile RAG/health/calendar context
 *
 * The caller-author pattern keeps this function pure (no async, no RAG
 * await). lib/chat.js orchestrates: call assembleSystemPrompt → await the
 * cached layered context → append as Block 1.
 *
 * ── st_2cd1af73 UNIFIED CONTEXT WATERFALL (owner-settled 2026-06-11) ─────────
 * ONE waterfall for EVERY chat — no topic / no-topic special-casing. The cached
 * prefix is the same ordered stack of byte-stable blocks on every conversation;
 * only the LAST (topic) block is conditional. assembleCachedSystemBlocks() emits:
 *
 *   1. Product prompt (Block A) — generic, zero-personal, zero per-turn variance.
 *   2. Voice canon            — a VERBATIM waterfall of the canonical voice files
 *                               (base.md + chat-app.md + the Miyagi conversation
 *                               sections). Rides ALL chats now, not just no-topic.
 *   3. Identity card          — "## Who I am" (mtime-cached; stable within a day).
 *   4. Brief            — the daily chief-of-staff cheat sheet, read FROM
 *                               DISK (user/contexts/brief.md `## Summary`
 *                               tier), mtime-keyed. NO LLM on any request path:
 *                               the brief is synthesized daily, the chat path
 *                               only reads it. Missing file → deterministic topic
 *                               index (pure SQL, no LLM). This REPLACES the old
 *                               hand-authored grounding tail (deleted entirely).
 *   5. Topic summary          — the SELECTED topic's ~4k `## Summary` tier (the
 *                               owner's summary-on-top contract restored; the full
 *                               doc stays on disk for depth). Omitted when no
 *                               topic is selected.
 *
 * CACHE BREAKPOINTS (Anthropic caches the longest matching prefix ending at a
 * breakpoint that clears the model minimum): after block 4 (the UNIVERSAL entry —
 * A+canon+identity+brief ≈ 3.7+6.4+3.8+4 ≈ 17.9k chars ≥ the 16.4k-char floor)
 * and after block 5 (the topic entry, for topic chats). The MEASURED floor on the
 * chat model is 4096 input tokens ≈ 16.4k chars (live probe, claude-haiku-4-5,
 * 2026-06-11). Because EVERY real conversation now carries A+canon+identity+brief,
 * EVERY conversation clears the floor at the universal breakpoint and reads the
 * same cross-conversation cache entry from turn 2 onward — the old no-topic
 * sub-floor miss is gone.
 *
 * Volatile RAG / entity / interaction / history context is appended AFTER block 5
 * by the caller via withVolatileContext() with NO cache_control, so it varies per
 * turn without invalidating the cached prefix.
 *
 * THE PING (lib/warmup.js) is unchanged: it sends Block A + the voice canon (both
 * ZERO-PERSONAL) and never the identity card, world brief, or topic — so nothing
 * personal rides the 4-minute keep-warm wire. Whether A+canon alone clears the
 * floor is owner-open; the ping's behavior is held EXACTLY as-is by this build.
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ROBOTDOJO_BRAND_PROMPT } from '../brand-persona.js';
import { getIdentityCard } from '../identity-card.js';
import { getEgoBlock } from '../ego-render.js';
import { buildBriefBlock } from './brief.js';
import { buildOwnerVoicePack } from '../session-open-pack.js';
import { readStandingCorrections } from '../standing-corrections.js';

const BASE_SYSTEM_PROMPT = ROBOTDOJO_BRAND_PROMPT;

// Repo root, resolved from this module's location (lib/chat/system-prompt.js →
// up two dirs). Used to read the canonical voice files by absolute path so the
// waterfall works regardless of process CWD.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ── st_2cd1af73 — the VOICE CANON block (block 2 of the unified waterfall) ────
// WHAT IT IS: a VERBATIM waterfall of the canonical voice files, general →
// specific. It carries the assistant's VOICE, STYLE, and conversation-mode
// persona — ZERO personal data. Under the unified waterfall (owner-settled
// 2026-06-11) it rides EVERY chat, not just no-topic ones: the voice contract
// improves every answer, and because it is zero-personal it is also the block the
// keep-warm ping warms alongside Block A (nothing private on the wire).
//
// WHAT CHANGED from the prior C′: the hand-authored grounding/capability tail that
// used to fill C′ (AMBIENT_GROUNDING_TAIL) is DELETED. Its job — telling the model
// how to USE the injected context layers and where the capability edge is — is now
// served by the standing layers themselves (identity card, world brief, topic
// summary, RAG) plus the product prompt's output-format contract. The owner's
// direction was to stop re-authoring refined prose and point at the source files;
// the canon is now exactly the verbatim voice files, nothing more.
//
// WATERFALL ORDER (VOICE_CANON_SOURCES below):
//   1. config/agent-voice/voice.md            — the canonical agent voice register
//   2. config/agent-voice/formatting/web.md — the chat-app channel delta
//   3. agents/personas/Miyagi.md ### Identity / ### Mentor / ### North star
//        — the conversation-mode persona (skips the pipeline/tooling sections,
//          which are about the build pipeline, not the chat product)
//
// BYTE-STABILITY (the cache invariant): the canon has no DB read, no dates, no
// per-turn variance. Its ONLY inputs are the canonical voice files, which change
// when inferred feedback or sample learning updates them. The assembled block is
// memoized keyed on the source files' mtimes: identical mtimes => byte-identical
// bytes on every call, so every turn across every conversation and day sees the
// same bytes (cache_read on turn 2 onward). An edit moves that file's mtime, the
// key rotates ONCE, the block recomputes, steady state resumes — exactly one miss.

/**
 * The voice canon waterfall: ordered, verbatim reads of the canonical voice
 * files, general → specific. Each entry is read from disk, frontmatter + HTML
 * comments stripped (mechanical cleaning, not rewriting), and — when `section` is
 * set — sliced to that single markdown heading so only the conversation-relevant
 * part of a larger file is included. Paths are repo-relative; resolved against
 * REPO_ROOT so the read is CWD-independent.
 *
 * WHY this exact set: base.md + chat-app.md are the canonical agent voice + chat
 * channel. The three Miyagi sections are the conversation-mode persona — Identity,
 * Mentor, and North star describe how the assistant thinks and speaks; the
 * pipeline/tooling/output-contract sections are skipped (build pipeline, not chat).
 */
const VOICE_CANON_SOURCES = [
  { label: 'config/agent-voice/voice.md', path: 'config/agent-voice/voice.md' },
  { label: 'config/agent-voice/formatting/web.md', path: 'config/agent-voice/formatting/web.md' },
  { label: 'agents/personas/Miyagi.md ### Identity', path: 'agents/personas/Miyagi.md', section: '### Identity' },
  { label: 'agents/personas/Miyagi.md ### Mentor', path: 'agents/personas/Miyagi.md', section: '### Mentor' },
  { label: 'agents/personas/Miyagi.md ### North star', path: 'agents/personas/Miyagi.md', section: '### North star' },
];

// The fixed header + intro that frame the voice canon block. Minimal authored
// prose (a title and one orienting sentence) — the owner permits section
// separators/headers naming each source; everything below is verbatim file
// content. No grounding/capability tail anymore (deleted under the unified
// waterfall — the standing layers + product prompt serve that role).
const CANON_HEADER = '# How I show up in this chat';
const CANON_INTRO =
  'This is the standing contract for how I talk. It is assembled verbatim from the product\'s canonical voice files; nothing here is improvised per turn, and it carries no personal facts of its own — those arrive through the context layers below when they bear on the question.';

/**
 * Strip YAML frontmatter and HTML comments from a markdown source, then trim and
 * collapse runs of blank lines. Mechanical cleaning only — no content is
 * rewritten. The canonical voice files open with `---\n...\n---` frontmatter and
 * carry `<!-- HUMAN-AUTHORED -->` / `<!-- source -->` comments that are authoring
 * metadata, not voice; they would only add cache-stable noise to the prompt.
 */
function cleanVoiceMarkdown(markdown) {
  let body = String(markdown || '');
  // Leading YAML frontmatter (only when the file starts with it).
  body = body.replace(/^---\n[\s\S]*?\n---\n/, '');
  // HTML comments anywhere.
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  // Collapse 3+ consecutive newlines (left by stripped comments) to a blank line.
  body = body.replace(/\n{3,}/g, '\n\n');
  return body.trim();
}

/**
 * Extract a single markdown section — the heading line and everything under it
 * up to the next heading of the same or higher level. Used to pull just the
 * conversation-relevant `### Identity` / `### Mentor` / `### North star` sections
 * out of the full Miyagi persona file. Returns '' when the heading is absent.
 */
function extractMarkdownSection(markdown, heading) {
  const lines = String(markdown || '').split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return '';
  const level = (heading.match(/^#+/) || ['#'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

// Memoized assembly keyed on the source files' mtimes. `key` is the join of each
// source file's mtimeMs; when any voice file is refined (e.g. by /correction) its
// mtime changes, the key no longer matches, and the block recomputes exactly
// once. Until then the same bytes are returned verbatim (the cache invariant).
let _canonCache = null; // { key: string, body: string }

/**
 * Compute the mtime cache key: each source file's mtimeMs, in waterfall order,
 * joined. A missing/unreadable file contributes a '0' marker so the key is
 * stable and the recompute path degrades gracefully (that source is skipped in
 * the build, see buildVoiceCanonBlock).
 */
function canonSourcesKey() {
  return VOICE_CANON_SOURCES.map((s) => {
    try {
      return String(statSync(resolve(REPO_ROOT, s.path)).mtimeMs);
    } catch {
      return '0';
    }
  }).join('|');
}

/**
 * Test hook — drop the memoized voice canon block so the next build re-reads the
 * source files. The block is mtime-cached (not a frozen literal); clearing the
 * cache forces a recompute, which is what a test that mutates a source file on
 * disk needs. Safe to call any time.
 */
export function _clearVoiceCanonCache() {
  _canonCache = null;
}

// Back-compat alias for the prior C′ test-hook name. Some external callers /
// tests referenced _clearAmbientWorldMapCache; keep the name working so a
// renamed internal never silently no-ops a cache clear.
export const _clearAmbientWorldMapCache = _clearVoiceCanonCache;

/**
 * Build the VOICE CANON block (block 2 of the unified waterfall): a WATERFALL of
 * verbatim reads of the canonical voice files (VOICE_CANON_SOURCES). ZERO
 * personal data — every input is a PII-free repo file; no DB read, no date. This
 * rides EVERY chat now (topic and no-topic), and is also the second block the
 * keep-warm ping warms alongside Block A.
 *
 * Byte-stable per the cache invariant: the assembled bytes are memoized keyed on
 * the source files' mtimes, so the same bytes are returned on every call until a
 * voice file is refined (then the key rotates once and the block recomputes).
 *
 * Takes (db, now) for signature compatibility with the call sites
 * (assembleCachedSystemBlocks, warmup), but reads neither — the canon carries no
 * DB-derived or time-derived content by design.
 *
 * @param {import('better-sqlite3').Database} [_db] - unused (call-site compat).
 * @param {Date} [_now] - unused (no date in the bytes).
 * @returns {string} the assembled voice canon block (never empty in production).
 */
export function buildVoiceCanonBlock(_db, _now) {
  const key = canonSourcesKey();
  if (_canonCache && _canonCache.key === key) {
    return _canonCache.body;
  }

  const sections = [];
  for (const src of VOICE_CANON_SOURCES) {
    let raw;
    try {
      raw = readFileSync(resolve(REPO_ROOT, src.path), 'utf8');
    } catch {
      // Graceful degradation: a missing voice file drops out of the waterfall
      // rather than throwing. The remaining sources still carry the voice
      // contract; the universal-entry floor is cleared by the identity + world
      // brief blocks downstream regardless.
      continue;
    }
    let body = cleanVoiceMarkdown(raw);
    if (src.section) body = extractMarkdownSection(body, src.section);
    if (!body.trim()) continue;
    // Each included file is preceded by a provenance comment naming its source,
    // so the assembled block self-documents where every part came from. The
    // comment is the only authored text between verbatim file bodies.
    sections.push(`<!-- source: ${src.label} -->\n${body}`);
  }

  const body = [
    CANON_HEADER,
    CANON_INTRO,
    ...sections,
  ].join('\n\n');

  _canonCache = { key, body };
  return body;
}

// (Back-compat alias for the pre-waterfall ambient-block name removed in the
// brief.md rename — the Brief builder lives in ./brief.js.)

// Topic-context section read for the cached prefix (st_2cd1af73 UNIFIED
// WATERFALL — block 5). Reads the query-independent context_md from user_topics,
// so the topic section is stable across every turn of a topic-scoped
// conversation instead of riding the volatile tail.
//
// WHAT CHANGED (owner-settled 2026-06-11): inject the ~4k `## Summary` tier, NOT
// the full ~12k context_md. The owner's summary-on-top contract is restored — the
// summary is the distilled high-signal card; the full doc stays on disk for depth
// (chat reads only the summary). The earlier "full context_md in the cached
// block" approach existed to single-handedly clear the 4096-token cache floor;
// under the unified waterfall the floor is ALREADY cleared at the universal entry
// (A+canon+identity+brief), so block 5 no longer needs to be oversized to make
// caching engage. We cap at TOPIC_SUMMARY_CHAR_BUDGET so a pathological summary
// can't unbound the prompt; the cap is a safety net (the writer already caps the
// summary at ~4k), never a mid-sentence truncation of arbitrary text.
const TOPIC_SUMMARY_CHAR_BUDGET = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_CACHED_TOPIC_CHAR_BUDGET || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 4000;
})();

function stripFrontmatterLocal(markdown) {
  let body = String(markdown || '').trim();
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) body = body.slice(end + 4).trim();
  }
  return body;
}

// Summary/History split parser — identical contract to lib/chat-context.js
// extractSummarySection. Returns the `## Summary` section body when the marker is
// present, else null so the caller keeps the legacy first-N-chars behavior
// (legacy files lead with their chat summary). Anchored to a line so a stray
// "## Summary" inside prose never false-positives.
const TOPIC_SUMMARY_HEADING_RE = /^[ \t]*##[ \t]+Summary[ \t]*$/im;
const TOPIC_SECTION_END_RE = /^[ \t]*(?:---[ \t]*|##[ \t]+\S.*)$/m;

function extractTopicSummary(body) {
  const text = String(body || '');
  const m = TOPIC_SUMMARY_HEADING_RE.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const end = TOPIC_SECTION_END_RE.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim();
}

/**
 * Build the topic-context section for the cached prefix (block 5), or '' when the
 * topic has no context_md (or no topic is set). Accepts a single slug or a
 * comma/array list; multiple topics are concatenated under one `## Topic context`
 * header in list order, capped to the topic SUMMARY budget. Injects the topic's
 * `## Summary` tier (the distilled card) — query-independent and therefore
 * byte-stable across every turn of a topic-scoped conversation. Legacy context_md
 * with no `## Summary` marker falls back to the verbatim head slice (those files
 * lead with their summary), capped to the same budget.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|string[]|null} topic
 * @returns {string}
 */
export function buildTopicContextBlock(db, topic) {
  if (!topic) return '';
  const slugs = (Array.isArray(topic) ? topic : String(topic).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!slugs.length) return '';
  try {
    const stmt = db.prepare(
      'SELECT label, slug, context_md FROM user_topics WHERE slug = ? AND context_md IS NOT NULL AND length(context_md) > 0',
    );
    const bodies = [];
    let remaining = TOPIC_SUMMARY_CHAR_BUDGET;
    for (const slug of slugs) {
      if (remaining <= 0) break;
      const row = stmt.get(slug);
      if (!row?.context_md) continue;
      // Distill, never blindly truncate: prefer the pre-computed Summary tier;
      // legacy files (no marker) fall back to the head slice. Either way capped
      // to the remaining budget.
      const stripped = stripFrontmatterLocal(row.context_md);
      const summary = extractTopicSummary(stripped);
      const body = (summary !== null ? summary : stripped).slice(0, remaining);
      if (!body.trim()) continue;
      const label = row.label || row.slug || slug;
      const section = slugs.length > 1 ? `### ${label}\n${body}` : body;
      bodies.push(section);
      remaining -= section.length;
    }
    return bodies.length ? `## Topic context\n${bodies.join('\n\n')}` : '';
  } catch {
    return '';
  }
}

/**
 * Read user_settings as a flat key:value block, or empty string when the
 * table is absent or empty. Fallback when the context router is disabled.
 */
function buildUserSettingsBlock(db) {
  try {
    const rows = db.prepare('SELECT key, value FROM user_settings').all();
    if (!rows.length) return '';
    const lines = rows.map(r => `- ${r.key}: ${r.value}`);
    return '\n\nUser preferences:\n' + lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * The owner-name preamble line, or '' when no admin display_name is set.
 * st_2cd1af73 AC-1 — the owner's name is PII; it belongs in the IDENTITY cache
 * block (B), not the generic block (A) that the warm ping sends on the wire
 * every 4 minutes. Exported only so assembleCachedSystemBlocks can place it
 * with the identity card.
 */
export function buildOwnerNameLine(db) {
  try {
    const owner = db.prepare('SELECT display_name FROM users WHERE is_admin = 1 LIMIT 1').get();
    if (owner?.display_name) {
      return `The user's preferred name is ${owner.display_name}. Address them as ${owner.display_name}.`;
    }
  } catch { /* non-fatal */ }
  return '';
}

/**
 * Build the stable, cacheable portion of the system prompt as a single text block.
 * This is what every turn within a 5-minute conversation window hits from cache.
 *
 * @param {object} opts
 * @param {string} [opts.systemPrompt] - override for BASE_SYSTEM_PROMPT
 * @param {string} [opts.belt] - 'white' | 'black' (default 'white')
 * @param {string} [opts.routerBlock] - pre-resolved context-router output
 * @param {string} [opts.injectedContext] - extra context (e.g., from URL)
 * @param {boolean} [opts.useTools] - whether tool schemas are advertised on this request
 * @param {import('better-sqlite3').Database} db
 * @returns {string} The cacheable text body
 */
function buildCacheableSystemText(opts, db) {
  const {
    systemPrompt = null,
    belt = 'white',
    routerBlock = '',
    injectedContext = null,
    useTools = false,
    // st_2cd1af73 AC-1 — when assembleCachedSystemBlocks builds the GENERIC
    // Block A (the zero-personal text the warm ping sends), it sets these false
    // so the owner name (PII) and user_settings move to the identity block.
    // Default true preserves assembleSystemPrompt()'s legacy single-block shape
    // and the existing system-prompt tests that assert the owner name lives in
    // the first cacheable block.
    includeOwnerName = true,
    includeUserSettings = true,
  } = opts;

  let system = systemPrompt || BASE_SYSTEM_PROMPT;

  // Anti-hallucinated-tool-call rule (st_8c7b7a6b 2026-05-14):
  // Sonnet sometimes emits literal `<tool_call>...</tool_call>` and
  // `<tool_response>...</tool_response>` XML in its prose output even
  // when no tools are advertised (the model has been trained on tool-use
  // formats and falls into the pattern unbidden). When that happens the
  // user sees a raw JSON dump where the answer should be — exactly the
  // failure caught at /chat/b2e79f3c on 2026-05-14, "tell me about Sam
  // Okafor" came back as a fake `<tool_call>{"name":"search_contacts"...}`
  // block.
  //
  // Cure: explicit instruction. Even with this in the system prompt
  // Sonnet may occasionally slip; pair with a stream-side filter if it
  // persists. Stays in the cacheable prefix so it costs nothing per turn.
  system += '\n\n## Output format — non-negotiable\n';
  system +=
    'Every answer must use the best available combination of injected Robot Dojo context and the model\'s general knowledge. ' +
    'Robot Dojo context is additional evidence, not a replacement for general knowledge. ' +
    'For private/user-world facts, prefer injected local context over general knowledge. ' +
    'When local context is thin, still answer the public/general parts from general knowledge. ' +
    'Do not explain retrieval, context layers, or source mechanics unless the user asks. ' +
    'Never invent private relationship or personal-data facts. ' +
    // st_df0a8d71 D6 — the canonical abstention contract. Anchored-confabulation
    // research (arXiv 2604.25931) shows PARTIAL personal context INCREASES
    // confident hallucination just outside its coverage, so coverage and
    // abstention ship together: any personal/entity fact not present in the
    // provided context gets the canonical phrase — which also makes the
    // absent-class fact quiz gradeable without an LLM judge.
    'When the user asks for a personal or entity fact that is not present in the provided context, reply with the exact phrase "I do not have that on record." — you may offer to take a deeper look, but never guess, infer from tone, or fill the gap from general knowledge.\n';
  if (useTools) {
    system +=
      'Tools are available on this request. Use them only when the user clearly asks you to inspect, create, update, connect, import, remember, or log something. ' +
      'For product questions, answer directly. For destructive actions, require the explicit confirmation named by the tool schema before calling the tool. ' +
      'Never invent tools or write fake tool calls in prose.';
  } else {
    system +=
      'You have no tools available on this request. Answer the user\'s question directly in plain prose or markdown. ' +
      'Do NOT emit any of the following, even as text or examples: `<tool_call>`, `<tool_response>`, `<function_call>`, ' +
      'JSON objects of the shape `{"name":"...","arguments":...}` or `{"id":"...","name":"...","tier":...}`, ' +
      'fake tool-use roleplay where you write your own tool calls and responses. ' +
      'If you have data about a person from the injected context, write that data as natural prose. ' +
      // st_df0a8d71 D6 — the old "Only mention missing local context…" line is
      // replaced by the abstention contract in the shared output-format block
      // above; repeating a softer variant here would dilute the exact-phrase
      // contract the fact quiz grades on.
      'Never pretend to call a tool.';
  }

  if (includeOwnerName) {
    const ownerLine = buildOwnerNameLine(db);
    if (ownerLine) system += `\n\n${ownerLine}`;
  }

  if (belt === 'black') {
    system += '\n\nCURRENT BELT: ' + belt.charAt(0).toUpperCase() + belt.slice(1) +
      '. The user has full access to all available tools including entity extraction, Network intelligence, family tree, and health analysis. Do NOT direct them to upgrade — they are already on the highest relevant tier.';
  } else {
    system += '\n\nCURRENT BELT: White (free). Tools are limited to personal data management, search, and account setup.';
  }

  if (routerBlock) {
    system += '\n\n' + routerBlock;
  } else if (includeUserSettings) {
    system += buildUserSettingsBlock(db);
  }

  if (injectedContext) {
    system += '\n\n--- Additional Context ---\n' + injectedContext;
  }

  return system;
}

/**
 * Build the chat system prompt as an array of content blocks.
 *
 * The first block carries cache_control: {type: 'ephemeral'} so providers
 * that support prompt caching (Anthropic) cache it. The provider's
 * applyCacheToSystem() understands the array shape and passes it through
 * verbatim — the caller (here) decides the boundary.
 *
 * For string-only callers (legacy paths) — call flattenSystemBlocks() to
 * collapse the array back to a single string.
 *
 * @param {object} opts - same as buildCacheableSystemText
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{type:'text', text:string, cache_control?: {type:'ephemeral'}}>}
 */
export function assembleSystemPrompt(opts = {}, db) {
  const cacheable = buildCacheableSystemText(opts, db);
  return [
    { type: 'text', text: cacheable, cache_control: { type: 'ephemeral' } },
  ];
}

/**
 * st_2cd1af73 UNIFIED WATERFALL — assemble the ordered, byte-stable CACHED prefix
 * as the unified block stack. Returns ONLY the cached blocks; the caller appends
 * the volatile (RAG/entity/interaction) tail with withVolatileContext(), which
 * carries no cache_control.
 *
 * BLOCK STACK (every real chat, same order):
 *   1. Block A     — generic product prompt (zero personal, zero per-turn variance)
 *   2. Voice canon — verbatim canonical voice files (zero personal); rides ALL chats
 *   3. Identity    — owner name (PII) + identity card; stable within a day
 *   4. Brief — the daily chief-of-staff cheat sheet, READ FROM DISK
 *                    (mtime-keyed); deterministic topic index when the file is
 *                    absent. No LLM on this path.
 *   5. Topic       — the selected topic's ~4k `## Summary` tier (omitted when no
 *                    topic is selected).
 *
 * CACHE BREAKPOINTS (Anthropic caches the longest matching prefix ending at a
 * breakpoint that clears the model minimum; max 4 breakpoints): we place them on
 * Block A, on the voice canon, on the LAST universal block (block 4 world brief,
 * or block 3 identity if the brief is empty — the UNIVERSAL ENTRY boundary), and
 * on the topic block (the TOPIC ENTRY boundary). That is at most 4 — within the
 * limit — and gives exactly the two boundaries the owner specified: after block 4
 * and after block 5. Because EVERY conversation carries A+canon+identity+brief
 * (~17.9k chars ≥ the ~16.4k-char / 4096-token floor), every conversation clears
 * the floor at the universal entry and reads the same cross-conversation entry
 * from turn 2 onward.
 *
 * BYTE-STABILITY: A is generic (no per-turn variance on the router-off launch
 * path). Canon is mtime-cached verbatim voice (stable within a day). Identity is
 * mtime-cached. Brief is read from a daily file mtime-keyed (stable within a
 * day, rotates once daily). Topic is a query-INDEPENDENT read of the topic
 * summary. So turn N's cached prefix is byte-identical to turn N+1's → cache_read
 * on turn 2 onward, in both topic and no-topic conversations, across conversations.
 *
 * THE PING (lib/warmup.js): warmup calls this with
 * {includeIdentity:false, includeTopic:false, includeAmbient:true}. Under this
 * contract that yields EXACTLY [Block A, voice canon] — both zero-personal — and
 * NEVER the identity card, world brief, or topic. includeIdentity:false is the
 * ping signature; it also FORCE-DISABLES the world brief (block 4) so no personal
 * bytes (calendar, roster, recent activity) ride the 4-minute keep-warm wire.
 * warmup.js is unchanged; this builder maps its existing args to [A, canon].
 *
 * @param {object} opts
 * @param {string} [opts.belt='white']
 * @param {boolean} [opts.useTools=false]
 * @param {string|string[]|null} [opts.topic=null] - active topic slug(s)
 * @param {string} [opts.routerBlock=''] - opt-in context-router output (off by default)
 * @param {string} [opts.injectedContext=null] - rare URL-injected context
 * @param {string} [opts.systemPrompt] - override for the generic base prompt
 * @param {boolean} [opts.includeIdentity=true] - emit block 3 (identity). When
 *   false (the ping/A-only signature) the world brief is also force-disabled so
 *   the result carries zero personal data.
 * @param {boolean} [opts.includeCanon=true] - emit block 2 (voice canon). The ping
 *   leaves this at its default (true) so it warms A + canon.
 * @param {boolean} [opts.includeBrief=true] - emit block 4 (world brief).
 *   Force-disabled whenever includeIdentity is false (no PII on the ping wire).
 * @param {boolean} [opts.includeTopic=true] - emit block 5 (topic summary) when a
 *   topic is set.
 * @param {boolean} [opts.includeAmbient=true] - retained for call-site/back-compat
 *   (the ping passes it). It no longer gates a distinct block — the voice canon is
 *   always block 2 — but is preserved so warmup.js's existing args remain valid.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{type:'text', text:string, cache_control?:{type:'ephemeral'}}>}
 */
export function assembleCachedSystemBlocks(opts = {}, db) {
  const {
    belt = 'white',
    useTools = false,
    topic = null,
    routerBlock = '',
    injectedContext = null,
    systemPrompt = null,
    includeIdentity = true,
    includeCanon = true,
    includeBrief = true,
    includeTopic = true,
    // includeAmbient is retained for warmup.js back-compat; it no longer gates a
    // distinct block (the voice canon is unconditionally block 2). Read it so the
    // destructure documents the accepted arg, but it does not change the stack.
    includeAmbient: _includeAmbient = true,
  } = opts;
  void _includeAmbient;

  const EPH = { type: 'ephemeral' };

  // Universal blocks accumulate as plain text entries; cache_control is applied
  // deliberately at the end (Block A, canon, the LAST universal block, and topic)
  // so we never exceed Anthropic's 4-breakpoint limit and the breakpoints land
  // exactly at the universal-entry and topic-entry boundaries the owner specified.
  const universal = [];

  // Block 1 (A) — GENERIC product prompt: zero personal data, zero per-turn
  // variance. This is the EXACT text the warm ping sends (same builder, same
  // args), so the ping's cache entry is the one a real turn reads.
  // includeOwnerName/includeUserSettings are false here: the owner name and
  // preferences are PII and live in the identity block so nothing personal rides
  // the keep-warm wire.
  const generic = buildCacheableSystemText(
    { systemPrompt, belt, routerBlock, injectedContext, useTools, includeOwnerName: false, includeUserSettings: false },
    db,
  );
  universal.push({ role: 'generic', text: generic });

  // Block 2 — VOICE CANON: verbatim canonical voice files. Zero personal data.
  // Rides every chat. This is the second block the ping warms.
  if (includeCanon) {
    const canon = buildVoiceCanonBlock(db);
    if (canon && canon.trim()) universal.push({ role: 'canon', text: canon });
  }

  // Block 3 — IDENTITY: owner name (PII) + identity card + the who-is-who ego
  // block (st_df0a8d71 D3). Stable within a day / until a graph write. The ego
  // block is a MEMORY read (lib/ego-render.js memo — zero per-turn SQL); it
  // rides this block because identity's cadence class is the correct
  // cache-invalidation cadence for graph truth: byte-stable across turns, one
  // cache miss per graph change. The ping keeps includeIdentity:false, so the
  // ego block never rides the keep-warm wire (nothing personal on the ping).
  // Omitted entirely when all parts are empty so we never emit a blank cached
  // block; ego absence is recorded loudly per turn by the caller (AC-7).
  if (includeIdentity) {
    const ownerLine = buildOwnerNameLine(db);
    const identity = getIdentityCard();
    const ownerVoice = buildOwnerVoicePack();
    const standing = readStandingCorrections();
    const ego = getEgoBlock();
    const parts = [];
    if (ownerLine) parts.push(ownerLine);
    if (identity && identity.trim()) parts.push(identity);
    if (ownerVoice && ownerVoice.trim()) parts.push(ownerVoice);
    if (standing && standing.trim()) parts.push(standing);
    if (ego && ego.trim()) parts.push(ego);
    if (parts.length) universal.push({ role: 'identity', text: parts.join('\n\n') });
  }

  // Block 4 — WORLD BRIEF: the daily chief-of-staff cheat sheet, READ FROM DISK.
  // PERSONAL (calendar, roster, recent activity), so it is FORCE-DISABLED on the
  // ping (includeIdentity:false) — nothing private on the keep-warm wire. No LLM
  // on this path: buildBriefBlock reads the file's Summary tier mtime-keyed,
  // falling back to the deterministic (SQL-only) topic index when the file is
  // absent (fresh install / pre-first-synthesis).
  const emitBrief = includeBrief && includeIdentity;
  if (emitBrief) {
    const brief = buildBriefBlock(db);
    if (brief && brief.trim()) universal.push({ role: 'world_brief', text: brief });
  }

  // Apply cache_control across the universal stack: Block A, the canon, and the
  // LAST universal block (the universal-entry breakpoint). Marking A + canon lets
  // the ping ([A, canon]) match a real boundary; marking the last universal block
  // is the breakpoint after block 4 (or after block 3 when the brief is empty).
  const blocks = universal.map((b) => ({ type: 'text', text: b.text }));
  const markIdx = new Set();
  if (blocks.length) markIdx.add(0);                 // Block A
  const canonIdx = universal.findIndex((b) => b.role === 'canon');
  if (canonIdx !== -1) markIdx.add(canonIdx);        // voice canon
  if (blocks.length) markIdx.add(blocks.length - 1); // last universal block (entry)
  for (const i of markIdx) blocks[i].cache_control = EPH;

  // Block 5 — TOPIC: the selected topic's ~4k Summary tier (query-independent,
  // stable per conversation). Its own cache_control = the topic-entry breakpoint
  // after block 5. Omitted when no topic context resolves.
  if (includeTopic) {
    const topicBlock = buildTopicContextBlock(db, topic);
    if (topicBlock && topicBlock.trim()) {
      blocks.push({ type: 'text', text: topicBlock, cache_control: EPH });
    }
  }

  return blocks;
}

/**
 * Append a volatile (uncached) RAG/context block to a previously assembled
 * system prompt array. The block is added WITHOUT cache_control — provider
 * sees it as fresh content per turn, which is the contract that makes the
 * prior blocks cacheable (cache key requires content stability).
 *
 * @param {Array} blocks - assembleSystemPrompt() return
 * @param {string} text - the volatile RAG/layered context text
 * @returns {Array} new array; input is not mutated
 */
export function withVolatileContext(blocks, text) {
  if (!text) return blocks;
  return [...blocks, { type: 'text', text }];
}

/**
 * Flatten the block array into a single string. For legacy callers (sync
 * chat path in chat.js and ollama) that pass system as a string.
 *
 * @param {string | Array<{text?:string}>} blocks
 * @returns {string}
 */
export function flattenSystemBlocks(blocks) {
  if (!blocks) return '';
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks.map(b => b.text || '').join('\n\n');
}
