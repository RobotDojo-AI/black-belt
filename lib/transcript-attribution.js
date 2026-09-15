/**
 * lib/transcript-attribution.js — the attribution orchestrator (st_8a841c68).
 *
 * Runs the waterfall in strict trust order and does EVERY identity write. This
 * is the only place speaker_person_id is set during attribution; the residual
 * layer (lib/attribute-residual.js) returns scores that this module reads and
 * writes — the inviolable LLM-write boundary (the model scores, deterministic
 * code writes) lives here.
 *
 * Order per transcript:
 *   1. Deterministic waterfall (lib/attribute-deterministic.js) — mic anchor,
 *      name-mention, hand-off, turn-taking. Free, rule-based.
 *   2. Residual layer (optional, injected) — fingerprint cosine then a Haiku
 *      roster-conditioned scorer, ONLY on turns the deterministic layer left
 *      open. Returns {turnIndex, personId|null, confidence}; this module writes.
 *   3. Margin reject — any proposed assignment below the margin-reject threshold
 *      stays unassigned + needs_confirm.
 *   4. Recompute talk-share, set attributed_at, rechunk + rewrite the flat file.
 *
 * confirmed turns (method='confirmed') are sticky: they are NEVER overwritten by
 * any layer or a later pass (plan failure manifest #7).
 *
 * Thin-facade: db is the first argument. The residual scorer + owner id are
 * injected via opts so this module has no LLM import (the boundary grep on the
 * residual module proves the model never writes; this module is where the
 * deterministic write lives).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSegments, setSegmentSpeaker, talkShare } from './transcript-segments.js';
import { resolveRoster } from './transcript-roster.js';
import { attributeDeterministic } from './attribute-deterministic.js';
import { rechunkTranscript } from './chunk-worker.js';
import { writeTranscriptFile } from './transcripts.js';
import { ownerPersonId as identityOwnerPersonId, ownerEmails } from './identity.js';
import { matchPerson } from './entity-resolve.js';
import { confirmSegmentSpeaker } from './people-write.js';
import { updateProfile } from './speech-fingerprint.js';

let _cfg = null;
function cfg() {
  if (_cfg) return _cfg;
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(resolve(process.cwd(), 'config/defaults.json'), 'utf8')).attribution || {};
  } catch { /* defaults below */ }
  _cfg = {
    marginRejectThreshold: raw.marginRejectThreshold ?? 0.15,
  };
  return _cfg;
}

/**
 * Resolve the owner person id: prefer the configured owner_person_id, else
 * resolve the first owner email through the read-only matchPerson. Returns null
 * when identity is unconfigured — the caller then skips the mic anchor honestly
 * (a microphone turn we can't tie to a person stays unassigned, never guessed).
 */
export function resolveOwnerPersonId() {
  const direct = identityOwnerPersonId();
  if (direct) return direct;
  for (const email of ownerEmails()) {
    const m = matchPerson({ email });
    if (m?.personId) return m.personId;
  }
  return null;
}

/**
 * Attribute one transcript.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} transcriptId
 * @param {object} [opts]
 * @param {string|null} [opts.ownerPersonId]  — override (tests); default resolves via identity
 * @param {(args:{db,transcriptId,unsettled,candidates,ownerPersonId})=>Promise<Array<{turnIndex:number,personId:string|null,confidence:number,method?:string}>>} [opts.residualScorer]
 *        — injected Phase-5 scorer. Returns SCORES; this orchestrator writes.
 * @param {boolean} [opts.rewrite=true]  — rechunk + rewrite flat file after.
 * @returns {Promise<{settled:number, unassigned:number, talkShare:object}>}
 */
