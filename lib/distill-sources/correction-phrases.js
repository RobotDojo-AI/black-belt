// lib/distill-sources/correction-phrases.js — Tier 0 extraction of behavioral
// correction phrases from the user's own messages in robotdojo chat history.
//
// WHY Tier 0: No LLM needed. SQL LIKE patterns over 11K+ messages give us
// ground-truth behavioral signals — phrases the user actually typed to correct AI
// behavior. This is the highest-confidence source for USER.md behavioral
// corrections: it's revealed behavior, not stated preference.
//
// WHY this file exists separately: It's reusable by --corrections-only mode
// (zero LLM cost, fast diagnostic) and by the full synthesis engine. Keeping
// it as a pure SQL extractor lets callers decide what to do with the results.
//
// Output: [{ phrase, count, examples }] sorted by count desc.

import db from '../db.js';

// LIKE patterns targeting real correction language observed in the corpus.
// Each entry: [displayPhrase, sqlPattern]
// sqlPattern uses SQL LIKE syntax (% = wildcard).
//
// WHY these specific patterns: sampling the 11,430 user messages shows these
// are the actual phrases the user uses — confirmed by running counts before coding.
const CORRECTION_PATTERNS = [
  ['too long',          '%too long%'],
  ['too verbose',       '%too verbose%'],
  ['be brief',          '%be brief%'],
  ['shorter',           '%shorter%'],
  ['cut ',              '%cut %'],
  ['summarize',         '%summarize%'],
  ["don't ",            "%don't %"],
  ['stop ',             '%stop %'],
  ['only answer',       '%only answer%'],
  ['just answer',       '%just answer%'],
  ['only the',          '%only the%'],
  ['not what i asked',  '%not what i asked%'],
  ['remove ',           '%remove %'],
  ['skip the',          '%skip the%'],
  ['drop the',          '%drop the%'],
  ['i want you only',   '%i want you only%'],
  ['do not add',        '%do not add%'],
  ["don't add",         "%don't add%"],
  ['stop adding',       '%stop adding%'],
  ['less context',      '%less context%'],
];

/**
 * Extract correction phrases from user messages via SQL LIKE patterns.
 *
 * @returns {Array<{ phrase: string, count: number, examples: string[] }>}
 *   Sorted by count descending. Only phrases with count > 0 are returned.
 */
export function gather() {
  // Use a prepared statement per pattern — LIKE patterns can't be parameterized
  // as arrays in SQLite, so we loop. Each query is O(N) over 11K rows — fast.
  const results = [];

  for (const [phrase, pattern] of CORRECTION_PATTERNS) {
    const countRow = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM messages
      WHERE role = 'user'
        AND lower(content) LIKE lower(?)
    `).get(pattern);

    if (!countRow || countRow.cnt === 0) continue;

    // Pull up to 3 representative examples (shortest matching content for
    // readability — shorter messages are more likely to be pure corrections).
    const exampleRows = db.prepare(`
      SELECT content
      FROM messages
      WHERE role = 'user'
        AND lower(content) LIKE lower(?)
      ORDER BY length(content) ASC
      LIMIT 3
    `).all(pattern);

    results.push({
      phrase,
      count: countRow.cnt,
      // Truncate examples so they're scannable in reports
      examples: exampleRows.map(r => r.content.slice(0, 120).replace(/\n/g, ' ')),
    });
  }

  // Sort by frequency — highest-signal corrections first
  results.sort((a, b) => b.count - a.count);
  return results;
}
