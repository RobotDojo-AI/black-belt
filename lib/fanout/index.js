/**
 * fanout/index.js — the orchestrator. Wires fan → judge → challenger →
 * synthesis → receipts → render over an injectable dependency seam.
 *
 * deps = { complete, now, rng, baseDir }:
 *   complete(provider, args) → the single IO seam (real providers or a fake)
 *   now()  → Date            (injected so run ids are deterministic in tests)
 *   rng()  → float [0,1)      (injected so anonymize/run-id are deterministic)
 *   baseDir → receipts root   (config.configDir in production, a temp dir in tests)
 *
 * defaultDeps() binds complete to (await getProvider(p)).complete(args) and
 * supplies a real clock + a crypto-backed rng. Nothing here calls a provider
 * directly — that is the whole point of the pure/IO split.
 */
import crypto from 'node:crypto';
import { getModel, default as config } from '../config.js';
import { getProvider } from '../llm/index.js';
import { fanTask } from './fan.js';
import { runJudge } from './judge.js';
import { agreementSignal, shouldChallenge, runChallenger } from './challenger.js';
import { runSynthesis } from './synthesize.js';
import { costForCall, totalCost } from './cost.js';
import { newRunId, runDirFor, writeReceipts } from './receipts.js';

export const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google', 'xai'];

// Fixed roles: the judge and synthesizer default to Grok (owner directive +
// ecosystem coherence). The judge provider is user-selectable; the synthesizer
// is fixed this story (the --synth-provider override is a specified-but-unbuilt
// extension point per the plan).
const SYNTH_PROVIDER = 'xai';
const CHALLENGER_PROVIDER = 'xai';

/**
 * Resolve the FAN tier from the cheap/best flags. Pure — the judge and
 * synthesizer are never cheapened (they stay on 'best'); only the fan moves.
 * @param {{cheap?:boolean, best?:boolean}} flags
 * @returns {'fast'|'balanced'|'best'}
 */
export function resolveFanTier({ cheap = false, best = false } = {}) {
  if (best) return 'best';
  if (cheap) return 'fast';
  return 'balanced';
}

function firstSentence(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const m = t.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : t.slice(0, 160)).trim();
}

/**
 * Production dependency wiring.
 * @returns {{complete:Function, now:Function, rng:Function, baseDir:string}}
 */
// The Anthropic client is constructed with a 15s request timeout tuned for the
// chat TTFT path (lib/llm/anthropic.js). A fan-out call is the opposite shape —
// one long frontier generation, budgeted at FAN_TIMEOUT_MS — so Opus times out
// at 15s on every substantial run and the panel silently drops to three
// providers. complete() honors a per-request `timeout_ms`; pass the fan's own
// budget so the provider bound matches the orchestrator's.
const FAN_REQUEST_TIMEOUT_MS = 120000;

export function defaultDeps() {
  return {
    complete: async (provider, args) => (await getProvider(provider)).complete({
      timeout_ms: FAN_REQUEST_TIMEOUT_MS,
      ...args,
    }),
    now: () => new Date(),
    // crypto-backed rng — collision-safe for run ids, blind for anonymize.
    rng: () => crypto.randomBytes(4).readUInt32BE(0) / 0x1_0000_0000,
    baseDir: config.configDir,
  };
}

/**
 * Run one fan-out end to end.
 *
 * @param {string} task
 * @param {object} [opts]
 * @param {string} [opts.judgeProvider='xai']
 * @param {boolean} [opts.excludeOwn]
 * @param {boolean} [opts.challenge]
 * @param {boolean} [opts.noChallenge]
 * @param {boolean} [opts.cheap]
 * @param {boolean} [opts.best]
 * @param {string} [opts.posture='research']
 * @param {number} [opts.timeoutMs]
 * @param {object} deps - { complete, now, rng, baseDir }
 * @returns {Promise<object>} render-ready result
 */
