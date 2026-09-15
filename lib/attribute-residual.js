/**
 * lib/attribute-residual.js — the residual (non-deterministic) attribution
 * layer (st_8a841c68 Phase 5). Runs ONLY on the turns the deterministic
 * waterfall left open.
 *
 * INVIOLABLE LLM-WRITE BOUNDARY: this module SCORES and never writes identity.
 * It runs no segment-table identity write of any kind — no raw speaker-id
 * UPDATE, no call into the segment DAL's writers. It returns
 * {turnIndex, personId|null, confidence}; the orchestrator
 * (lib/transcript-attribution.js, deterministic code) reads that and writes the
 * row. A criterion greps this file to enforce the boundary (plan failure
 * manifest #3). It does not import the segment DAL at all.
 *
 * Two residual signals, in order:
 *   1. Fingerprint cosine (Tier 0, free): embed the turn locally, cosine
 *      against each roster candidate's accumulated speech profile. Confidence =
 *      the top1−top2 margin, scaled by the winning candidate's token_count vs
 *      the ~1k floor (a thin profile is trusted less).
 *   2. Haiku roster-conditioned scorer (Tier 1): ONLY the turns fingerprinting
 *      couldn't settle are routed through lib/compute-tier.js routeToBuckets →
 *      lib/llm-gateway.js llmCreate(modelFor('fast')). The prompt is the closed
 *      roster (gold alias list) + the surrounding turns; the model returns a
 *      JSON score per turn.
 */

// INTELLIGENCE_TIER: extraction — Haiku SCORES a closed attribution decision
// (never writes identity, per the module's own inviolable-boundary comment
// above); the deterministic caller writes the score, not freeform prose.
export const INTELLIGENCE_TIER = 'extraction';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { embed } from './rag.js';
import { profileVector, cosineSimilarity } from './speech-fingerprint.js';
import { routeToBuckets } from './compute-tier.js';
import { llmCreate } from './llm-gateway.js';
import { modelFor } from './model-lane.js';

let _cfg = null;
function cfg() {
  if (_cfg) return _cfg;
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(resolve(process.cwd(), 'config/defaults.json'), 'utf8')).attribution || {};
  } catch { /* defaults below */ }
  _cfg = {
    fingerprintFloorTokens: raw.fingerprintFloorTokens ?? 1000,
    fingerprintMinConfidence: raw.fingerprintMinConfidence ?? 0.5,
    llmMinConfidence: raw.llmMinConfidence ?? 0.5,
    maxResidualChunks: raw.maxResidualChunks ?? 96,
  };
  return _cfg;
}

// Holistic attribution reads the conversation in CHUNK_TURNS-long consecutive
// windows (not turn-by-turn): the model sees the whole flow with the anchors
// already marked and labels the unknown turns by names used + back-and-forth,
// propagating identities the way a person reading the transcript would.
const CHUNK_TURNS = 90;
// Overlap between chunks so a hand-off near a boundary still has its lead-in.
const CHUNK_OVERLAP = 10;
// Safety cap on chunks per call. Long offsites can run past 5k turns; the cap
// stays finite, but high enough that normal long calls get complete coverage.

/**
 * Fingerprint-cosine score for one turn against the resolvable roster.
 * @returns {{personId:string|null, confidence:number}}
 */
async function fingerprintScore(db, text, candidates, profiles, tokenCounts) {
  let vec;
  try { vec = await embed(text, { inputType: 'document' }); }
  catch { return { personId: null, confidence: 0 }; }
  if (!vec) return { personId: null, confidence: 0 };

  const sims = [];
  for (const c of candidates) {
    const pv = profiles.get(c.personId);
    if (!pv) continue;
    sims.push({ personId: c.personId, sim: cosineSimilarity(vec, pv), tokens: tokenCounts.get(c.personId) || 0 });
  }
  if (sims.length === 0) return { personId: null, confidence: 0 };
  sims.sort((a, b) => b.sim - a.sim);
  const top = sims[0];
  const second = sims[1]?.sim ?? 0;
  const margin = Math.max(0, top.sim - second);
  // Scale the margin by how much confirmed text backs the winner (the ~1k
  // floor): a thin profile earns less confidence even on a clean margin.
  const c = cfg();
  const tokenScale = Math.min(1, top.tokens / c.fingerprintFloorTokens);
  const confidence = margin * tokenScale;
  return { personId: top.personId, confidence };
}

