/**
 * code-mutation/line-replace.js — line-targeted text replacement (post-amendment).
 *
 * WHY no ts-morph: amendment 2026-04-30 dropped the AST mutation tier. We do
 * a literal text replace, but with strict single-occurrence enforcement.
 *
 * Contract:
 *   - require: oldLiteral appears in writerFile EXACTLY ONCE
 *   - 0 matches → throw VerifyError("no literal match — likely template-literal")
 *   - >1 matches → throw VerifyError("ambiguous match: N occurrences")
 *   - 1 match → rewrite that line, save, return { mutated, replacedCount: 1 }
 *
 * Caller is responsible for the verification cascade and revert.
 */

import { readFileSync, writeFileSync } from 'node:fs';

export class VerifyError extends Error {}

/**
 * Count substring occurrences (full content scan, not line-by-line, so a
 * literal spanning a line break is also counted).
 */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * lineReplace — replace `oldLiteral` with `newLiteral` in writerFile, but only
 * if oldLiteral appears exactly once.
 */
export function lineReplace(writerFile, oldLiteral, newLiteral) {
  if (!oldLiteral) throw new VerifyError('lineReplace: oldLiteral is empty');
  if (typeof newLiteral !== 'string') throw new VerifyError('lineReplace: newLiteral must be string');

  const original = readFileSync(writerFile, 'utf8');
  const occurrences = countOccurrences(original, oldLiteral);

  if (occurrences === 0) {
    throw new VerifyError(`no literal match for "${oldLiteral}" in ${writerFile} — likely template-literal`);
  }
  if (occurrences > 1) {
    throw new VerifyError(`ambiguous match: ${occurrences} occurrences of "${oldLiteral}" in ${writerFile}`);
  }

  // Single occurrence — perform the replace. We do it on the full file so a
  // literal can span lines safely; the count guarantees the result is unambiguous.
  const updated = original.replace(oldLiteral, newLiteral);
  writeFileSync(writerFile, updated, 'utf8');

  return { mutated: writerFile, replacedCount: 1 };
}
