/**
 * lib/attribute-deterministic.js — the Tier-0 attribution waterfall
 * (st_8a841c68 Phase 3). Rule-based, NO LLM, NO statistics.
 *
 * This module computes proposed assignments; it does NOT write the DB. The
 * orchestrator (lib/transcript-attribution.js) reads these proposals and does
 * every identity write. A criterion greps this file to prove it makes zero LLM
 * calls (AC-3).
 *
 * The waterfall, in strict trust order — each turn is settled by the EARLIEST
 * layer that clears its bar; later layers never overwrite an earlier one:
 *
 *   1. Mic anchor      — source='microphone' ⇒ owner. Deterministic, ~100%,
 *                        free. Seeds everything downstream.
 *   2. Name-mention /  — a roster name spoken in a turn names the LIKELY-NEXT
 *      vocative          speaker (addressee takes the turn; the namer is not the
 *                        named). High precision, low coverage.
 *   3. Hand-off        — explicit "over to you, person-b" hands the NEXT turn to
 *                        the named candidate.
 *   4. Turn-taking     — the same person rarely takes two consecutive system
 *                        turns; propagate a single-other-candidate inference
 *                        between owner turns when the roster has exactly one
 *                        non-owner candidate.
 *
 * Confidence values are tunable (config/defaults.json attribution.*), never
 * hardcoded literals in the body.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let _cfg = null;
function cfg() {
  if (_cfg) return _cfg;
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(resolve(process.cwd(), 'config/defaults.json'), 'utf8')).attribution || {};
  } catch { /* fall back to built-in defaults below */ }
  _cfg = {
    nameMentionConfidence: raw.nameMentionConfidence ?? 0.7,
    handoffConfidence: raw.handoffConfidence ?? 0.6,
    turntakingConfidence: raw.turntakingConfidence ?? 0.45,
  };
  return _cfg;
}

// Hand-off cue phrases: a turn containing one of these hands the floor to a
// named candidate. Kept deliberately small and high-precision.
const HANDOFF_CUES = [
  'over to you', 'back to you', 'go ahead', 'take it away',
  'why don\'t you', 'do you want to', 'take us through', 'walk us through',
];

/**
 * Tokenize a roster name into its lowercase word tokens (for first-name and
 * full-name matching against turn text). Returns {full, first} or null when the
 * name is unusable (<1 token).
 */
function nameTokens(name) {
  const tokens = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return { full: tokens.join(' '), first: tokens[0], tokenCount: tokens.length };
}

/**
 * Find which roster candidate (if any) is mentioned in a turn's text. The
 * roster is CLOSED (3-6 people), so a single-token first-name match is safe
 * here where a global match would not be — but only when that first name is
 * unambiguous within the roster. A ≥2-token full-name match always wins.
 *
 * Returns the matched candidate or null.
 */
function mentionedCandidate(text, candidates) {
  const t = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  // Full-name match first (highest precision).
  for (const c of candidates) {
    const nt = nameTokens(c.name);
    if (nt && nt.tokenCount >= 2 && t.includes(` ${nt.full} `)) return c;
  }
  // First-name match, but only when that first name is UNIQUE in the roster
  // (closed-set safety — two "Davids" can't be disambiguated by first name).
  const firstNameCounts = new Map();
  for (const c of candidates) {
    const nt = nameTokens(c.name);
    if (nt) firstNameCounts.set(nt.first, (firstNameCounts.get(nt.first) || 0) + 1);
  }
  for (const c of candidates) {
    const nt = nameTokens(c.name);
    if (nt && firstNameCounts.get(nt.first) === 1 && t.includes(` ${nt.first} `)) return c;
  }
  return null;
}

function hasHandoffCue(text) {
  const t = String(text || '').toLowerCase();
  return HANDOFF_CUES.some((cue) => t.includes(cue));
}

/**
 * Run the deterministic waterfall over a transcript's turns.
 *
 * @param {object} params
 * @param {Array<{turn_index:number,source:string,text:string}>} params.segments  — ordered turns
 * @param {Array<{personId:string|null,name:string,email:string}>} params.candidates — roster (resolved)
 * @param {string|null} params.ownerPersonId  — the recorder; null when identity unconfigured
 * @returns {Map<number, {personId:string, confidence:number, method:string}>}
 *   keyed by turn_index. Only settled turns appear; the rest stay for later
 *   layers / unassigned.
 */
export function attributeDeterministic({ segments, candidates, ownerPersonId }) {
  const c = cfg();
  const proposals = new Map();
  const roster = (candidates || []).filter((x) => x.personId); // only resolvable people can be assigned

  // ── Layer 1: mic anchor ──────────────────────────────────────────────────
  // Every microphone turn is the owner. confidence 1.0, method 'mic_anchor'.
  // Skipped honestly when the owner is not resolvable (identity unconfigured):
  // a microphone turn we can't tie to a person stays unassigned, never guessed.
  if (ownerPersonId) {
    for (const s of segments) {
      if (s.source === 'microphone') {
        proposals.set(s.turn_index, { personId: ownerPersonId, confidence: 1.0, method: 'mic_anchor' });
      }
    }
  }

  // The non-owner roster — the candidate set for system turns.
  const others = roster.filter((x) => x.personId !== ownerPersonId);

  // ── Layer 2: name-mention / vocative ─────────────────────────────────────
  // A roster name spoken in turn i predicts the NEXT speaker is that person
  // (addressee takes the floor). Pin turn i+1 when it is a system turn still
  // unsettled and the named person is not the owner.
  for (let i = 0; i < segments.length - 1; i++) {
    const s = segments[i];
    const next = segments[i + 1];
    if (next.source !== 'system' || proposals.has(next.turn_index)) continue;
    const named = mentionedCandidate(s.text, others);
    if (named) {
      proposals.set(next.turn_index, { personId: named.personId, confidence: c.nameMentionConfidence, method: 'name_mention' });
    }
  }

  // ── Layer 3: hand-off ────────────────────────────────────────────────────
  // An explicit hand-off cue + a named candidate in turn i hands turn i+1 to
  // that candidate with slightly lower confidence than a clean vocative.
  for (let i = 0; i < segments.length - 1; i++) {
    const s = segments[i];
    const next = segments[i + 1];
    if (next.source !== 'system' || proposals.has(next.turn_index)) continue;
    if (!hasHandoffCue(s.text)) continue;
    const named = mentionedCandidate(s.text, others);
    if (named) {
      proposals.set(next.turn_index, { personId: named.personId, confidence: c.handoffConfidence, method: 'handoff' });
    }
  }

  // ── Layer 4: turn-taking propagation ─────────────────────────────────────
  // The documented adjacency win, applied conservatively: when the roster has
  // exactly ONE resolvable non-owner candidate, every still-unsettled system
  // turn is that person BY ELIMINATION (a 2-person call — owner + one other —
  // is fully determined; this is deterministic, not a guess, so its confidence
  // sits above the reject floor). With more than one other candidate we do NOT
  // guess here; the residual layer (fingerprint + LLM) handles those.
  if (others.length === 1) {
    const only = others[0];
    for (const s of segments) {
      if (s.source === 'system' && !proposals.has(s.turn_index)) {
        proposals.set(s.turn_index, { personId: only.personId, confidence: c.turntakingConfidence, method: 'turntaking' });
      }
    }
  }

  return proposals;
}

export { mentionedCandidate, nameTokens, HANDOFF_CUES };