export async function runFanout(task, opts = {}, deps = defaultDeps()) {
  const { complete, now, rng, baseDir } = deps;
  const judgeProvider = opts.judgeProvider || 'xai';
  if (!KNOWN_PROVIDERS.includes(judgeProvider)) {
    throw new Error(`unknown_judge_provider: ${judgeProvider} — choose one of ${KNOWN_PROVIDERS.join(', ')}`);
  }
  if (typeof task !== 'string' || !task.trim()) {
    throw new Error('empty_task: a non-empty task string is required');
  }

  const tier = resolveFanTier(opts);
  const posture = opts.posture || 'research';
  const flags = {
    judge: judgeProvider,
    tier,
    excludeOwn: !!opts.excludeOwn,
    challenge: !!opts.challenge,
    noChallenge: !!opts.noChallenge,
  };

  // ── Fan ──
  const fanResults = await fanTask({ task, providers: KNOWN_PROVIDERS, tier, complete, timeoutMs: opts.timeoutMs });
  const succeeded = fanResults.filter((r) => r.ok && r.text);
  if (succeeded.length === 0) {
    const why = fanResults.map((r) => `${r.provider}: ${r.error || 'no text'}`).join('; ');
    throw new Error(`all_providers_failed: ${why}`);
  }

  // ── Judge ──
  const judgeModel = getModel(judgeProvider, 'best');
  const judge = await runJudge(task, succeeded, {
    complete,
    model: judgeModel,
    judgeProvider,
    excludeOwn: !!opts.excludeOwn,
    rng,
  });

  const judgeUnavailable = !!judge.unavailable;
  const ranked = judgeUnavailable ? [] : judge.ranked;
  const signal = judgeUnavailable ? { agree: false, agreementScore: 0, spread: 0, reason: 'judge unavailable' } : agreementSignal(judge);

  // ── Challenger (after judge, before synthesis) ──
  const chDecision = judgeUnavailable
    ? { run: false, reason: 'judge unavailable' }
    : shouldChallenge({ challenge: !!opts.challenge, noChallenge: !!opts.noChallenge, posture }, signal);

  let challenger = { ran: false, reason: chDecision.reason, argument: '', thesis: '', calls: [] };
  if (chDecision.run) {
    const c = await runChallenger(task, ranked, succeeded, {
      complete,
      provider: CHALLENGER_PROVIDER,
      model: getModel(CHALLENGER_PROVIDER, 'best'),
    });
    challenger = { ran: true, reason: chDecision.reason, argument: c.argument, thesis: firstSentence(c.argument), calls: c.calls };
  }

  // ── Synthesis ──
  let synth;
  if (judgeUnavailable) {
    // No ranking to merge — fall back to the first surviving raw answer.
    synth = {
      parsed: null,
      decision: { text: succeeded[0].text, fellBack: true, reason: 'judge unavailable — no ranking', provenance: [] },
      calls: [],
      model: null,
    };
  } else {
    synth = await runSynthesis(task, ranked, succeeded, challenger.argument, {
      complete,
      provider: SYNTH_PROVIDER,
      model: getModel(SYNTH_PROVIDER, 'best'),
    });
  }
  const answer = synth.decision.text;

  // ── Cost ──
  const rawCalls = [
    ...succeeded.map((r) => ({ provider: r.provider, model: r.model, usage: r.usage })),
    ...(judge.calls || []),
    ...(challenger.calls || []),
    ...(synth.calls || []),
  ];
  const costLines = rawCalls.map((c) => costForCall({ provider: c.provider, model: c.model, usage: c.usage }));
  const totalDollars = totalCost(costLines);
  for (const line of costLines) {
    if (!line.priced) {
      // Honest zero, loud flag — never mis-price an unknown model as sonnet.
      process.stderr.write(`[fanout] warning: no PRICING entry for '${line.model}' — reported as unpriced ($0).\n`);
    }
  }

  // ── Receipts ──
  const runId = newRunId(now, rng);
  const runDir = runDirFor(baseDir, runId);
  const timestamp = now().toISOString();

  const promptMd = [
    `# fanout run ${runId}`,
    `time: ${timestamp}`,
    `tier: ${tier}   judge: ${judgeProvider}   excludeOwn: ${flags.excludeOwn}   challenge: ${flags.challenge}   no-challenge: ${flags.noChallenge}`,
    '',
    'resolved model ids:',
    ...KNOWN_PROVIDERS.map((p) => `  ${p}: ${getModel(p, tier)}`),
    `  judge (${judgeProvider}): ${judgeModel}`,
    '',
    '## task',
    task,
  ].join('\n');

  const judgeJson = judgeUnavailable
    ? { unavailable: true, reason: judge.reason }
    : {
        judgeProvider,
        judgeModel,
        excludeOwn: flags.excludeOwn,
        labelToProvider: judge.labelToProvider,
        ordering1: judge.ordering1,
        ordering2: judge.ordering2,
        averaged: judge.averaged,
        agreement: judge.agreement,
        agreement_rationale: judge.agreement_rationale,
        spread: signal.spread,
        agreementSignal: signal,
        ranked: judge.ranked,
        ownRank: judge.own,
      };

  const challengerMd = challenger.ran
    ? challenger.argument
    : `skipped: ${challenger.reason}`;

  const synthesisMd = synth.decision.fellBack
    ? [
        `decision: fallback`,
        `reason: ${synth.decision.reason}`,
        '',
        '## answer (top raw answer, verbatim)',
        answer,
      ].join('\n')
    : [
        `decision: synthesize`,
        '',
        '## answer',
        answer,
        '',
        '## provenance',
        JSON.stringify(synth.decision.provenance || [], null, 2),
      ].join('\n');

  const costJson = {
    total_dollars: totalDollars,
    calls: costLines,
  };

  const metaJson = {
    runId,
    timestamp,
    tier,
    flags,
    providersAttempted: KNOWN_PROVIDERS,
    providersSucceeded: succeeded.map((r) => r.provider),
    fan: fanResults.map((r) => ({ provider: r.provider, model: r.model, ok: r.ok, latencyMs: r.latencyMs, error: r.error })),
    judgeUnavailable,
    challengerRan: challenger.ran,
    synthesisFellBack: synth.decision.fellBack,
  };

  writeReceipts(runDir, {
    prompt: promptMd,
    rawAnswers: succeeded.map((r) => ({ provider: r.provider, text: r.text })),
    judge: judgeJson,
    challenger: challengerMd,
    synthesis: synthesisMd,
    cost: costJson,
    meta: metaJson,
  });

  // ── Render-ready result ──
  return {
    runId,
    runDir,
    tier,
    flags,
    answer,
    judgeProvider,
    judgeUnavailable,
    ranked: (ranked || []).map((r) => ({ provider: r.provider, correctness: r.correctness })),
    own: judgeUnavailable ? null : judge.own,
    agreement: judgeUnavailable ? null : judge.agreement,
    spread: signal.spread,
    challenger: { ran: challenger.ran, reason: challenger.reason, thesis: challenger.thesis },
    synthesisFellBack: synth.decision.fellBack,
    fallbackReason: synth.decision.reason,
    totalDollars,
    costLines,
    providersSucceeded: succeeded.map((r) => r.provider),
    providersAttempted: KNOWN_PROVIDERS,
  };
}
