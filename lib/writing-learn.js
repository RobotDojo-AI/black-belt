/**
 * lib/writing-learn.js — compound owner voice from how they write to the world.
 *
 * Sources: samples/ plus sent mail. Operator chat to Miyagi is not a source —
 * that register is quick and dirty, and it trains Miyagi, not owner drafts.
 * Chat-log mining (scripts/mine-conversation-feedback.js) is the Miyagi path.
 *
 * Compounds owner voice.md in the background. No approval. Never Miyagi.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { WK_USER_VOICE_DIR } from './robotdojo-paths.js';

export const INTELLIGENCE_TIER = 'extraction';

export const FIRST_CHARS = 8000;
export const MIN_CHARS = 8000;
export const MAX_CHARS = 120000;
export const GROWTH_EMPTY = 2;
export const GROWTH_HIT = 1.25;
export const PLATEAU_EMPTY = 4;
export const LEARN_EPS = 0.08;
export const LEARNED_NAME = 'learned.md';
export const STATE_NAME = 'learn-state.json';
export const AUTO_START = '<!-- AUTO:writing-learn -->';
export const AUTO_END = '<!-- /AUTO:writing-learn -->';

const SAMPLE_EXTS = new Set([
  '.txt', '.md', '.pdf', '.docx', '.doc',
  '.pptx', '.ppt', '.html', '.htm', '.rtf', '.eml', '.mbox',
]);

export function nextThreshold({ lastThreshold = FIRST_CHARS, learned = false, consecutiveEmpty = 0 } = {}) {
  if (consecutiveEmpty >= PLATEAU_EMPTY) return MAX_CHARS;
  const base = Math.max(MIN_CHARS, Number(lastThreshold) || FIRST_CHARS);
  const grown = learned ? base * GROWTH_HIT : base * GROWTH_EMPTY;
  return Math.min(MAX_CHARS, Math.round(grown));
}

export function featureDistance(a, b) {
  if (!a || !b) return 1;
  const dims = [
    clamp01((a.avgSentenceLen || 0) / 40) - clamp01((b.avgSentenceLen || 0) / 40),
    clamp01((a.avgParaLen || 0) / 80) - clamp01((b.avgParaLen || 0) / 80),
    (a.contractionDensity || 0) - (b.contractionDensity || 0),
    (a.spokenDensity || 0) - (b.spokenDensity || 0),
    (a.bulletDensity || 0) - (b.bulletDensity || 0),
    (a.headerDensity || 0) - (b.headerDensity || 0),
    (a.formalDensity || 0) - (b.formalDensity || 0),
    Number(!!a.hasGreeting) - Number(!!b.hasGreeting),
    Number(!!a.hasSignOff) - Number(!!b.hasSignOff),
  ];
  return Math.sqrt(dims.reduce((s, d) => s + d * d, 0) / dims.length);
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function fingerprint(path) {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}|${st.size}`;
  } catch {
    return '';
  }
}

function collectSampleFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.name.startsWith('.')) continue;
    if (ent.isDirectory()) {
      if (ent.name === 'reviews') continue;
      collectSampleFiles(full, acc);
      continue;
    }
    if (SAMPLE_EXTS.has(extname(ent.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

function readTextFile(path) {
  try {
    if (extname(path).toLowerCase() !== '.txt' && extname(path).toLowerCase() !== '.md') return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function cacheFile(voiceDir, rel, fp) {
  const key = createHash('sha256').update(`${rel}|${fp}`).digest('hex').slice(0, 24);
  return join(voiceDir, '.learn-cache', `${key}.txt`);
}

async function bodyFor(voiceDir, item, extractText) {
  if (!item.path) return '';
  const cached = cacheFile(voiceDir, item.rel, item.fp);
  if (existsSync(cached)) {
    try { return readFileSync(cached, 'utf8'); } catch { /* extract */ }
  }
  const cheap = readTextFile(item.path);
  const body = cheap || (await extractText(item.path)) || '';
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, body);
  return body;
}

export async function loadSentMailItems({ limit = 300 } = {}) {
  try {
    const db = (await import('./db.js')).default;
    const rows = db.prepare(`
      SELECT id, body_text, received_at
      FROM emails
      WHERE labels LIKE '%"SENT"%'
        AND body_text IS NOT NULL
        AND length(body_text) >= 200
      ORDER BY received_at DESC
      LIMIT ?
    `).all(limit);
    return rows.map((r) => ({
      rel: `__email:${r.id}`,
      fp: `${r.received_at}|${String(r.body_text).length}`,
      path: null,
      extra: r.body_text,
    }));
  } catch {
    return [];
  }
}

