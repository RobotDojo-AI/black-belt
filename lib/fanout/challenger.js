/**
 * fanout/challenger.js — the steelman step that runs after the judge and
 * before synthesis, so a shared blind spot is forced into view instead of
 * passing silently.
 *
 * Two PURE decision functions:
 *   agreementSignal — free, auditable, content-aware "do the four agree?"
 *   shouldChallenge — the trigger truth-table (default / flags / auto-fire)
 *
 * One IO wrapper:
 *   runChallenger   — produces the argument against the leader / for the dissenter
 */

// Headroom for thinking tokens — see the note on FAN_MAX_TOKENS in fan.js.
const CHALLENGER_MAX_TOKENS = 5000;

/**
 * Observable agreement signal, computed entirely from the judge result (free —
 * no extra model call). Two numbers, both landing in judge.json for audit:
 *   agreementScore = the judge's averaged self-reported convergence (content-aware)
 *   spread         = max-min of averaged correctness (the judge's separability)
 * agree when either the model reports high convergence OR the deterministic
 * spread backstop is tight — the spread guards against over-trusting the
 * model's self-report.
 *
 * @param {{agreement?:number, ranked?:Array<{correctness:number}>}} judgeResult
 * @returns {{agree:boolean, agreementScore:number, spread:number, reason:string}}
 */
export function agreementSignal(judgeResult) {
  const agreementScore = Number(judgeResult?.agreement) || 0;
  const scores = (judgeResult?.ranked || [])
    .map((r) => Number(r.correctness))
    .filter((v) => Number.isFinite(v));
  const spread = scores.length >= 2 ? Math.max(...scores) - Math.min(...scores) : 0;
  const byAgreement = agreementScore >= 70;
  const bySpread = spread <= 8;
  const agree = byAgreement || bySpread;
  const reason = agree
    ? `agree (agreementScore=${agreementScore} spread=${spread})`
    : `disagree (agreementScore=${agreementScore} spread=${spread})`;
  return { agree, agreementScore, spread, reason };
}

/**
 * Resolve whether the challenger runs. Precedence, highest first:
 *   1. --no-challenge   → off (explicit skip wins over everything)
 *   2. --challenge      → on  (explicit force)
 *   3. research posture → on  (default-on for the research posture)
 *   4. answers agree    → on  (auto-fire even when the posture would skip)
 *   5. otherwise        → off
 *
 * @param {{challenge?:boolean, noChallenge?:boolean, posture?:string}} flags
 * @param {{agree?:boolean}} [agreement]
 * @returns {{run:boolean, reason:string}}
 */
export function shouldChallenge(flags = {}, agreement = {}) {
  if (flags.noChallenge) return { run: false, reason: 'skipped: --no-challenge' };
  if (flags.challenge) return { run: true, reason: 'forced: --challenge' };
  if ((flags.posture || 'research') === 'research') {
    return { run: true, reason: 'default-on: research posture' };
  }
  if (agreement && agreement.agree) {
    return { run: true, reason: 'auto-fired: answers substantially agree' };
  }
  return { run: false, reason: 'skipped: non-research posture, no force, no agreement' };
}

// ── IO wrapper ────────────────────────────────────────────────────────────

/**
 * Produce the strongest case AGAINST the leading answer and FOR the top
 * dissenting answer. Runs on the deanonymized ranking (identity is fine here —
 * this is argument, not scoring).
 *
 * @param {string} task
 * @param {Array<{provider:string}>} ranked - judge ranking, leader first
 * @param {Array<{provider:string, text:string}>} answers - surviving fan answers
 * @param {object} deps
 * @param {(provider:string, args:object)=>Promise<object>} deps.complete
 * @param {string} deps.provider - challenger provider (default xai)
 * @param {string} deps.model    - concrete challenger model id
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<{argument:string, provider:string, model:string, calls:Array}>}
 */
export async function runChallenger(task, ranked, answers, { complete, provider, model, signal } = {}) {
  const textFor = (p) => (answers.find((a) => a.provider === p) || {}).text || '';
  const leader = ranked[0];
  const dissenter = ranked.find((r) => r.provider !== leader?.provider) || ranked[1] || null;

  const leaderText = leader ? textFor(leader.provider) : '';
  const dissenterText = dissenter ? textFor(dissenter.provider) : '';

  const system = [
    'You are a challenger. Your job is to force a shared blind spot into the open.',
    'Argue the STRONGEST honest case AGAINST the leading answer and FOR the dissenting',
    'answer. Do not hedge and do not restate the answers — surface what the leader could',
    'be getting wrong and what the dissenter sees that the leader misses. Be concrete.',
    'If the leading answer is genuinely solid, say precisely which of its claims is most',
    'load-bearing and therefore most worth stress-testing.',
    'Return prose, not JSON.',
  ].join('\n');

  const user = [
    `TASK:\n${task}`,
    '',
    'LEADING ANSWER (judge rank #1):',
    leaderText,
    '',
    'TOP DISSENTING ANSWER:',
    dissenterText || '(no distinct dissenting answer survived)',
    '',
    'Make the challenge now.',
  ].join('\n');

  const res = await complete(provider, {
    model,
    system,
    messages: [{ role: 'user', content: user }],
    max_tokens: CHALLENGER_MAX_TOKENS,
    signal,
  });
  const argument = res?.content?.[0]?.text ?? '';
  return {
    argument,
    provider,
    model: res?.model || model,
    calls: [{ provider, model: res?.model || model, usage: res?.usage }],
  };
}