const SYSTEM_PROMPT = [
  'You attribute a MEETING TRANSCRIPT to its speakers. The attendees are a CLOSED roster',
  '(given with a person id in brackets) — every speaker is one of them.',
  'You are given a chunk of CONSECUTIVE turns in order. Each turn is already marked:',
  'OWNER = the meeting owner (their own microphone), [id] = already identified, ? = unknown.',
  'IMPORTANT: the ? turns are from the room/system audio — the OWNER is NOT one of them',
  '(the owner speaks only on their own OWNER turns). Attribute every ? turn to one of the',
  'OTHER roster members, never to the owner.',
  'Read the conversation as a whole. Use every cue a human would: who is addressed BY NAME',
  '("Sloan, your take?" means the next substantive turn is usually Sloan, and the speaker who',
  'said it is NOT Sloan), hand-offs ("over to you, Peter"), question→answer back-and-forth,',
  'self-reference, and the fact that the same person rarely takes two unbroken turns. Propagate',
  'identities through the flow from the turns you are sure of to the ones next to them.',
  'Label as many of the ? turns as the conversation lets you, with a confidence each.',
  'Return STRICT JSON: an array of {"turnIndex": <int>, "personId": "<roster id>", "confidence": <0..1>}.',
  'CRITICAL: include ONLY the ? turns you can attribute to a named roster person. OMIT every turn',
  'you cannot name — do NOT emit null or low-confidence filler entries (that bloats the output and',
  'truncates it). personId must be a real bracketed roster id; never invent a person.',
  'Output JSON only, no prose, no markdown fences.',
].join(' ');

// Extract a JSON array of score objects from a model response, tolerating
// ```json fences and truncation (max_tokens cut the array mid-stream): salvage
// every complete {...} object even if the closing ] never arrived.
function parseScoreArray(textOut) {
  if (!textOut) return [];
  let body = textOut.replace(/```json\s*/gi, '').replace(/```/g, '');
  const open = body.indexOf('[');
  if (open >= 0) body = body.slice(open);
  try {
    const m = body.match(/\[[\s\S]*\]/);
    if (m) { const a = JSON.parse(m[0]); if (Array.isArray(a)) return a; }
  } catch { /* fall through to object salvage */ }
  // Truncation salvage: pull each complete top-level object.
  const objs = [];
  for (const m of body.matchAll(/\{[^{}]*\}/g)) {
    try { objs.push(JSON.parse(m[0])); } catch { /* skip partial */ }
  }
  return objs;
}

function renderTurn(seg, scoreThis) {
  const who = seg.source === 'microphone'
    ? 'OWNER'
    : (seg.speaker_person_id ? `[${seg.speaker_person_id}]` : '?');
  const mark = scoreThis && who === '?' ? ' «label this»' : '';
  return `turn ${seg.turn_index} (${who}): ${String(seg.text || '').slice(0, 400)}${mark}`;
}

/**
 * Holistic, roster-conditioned attribution over the WHOLE conversation, read in
 * consecutive overlapping chunks. Returns score objects; never writes.
 *
 * Unlike per-turn scoring, the model sees each chunk's full flow with anchors
 * marked and propagates names across the back-and-forth. `known` is the live
 * label map (turn_index → personId) seeded with the deterministic + fingerprint
 * anchors and grown as each chunk resolves, so later chunks see earlier results.
 */
async function llmScore(db, transcriptId, allSegments, candidates, known) {
  const roster = candidates
    .filter((c) => c.personId)
    .map((c, i) => `${i + 1}. ${c.name || c.email} [${c.personId}]`)
    .join('\n');
  if (!roster) return [];

  const validIds = new Set(candidates.filter((c) => c.personId).map((c) => c.personId));
  const out = [];

  // Build consecutive chunks over the full turn sequence.
  const step = CHUNK_TURNS - CHUNK_OVERLAP;
  let chunkCount = 0;
  for (let start = 0; start < allSegments.length && chunkCount < cfg().maxResidualChunks; start += step) {
    const chunk = allSegments.slice(start, start + CHUNK_TURNS);
    // Skip chunks with no unknown turns to spend (nothing for the model to do).
    const hasUnknown = chunk.some((s) => s.source !== 'microphone' && !known.get(s.turn_index));
    if (!hasUnknown) continue;
    chunkCount++;

    const lines = chunk.map((s) => {
      // Reflect the live `known` map so propagation from earlier chunks shows.
      const labelled = { ...s, speaker_person_id: s.source === 'microphone' ? null : (known.get(s.turn_index) || s.speaker_person_id) };
      return renderTurn(labelled, true);
    }).join('\n');

    const user = `ROSTER:\n${roster}\n\nCONVERSATION (consecutive turns):\n${lines}`;
    let resp;
    try {
      resp = await llmCreate(
        { model: modelFor('fast'), max_tokens: 4096, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }] },
        'attribute-residual',
      );
    } catch (e) {
      console.warn(`[residual] llm chunk failed: ${e.message}`);
      continue;
    }

    const textOut = (resp?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = parseScoreArray(textOut);
    if (!parsed.length) continue;

    for (const p of parsed) {
      if (!p || !Number.isInteger(p.turnIndex)) continue;
      const personId = (p.personId && validIds.has(p.personId)) ? p.personId : null;
      const confidence = typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0;
      out.push({ turnIndex: p.turnIndex, personId, confidence, method: 'llm' });
      // Grow the anchor map so the overlapping next chunk sees this result.
      if (personId && confidence >= cfg().llmMinConfidence) known.set(p.turnIndex, personId);
    }
  }
  return out;
}

