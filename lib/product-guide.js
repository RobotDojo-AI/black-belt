/**
 * lib/product-guide.js — Miyagi as the product guide (st_f67bc2eb D11, AC-8).
 *
 * Routes the EXISTING generated public-truth projection (apps/static/faq/
 * *.json — human-authored canonical docs → scripts/generate-public-truth.js,
 * each answer carrying its Source attribution) into authenticated chat, so
 * product-usage questions answer GROUNDED, naming the source document, and
 * say plainly when the docs do not cover the question instead of guessing.
 *
 * Rejected design: a code-reading answerer — unbounded and ungated. The docs
 * projection is the product's public truth surface; grounding on it keeps
 * every answer attributable.
 *
 * Tier 0 on the routing path: an in-memory keyword index built ONCE at boot
 * (warmup primes it), a deterministic question-shape + product-term detector,
 * and a volatile-context block assembled by string concat. No LLM in the
 * detector, no new fetches, cached prefix untouched (the block rides the
 * volatile tail only).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAQ_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'static', 'faq');

// Question-shape gate: interrogative start or a question mark. A statement
// never triggers the guide.
const QUESTION_SHAPE_RE = /^(?:how|where|what|can|could|do|does|is|are|why|when|which|who)\b|[?？]\s*$/i;

// Generic words that must never count as product-term evidence.
const STOPWORDS = new Set([
  'what', 'is', 'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for',
  'do', 'does', 'i', 'my', 'me', 'you', 'your', 'how', 'can', 'where', 'why',
  'when', 'which', 'who', 'are', 'it', 'its', 'with', 'that', 'this', 'from',
  'robot', 'dojo', 'should', 'need', 'want', 'about', 'have', 'has', 'get',
]);

let _index = null; // [{ q, a, source, keywords:Set }]
let _termSet = null; // union of all entry keywords (the product-term evidence set)

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
}

function addEntry(index, q, a, source) {
  if (!q || !a) return;
  const keywords = new Set([...tokenize(q), ...tokenize(a)].filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
  index.push({ q: q.trim(), a: a.trim(), source: (source || 'product docs').trim(), keywords });
}

/** Parse a "Q: … A: … Source: …" projection blob into entries. */
function parseContextBlob(blob, index) {
  const chunks = String(blob || '').split(/\n(?=Q:\s)/);
  for (const chunk of chunks) {
    const m = chunk.match(/^Q:\s*([\s\S]*?)\nA:\s*([\s\S]*?)(?:\nSource:\s*(.*))?\s*$/);
    if (m) addEntry(index, m[1], m[2], m[3]);
  }
}

/**
 * Build (or return) the in-memory index over every generated FAQ file —
 * core.json's structured categories plus each guide file's Q/A/Source blob,
 * deduped by question text.
 */
export function loadProductGuideIndex({ force = false } = {}) {
  if (_index && !force) return _index;
  const index = [];
  let files = [];
  try { files = readdirSync(FAQ_DIR).filter((f) => f.endsWith('.json')); } catch { files = []; }
  for (const file of files) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(resolve(FAQ_DIR, file), 'utf8')); } catch { continue; }
    if (parsed?.categories) {
      for (const entries of Object.values(parsed.categories)) {
        for (const e of entries || []) addEntry(index, e.q, e.a, e.source);
      }
    }
    if (typeof parsed?.context === 'string') parseContextBlob(parsed.context, index);
  }
  // Dedup by normalized question (core + guide files overlap by design).
  const seen = new Set();
  _index = index.filter((e) => {
    const key = e.q.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  _termSet = new Set();
  for (const e of _index) for (const k of e.keywords) _termSet.add(k);
  return _index;
}

/**
 * Deterministic product-usage detector (Tier 0): question shape + at least
 * two product-term hits against the docs index vocabulary. Returns the
 * matched entries best-first (possibly empty — an uncovered product question
 * still fires so the answer contract can say "not documented" instead of the
 * model guessing).
 *
 * @returns {null | { matches: Array<{q, a, source}>, terms: string[] }}
 */
export function detectProductQuestion(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 400) return null;
  if (!QUESTION_SHAPE_RE.test(raw)) return null;
  loadProductGuideIndex();
  const tokens = [...new Set(tokenize(raw).filter((t) => t.length >= 3 && !STOPWORDS.has(t)))];
  const terms = tokens.filter((t) => _termSet.has(t));
  // Product-usage evidence floor: two independent vocabulary hits, or one hit
  // plus an explicit product mention ("robot dojo").
  const mentionsProduct = /\brobot\s*dojo\b/i.test(raw);
  if (terms.length < 2 && !(terms.length >= 1 && mentionsProduct)) return null;

  // Score floor scales with available evidence: a short explicit question
  // ("How do I install Robot Dojo?" — one non-stopword term) still matches
  // its entries; longer questions need two overlapping terms.
  const scoreFloor = terms.length >= 2 ? 2 : 1;
  const scored = _index
    .map((e) => ({ e, score: terms.reduce((n, t) => n + (e.keywords.has(t) ? 1 : 0), 0) }))
    .filter((s) => s.score >= scoreFloor)
    .sort((a, b) => b.score - a.score || a.e.q.localeCompare(b.e.q))
    .slice(0, 3);
  return { matches: scored.map((s) => ({ q: s.e.q, a: s.e.a, source: s.e.source })), terms };
}

/**
 * The grounded block injected into the VOLATILE context for a detected
 * product-usage question. Carries the matched entries with their source
 * names and the answer contract: answer only from these, name the source,
 * and when the docs do not cover it say so plainly — never guessed steps.
 */
export function buildProductGuideBlock(detection) {
  if (!detection) return '';
  const lines = [
    '## Product guide (Robot Dojo documentation)',
    'The user is asking how to use the product. Answer ONLY from the documented entries below, and name the source document in your answer.',
  ];
  if (detection.matches.length) {
    for (const m of detection.matches) {
      lines.push(`- Q: ${m.q}\n  A: ${m.a}\n  Source: ${m.source}`);
    }
    lines.push(
      'If none of these entries actually answers the question, say plainly that the product documentation does not cover it and stop. '
      + 'Do NOT then describe, explain, or speculate about the feature from your own knowledge of how the system might work — that is a guess, and a guess about product behaviour is worse than an honest "not documented."',
    );
  } else {
    lines.push(
      'No documented entry covers this question. Reply with ONLY: that the product documentation does not cover it, and that the user can ask the founders. '
      + 'Then STOP. Do NOT add "what I can tell you from the system is…", do NOT describe or explain the feature, do NOT infer its behaviour from tool names, config, or general reasoning. '
      + 'An inferred explanation of an undocumented feature is exactly the guessing this contract forbids — omission is the correct answer.',
    );
  }
  return lines.join('\n');
}

/** Test hook. */
export function _resetProductGuideForTest() {
  _index = null;
  _termSet = null;
}
