// lib/identity-targets/extraction-prompt.js — the pre-export prompt.
//
// Before the user exports chat history from a web AI tool, we give them
// a prompt to paste into that tool first. The prompt asks the LLM to
// dump the maximum possible context it has inferred about the user.
// This is instant (no need to wait for export processing) and captures
// reasoning the LLM may have built up across memory features,
// persistent project context, and custom instructions.
//
// Rendered per-tool because each platform has slightly different memory
// semantics (ChatGPT Memory, Claude Projects, Gemini Context, etc).
//
// The You-tab prompt in lib/memory-prompt.js is the canonical full export.
// BASE is the per-tool variant of the same category list.

export const DUMP_CATEGORIES = `**Include every category below. If you have no signal for one, write "no signal" and move on — do not fabricate. Do not flatten me into a type, archetype, or Big Five label. Stay concrete: names, dates, quotes, tools, specific incidents.**

Each bullet starts with [stated], [inferred], or [uncertain]. Prefer direct quotes over paraphrase. Corrections I have given you are higher signal than compliments.

1. **Identity & self-concept.** How I describe myself. Names I use. What I appear to value. What I avoid. Who I'm becoming. Quotes.
2. **Thinking style.** How I reason. Frameworks I reach for. Where I'm rigorous vs loose. Contradictions between what I say and what I do.
3. **Voice & communication.** How I write. Sentence rhythm, length, register. Words I use, words I avoid. Casual vs business vs technical modes. How I give and receive feedback. Include up to 5 short verbatim quotes of my writing if you have them.
4. **Behavior I want from an AI.** How I want you to behave with me. Patterns I've corrected you on. Things I've pushed back on. Things I've praised. List correction phrases verbatim, the ones I actually used.
5. **Work & projects.** Active projects and goals — including fuzzy goals I never stated explicitly that you inferred. Recurring problems. Stakeholders. Time pressure.
6. **People in my life.** Every person you actually know about — family, colleagues, clients, friends. How I relate to each, how I refer to them, what tone I take. Do not invent people.
7. **Concrete preferences.** Tools, formats, output styles. Examples of outputs I liked or disliked if you remember them.
8. **Inferred preferences.** Patterns extracted from my behavior that I never stated. Be specific. Do not hedge into meaninglessness.
9. **Constraints.** Health, routines, lifestyle factors, time zone — anything that should shape how you work with me.
10. **Contradictions & blind spots.** Where my stated goals diverge from my actual behavior. Where I'm stuck. Where I repeat the same mistake.
{MEMORY_INSTRUCTION}
12. **Your operating assumptions.** Unstated assumptions about me that drive your responses.
13. **How an AI fails with me.** The fastest ways to lose my trust. What I treat as a broken answer.`;

export const DUMP_RULES = `**Output rules:**
- First line of the dump is exactly \`# Robot Dojo Memory Import\`. Nothing before it. No "sure". No fence.
- Do not summarize. Expand. Use bullets, examples, and direct quotes.
- Tag each bullet [stated], [inferred], or [uncertain].
- No hedging fluff. Confidence levels are fine; vague hand-waving is not.
- Mine sources in this order: (1) persistent memory / saved memories, verbatim; (2) custom instructions, user rules, project instructions, and user-level files about me as a person, verbatim; (3) then inferences from our conversations.
- Do not dump repository source, diffs, configs, or tool logs. Do not dump API keys, tokens, passwords, private keys, .env contents, or secrets. If a memory contains a secret, write [redacted].
- If you hit a length limit, stop at a section heading and write CONTINUE FROM <n> as the last line. If I send CONTINUE FROM n, resume at that section and repeat the header as line 1.
- If you finish every category, last line: END OF DUMP
- No closing recap. The dump is the artifact.`;

export const BASE = `Your job: produce the most comprehensive dump possible of your understanding of me. Not a summary — an information transfer. Use as many tokens as you need.

${DUMP_CATEGORIES}

${DUMP_RULES}

Output the full dump now. I'll paste the entire reply into another system — the more tokens, the better.`;

/**
 * Build an extraction prompt customized for a given AI tool.
 * @param {object} opts
 * @param {string} opts.memoryFeatureName  e.g. 'ChatGPT Memory', 'Claude Projects context'
 * @param {string} [opts.memoryExtra]      optional additional instruction
 */
export function buildExtractionPrompt({ memoryFeatureName, memoryExtra = '' }) {
  const memoryLine = memoryFeatureName
    ? `11. **Persistent memory contents.** If ${memoryFeatureName} is active, dump every entry verbatim before anything else.${memoryExtra ? ' ' + memoryExtra : ''}`
    : '11. **Persistent memory contents.** If you have any persistent memory feature, dump every entry verbatim before anything else.';
  return BASE.replace('{MEMORY_INSTRUCTION}', memoryLine);
}
