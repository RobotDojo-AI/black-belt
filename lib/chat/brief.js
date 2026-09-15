/**
 * Brief — the cached chat block 4 reader + the deterministic topic index
 * (st_2cd1af73 UNIFIED CONTEXT WATERFALL).
 *
 * The world brief is a chief-of-staff cheat sheet synthesized DAILY by
 * scripts/synthesize-brief.js into ONE canonical markdown
 * (user/contexts/brief.md). This module is the READ side: chat injects the
 * file's `## Summary` tier as cached block 4, keyed on the file's mtime so the
 * bytes are stable within a day and rotate exactly once a night (correct — the
 * brief is a daily artifact).
 *
 * NO LLM ON ANY REQUEST PATH: the brief is read from disk here, never
 * synthesized per turn. When the file is missing (fresh install, before the
 * first synthesis), buildBriefBlock falls back to the DETERMINISTIC topic
 * index (buildDeterministicTopicIndex) — pure SQL, no LLM — so a brand-new chat
 * still clears nothing-but-truth into block 4 rather than an empty block.
 *
 * The deterministic topic index lives here (not in the synthesis script) so BOTH
 * the synthesis script (as the index sub-section of the brief) AND the chat
 * fallback (when the file is absent) build it from the identical code — the
 * fallback is then byte-coherent with what the maint_brief routine will later write.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { USER_CONTEXTS_DIR } from '../robotdojo-paths.js';

// Canonical on-disk location. user/contexts is a symlink to ~/.robotdojo/contexts
// on the owner box; USER_CONTEXTS_DIR resolves the real directory either way, so
// the synthesis writer and this reader always agree on one path. The env override
// (ROBOTDOJO_BRIEF_PATH) exists for tests, which point both the writer and
// reader at a temp fixture; production never sets it.
export const BRIEF_PATH = process.env.ROBOTDOJO_BRIEF_PATH
  ? resolve(process.env.ROBOTDOJO_BRIEF_PATH)
  : resolve(USER_CONTEXTS_DIR, 'brief.md');

// Tier budgets. Summary ~4k is the owner spec for block 4; Micro ~1k is the
// optional ultra-compact tier (topic index alone). Env-overridable per build
// conventions. The injector NEVER mid-truncates prose to hit these — the
// synthesis writes the Summary already capped, and the reader selects the whole
// `## Summary` section (a pre-computed unit), not a char slice of arbitrary text.
function envInt(name, fallback) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}
export const BRIEF_SUMMARY_BUDGET = envInt('ROBOTDOJO_BRIEF_SUMMARY_CHARS', 4000);
export const BRIEF_MICRO_BUDGET = envInt('ROBOTDOJO_BRIEF_MICRO_CHARS', 1000);

// Number of topics in the compressed index, and the gist length per topic. The
// index inside a SYNTHESIZED brief is "a few hundred chars" (owner spec): label +
// a short gist. In the DETERMINISTIC fallback (no synthesis yet) the index is the
// whole brief, so the gist runs longer there to (a) be genuinely useful and (b)
// fill block 4 toward its ~4k budget so the universal cache entry clears the
// 4096-token floor without depending on the daily synthesis having run.
const TOPIC_INDEX_MAX = envInt('ROBOTDOJO_BRIEF_TOPIC_INDEX_MAX', 26);
const TOPIC_GIST_CHARS = envInt('ROBOTDOJO_BRIEF_TOPIC_GIST_CHARS', 90);
const TOPIC_GIST_CHARS_FALLBACK = envInt('ROBOTDOJO_BRIEF_TOPIC_GIST_CHARS_FALLBACK', 180);
// Core roster size for the deterministic fallback's "inner circle" block.
const FALLBACK_ROSTER_MAX = envInt('ROBOTDOJO_BRIEF_FALLBACK_ROSTER_MAX', 12);

/**
 * Strip leading YAML frontmatter from a markdown body. Local copy (no import
 * cycle with chat-context.js); identical mechanical strip.
 */
function stripFrontmatter(markdown) {
  let body = String(markdown || '').trim();
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) body = body.slice(end + 4).trim();
  }
  return body;
}

