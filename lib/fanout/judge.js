/**
 * fanout/judge.js — bias-guarded ranking of the fanned answers.
 *
 * This is the load-bearing trust surface. A judge that is itself one of the
 * four fanned models will, unguarded, prefer its own answer (self-recognition
 * + position bias, Panickssery 2024 / verdict flips 35-76% on an order swap).
 * The guards, each a PURE function so it is provable without an API key:
 *
 *   selectJudgePool   — optionally drop the judge provider's own answer
 *   anonymizeAnswers  — relabel providers to A/B/C/D via injected rng (blind)
 *   buildJudgePrompt  — correctness-only + verbosity guard + strict JSON schema
 *   parseJudgeResponse— tolerant parse (fenced / dirty JSON)
 *   averageOrderings  — average the two swapped-order runs per label
 *   rankFromAveraged  — deanonymize + sort
 *   ownRankOf         — surface where the judge placed its own answer
 *
 * runJudge is the only IO here: it drives the two swapped-order calls over the
 * injected `complete` seam and stitches the pure steps together.
 */

// Headroom for thinking tokens — see the note on FAN_MAX_TOKENS in fan.js. A
// judge that runs out of budget mid-reasoning returns unparseable scores.
const JUDGE_MAX_TOKENS = 6000;
const LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * Select which answers enter the ranked pool.
 * `--exclude-own` drops the answer written by the SELECTED judge provider
 * (generalized — whichever provider is judging, not a hardcoded xai). The
 * dropped answer is still saved as a raw receipt by the caller; it is only
 * removed from the ranking so the judge cannot score itself.
 *
 * @param {Array<{provider:string, text:string}>} answers - surviving fan answers
 * @param {{excludeOwn?:boolean, judgeProvider:string}} opts
 * @returns {Array} filtered answers (input order preserved)
 */
export function selectJudgePool(answers, { excludeOwn = false, judgeProvider } = {}) {
  const pool = (answers || []).filter((a) => a && a.text);
  if (!excludeOwn) return pool.slice();
  return pool.filter((a) => a.provider !== judgeProvider);
}

/**
 * Blind the pool: shuffle provider→label assignment with the injected rng so
 * A/B/C/D is a random provider each run and the label carries no identity.
 * Returns the labeled answers (label + text only — NO provider field, so the
 * prompt cannot leak identity) plus the recovery map.
 *
 * @param {Array<{provider:string, text:string}>} pool
 * @param {() => number} rng - float in [0,1); injected for deterministic tests
 * @returns {{labeled:Array<{label:string,text:string}>, labelToProvider:Object, providerToLabel:Object}}
 */
export function anonymizeAnswers(pool, rng = Math.random) {
  const shuffled = pool.slice();
  // Fisher-Yates with the injected rng — deterministic under a seeded rng.
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const labeled = [];
  const labelToProvider = {};
  const providerToLabel = {};
  shuffled.forEach((answer, idx) => {
    const label = LABELS[idx];
    labeled.push({ label, text: answer.text });
    labelToProvider[label] = answer.provider;
    providerToLabel[answer.provider] = label;
  });
  return { labeled, labelToProvider, providerToLabel };
}

/**
 * Build the judge system + user prompt for one presentation order.
 * The system prompt carries every guard the ranking's trustworthiness rests on:
 * correctness/usefulness only, explicitly ignore length/verbosity/formatting/
 * style, no guessing which model wrote which, JSON-only output to the schema.
 *
 * @param {string} task
 * @param {Array<{label:string,text:string}>} labeled
 * @param {{order:string[]}} opts - the sequence of labels to present in
 * @returns {{system:string, user:string}}
 */
