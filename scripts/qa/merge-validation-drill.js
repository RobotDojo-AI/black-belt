#!/usr/bin/env node
/**
 * scripts/qa/merge-validation-drill.js — validate the PRODUCT merge on the
 * known live duplicate pairs (st_f67bc2eb AC-11).
 *
 * Compute tier map: Tier 0 orchestration — drives the real merge endpoint
 * (POST /api/network/people/merge) on the running server and verifies final
 * state read-only. No LLM anywhere; identity operations are deterministic by
 * design principle 3.
 *
 * The pair ids live in a story-dir JSON (--pairs <path>) so no personal
 * identifier enters the repo. For each pair the drill proves:
 *   1. the product merge endpoint accepts the pair (or reports the idempotent
 *      no-op if a prior run already completed it)
 *   2. final merged state holds: loser archived, zero identifiers left on
 *      the loser, zero active relationship edges touch the loser
 *   3. a second call is a clean no-op (idempotency on the live pair)
 *
 * No cleanup step by design: the merge IS the desired end state of the live
 * data (this drill is the story's owner-corpus validation, not a fixture
 * exercise). Nothing synthetic is created.
 */
export const INTELLIGENCE_TIER = 'orchestration';

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const args = process.argv.slice(2);
const pairsPath = (() => {
  const i = args.indexOf('--pairs');
  return i >= 0 ? args[i + 1] : null;
})();
if (!pairsPath) {
  console.error('usage: merge-validation-drill.js --pairs <path/to/merge-pairs.json>');
  process.exit(2);
}

function resolveApiKey() {
  if (process.env.API_KEY) return process.env.API_KEY.trim();
  const out = spawnSync('security', ['find-generic-password', '-s', 'robotdojo-ROBOTDOJO_AUTH_TOKEN', '-w'], { encoding: 'utf8' });
  const key = String(out.stdout || '').trim();
  if (!key) {
    console.error('[merge-drill] no API key: set API_KEY or store robotdojo-ROBOTDOJO_AUTH_TOKEN in Keychain');
    process.exit(2);
  }
  return key;
}
const API_KEY = resolveApiKey();

const { default: appConfig } = await import('../../lib/config.js');
const BASE_URL = process.env.ROBOTDOJO_QA_BASE_URL || `https://127.0.0.1:${appConfig.ports.app}`;
const { default: db } = await import('../../lib/db.js');

const { pairs } = JSON.parse(readFileSync(pairsPath, 'utf8'));
if (!Array.isArray(pairs) || !pairs.length) {
  console.error('[merge-drill] pairs file holds no pairs');
  process.exit(2);
}

const failures = [];
const check = (ok, msg) => {
  console.log(`[merge-drill] ${ok ? 'ok' : 'FAIL'} — ${msg}`);
  if (!ok) failures.push(msg);
};

async function callMerge(winnerId, loserId) {
  const res = await fetch(`${BASE_URL}/api/network/people/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ winner_id: winnerId, loser_id: loserId }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

for (const [i, pair] of pairs.entries()) {
  const { winner_id: winner, loser_id: loser } = pair;
  const label = `pair ${i + 1}`;
  const winnerRow = db.prepare('SELECT id, COALESCE(archived,0) AS archived FROM people WHERE id = ?').get(winner);
  const loserRow = db.prepare('SELECT id, COALESCE(archived,0) AS archived FROM people WHERE id = ?').get(loser);
  if (!winnerRow || !loserRow) {
    check(false, `${label}: both rows exist (winner=${Boolean(winnerRow)} loser=${Boolean(loserRow)})`);
    continue;
  }

  const first = await callMerge(winner, loser);
  check(first.status === 200 && first.body.ok === true,
    `${label}: product merge accepted (HTTP ${first.status}${first.body.reason ? `, ${first.body.reason}` : ''})`);

  // Final merged state — read-only verification.
  const archived = db.prepare('SELECT COALESCE(archived,0) AS archived FROM people WHERE id = ?').get(loser).archived;
  check(Number(archived) === 1, `${label}: loser archived`);
  const idents = db.prepare('SELECT COUNT(*) n FROM person_identifiers WHERE person_id = ?').get(loser).n;
  check(idents === 0, `${label}: zero identifiers left on the loser (${idents})`);
  const activeEdges = db.prepare(
    "SELECT COUNT(*) n FROM person_relations WHERE status = 'active' AND (person_a = ? OR person_b = ?)",
  ).get(loser, loser).n;
  check(activeEdges === 0, `${label}: zero active edges touch the loser (${activeEdges})`);

  // Idempotency on the live pair: the second call is a clean no-op.
  const second = await callMerge(winner, loser);
  check(second.status === 200 && second.body.ok === true && second.body.merged === false,
    `${label}: re-run is a no-op (merged=${second.body.merged})`);
}

console.log(`[merge-drill] ${failures.length ? `${failures.length} failure(s)` : 'OK — the known duplicate pairs sit in final merged state'}`);
process.exit(failures.length ? 1 : 0);