/**
 * Extract the first meaningful sentence/gist from a topic's context_md Summary,
 * compressed to a short label-line tail. Reads the `## Summary` section when
 * present (the synthesized exec summary), else the head of the stripped body
 * (legacy files lead with their summary). Returns a single cleaned line, ≤ the
 * gist budget — never a mid-word cut past the budget; we cut at a word boundary.
 */
function topicGist(contextMd, maxChars = TOPIC_GIST_CHARS) {
  const body = stripFrontmatter(contextMd);
  if (!body) return '';
  // Prefer the Summary section body.
  let text = body;
  const m = /^[ \t]*##[ \t]+Summary[ \t]*$/im.exec(body);
  if (m) {
    const after = body.slice(m.index + m[0].length);
    const end = /^[ \t]*(?:---[ \t]*|##[ \t]+\S.*)$/m.exec(after);
    text = (end ? after.slice(0, end.index) : after);
  }
  // First line of real prose → the gist seed. Skip headings, fences, and
  // non-prose noise: session markers (`_Session: …_`), emphasis-only/italic
  // header lines, marker tokens, and lines with no letters. This is the "distill,
  // don't grab the first byte" guard — a topic doc may open with a metadata line
  // before its substance.
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => {
      if (!l || l.startsWith('#') || l.startsWith('---')) return false;
      // strip surrounding markdown emphasis to test the underlying text
      const bare = l.replace(/^[*_~`>\s-]+/, '').replace(/[*_~`\s]+$/, '');
      if (!bare) return false;
      if (/^session\s*[:\-]/i.test(bare)) return false;      // "_Session: 2026-…_"
      if (/^_marker_/i.test(bare)) return false;             // authored marker tokens
      if (!/[a-z]/i.test(bare)) return false;                // no letters → not prose
      // emphasis-only header like "*Topic Context for …*" — keep only if it reads
      // like a sentence (has a verb-ish length), else skip the wrapper line.
      return bare.length >= 12;
    });
  if (!firstLine) return '';
  // Strip leading/trailing markdown emphasis so the gist is clean prose.
  const cleaned = firstLine
    .replace(/\s+/g, ' ')
    .replace(/^[*_~`>\s-]+/, '')
    .replace(/[*_~`\s]+$/, '')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  // Cut at the last word boundary inside the budget — distill, never mid-word.
  const slice = cleaned.slice(0, maxChars);
  const sp = slice.lastIndexOf(' ');
  return (sp > maxChars * 0.5 ? slice.slice(0, sp) : slice).trim() + '…';
}

/**
 * Build the compressed topic index — `label — gist` per visible topic, ordered
 * by the user's own sort order. Pure SQL + string compression (no LLM). Shared
 * by the synthesis script (the brief's `### Topic index` sub-section) and the
 * chat fallback (block 4 when brief.md is absent), so both render the same
 * bytes from the same DB state.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} [gistChars] - per-topic gist length (the fallback path passes a
 *   longer value so block 4 fills toward its budget; the synthesis path uses the
 *   shorter default).
 * @returns {string} newline-joined `- Label — gist` lines, or '' when no topics
 *   carry usable context.
 */
