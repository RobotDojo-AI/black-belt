/**
 * Foundation-model memory export prompt — for the You tab copy card.
 *
 * This prompt is given TO another AI. It is not a Robot Dojo briefing.
 * The other model only needs an output format so the dump can be pasted back.
 */

import { createHash } from 'node:crypto';
import { DUMP_CATEGORIES, DUMP_RULES } from './identity-targets/extraction-prompt.js';

const GENERIC_MEMORY_INSTRUCTION =
  '11. **Previous exports, chat history, and persistent memory.** Dump every memory entry verbatim. ' +
  'Include prior exports if you have them. Include keywords like memory, chat history, and export.';

const FRAME = `Produce the most comprehensive dump possible of your understanding of me. Not a summary — an information transfer. Use as many tokens as you need.

First line of your output must be exactly this, with nothing before it:

# Robot Dojo Memory Import

Second line: \`As of: YYYY-MM-DD\` (today's date). Third line: how you know me — persistent memory, this thread only, custom instructions, user rules, project knowledge about me as a person, or a mix. If you only know me from this thread, say so.

`;

/**
 * Returns the full foundation-model memory export prompt.
 *
 * @returns {{ prompt: string, hash: string }}
 */
export function getMemoryPrompt() {
  const categories = DUMP_CATEGORIES.replace('{MEMORY_INSTRUCTION}', GENERIC_MEMORY_INSTRUCTION);
  const prompt = [
    FRAME.trim(),
    categories.trim(),
    DUMP_RULES.trim(),
    'Output the full dump now. I will paste the entire reply into another system — the more tokens, the better.',
  ].join('\n\n');
  const hash = createHash('sha256').update(prompt).digest('hex').slice(0, 16);
  return { prompt, hash };
}