export function buildJudgePrompt(task, labeled, { order } = {}) {
  const byLabel = new Map(labeled.map((l) => [l.label, l]));
  const seq = (order && order.length ? order : labeled.map((l) => l.label))
    .filter((label) => byLabel.has(label));

  const system = [
    'You are an impartial answer judge.',
    'You are shown a task and several candidate answers labeled A, B, C, D.',
    'Score ONLY correctness and usefulness. Judge whether each answer is right and',
    'actually helps solve the task.',
    'Explicitly IGNORE length, verbosity, formatting, markdown, and writing style —',
    'a longer or flashier answer must NOT win on presentation. A concise correct',
    'answer beats a verbose one.',
    'You do NOT know and must NOT guess which model wrote which answer. Treat the',
    'labels as anonymous.',
    'Also report how substantively the answers converge on the same conclusion.',
    'Output ONLY a single JSON object, no prose, no code fences, matching exactly:',
    '{',
    '  "agreement": <integer 0-100, how substantively the answers converge>,',
    '  "agreement_rationale": "<one sentence>",',
    '  "scores": [',
    '    { "label": "A", "correctness": <integer 0-100>, "rationale": "<correctness-only justification>" }',
    '  ]',
    '}',
    'Include one scores entry per label shown. correctness and agreement are integers 0-100.',
  ].join('\n');

  const answersBlock = seq
    .map((label) => `### Answer ${label}\n${byLabel.get(label).text}`)
    .join('\n\n');

  const user = [
    `TASK:\n${task}`,
    '',
    'CANDIDATE ANSWERS:',
    answersBlock,
    '',
    'Return the JSON object now.',
  ].join('\n');

  return { system, user };
}

/**
 * Tolerant parse of a judge response. Models occasionally wrap JSON in ```json
 * fences or add a stray sentence. Strip fences, then parse; on failure extract
 * the first {...} span and parse that. Returns the object or null.
 *
 * @param {string} text
 * @returns {object|null}
 */
