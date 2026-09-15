/**
 * lib/criteria-parser.js
 *
 * Single source of truth for the plan's machine-verifiable criteria line
 * contract. Both `scripts/criteria-runner.js` (the runner) and
 * `scripts/story-gate.js` (the seal validator) import from here. They MUST
 * stay in lock-step — a plan that seals must always parse and run.
 *
 * st_6f81e248 AC16. Replaces two divergent parsers: criteria-runner.js used a
 * strict regex requiring a non-empty description, while story-gate.js used a
 * loose `.includes('→ `')` presence check. A plan with `- → \`cmd\`` (no
 * description) would seal but fail to run. Consolidated here.
 *
 * The contract — documented once in `agents/skills/plan/SKILL.md`:
 *
 *   - <description> → `<command>`
 *
 *   - description: any non-empty text before the arrow.
 *   - arrow: literal `→` flanked by whitespace.
 *   - command: in backticks; no embedded backticks or newlines.
 *
 *   Lines without a description before the arrow are NOT valid criteria.
 *   Manual QA prose (lines starting with `**Manual QA:**`) is not a criterion.
 */

// Anchored to the start of a line. The description capture (.+?) is
// NON-OPTIONAL — `- → \`cmd\`` does not match because `.+?` requires ≥1
// character before the trailing `\s+→`. Both the runner and the gate share
// this regex via the parseCriteria() function below.
export const CRITERIA_LINE_PATTERN = /^-\s+(.+?)\s+→\s+`([^`]+)`/;

// Documented format string for user-facing error messages and agents/skills/plan/SKILL.md.
export const CRITERIA_LINE_FORMAT =
  '- <description> → `<command>` (description non-empty; command in backticks, no embedded backticks or newlines)';

/**
 * extractCriteriaSection(markdownText) → string
 *
 * Returns the concatenated text of EVERY `## How ACs are satisfied` section.
 * Each section ends at the next `## ` heading (any case, any letter). A
 * multi-deliverable plan has more than one such section (one per deliverable);
 * all are gathered so every criterion runs — not just the first deliverable's.
 * Returns the empty string when no such section exists.
 */
export function extractCriteriaSection(markdownText) {
  const lines = markdownText.split('\n');
  const chunks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '## How ACs are satisfied') {
      const end = lines.findIndex((l, j) => j > i && /^## /.test(l));
      chunks.push(lines.slice(i + 1, end === -1 ? lines.length : end).join('\n'));
      if (end !== -1) i = end - 1; // resume scanning after this section
    }
  }
  return chunks.join('\n');
}

/**
 * parseCriteria(markdownText) → Array<{description: string, command: string}>
 *
 * Accepts the FULL plan markdown OR the already-extracted criteria-section
 * text. Calls extractCriteriaSection internally only if a `## How ACs are
 * satisfied` heading is present in the input; otherwise treats the input as
 * the section body directly. This lets callers pass either shape without
 * branching.
 *
 * Returns the array of {description, command} pairs in document order. Lines
 * that do not match `CRITERIA_LINE_PATTERN` are silently skipped (Manual QA
 * lines, prose, headings, bullet lines without an arrow).
 */
export function parseCriteria(markdownText) {
  const section = markdownText.includes('## How ACs are satisfied')
    ? extractCriteriaSection(markdownText)
    : markdownText;
  const out = [];
  // Use a global-flagged copy of the per-line regex so we can run exec() in a
  // loop. The class-level CRITERIA_LINE_PATTERN stays non-global so callers
  // can `.test()` it on a single line without state leaks.
  const re = new RegExp(CRITERIA_LINE_PATTERN.source, 'gm');
  let m;
  while ((m = re.exec(section)) !== null) {
    out.push({ description: m[1].trim(), command: m[2].trim() });
  }
  return out;
}

/**
 * countCriteriaBullets(sectionText) → number
 *
 * Counts every `- ` bullet line in the criteria section. Used by story-gate
 * to detect the "bullets exist but none parse" case — surfaces a precise
 * "N criteria missing valid format" error rather than the generic "no
 * criteria" error.
 */
export function countCriteriaBullets(sectionText) {
  return sectionText.split('\n').filter((l) => /^-\s+/.test(l)).length;
}
