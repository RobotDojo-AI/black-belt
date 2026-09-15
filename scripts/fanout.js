#!/usr/bin/env node
/**
 * Compute-tier choice: this is a user-invoked interactive CLI, not a bulk
 * pipeline, so the tier ladder's "Tier 0 first" rule does not apply — there is
 * no bulk data to pre-filter. The point IS to spend frontier tokens: the fan
 * defaults to the four provider mid-tiers ('balanced') and the judge +
 * synthesizer run on 'best'. --cheap drops only the FAN to 'fast'; the judge
 * and synthesizer are never cheapened (a single judge call is a rounding error
 * next to four generations). --best lifts the fan to 'best' too. One run per
 * explicit operator invocation, cost reported inline.
 *
 * INTELLIGENCE_TIER: synthesis — reads no structured store, calls LLMs, writes
 * only markdown/JSON receipts under ~/.robotdojo/fanout/ (never a DB row).
 */
import { runFanout, defaultDeps, resolveFanTier, KNOWN_PROVIDERS } from '../lib/fanout/index.js';
import { renderInline } from '../lib/fanout/render.js';

export const INTELLIGENCE_TIER = 'synthesis';

const USAGE = `fanout — fan one task to all four frontier models, judged + synthesized inline.

Usage:
  node scripts/fanout.js "<task>" [flags]

Flags:
  --judge <provider>   judge model provider (default: xai). one of: ${KNOWN_PROVIDERS.join(', ')}
  --cheap              fan on budget tiers (judge/synth stay best)
  --best               fan on top tiers
  --exclude-own        drop the judge provider's own answer from the ranking
  --challenge          force the challenger step on
  --no-challenge       force the challenger step off

The coding agent is the language layer: it maps operator intent
("use claude as judge", "go cheap") onto these structured flags.`;

/**
 * Parse argv into { task, opts }. The CLI takes structured flags only — it
 * embeds no natural-language parser (the agent is the language layer, AC1).
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{task:string, opts:object}}
 */
export function parseArgs(argv) {
  const opts = { judgeProvider: 'xai', cheap: false, best: false, excludeOwn: false, challenge: false, noChallenge: false };
  const taskParts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--judge': {
        const val = argv[++i];
        if (!val || !KNOWN_PROVIDERS.includes(val)) {
          throw new Error(`--judge must be one of: ${KNOWN_PROVIDERS.join(', ')} (got ${val ?? 'nothing'})`);
        }
        opts.judgeProvider = val;
        break;
      }
      case '--cheap': opts.cheap = true; break;
      case '--best': opts.best = true; break;
      case '--exclude-own': opts.excludeOwn = true; break;
      case '--challenge': opts.challenge = true; break;
      case '--no-challenge': opts.noChallenge = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        taskParts.push(a);
    }
  }
  return { task: taskParts.join(' ').trim(), opts };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    process.exit(1);
  }
  if (!parsed.task) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }
  // resolveFanTier is exercised here so the tier the operator gets matches what
  // is priced/reported; the mapping itself is unit-tested in the orchestrator.
  void resolveFanTier(parsed.opts);
  try {
    const result = await runFanout(parsed.task, parsed.opts, defaultDeps());
    process.stdout.write(`${renderInline(result)}\n`);
  } catch (err) {
    process.stderr.write(`fanout failed: ${err.message}\n`);
    process.exit(1);
  }
}

// Only run when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
