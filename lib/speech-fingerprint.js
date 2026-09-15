/**
 * lib/speech-fingerprint.js — cross-call speech profiles (st_8a841c68 Phase 4).
 *
 * Tier 0 (free, local): content-masked style features + a mean-pooled LOCAL
 * embedding (lib/rag.js). NO LLM — a criterion greps this file to prove it uses
 * the local embedder and never MODELS.* / llmCreate (AC-5).
 *
 * The features are deliberately content-MASKED (function-word frequencies,
 * filler/discourse-marker rates, mean turn length) — the register layer the
 * research showed survives topic control. Topic-leaking content features are
 * excluded by construction, so a fingerprint re-identifies the same person on a
 * new agenda instead of matching the topic.
 *
 * Thin-facade: db is the first argument on the DB-touching functions.
 */

import { embed, vectorToBuffer, EMBED_DIM, cosineSimilarity } from './rag.js';

// Closed function-word + discourse-marker lexicon. These survive topic control
// (research §1/§3) where content words and punctuation do not. Frequencies are
// normalized per-token so turn length doesn't dominate.
const FUNCTION_WORDS = [
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'because', 'if', 'then',
  'i', 'you', 'we', 'they', 'he', 'she', 'it', 'this', 'that', 'there',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'did', 'does', 'have',
  'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'as',
];
const FILLERS = ['um', 'uh', 'like', 'right', 'yeah', 'okay', 'ok', 'know', 'mean', 'actually', 'basically', 'literally'];

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Deterministic content-masked style features over a set of turns.
 * @param {string[]} turns
 * @returns {{tokenCount:number, meanTurnTokens:number, functionWordRates:Record<string,number>, fillerRate:number}}
 */
export function fingerprintTurns(turns) {
  const allTokens = [];
  let turnLenSum = 0;
  let nonEmptyTurns = 0;
  for (const t of turns) {
    const toks = tokenize(t);
    if (toks.length === 0) continue;
    nonEmptyTurns++;
    turnLenSum += toks.length;
    for (const tok of toks) allTokens.push(tok);
  }
  const tokenCount = allTokens.length;
  const functionWordRates = {};
  if (tokenCount > 0) {
    const counts = new Map();
    for (const tok of allTokens) counts.set(tok, (counts.get(tok) || 0) + 1);
    for (const w of FUNCTION_WORDS) functionWordRates[w] = (counts.get(w) || 0) / tokenCount;
    let fillerHits = 0;
    for (const f of FILLERS) fillerHits += counts.get(f) || 0;
    return {
      tokenCount,
      meanTurnTokens: nonEmptyTurns > 0 ? turnLenSum / nonEmptyTurns : 0,
      functionWordRates,
      fillerRate: fillerHits / tokenCount,
    };
  }
  return { tokenCount: 0, meanTurnTokens: 0, functionWordRates: {}, fillerRate: 0 };
}

/**
 * Decode an embedding BLOB into a Float32Array (inverse of vectorToBuffer).
 */
function bufferToVector(buf) {
  if (!buf) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Read a person's stored profile vector (Float32Array) or null.
 * @param {import('better-sqlite3').Database} db
 * @param {string} personId
 */
export function profileVector(db, personId) {
  const row = db.prepare('SELECT embedding FROM person_speech_profile WHERE person_id = ?').get(personId);
  return row?.embedding ? bufferToVector(row.embedding) : null;
}

/**
 * Accumulate a person's confirmed/owner turns into their speech profile:
 * recompute the content-masked style features and a mean-pooled local
 * embedding, and grow token_count toward the ~1k floor that governs how much a
 * fingerprint match is trusted.
 *
 * WHY upsert the full feature set rather than incrementally merge vectors: the
 * caller passes the FULL confirmed corpus for the person (cheap — local embed),
 * so a clean recompute is simpler and correct than an online mean. Idempotent.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} personId
 * @param {string[]} confirmedTurns  — the person's confirmed/owner turn texts
 * @returns {Promise<{tokenCount:number}>}
 */
export async function updateProfile(db, personId, confirmedTurns) {
  const features = fingerprintTurns(confirmedTurns);
  if (features.tokenCount === 0) {
    // Nothing usable — record an empty profile so the row exists but contributes
    // no confidence (token_count 0). Never fabricate a vector.
    db.prepare(`
      INSERT INTO person_speech_profile (person_id, token_count, style_features, embedding, updated_at)
      VALUES (?, 0, '{}', NULL, datetime('now'))
      ON CONFLICT(person_id) DO UPDATE SET token_count = 0, style_features = '{}', updated_at = datetime('now')
    `).run(personId);
    return { tokenCount: 0 };
  }

  // Mean-pooled embedding: embed the concatenated confirmed turns (content-
  // bearing for the vector, by design — the cosine match is one signal; the
  // content-masked style_features are the topic-robust companion).
  let embeddingBuf = null;
  try {
    const vec = await embed(confirmedTurns.join('\n').slice(0, 8000), { inputType: 'document' });
    if (vec && vec.length === EMBED_DIM) embeddingBuf = vectorToBuffer(vec);
  } catch (e) {
    console.warn(`[fingerprint] embed failed for ${personId}: ${e.message}`);
  }

  db.prepare(`
    INSERT INTO person_speech_profile (person_id, token_count, style_features, embedding, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(person_id) DO UPDATE SET
      token_count = excluded.token_count,
      style_features = excluded.style_features,
      embedding = excluded.embedding,
      updated_at = datetime('now')
  `).run(personId, features.tokenCount, JSON.stringify(features), embeddingBuf);

  return { tokenCount: features.tokenCount };
}

export { cosineSimilarity, FUNCTION_WORDS, FILLERS };
