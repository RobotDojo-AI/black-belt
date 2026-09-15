#!/usr/bin/env node
// scripts/verify-fragment-consistency.js — st_463b0bf6 AC4.
//
// CLI wrapper around lib/agent-personas.js's verifyFragmentConsistency().
// check-persona-ontology.js only proves a fragment marker's declared sha256
// is current — it never inspects whether the inlined text between the
// fragment:start/fragment:end pair actually matches the live source. This is
// the counterpart check: diffs the fragment BODY bytes across every persona
// that embeds the source against the source's live on-disk content, not
// just the marker's claim.
//
// Usage: node scripts/verify-fragment-consistency.js <source-relative-path>
//   <source-relative-path> is repo-root-relative, e.g. config/agent-voice/voice.md

export const INTELLIGENCE_TIER = 'extraction';

import { verifyFragmentConsistency } from '../lib/agent-personas.js';

function main() {
  const sourceRelPath = process.argv[2];
  if (!sourceRelPath) {
    process.stderr.write('usage: verify-fragment-consistency.js <source-relative-path>\n');
    process.exit(1);
  }

  const result = verifyFragmentConsistency(sourceRelPath);

  if (result.checkedCount === 0) {
    process.stdout.write(
      `[verify-fragment-consistency] ok — ${sourceRelPath} not embedded in any persona fragment (no-op)\n`,
    );
    process.exit(0);
  }
  if (result.ok) {
    process.stdout.write(
      `[verify-fragment-consistency] ok — ${result.checkedCount} persona fragment(s) match ${sourceRelPath} exactly\n`,
    );
    process.exit(0);
  }
  process.stderr.write(`[verify-fragment-consistency] FAIL — ${result.mismatches.length} mismatch(es):\n`);
  for (const mm of result.mismatches) process.stderr.write(`  ${mm.persona}: ${mm.reason}\n`);
  process.exit(1);
}

main();
