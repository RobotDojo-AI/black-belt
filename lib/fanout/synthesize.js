/**
 * fanout/synthesize.js — provenance-grounded merge of the ranked answers,
 * with a hard fallback constraint.
 *
 * decideSynthesisOutput (PURE) is the invariant pushed into the deciding
 * function (Stonebraker): synthesis falls back to the top-ranked RAW answer
 * verbatim when the model declines (decision:"fallback"), returns an empty
 * answer, or emits unparseable JSON — never a degraded merge. The fallback
 * reason is inspectable in synthesis.md.
 *
 * runSynthesis (IO) drives the merge over the injected `complete` seam.
 */
import { parseJudgeResponse } from './judge.js';

// Headroom for thinking tokens — see the note on FAN_MAX_TOKENS in fan.js.
const SYNTH_MAX_TOKENS = 8000;

/**
 * Decide the final answer text: the merged synthesis, or a hard fall-back to
 * the strongest raw answer. Pure — the entire fallback invariant lives here so
 * AC2's "falls back when synthesis wouldn't improve on the strongest single
 * answer" is real and testable, not application hope.
 *
 * @param {object|null} parsed - parsed synthesis JSON ({decision, answer, provenance, fallback_reason})
 * @param {string} topRawAnswer - the rank-#1 raw answer text
 * @returns {{text:string, fellBack:boolean, reason:string, provenance:Array}}
 */
export function decideSynthesisOutput(parsed, topRawAnswer) {
  const top = typeof topRawAnswer === 'string' ? topRawAnswer : '';
  if (!parsed) {
    return { text: top, fellBack: true, reason: 'synthesis JSON failed to parse', provenance: [] };
  }
  if (parsed.decision === 'fallback') {
    return {
      text: top,
      fellBack: true,
      reason: parsed.fallback_reason || 'synthesis declined to improve on the top answer',
      provenance: [],
    };
  }
  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  if (!answer) {
    return { text: top, fellBack: true, reason: 'synthesis returned an empty answer', provenance: [] };
  }
  return { text: answer, fellBack: false, reason: '', provenance: Array.isArray(parsed.provenance) ? parsed.provenance : [] };
}

// ── IO wrapper ────────────────────────────────────────────────────────────

/**
 * Merge the ranked answers into one provenance-grounded answer. Operates on
 * the deanonymized ranking (ranking already happened under bias guards;
 * synthesis is not a bias-sensitive scoring step).
 *
 * @param {string} task
 * @param {Array<{provider:string}>} ranked
 * @param {Array<{provider:string, text:string}>} answers - surviving fan answers
 * @param {string} challengerArg - the challenger's argument (or '')
 * @param {object} deps
 * @param {(provider:string, args:object)=>Promise<object>} deps.complete
 * @param {string} deps.provider - synthesizer provider (default xai)
 * @param {string} deps.model    - concrete synthesizer model id
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<{parsed:object|null, decision:object, provider:string, model:string, calls:Array}>}
 */
export async function runSynthesis(task, ranked, answers, challengerArg, { complete, provider, model, signal } = {}) {
  const textFor = (p) => (answers.find((a) => a.provider === p) || {}).text || '';
  const topProvider = ranked[0]?.provider;
  const topRawAnswer = topProvider ? textFor(topProvider) : (answers[0]?.text || '');

  const answersBlock = ranked
    .map((r, i) => `### Answer from ${r.provider} (judge rank #${i + 1})\n${textFor(r.provider)}`)
    .join('\n\n');

  const system = [
    'You are a synthesizer. Reason ACROSS the candidate answers and produce one',
    'answer that reconciles their conflicts and is stronger than any single one.',
    'Carry provenance: for each substantive claim, record which model(s) backed it.',
    'Do NOT merely concatenate or summarize. If — and only if — no synthesis would',
    'improve on the single strongest (rank #1) answer, set "decision":"fallback" and',
    'explain why in "fallback_reason"; otherwise set "decision":"synthesize".',
    'Output ONLY a single JSON object, no prose, no code fences, matching exactly:',
    '{',
    '  "decision": "synthesize" | "fallback",',
    '  "answer": "<merged answer text, empty if fallback>",',
    '  "provenance": [ { "claim": "<claim>", "backed_by": ["<provider>", ...] } ],',
    '  "fallback_reason": "<why fallback, empty if synthesizing>"',
    '}',
  ].join('\n');

  const user = [
    `TASK:\n${task}`,
    '',
    'CANDIDATE ANSWERS (best-ranked first):',
    answersBlock,
    challengerArg ? `\nCHALLENGER (stress-test before you merge):\n${challengerArg}` : '',
    '',
    'Return the JSON object now.',
  ].join('\n');

  const res = await complete(provider, {
    model,
    system,
    messages: [{ role: 'user', content: user }],
    max_tokens: SYNTH_MAX_TOKENS,
    signal,
  });
  const parsed = parseJudgeResponse(res?.content?.[0]?.text ?? '');
  const decision = decideSynthesisOutput(parsed, topRawAnswer);
  return {
    parsed,
    decision,
    provider,
    model: res?.model || model,
    calls: [{ provider, model: res?.model || model, usage: res?.usage }],
  };
}