export function buildDeterministicTopicIndex(db, gistChars = TOPIC_GIST_CHARS) {
  try {
    const rows = db.prepare(`
      SELECT label, slug, context_md
      FROM user_topics
      WHERE visible = 1 AND context_md IS NOT NULL AND length(context_md) > 0
      ORDER BY sort_order, label
      LIMIT ?
    `).all(TOPIC_INDEX_MAX);
    if (!rows.length) return '';
    const lines = [];
    for (const r of rows) {
      const label = r.label || r.slug;
      const gist = topicGist(r.context_md, gistChars);
      lines.push(gist ? `- ${label} — ${gist}` : `- ${label}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Deterministic core-roster lines for the fallback brief — the inner-circle
 * people (n2 Family/Partners/Core), one line each, ranked. Pure SQL, no LLM.
 * Mirrors the synthesis roster so the fallback has the same useful shape.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string} newline-joined `- Name (relation, company)` lines, or ''.
 */
export function buildDeterministicCoreRoster(db) {
  try {
    const rows = db.prepare(`
      SELECT display_name, short_name, n2, last_seen,
             (SELECT name FROM companies WHERE id = people.company_id) AS company
      FROM people
      WHERE COALESCE(archived,0)=0 AND n2 IN ('Family','Partners','Core')
      ORDER BY CASE n2 WHEN 'Family' THEN 0 WHEN 'Partners' THEN 1 ELSE 2 END, score DESC
      LIMIT ?
    `).all(FALLBACK_ROSTER_MAX);
    if (!rows.length) return '';
    return rows.map((r) => {
      const name = r.short_name || r.display_name;
      const co = r.company ? `, ${r.company}` : '';
      const last = r.last_seen ? `, last ${String(r.last_seen).slice(0, 10)}` : '';
      return `- ${name} (${r.n2 || ''}${co}${last})`;
    }).join('\n');
  } catch {
    return '';
  }
}

/**
 * Extract the `## Summary` section body from the brief markdown. Stops at
 * the first `---` fence or following `##` heading (e.g. `## Micro`). Returns the
 * trimmed section, or '' when no Summary heading exists.
 */
function extractBriefSummary(markdown) {
  const body = stripFrontmatter(markdown);
  const m = /^[ \t]*##[ \t]+Summary[ \t]*$/im.exec(body);
  if (!m) return '';
  const after = body.slice(m.index + m[0].length);
  const end = /^[ \t]*(?:---[ \t]*|##[ \t]+\S.*)$/m.exec(after);
  return (end ? after.slice(0, end.index) : after).trim();
}

// Memoized read keyed on the file's mtime. The brief rotates once a night; until
// the mtime changes, every chat turn (across every conversation, across the day)
// gets byte-identical bytes — the strongest cache key (identical content =>
// cache_read on turn 2 onward of the universal entry). When maint_brief rewrites the
// file, mtime moves, the key rotates ONCE, the block recomputes, steady state
// resumes on the new bytes. A missing file is also memoized (as a fallback key)
// so the deterministic-index path isn't re-walked every turn either.
let _briefCache = null; // { key: string, body: string }

/** mtime key for the brief file, or 'absent' when it does not exist. */
function briefKey() {
  try {
    return `m:${statSync(BRIEF_PATH).mtimeMs}`;
  } catch {
    return 'absent';
  }
}

/**
 * Test hook — drop the memoized brief block so the next call re-reads disk.
 */
export function _clearBriefCache() {
  _briefCache = null;
}

/**
 * Build the cached chat block 4 (the world brief). Returns the brief's
 * `## Summary` tier wrapped under a `## Brief` heading for the prompt, or —
 * when the file is missing/empty — the deterministic topic index under the same
 * heading (so a fresh install still has a real, LLM-free block 4). Returns ''
 * only when BOTH the file is absent AND there are no topics to index (a truly
 * empty corpus), in which case the caller omits the block.
 *
 * Read-only, no LLM, mtime-memoized. db is used ONLY for the fallback topic
 * index (and only when the file is absent), so the warm path is a pure disk read.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string}
 */
export function buildBriefBlock(db) {
  const key = briefKey();
  if (_briefCache && _briefCache.key === key) return _briefCache.body;

  let body = '';
  if (key !== 'absent') {
    try {
      const summary = extractBriefSummary(readFileSync(BRIEF_PATH, 'utf8'));
      if (summary.trim()) {
        body = `## Brief\n${summary.trim()}`;
      }
    } catch {
      body = '';
    }
  }

  // Fallback: file missing or unreadable → a DETERMINISTIC brief built from pure
  // SQL (no LLM). This is the fresh-install / pre-first-synthesis path. It mirrors
  // the synthesized brief's shape (inner-circle roster + topic index) with longer
  // gists, both to be genuinely useful AND to fill block 4 toward its ~4k budget
  // so the universal cache entry clears the 4096-token floor even before the
  // first daily synthesis runs.
  if (!body) {
    const roster = buildDeterministicCoreRoster(db);
    const index = buildDeterministicTopicIndex(db, TOPIC_GIST_CHARS_FALLBACK);
    const parts = [];
    if (roster.trim()) parts.push(`### Inner circle\n${roster}`);
    if (index.trim()) parts.push(`### Active areas\n${index}`);
    if (parts.length) {
      body = `## Brief\n${parts.join('\n\n')}`;
    }
  }

  _briefCache = { key, body };
  return body;
}
