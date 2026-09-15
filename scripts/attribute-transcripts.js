#!/usr/bin/env node
/**
 * scripts/attribute-transcripts.js — run speaker attribution over segmented
 * Granola transcripts (st_8a841c68 Phase 3/5).
 *
 * Compute tier ladder (compute-tier protocol):
 *   Tier 0 (free): mic anchor, name-mention/vocative, hand-off, turn-taking,
 *                  roster matchPerson, fingerprint cosine — settle the bulk.
 *   Tier 1 (Haiku): ONLY the residual turns the deterministic + fingerprint
 *                   layers could not settle are routed to llmCreate(MODELS.haiku)
 *                   via lib/compute-tier.js routeToBuckets. The model SCORES;
 *                   deterministic code in lib/transcript-attribution.js writes
 *                   the identity. No Sonnet/Opus in this pipeline.
 *
 * INTELLIGENCE_TIER is 'synthesis': this script reads structure and calls the
 * LLM, but per the inviolable write boundary the LLM output never writes a DB
 * row — the orchestrator (deterministic) applies speaker_person_id.
 *
 * Usage:
 *   cd ~/robotdojo && ROBOTDOJO_ALLOW_PLAINTEXT=1 \
 *     node scripts/attribute-transcripts.js [--deterministic-only] [--id <transcriptId>] [--limit N]
 */
export const INTELLIGENCE_TIER = 'synthesis';

import db from '../lib/db.js';
import { attributeTranscript, resolveOwnerPersonId } from '../lib/transcript-attribution.js';
import { scoreResidual } from '../lib/attribute-residual.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(name); }

const DETERMINISTIC_ONLY = flag('--deterministic-only');
const ONLY_ID = arg('--id', null);
const LIMIT = Number(arg('--limit', '0')) || 0;

async function main() {
  const ownerPersonId = resolveOwnerPersonId();
  if (!ownerPersonId) {
    console.warn('[attribute] owner person not resolvable (identity.json unconfigured) — microphone turns will stay unassigned.');
  }

  let rows;
  if (ONLY_ID) {
    rows = db.prepare("SELECT id FROM transcripts WHERE id = ?").all(ONLY_ID);
  } else {
    rows = db.prepare(`
      SELECT t.id FROM transcripts t
      WHERE t.source = 'granola'
        AND EXISTS (SELECT 1 FROM transcript_segments s WHERE s.transcript_id = t.id)
    `).all();
  }
  if (LIMIT > 0) rows = rows.slice(0, LIMIT);

  // The residual scorer is injected only when not deterministic-only. In
  // deterministic-only mode (Phase 3 checkpoint) the orchestrator runs the
  // free waterfall and nothing else — no model touches the corpus.
  const residualScorer = DETERMINISTIC_ONLY ? undefined : scoreResidual;

  let done = 0;
  let totalSettled = 0;
  let totalUnassigned = 0;
  for (const r of rows) {
    try {
      const res = await attributeTranscript(db, r.id, { ownerPersonId, residualScorer });
      totalSettled += res.settled;
      totalUnassigned += res.unassigned;
      done++;
    } catch (e) {
      console.error(`[attribute] failed ${r.id}: ${e.message}`);
    }
  }

  console.log('--- attribute-transcripts report ---');
  console.log(`mode:                ${DETERMINISTIC_ONLY ? 'deterministic-only' : 'deterministic + residual'}`);
  console.log(`transcripts done:    ${done}/${rows.length}`);
  console.log(`turns settled:       ${totalSettled}`);
  console.log(`turns unassigned:    ${totalUnassigned}`);
}

main().catch((e) => {
  console.error(`[attribute] BLOCKED — ${e.message}`);
  process.exit(1);
});
