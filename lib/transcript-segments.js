/**
 * lib/transcript-segments.js — data-access layer for transcript_segments
 * (st_8a841c68). One row per speaker turn.
 *
 * Thin-facade (build-conventions): every function takes `db` as its first
 * parameter so routes stay HTTP-only and the logic is unit-testable with an
 * injected in-memory DB. No module-level db singleton here.
 *
 * This DAL is the ONLY identity-writing surface for segments
 * (setSegmentSpeaker / insertSegments). The LLM residual scorer must never
 * import it — the inviolable LLM-write boundary (deterministic code writes
 * speaker_person_id; the model only scores) is enforced by a criterion that
 * greps lib/attribute-residual.js for these names.
 */

import { ownerDisplayName, ownerPersonId } from './identity.js';

const VALID_METHODS = new Set([
  'mic_anchor', 'name_mention', 'handoff', 'turntaking',
  'fingerprint', 'llm', 'confirmed', 'unassigned',
]);

function displayNameForPerson(rawName, personId) {
  if (personId && personId === ownerPersonId()) {
    return ownerDisplayName();
  }
  return rawName || 'Unknown';
}

/**
 * Idempotent batch insert of a transcript's turns. Keyed on the
 * (transcript_id, turn_index) UNIQUE constraint via INSERT OR IGNORE, so
 * re-running the backfill over the same call upserts the same rows and never
 * duplicates a turn.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} transcriptId
 * @param {Array<{turnIndex:number,startMs:number|null,endMs:number|null,source:string,text:string}>} segments
 * @returns {{inserted:number}}
 */
export function insertSegments(db, transcriptId, segments) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transcript_segments
      (transcript_id, turn_index, start_ms, end_ms, source, text)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  const tx = db.transaction((rows) => {
    for (const s of rows) {
      const info = stmt.run(
        transcriptId,
        s.turnIndex,
        s.startMs ?? null,
        s.endMs ?? null,
        s.source,
        s.text ?? '',
      );
      inserted += info.changes;
    }
  });
  tx(segments);
  return { inserted };
}

/**
 * All turns for a transcript, in conversational order.
 * @param {import('better-sqlite3').Database} db
 * @param {string} transcriptId
 * @returns {Array<object>}
 */
export function getSegments(db, transcriptId) {
  return db.prepare(
    'SELECT * FROM transcript_segments WHERE transcript_id = ? ORDER BY turn_index ASC',
  ).all(transcriptId);
}

/**
 * Write an identity onto a single turn. The deterministic write path used by
 * the orchestrator for EVERY layer (anchor, propagation, fingerprint, and the
 * model's score after the orchestrator has read it). `confirmed` turns are
 * sticky — a later pass must not overwrite them (the orchestrator enforces
 * that by skipping them; this DAL is the raw writer).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} segmentId
 * @param {string|null} personId  — null leaves the turn unassigned
 * @param {number} confidence
 * @param {string} method  — must be one of VALID_METHODS
 * @param {{needsConfirm?:boolean}} [opts]
 */
export function setSegmentSpeaker(db, segmentId, personId, confidence, method, opts = {}) {
  if (!VALID_METHODS.has(method)) {
    throw new Error(`invalid segment method: ${method}`);
  }
  const needsConfirm = opts.needsConfirm ? 1 : 0;
  db.prepare(`
    UPDATE transcript_segments
       SET speaker_person_id = ?, confidence = ?, method = ?, needs_confirm = ?
     WHERE id = ?
  `).run(personId ?? null, confidence, method, needsConfirm, segmentId);
}

/**
 * Compute talk-share for a transcript: speaking milliseconds per named person
 * over attributed turns, plus an explicit unassigned bucket and total.
 *
 * WHY an explicit unassignedMs bucket: an all-unassigned call must report 100%
 * unassigned — honest, not a divide-by-zero or 100%-to-one-accidental-name
 * (plan failure manifest #5). Duration per turn is (end_ms - start_ms); when a
 * timestamp is missing the turn contributes 0 ms (it still exists as a turn,
 * it just adds no speaking time).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} transcriptId
 * @returns {{byPerson:Record<string,number>, unassignedMs:number, totalMs:number}}
 */
export function talkShare(db, transcriptId) {
  const rows = db.prepare(
    'SELECT speaker_person_id, start_ms, end_ms FROM transcript_segments WHERE transcript_id = ?',
  ).all(transcriptId);
  const byPerson = {};
  let unassignedMs = 0;
  let totalMs = 0;
  for (const r of rows) {
    const ms = (r.start_ms != null && r.end_ms != null && r.end_ms > r.start_ms)
      ? (r.end_ms - r.start_ms)
      : 0;
    totalMs += ms;
    if (r.speaker_person_id) {
      byPerson[r.speaker_person_id] = (byPerson[r.speaker_person_id] || 0) + ms;
    } else {
      unassignedMs += ms;
    }
  }
  return { byPerson, unassignedMs, totalMs };
}

/**
 * Read a transcript's attributed turns + talk-share for the UI (st_8a841c68
 * AC-6 read surface). Each turn carries its speaker name (or null = unassigned),
 * confidence, method, and the needs_confirm flag so the app can render the
 * conversation, the per-turn confidence, and the one-tap confirm affordance.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} transcriptId
 * @returns {{transcriptId:string, turns:Array, talkShare:object}|null}
 */
export function getAttributedTranscript(db, transcriptId) {
  const t = db.prepare('SELECT id, title, talk_share, attributed_at FROM transcripts WHERE id = ?').get(transcriptId);
  if (!t) return null;
  const rows = db.prepare(`
    SELECT s.id, s.turn_index, s.source, s.text, s.speaker_person_id,
           s.confidence, s.method, s.needs_confirm, p.display_name AS speaker_name
      FROM transcript_segments s
      LEFT JOIN people p ON p.id = s.speaker_person_id
     WHERE s.transcript_id = ?
     ORDER BY s.turn_index ASC
  `).all(transcriptId);
  const turns = rows.map((r) => ({
    segmentId: r.id,
    turnIndex: r.turn_index,
    source: r.source,
    text: r.text,
    personId: r.speaker_person_id,
    speakerName: r.speaker_person_id ? displayNameForPerson(r.speaker_name, r.speaker_person_id) : null,
    confidence: r.confidence,
    method: r.method,
    needsConfirm: r.needs_confirm === 1,
  }));
  let talkShare = {};
  try { talkShare = JSON.parse(t.talk_share || '{}'); } catch { talkShare = {}; }
  return { transcriptId: t.id, title: t.title, attributedAt: t.attributed_at, turns, talkShare };
}

export { VALID_METHODS };
