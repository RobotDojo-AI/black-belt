#!/usr/bin/env node
/**
 * Rebuild config/agent-voice/standing-corrections.md GENERATE block from
 * user/memory/log feedback entries. Deterministic — no LLM.
 *
 * Usage:
 *   node scripts/build-standing-corrections.js
 *   node scripts/build-standing-corrections.js --json
 */
import { rebuildStandingCorrectionsFile } from '../lib/standing-corrections.js';

export const INTELLIGENCE_TIER = 'extraction';

const json = process.argv.includes('--json');
const result = rebuildStandingCorrectionsFile();
if (json) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  console.log(
    `standing-corrections: ${result.count} feedback rules` +
    `${result.changed ? ' (updated)' : ' (unchanged)'} sha=${result.sha256.slice(0, 12)}`,
  );
}
