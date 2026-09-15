#!/usr/bin/env node
/**
 * scripts/resync-persona-fragments.js — push a voice fragment edit into every persona.
 *
 * st_4312c9c0. The six persona files inline copies of the shared voice
 * fragments between fragment:start/fragment:end markers, with the source's
 * sha256 declared in the include marker above. Editing the source alone leaves
 * six stale copies and a failing verify-fragment-consistency.
 *
 * CLI wrapper around lib/agent-personas.js's resyncPersonaFragment(), which
 * refreshes the declared sha and replaces the inlined body — all-or-nothing
 * across the six, computed in memory first and written atomically, so a crash
 * mid-run cannot leave three personas updated and three behind.
 *
 * Usage:
 *   node scripts/resync-persona-fragments.js config/agent-voice/formatting/coding-agent.md
 *   node scripts/resync-persona-fragments.js --all
 *
 * Run scripts/generate-identity.js afterwards to push the result into the
 * distributed Claude/Codex/Cursor adapters.
 */

// INTELLIGENCE_TIER: extraction — deterministic text substitution between
// markers. Makes no model call.
export const INTELLIGENCE_TIER = 'extraction';

import { resyncPersonaFragment, verifyFragmentConsistency } from '../lib/agent-personas.js';

// The shared fragments every persona embeds. --all resyncs each in turn.
const ALL_FRAGMENTS = [
  'config/agent-voice/voice.md',
  'config/agent-voice/formatting/coding-agent.md',
  'agents/default-quality.md',
];

function resyncOne(rel) {
  const result = resyncPersonaFragment(rel);
  if (!result.resynced.length) {
    process.stdout.write(`resync: ${rel} — ${result.reason}\n`);
    return true;
  }
  const check = verifyFragmentConsistency(rel);
  if (!check.ok) {
    process.stderr.write(`resync: ${rel} — still drifted after write: ${check.mismatches.map((m) => m.persona).join(', ')}\n`);
    return false;
  }
  process.stdout.write(`resync: ${rel} → ${result.resynced.length} persona(s), sha ${result.sourceSha.slice(0, 12)}\n`);
  return true;
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write('usage: resync-persona-fragments.js <source-relative-path> | --all\n');
    return 1;
  }
  const targets = arg === '--all' ? ALL_FRAGMENTS : [arg];
  let ok = true;
  for (const rel of targets) {
    try {
      if (!resyncOne(rel)) ok = false;
    } catch (err) {
      process.stderr.write(`resync: ${rel} — ${err.message}\n`);
      ok = false;
    }
  }
  return ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
