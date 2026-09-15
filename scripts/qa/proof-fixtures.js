/**
 * scripts/qa/proof-fixtures.js — loader for the owner's real QA proof fixtures
 * (st_e36f5f2b round 4, owner-out PII pass).
 *
 * The viewer/chat proof scripts (prod-chat-smoke.js, viewer-render-smoke.js,
 * viewer-stable-url-proof.js) verify the owner's LIVE deployment against real
 * contacts, companies, and places. Those real fixtures used to be hard-coded in
 * tracked source. They now live ONLY in the gitignored
 * config/qa-proof-fixtures.user.json override; the tracked scripts ship synthetic
 * placeholder fixtures. On this box the proofs run against the real entities via
 * the override; a fresh clone runs the synthetic placeholders.
 *
 * Mirrors the config/*.user.json override convention: HOME-resolved path, env
 * hook for tests, graceful no-op when the file is missing or malformed.
 *
 * Shape (all optional):
 *   {
 *     "prodChatPrompt": "…",        // prod-chat-smoke default chat prompt
 *     "renderCases":    [ … ],      // extra viewer-render-smoke cases
 *     "stableUrlCases": [ … ]       // extra viewer-stable-url-proof cases
 *   }
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

function overridePath() {
  return process.env.ROBOTDOJO_QA_PROOF_FIXTURES_PATH
    || resolve(homedir(), 'robotdojo', 'config', 'qa-proof-fixtures.user.json');
}

/** The parsed owner override, or `{}` when it is absent or unparseable. */
export function loadProofFixtures() {
  const path = overridePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn(`[qa-proof-fixtures] failed to parse ${path}: ${err.message} — using synthetic placeholders`);
    return {};
  }
}
