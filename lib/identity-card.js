/**
 * lib/identity-card.js
 *
 * User identity loader for the chat context stack. Reads
 * `user/workbenches/user/wk_user/context.md` from disk and exposes the body
 * via getIdentityCard() so chat-context.js can inject it into every system
 * prompt as Layer -1 (highest-priority always-on context).
 *
 * Why this exists: wk_user/context.md is the dense per-user identity
 * distillation — name, family, work, communication style, behavior priors.
 * Before this module wired the file directly into the prompt, the model had
 * no view of the user on the default chat path (st_8c7b7a6b turned tools
 * off). Without a direct identity injection, RAG was the only path; for
 * identity-shaped questions ("what do you know about me") RAG is the wrong
 * retrieval mechanism — the answer must be in the system prompt every turn,
 * not retrieved.
 *
 * WHY the path is `wk_user/context.md` (st_0c491456): the legacy
 * profile target (since retired) opened with two `<!-- include: -->`
 * fragments (~5745 chars of voice/formatting style notes for agents). The
 * 4000-char budget slice never reached the owner's name, family, or
 * career. The fix is the
 * dedicated identity distillation file — authored explicitly to fit the
 * budget, identity-first, no fragments. The fragments are agent-session
 * instructions and live in config/agent-voice/ and wk_user/user-voice/.
 *
 * WHY mtime cache vs in-memory snapshot: wk_user/context.md is rewritten
 * by the identity distill pipeline (generate-user-md.js → wk_user/USER.md,
 * with a synthesis pass into context.md) and by the owner editing it. Reading
 * on every chat turn would be a 4KB disk hit ~10x per turn across context-
 * cache misses. We cache the body keyed by mtime; on the rare write we
 * re-read.
 *
 * WHY char cap (USER_CARD_CHAR_BUDGET): the chat prompt has a fixed token
 * budget; identity should occupy ~1KB and let topic context + RAG own the
 * rest. The cap is conservative — 4000 chars ≈ 1000 tokens. context.md is
 * authored to fit within it. This constant is the SOLE budget enforcement
 * for wk_user/context.md (it is gitignored user PII; surfaces.json tracks
 * only repo-committed canonical surfaces).
 *
 * WHY boundary-aware truncation: when context.md grows past the budget
 * (owner edit, distill regen producing a slightly longer doc), a naive
 * .slice(0, BUDGET) cuts mid-sentence and presents the model with a
 * truncated fragment that may misrepresent a fact. truncateAtBoundary()
 * lands the cut at a markdown heading or paragraph break so the truncated
 * text is well-formed and self-contained. Below a 45% threshold the
 * boundary-fallback degrades to the raw slice (a malformed-but-truncated
 * doc is better than no identity).
 *
 * The function never throws — missing file or read error returns ''.
 * That degrades gracefully: chat still works, just without the identity
 * preamble.
 */

import { readFileSync, statSync } from 'node:fs';
import { WK_USER_CONTEXT_PATH } from './robotdojo-paths.js';

const IDENTITY_USER_PATH = WK_USER_CONTEXT_PATH;

// Cap to keep identity from crowding topic + RAG. Identity is "who I am",
// not "what I'm working on" — the rest of the layers carry that.
export const USER_CARD_CHAR_BUDGET = 4000;

let _cached = null; // { mtimeMs, body }

/**
 * Truncate markdown at the nearest preceding section / paragraph boundary
 * within `limit`. Mirrors the boundary policy used by lib/chat-context.js
 * for entity-card truncation: prefer a `\n## ` (section), then `\n---`
 * (horizontal rule), then a blank-line paragraph break. Only accept a
 * boundary that lands above 45% of the limit — below that, the slice is
 * preserved raw so we keep meaningful identity content over a tidy break.
 *
 * Exported for testability.
 */
export function truncateAtBoundary(markdown, limit = USER_CARD_CHAR_BUDGET) {
  const text = String(markdown || '').trim();
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const boundary = Math.max(
    slice.lastIndexOf('\n## '),
    slice.lastIndexOf('\n---'),
    slice.lastIndexOf('\n\n')
  );
  if (boundary > limit * 0.45) return slice.slice(0, boundary).trim();
  return slice.trim();
}

/**
 * Return the identity user card body wrapped in a "## Who I am" section
 * suitable for injection into a chat system prompt.
 *
 * Returns '' when the file is missing or unreadable.
 * Returns '' when the file exists but is empty.
 */
export function getIdentityCard() {
  let mtimeMs;
  try {
    mtimeMs = statSync(IDENTITY_USER_PATH).mtimeMs;
  } catch {
    return '';
  }

  if (_cached && _cached.mtimeMs === mtimeMs) {
    return _cached.body;
  }

  let raw;
  try {
    raw = readFileSync(IDENTITY_USER_PATH, 'utf8');
  } catch {
    return '';
  }

  // wk_user/context.md has no frontmatter by contract — the file is the
  // identity distillation, identity-first, opening with the owner's name.
  // No `---...---` strip needed; trim only.
  const body = truncateAtBoundary(raw.trim(), USER_CARD_CHAR_BUDGET);

  const wrapped = body ? `## Who I am\n${body}` : '';
  _cached = { mtimeMs, body: wrapped };
  return wrapped;
}

/**
 * Test hook: clears the in-process cache so the next getIdentityCard()
 * re-reads from disk. Not exported for production callers — exported only
 * so AC-3 / AC-4 sentinel tests in tests/ can force a re-read after
 * writing to context.md.
 */
export function _clearIdentityCardCache() {
  _cached = null;
}