export function collectNewSource({
  voiceDir = WK_USER_VOICE_DIR,
  seen = {},
  extraText = '',
  mailItems = [],
} = {}) {
  const samplesDir = join(voiceDir, 'samples');
  const files = collectSampleFiles(samplesDir).map((path) => ({
    rel: relative(samplesDir, path),
    fp: fingerprint(path),
    path,
  }));
  const unseen = files.filter((f) => seen[f.rel] !== f.fp);
  for (const item of mailItems) {
    if (!item?.rel || seen[item.rel] === item.fp) continue;
    unseen.push(item);
  }
  if (extraText) {
    const extraHash = createHash('sha256').update(extraText).digest('hex').slice(0, 16);
    if (seen['__outbound'] !== extraHash) {
      unseen.push({ rel: '__outbound', fp: extraHash, path: null, extra: extraText });
    }
  }
  return { files, unseen, mailItems };
}

async function extractItems(voiceDir, items) {
  const { extractText } = await import('./voice-ingest.js');
  const bodies = [];
  let chars = 0;
  for (const item of items) {
    const body = item.extra || await bodyFor(voiceDir, item, extractText);
    if (!body) continue;
    bodies.push(body);
    chars += body.length;
  }
  return { text: bodies.join('\n\n'), chars, bodies };
}

export function renderLearnedMarkdown({ features, fileCount, wordCount }) {
  return [
    '# Observed from your writing',
    AUTO_START,
    '',
    renderVoiceObservations({ features, fileCount, wordCount }),
    '',
    AUTO_END,
    '',
  ].join('\n');
}

export function renderVoiceObservations({ features, fileCount, wordCount }) {
  const avg = Math.round(features.avgSentenceLen || 0);
  const para = Math.round(features.avgParaLen || 0);
  const sentence = avg <= 12
    ? `Sentences average ${avg} words. Short lines and fragments are common.`
    : avg <= 20
      ? `Sentences average ${avg} words.`
      : `Sentences average ${avg} words. Longer exploratory sentences show up.`;
  const paragraph = para <= 30
    ? `Paragraphs are short. One idea, then a break.`
    : `Paragraphs average ${para} words. Let a short sentence land the point after a longer one.`;
  const contractions = (features.contractionDensity || 0) > 0.03
    ? 'Contractions are frequent. Write like speech that made it onto the page.'
    : 'Contractions are sparse. Write the word.';
  const lists = (features.bulletDensity || 0) > 0.12
    ? 'Lists carry atomic items. Prose still carries the argument.'
    : 'Prose carries the argument. Lists only when the items are atomic.';
  const formal = (features.formalDensity || 0) > 0.015
    ? 'Formal markers show up. Keep them when the piece is a memo or proposal.'
    : 'Formal legal and consulting filler is rare. Plain language.';
  const spoken = (features.spokenDensity || 0) > 0.005
    ? 'Spoken cadence shows up.'
    : 'Spoken slang is rare.';
  const envelope = features.hasGreeting
    ? 'Notes often open with a greeting and a name.'
    : 'Jump into the thought. No throat-clearing.';
  return [
    `Based on ${wordCount} words across ${fileCount} source(s).`,
    '',
    '## Style',
    sentence,
    paragraph,
    contractions,
    lists,
    '',
    '## Tone',
    formal,
    spoken,
    envelope,
    '',
    '## When drafting',
    'Match this cadence. Complete sentences a partner can read once.',
    'Spell a term, then put the abbreviation in parentheses.',
    avg > 20
      ? 'A long exploratory sentence, then a short one that lands.'
      : 'Keep the line short. A fragment is fine when it is the point.',
  ].join('\n');
}

export function hasAutoBlock(text) {
  return String(text || '').includes(AUTO_START) && String(text || '').includes(AUTO_END);
}

export function stripAutoBlock(text) {
  return String(text || '')
    .replace(new RegExp(`\\n?${escapeReg(AUTO_START)}[\\s\\S]*?${escapeReg(AUTO_END)}\\n?`, 'g'), '\n')
    .trimEnd();
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compoundOwnerVoice(prior, { features, fileCount, wordCount } = {}) {
  const auto = [
    AUTO_START,
    renderVoiceObservations({ features, fileCount, wordCount }),
    AUTO_END,
  ].join('\n');
  const seed = stripAutoBlock(prior || '').trim();
  if (!seed) {
    return `# User voice — base register\n\n${auto}\n`;
  }
  return `${seed}\n\n${auto}\n`;
}

function writeOwnerVoice(voicePath, learnedPath, payload) {
  const prior = existsSync(voicePath) ? readFileSync(voicePath, 'utf8') : '';
  const next = compoundOwnerVoice(prior, payload);
  writeFileSync(voicePath, next);
  writeFileSync(learnedPath, renderLearnedMarkdown(payload));
}

function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {
      version: 1,
      consecutive_empty: 0,
      learn_count: 0,
      next_chars: FIRST_CHARS,
      seen: {},
      last_features: null,
    };
  }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function markSeen(state, unseen) {
  const seen = { ...(state.seen || {}) };
  for (const u of unseen) seen[u.rel] = u.fp;
  return seen;
}