export async function attributeTranscript(db, transcriptId, opts = {}) {
  const c = cfg();
  const segments = getSegments(db, transcriptId);
  if (segments.length === 0) {
    return { settled: 0, unassigned: 0, talkShare: { byPerson: {}, unassignedMs: 0, totalMs: 0 } };
  }

  const transcriptRow = db.prepare('SELECT * FROM transcripts WHERE id = ?').get(transcriptId);
  const { candidates } = resolveRoster(db, transcriptRow);
  const ownerPersonId = opts.ownerPersonId !== undefined ? opts.ownerPersonId : resolveOwnerPersonId();

  // segment rows carry turn_index; index by it for the write loop.
  const byTurn = new Map(segments.map((s) => [s.turn_index, s]));

  // A confirmed turn is sticky — never re-attribute it.
  const isConfirmed = (s) => s.method === 'confirmed';

  // ── Idempotent reset ─────────────────────────────────────────────────────
  // Re-attribution must fully recompute, not layer on a prior pass. Clear every
  // non-confirmed turn back to unassigned first, so a stale guess from an earlier
  // run (e.g. a system turn wrongly pinned to the owner before a fix) cannot
  // survive when this pass no longer produces it. Confirmed turns stay.
  for (const s of segments) {
    if (!isConfirmed(s) && s.speaker_person_id != null) {
      setSegmentSpeaker(db, s.id, null, 0, 'unassigned');
      s.speaker_person_id = null; s.method = 'unassigned'; s.confidence = 0;
    }
  }

  // ── Layer 1: deterministic waterfall ─────────────────────────────────────
  const proposals = attributeDeterministic({ segments, candidates, ownerPersonId });
  for (const [turnIndex, p] of proposals) {
    const seg = byTurn.get(turnIndex);
    if (!seg || isConfirmed(seg)) continue;
    setSegmentSpeaker(db, seg.id, p.personId, p.confidence, p.method);
  }

  // ── Layer 2: residual (optional) ─────────────────────────────────────────
  // Only the turns still open after the deterministic layer. The scorer returns
  // {turnIndex, personId|null, confidence}; we apply the margin reject and write.
  if (typeof opts.residualScorer === 'function') {
    const settledTurns = new Set(proposals.keys());
    const unsettled = segments.filter(
      (s) => s.source === 'system' && !settledTurns.has(s.turn_index) && !isConfirmed(s),
    );
    if (unsettled.length > 0) {
      let scores = [];
      try {
        scores = await opts.residualScorer({ db, transcriptId, unsettled, candidates, ownerPersonId });
      } catch (e) {
        // Graceful degradation: a residual failure leaves those turns unassigned,
        // never crashes the deterministic result that already landed.
        console.warn(`[attribution] residual scorer failed for ${transcriptId}: ${e.message}`);
        scores = [];
      }
      for (const score of scores || []) {
        const seg = byTurn.get(score.turnIndex);
        if (!seg || isConfirmed(seg)) continue;
        // Margin reject: a null person or a below-threshold confidence stays
        // unassigned + needs_confirm. Anything assigned must clear the bar.
        if (!score.personId || (score.confidence ?? 0) < c.marginRejectThreshold) {
          setSegmentSpeaker(db, seg.id, null, score.confidence ?? 0, 'unassigned', { needsConfirm: true });
        } else {
          setSegmentSpeaker(db, seg.id, score.personId, score.confidence, score.method || 'llm');
        }
      }
    }
  }

  // ── Margin reject sweep: any still-open turn is honest unassigned ─────────
  // Turns no layer settled stay NULL with needs_confirm so they surface for
  // pull-based confirm. (Already-NULL fresh rows get needs_confirm=1.)
  const after = getSegments(db, transcriptId);
  let settled = 0;
  let unassigned = 0;
  for (const s of after) {
    if (s.speaker_person_id) { settled++; continue; }
    unassigned++;
    if (!isConfirmed(s) && s.needs_confirm !== 1) {
      setSegmentSpeaker(db, s.id, null, s.confidence ?? 0, 'unassigned', { needsConfirm: true });
    }
  }

  // ── Talk-share + attributed_at ───────────────────────────────────────────
  const share = talkShare(db, transcriptId);
  const nowIso = new Date().toISOString();
  db.prepare('UPDATE transcripts SET talk_share = ?, attributed_at = ? WHERE id = ?')
    .run(JSON.stringify(share), nowIso, transcriptId);

  // ── Surface attributed text to both sinks (chunk + flat file) ────────────
  if (opts.rewrite !== false) {
    try { await rechunkTranscript(transcriptId); }
    catch (e) { console.warn(`[attribution] rechunk failed for ${transcriptId}: ${e.message}`); }
    const fresh = db.prepare('SELECT * FROM transcripts WHERE id = ?').get(transcriptId);
    try { await writeTranscriptFile(fresh); }
    catch (e) { console.warn(`[attribution] flat-file rewrite failed for ${transcriptId}: ${e.message}`); }
  }

  return { settled, unassigned, talkShare: share };
}

/**
 * Confirm a turn's speaker AND close the learning loop (st_8a841c68 AC-6).
 * Writes the sticky method='confirmed' assignment, then refreshes that person's
 * cross-call speech profile from ALL their confirmed + owner turns across the
 * corpus, so the next call needs fewer confirms for the same cast. Finally
 * rewrites the call's chunk + flat file so the confirmed name reaches chat and
 * disk immediately.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} segmentId
 * @param {string} personId
 * @returns {Promise<object>} the updated segment row
 */
export async function confirmAndLearn(db, segmentId, personId) {
  const updated = confirmSegmentSpeaker(db, segmentId, personId);

  // Refresh the person's profile from every high-trust turn we now have.
  const turns = db.prepare(`
    SELECT text FROM transcript_segments
     WHERE speaker_person_id = ? AND method IN ('mic_anchor','confirmed') AND text != ''
  `).all(personId).map((r) => r.text);
  try { await updateProfile(db, personId, turns); }
  catch (e) { console.warn(`[attribution] profile refresh failed for ${personId}: ${e.message}`); }

  // Surface the confirmed name to both sinks. A confirm bumps attributed_at so
  // the freshness-gated rewrites fire.
  db.prepare("UPDATE transcripts SET attributed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), updated.transcript_id);
  const t = db.prepare('SELECT * FROM transcripts WHERE id = ?').get(updated.transcript_id);
  try { await rechunkTranscript(updated.transcript_id); } catch { /* re-embed pass reconciles */ }
  try { await writeTranscriptFile(t); } catch { /* next pass reconciles */ }

  return updated;
}