/**
 * Score the residual (still-open) turns. Returns an array of
 * {turnIndex, personId|null, confidence, method} — SCORES ONLY. The orchestrator
 * writes the identity.
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {string} args.transcriptId
 * @param {Array} args.unsettled  — the open system turns (segment rows)
 * @param {Array} args.candidates — the resolved roster
 * @returns {Promise<Array<{turnIndex:number, personId:string|null, confidence:number, method:string}>>}
 */
export async function scoreResidual({ db, transcriptId, unsettled, candidates, ownerPersonId = null }) {
  const c = cfg();
  // The unsettled turns are SYSTEM-stream turns. When the owner is mic'd (the
  // common remote call), their speech is on the microphone stream and was
  // already anchored deterministically — so a system turn is never the owner.
  // Exclude the owner from the candidate pool here, or their rich fingerprint and
  // an LLM default both over-attribute the room's turns to the owner.
  const resolvable = (candidates || []).filter((x) => x.personId && x.personId !== ownerPersonId);
  if (resolvable.length === 0 || unsettled.length === 0) return [];

  // Preload candidate profiles + token counts (Tier 0).
  const profiles = new Map();
  const tokenCounts = new Map();
  for (const cand of resolvable) {
    const pv = profileVector(db, cand.personId);
    if (pv) profiles.set(cand.personId, pv);
    const row = db.prepare('SELECT token_count FROM person_speech_profile WHERE person_id = ?').get(cand.personId);
    tokenCounts.set(cand.personId, row?.token_count || 0);
  }

  const allSegments = db.prepare(
    'SELECT turn_index, source, text, speaker_person_id FROM transcript_segments WHERE transcript_id = ? ORDER BY turn_index ASC',
  ).all(transcriptId);

  const scores = [];

  // The live anchor map the transitive LLM pass propagates FROM: seed it with
  // every deterministic non-mic attribution already on the segments (name
  // mentions, hand-offs, 2-person turn-taking). Mic turns render as OWNER, not
  // a roster id, so they are not in this map.
  const known = new Map();
  for (const s of allSegments) {
    if (s.source !== 'microphone' && s.speaker_person_id) known.set(s.turn_index, s.speaker_person_id);
  }

  // ── Tier 0: fingerprint cosine ──────────────────────────────────────────
  // Each fingerprint hit becomes another anchor the transitive pass reads.
  const stillOpen = [];
  for (const seg of unsettled) {
    const fp = profiles.size > 0
      ? await fingerprintScore(db, seg.text, resolvable, profiles, tokenCounts)
      : { personId: null, confidence: 0 };
    if (fp.personId && fp.confidence >= c.fingerprintMinConfidence) {
      scores.push({ turnIndex: seg.turn_index, personId: fp.personId, confidence: fp.confidence, method: 'fingerprint' });
      known.set(seg.turn_index, fp.personId);
    } else {
      stillOpen.push(seg);
    }
  }

  // ── Tier 1: transitive Haiku pass over the whole conversation ────────────
  // Not per-turn: the model reads consecutive chunks with all anchors marked and
  // propagates names through the back-and-forth. routeToBuckets keeps the LLM on
  // the residual only (the chunker itself skips chunks with no unknown turn).
  if (stillOpen.length > 0) {
    routeToBuckets(stillOpen, () => 'haiku'); // canonical "LLM only on residual" gate
    const llmScores = await llmScore(db, transcriptId, allSegments, resolvable, known);
    for (const s of llmScores) {
      if (s.personId && s.confidence >= c.llmMinConfidence) {
        scores.push(s);
      } else {
        // Below-threshold or null → null score; the orchestrator marks the turn
        // unassigned + needs_confirm (honest deferral).
        scores.push({ turnIndex: s.turnIndex, personId: null, confidence: s.confidence, method: 'llm' });
      }
    }
  }

  return scores;
}