/**
 * One cheap pass. No LLM. Compounds owner voice.md. Never Miyagi.
 * @returns {{ ran: boolean, learned: boolean, reason: string, newChars: number, nextChars: number, consecutiveEmpty: number }}
 */
export async function maybeLearnOwnerVoice({
  voiceDir = WK_USER_VOICE_DIR,
  extraText = '',
  mailItems,
  now = new Date().toISOString(),
} = {}) {
  mkdirSync(voiceDir, { recursive: true });
  mkdirSync(join(voiceDir, 'samples'), { recursive: true });
  const statePath = join(voiceDir, STATE_NAME);
  const learnedPath = join(voiceDir, LEARNED_NAME);
  const voicePath = join(voiceDir, 'voice.md');
  const priorVoice = existsSync(voicePath) ? readFileSync(voicePath, 'utf8') : '';

  const mail = mailItems !== undefined
    ? mailItems
    : (voiceDir === WK_USER_VOICE_DIR ? await loadSentMailItems() : []);

  const state = loadState(statePath);
  const collected = collectNewSource({
    voiceDir,
    seen: state.seen || {},
    extraText,
    mailItems: mail,
  });
  const { unseen, files } = collected;
  const threshold = Math.max(MIN_CHARS, state.next_chars || FIRST_CHARS);
  const fresh = await extractItems(voiceDir, unseen);
  const newChars = fresh.chars;

  if (newChars < threshold) {
    if (state.last_features && !hasAutoBlock(priorVoice)) {
      const payload = {
        features: state.last_features,
        fileCount: Object.keys(state.seen || {}).length || files.length,
        wordCount: state.last_features.wordCount || 0,
      };
      writeOwnerVoice(voicePath, learnedPath, payload);
      return {
        ran: true,
        learned: true,
        reason: 'compounded',
        newChars,
        nextChars: threshold,
        consecutiveEmpty: state.consecutive_empty || 0,
      };
    }
    return {
      ran: false,
      learned: false,
      reason: 'below_threshold',
      newChars,
      nextChars: threshold,
      consecutiveEmpty: state.consecutive_empty || 0,
    };
  }

  const { computeFeatures } = await import('./voice-ingest.js');
  const newFeatures = computeFeatures(fresh.text);
  if (!newFeatures || newFeatures.wordCount < 80) {
    const empty = (state.consecutive_empty || 0) + 1;
    const next = nextThreshold({ lastThreshold: threshold, learned: false, consecutiveEmpty: empty });
    saveState(statePath, {
      ...state,
      last_run_at: now,
      consecutive_empty: empty,
      next_chars: next,
      seen: markSeen(state, unseen),
    });
    return { ran: true, learned: false, reason: 'too_thin', newChars, nextChars: next, consecutiveEmpty: empty };
  }

  const extraItems = [
    ...mail,
    ...(extraText ? [{ rel: '__outbound', fp: 'live', path: null, extra: extraText }] : []),
  ];
  const corpusItems = [...files, ...extraItems];
  const corpus = corpusItems.length ? await extractItems(voiceDir, corpusItems) : fresh;
  const corpusFeatures = computeFeatures(corpus.text) || newFeatures;
  const dist = featureDistance(newFeatures, state.last_features);
  const learned = !state.last_features || dist >= LEARN_EPS;
  const empty = learned ? 0 : (state.consecutive_empty || 0) + 1;
  const next = nextThreshold({ lastThreshold: threshold, learned, consecutiveEmpty: empty });
  const sourceCount = files.length + extraItems.length;

  if (learned) {
    writeOwnerVoice(voicePath, learnedPath, {
      features: corpusFeatures,
      fileCount: sourceCount,
      wordCount: corpusFeatures.wordCount,
    });
  }

  saveState(statePath, {
    version: 1,
    last_run_at: now,
    last_learn_at: learned ? now : state.last_learn_at || null,
    consecutive_empty: empty,
    learn_count: (state.learn_count || 0) + (learned ? 1 : 0),
    next_chars: next,
    seen: markSeen(state, unseen),
    last_features: corpusFeatures,
    last_distance: dist,
  });

  return {
    ran: true,
    learned,
    reason: learned ? 'learned' : 'stable',
    newChars,
    nextChars: next,
    consecutiveEmpty: empty,
    distance: dist,
  };
}
