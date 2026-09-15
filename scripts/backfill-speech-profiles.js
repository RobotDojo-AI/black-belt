#!/usr/bin/env node
/**
 * scripts/backfill-speech-profiles.js — build cross-call speech profiles
 * (st_8a841c68 Phase 4).
 *
 * Compute tier: Tier 0 (extraction) — content-masked style features + a local
 * (free) embedding. No LLM. Reads the corpus's confirmed/owner-attributed
 * turns, groups them by person, and writes one person_speech_profile per person
 * via lib/speech-fingerprint.js updateProfile.
 *
 * The seed is the high-trust attribution methods: the owner's microphone turns
 * (mic_anchor, confidence 1.0) and any human-confirmed turns. These are the
 * turns we KNOW belong to a person, so they are the honest basis for a
 * fingerprint. Low-confidence guesses are excluded — a profile built on guesses
 * would compound error, not reduce it.
 *
 * Usage:
 *   cd ~/robotdojo && ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/backfill-speech-profiles.js
 */
export const INTELLIGENCE_TIER = 'extraction';

import db from '../lib/db.js';
import { updateProfile } from '../lib/speech-fingerprint.js';

async function main() {
  // Best-effort checkpoint (build-conventions): protects against killed-process
  // reader marks. When a healthy server owns the WAL, RESTART can contend — a
  // failure here is non-fatal because the shared db.js connection writes safely.
  try { db.pragma('wal_checkpoint(RESTART)'); }
  catch (e) { console.warn(`[backfill-speech-profiles] checkpoint skipped: ${e.message}`); }

  // High-trust turns only: mic_anchor (owner) + confirmed (human). These are
  // the turns whose identity we KNOW, so they are the honest profile basis.
  const rows = db.prepare(`
    SELECT speaker_person_id AS pid, text
    FROM transcript_segments
    WHERE speaker_person_id IS NOT NULL
      AND method IN ('mic_anchor', 'confirmed')
      AND text IS NOT NULL AND text != ''
    ORDER BY speaker_person_id
  `).all();

  const byPerson = new Map();
  for (const r of rows) {
    if (!byPerson.has(r.pid)) byPerson.set(r.pid, []);
    byPerson.get(r.pid).push(r.text);
  }

  let built = 0;
  let withTokens = 0;
  for (const [personId, turns] of byPerson) {
    const { tokenCount } = await updateProfile(db, personId, turns);
    built++;
    if (tokenCount > 0) withTokens++;
  }

  console.log('--- backfill-speech-profiles report ---');
  console.log(`people with high-trust turns: ${byPerson.size}`);
  console.log(`profiles written:             ${built}`);
  console.log(`profiles with tokens>0:       ${withTokens}`);
}

main().catch((e) => {
  console.error(`[backfill-speech-profiles] BLOCKED — ${e.message}`);
  process.exit(1);
});