export function parseJudgeResponse(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let cleaned = text.trim();
  // Strip a leading/trailing code fence (```json ... ``` or ``` ... ```).
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through to span extraction */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function scoresToMap(parsed) {
  const map = new Map();
  for (const s of parsed?.scores || []) {
    if (s && typeof s.label === 'string') map.set(s.label, s);
  }
  return map;
}

/**
 * Average two swapped-order judge runs per label. Position bias is the largest
 * measured judge bias; averaging the score a label got in each presentation
 * slot neutralizes it. Also records |order1-order2| per label as a position-
 * bias diagnostic, and averages the agreement field.
 *
 * @param {object} parsed1 - first ordering's parsed judge response
 * @param {object} parsed2 - second (reversed) ordering's parsed judge response
 * @returns {{agreement:number, agreement_rationale:string, scores:Array<{label:string,correctness:number,delta:number,rationale:string,correctness1:number,correctness2:number}>}}
 */
export function averageOrderings(parsed1, parsed2) {
  const m1 = scoresToMap(parsed1);
  const m2 = scoresToMap(parsed2);
  const labels = new Set([...m1.keys(), ...m2.keys()]);
  const scores = [];
  for (const label of labels) {
    const s1 = m1.get(label);
    const s2 = m2.get(label);
    const c1 = s1 ? Number(s1.correctness) : null;
    const c2 = s2 ? Number(s2.correctness) : null;
    const present = [c1, c2].filter((v) => Number.isFinite(v));
    const correctness = present.length ? present.reduce((a, b) => a + b, 0) / present.length : 0;
    const delta = (Number.isFinite(c1) && Number.isFinite(c2)) ? Math.abs(c1 - c2) : 0;
    scores.push({
      label,
      correctness,
      delta,
      correctness1: Number.isFinite(c1) ? c1 : null,
      correctness2: Number.isFinite(c2) ? c2 : null,
      rationale: (s1 && s1.rationale) || (s2 && s2.rationale) || '',
    });
  }
  const a1 = Number(parsed1?.agreement);
  const a2 = Number(parsed2?.agreement);
  const agPresent = [a1, a2].filter((v) => Number.isFinite(v));
  const agreement = agPresent.length ? agPresent.reduce((a, b) => a + b, 0) / agPresent.length : 0;
  return {
    agreement,
    agreement_rationale: parsed1?.agreement_rationale || parsed2?.agreement_rationale || '',
    scores,
  };
}

/**
 * Deanonymize the averaged scores and sort into a ranking. Maps each label
 * back to its provider and sorts by averaged correctness, descending.
 *
 * @param {{scores:Array}} averaged
 * @param {Object} labelToProvider
 * @returns {Array<{provider:string, label:string, correctness:number, delta:number, rationale:string}>}
 */
export function rankFromAveraged(averaged, labelToProvider) {
  return (averaged?.scores || [])
    .map((s) => ({
      provider: labelToProvider[s.label],
      label: s.label,
      correctness: s.correctness,
      delta: s.delta,
      rationale: s.rationale,
    }))
    .sort((a, b) => b.correctness - a.correctness);
}

/**
 * Surface where the judge placed its own answer. Only meaningful when the
 * judge provider's answer survived the fan and was in the ranked pool.
 *
 * @param {Array<{provider:string}>} ranked
 * @param {string} judgeProvider
 * @returns {{provider:string, rank:number|null, of:number}}
 */
export function ownRankOf(ranked, judgeProvider) {
  const of = ranked.length;
  const idx = ranked.findIndex((r) => r.provider === judgeProvider);
  return { provider: judgeProvider, rank: idx === -1 ? null : idx + 1, of };
}

// ── IO wrapper ────────────────────────────────────────────────────────────

/**
 * Run the bias-guarded judge over the injected `complete` seam.
 *
 * @param {string} task
 * @param {Array<{provider:string, text:string}>} answers - surviving fan answers
 * @param {object} deps
 * @param {(provider:string, args:object) => Promise<object>} deps.complete
 * @param {string} deps.model - concrete judge model id (getModel(judgeProvider,'best'))
 * @param {string} deps.judgeProvider
 * @param {boolean} [deps.excludeOwn]
 * @param {() => number} [deps.rng]
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<object>} judge result (see fields below); `unavailable:true` on parse failure
 */
export async function runJudge(task, answers, { complete, model, judgeProvider, excludeOwn = false, rng = Math.random, signal } = {}) {
  const pool = selectJudgePool(answers, { excludeOwn, judgeProvider });
  if (pool.length === 0) {
    return { unavailable: true, reason: 'no_answers_to_judge', judgeProvider, judgeModel: model, calls: [] };
  }

  const { labeled, labelToProvider } = anonymizeAnswers(pool, rng);
  const order1 = labeled.map((l) => l.label);
  const order2 = order1.slice().reverse();

  // Two swapped-order calls, in parallel — the whole point is to average out
  // the presentation slot, so run them concurrently, not sequentially.
  const callOrder = async (order) => {
    const { system, user } = buildJudgePrompt(task, labeled, { order });
    const args = { model, system, messages: [{ role: 'user', content: user }], max_tokens: JUDGE_MAX_TOKENS, signal };
    let res = await complete(judgeProvider, args);
    let parsed = parseJudgeResponse(res?.content?.[0]?.text ?? '');
    if (!parsed) {
      // Retry once — models occasionally break JSON on the first try.
      res = await complete(judgeProvider, args);
      parsed = parseJudgeResponse(res?.content?.[0]?.text ?? '');
    }
    return { parsed, usage: res?.usage, model: res?.model || model };
  };

  const [r1, r2] = await Promise.all([callOrder(order1), callOrder(order2)]);
  const calls = [
    { provider: judgeProvider, model: r1.model, usage: r1.usage },
    { provider: judgeProvider, model: r2.model, usage: r2.usage },
  ];

  if (!r1.parsed && !r2.parsed) {
    // Hard failure after retry: degrade rather than fabricate a ranking.
    return { unavailable: true, reason: 'judge_json_unparseable', judgeProvider, judgeModel: model, labelToProvider, calls };
  }

  // If one ordering failed, average() tolerates the missing side per label.
  const averaged = averageOrderings(r1.parsed || { scores: [] }, r2.parsed || { scores: [] });
  const ranked = rankFromAveraged(averaged, labelToProvider);
  const own = excludeOwn
    ? { provider: judgeProvider, excluded: true, rank: null, of: ranked.length }
    : ownRankOf(ranked, judgeProvider);

  return {
    unavailable: false,
    judgeProvider,
    judgeModel: model,
    excludeOwn,
    labelToProvider,
    ordering1: r1.parsed,
    ordering2: r2.parsed,
    averaged,
    agreement: averaged.agreement,
    agreement_rationale: averaged.agreement_rationale,
    ranked,
    own,
    calls,
  };
}
