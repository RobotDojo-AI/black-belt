/**
 * lib/work-item-title.js — st_8745309c follow-on.
 *
 * Plain-English title derivation for a work item (story). Used by:
 *   - scripts/robotdojo-session-title.zsh (via scripts/robotdojo-title.js)
 *     to set the terminal tab title at session launch.
 *   - scripts/robotdojo-statusline.sh (via the same helper) to set the
 *     Claude Code statusLine for the active session.
 *
 * Title resolution order for a story_id:
 *   1. meta.title — if the story author wrote a plain-English title, use it
 *      verbatim. Authoritative override; never re-cased.
 *   2. Derive from meta.slug — replace hyphens with spaces, title-case each
 *      word, then upper-case any token in the KNOWN_ACRONYMS set.
 *   3. Idle / missing story / unreadable meta → empty string. Caller decides
 *      whether to render just the label or nothing.
 *
 * Pure: no LLM, no DB, no network. File I/O only (meta.json read).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PIPELINE_STORIES_DIR } from './robotdojo-paths.js';

// Acronyms that should display upper-case rather than title-case. Drawn
// from terms that appear in actual story slugs and that read wrong as
// "Ide", "Api", "Sql". Keep this set narrow: every entry must be a term
// the owner would write capitalised in prose. Adding "OS" here would
// upcase the "os" in "close" if a slug ever contained it, so the matcher
// is whole-token only — see deriveFromSlug.
const KNOWN_ACRONYMS = new Set([
  'IDE', 'AI', 'DB', 'API', 'QA', 'UI', 'UX', 'RAG',
  'CLI', 'PR', 'ID', 'URL', 'SQL', 'LLM', 'OS',
]);

// Sentinels that mean "no active story". The zsh wrapper writes the
// literal string "idle" when no story is active; the empty string covers
// the case where the env var is set but blank.
function isIdleStoryId(storyId) {
  if (storyId == null) return true;
  const s = String(storyId).trim();
  if (s === '') return true;
  if (s === 'idle') return true;
  return false;
}

/**
 * Derive a plain-English title from a slug.
 *
 *   "cross-ide-session-coordination" → "Cross IDE Session Coordination"
 *   "memory-architecture"            → "Memory Architecture"
 *
 * Splits on hyphens, then for each token: if the UPPER-CASE form is in
 * KNOWN_ACRONYMS, render upper-case; otherwise title-case (first char
 * upper, rest lower). Empty tokens (from leading/trailing/double hyphens)
 * are dropped.
 */
export function deriveFromSlug(slug) {
  if (typeof slug !== 'string' || slug.trim() === '') return '';
  return slug
    .split('-')
    .filter(tok => tok.length > 0)
    .map(tok => {
      const upper = tok.toUpperCase();
      if (KNOWN_ACRONYMS.has(upper)) return upper;
      return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Read a story's meta.json and return its parsed object, or null on any
 * failure (missing dir, missing file, malformed JSON). Graceful — the
 * statusLine must never error.
 */
function readMeta(storyId) {
  const metaPath = join(PIPELINE_STORIES_DIR, storyId, 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    const raw = readFileSync(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Return the plain-English title for a story_id, or empty string.
 *
 *   - meta.title present and non-empty → returned verbatim (author's choice
 *     wins; we do not re-case or normalize it).
 *   - else meta.slug present → derived via deriveFromSlug.
 *   - else story_name (legacy field) → derived via deriveFromSlug.
 *   - else (no meta, idle id, or no slug/name) → "".
 */
export function workItemTitle(storyId) {
  if (isIdleStoryId(storyId)) return '';
  const meta = readMeta(String(storyId));
  if (!meta) return '';
  if (typeof meta.title === 'string' && meta.title.trim() !== '') {
    return meta.title.trim();
  }
  if (typeof meta.slug === 'string' && meta.slug.trim() !== '') {
    return deriveFromSlug(meta.slug);
  }
  if (typeof meta.story_name === 'string' && meta.story_name.trim() !== '') {
    return deriveFromSlug(meta.story_name);
  }
  return '';
}
