/**
 * voice-ingest.js — Voice sample extraction, feature analysis, register classification,
 * voice doc augmentation, and voice.md synthesis.
 *
 * Compute tier:
 *   Tier 0: feature extraction + classification (local, free)
 *   Tier 1: Haiku for disambiguation when Tier 0 score is ambiguous (< 20% gap)
 *   Tier 2: Sonnet for voice doc augmentation and voice.md synthesis
 */
// INTELLIGENCE_TIER: synthesis — writes wk_user/user-voice/structure/, the
// calibration corpus every future piece of owner-voice prose is drafted
// against (a held substrate site per this story's plan).
export const INTELLIGENCE_TIER = 'synthesis';

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { llmCreate } from './llm-gateway.js';
import { modelFor } from './model-lane.js';

// ── Constants ──────────────────────────────────────────────────────────────

// The canonical document-type registers — exactly the per-register docs under
// wk_user/user-voice/structure/. Channels (email, sms) are a separate axis
// (wk_user/user-voice/formatting/), not registers, so they are NOT scored here.
export const CANONICAL_REGISTERS = [
  'bio', 'business-memo', 'business-ppt', 'deck', 'essay', 'heartfelt',
  'memo', 'personal-essay', 'proposal', 'public-post', 'speech', 'whitepaper',
];

// The per-register voice docs synthesizeVoiceMd reads live under the owner voice
// corpus's registers/ subdir (config/voices/ was retired by st_73169c14).
const VOICES_DIR = resolve(homedir(), 'robotdojo/user/workbenches/user/wk_user/user-voice/structure');

// ── Text extraction ────────────────────────────────────────────────────────

/**
 * Extract writing from a sample. Format is not the product — extracted text is.
 * Returns null if extraction fails or yields no text.
 */
export async function extractText(filePath) {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.txt' || ext === '.md') {
    try {
      return nonempty(readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  if (ext === '.html' || ext === '.htm') {
    try {
      return nonempty(stripMarkup(readFileSync(filePath, 'utf8')));
    } catch {
      return null;
    }
  }

  if (ext === '.rtf') {
    try {
      return nonempty(stripRtf(readFileSync(filePath, 'utf8')));
    } catch {
      return null;
    }
  }

  if (ext === '.eml' || ext === '.mbox') {
    try {
      return nonempty(stripEml(readFileSync(filePath, 'utf8')));
    } catch {
      return null;
    }
  }

  if (ext === '.pdf') {
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const data = await pdfParse(readFileSync(filePath));
      return nonempty(data.text);
    } catch {
      return null;
    }
  }

  if (ext === '.docx' || ext === '.doc') {
    try {
      const mammoth = (await import('mammoth')).default;
      const result = await mammoth.extractRawText({ path: filePath });
      return nonempty(result.value);
    } catch {
      return null;
    }
  }

  if (ext === '.pptx' || ext === '.ppt') {
    try {
      return await extractPptx(filePath);
    } catch {
      return null;
    }
  }

  return null;
}

function nonempty(text) {
  const t = String(text || '').trim();
  return t.length ? t : null;
}

function stripMarkup(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ');
}

function stripRtf(raw) {
  return String(raw || '')
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-z]+-?\d* ?/gi, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ');
}

function stripEml(raw) {
  const text = String(raw || '');
  const split = text.split(/\r?\n\r?\n/);
  const body = split.length > 1 ? split.slice(1).join('\n\n') : text;
  return stripMarkup(body);
}

async function extractPptx(filePath) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(readFileSync(filePath));
  const names = Object.keys(zip.files)
    .filter((n) => /ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort();
  const parts = [];
  for (const name of names) {
    const xml = await zip.files[name].async('string');
    const texts = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => m[1]);
    if (texts.length) parts.push(texts.join(' '));
  }
  return nonempty(parts.join('\n\n'));
}

// ── Feature extraction ─────────────────────────────────────────────────────

/**
 * Compute Tier-0 stylometric features from plain text.
 * All computation is local — no LLM calls.
 */
export function computeFeatures(text) {
  if (!text || text.trim().length === 0) return null;

  // Sentence splitting (basic — handles ., !, ?)
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z"'])/)
    .map(s => s.trim())
    .filter(s => s.length > 5);

  const avgSentenceLen = sentences.length
    ? sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / sentences.length
    : 0;

  // Paragraph length (non-empty paragraphs)
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const avgParaLen = paragraphs.length
    ? paragraphs.reduce((sum, p) => sum + p.split(/\s+/).length, 0) / paragraphs.length
    : 0;

  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // Contraction density: words like don't, it's, I'm, we're, etc.
  const contractions = words.filter(w => /\b\w+'\w+\b/.test(w)).length;
  const contractionDensity = wordCount > 0 ? contractions / wordCount : 0;

  // Spoken abbreviations: gonna, wanna, kinda, sorta, etc.
  const spokenAbbrevPattern = /\b(gonna|wanna|kinda|sorta|gotta|lemme|gimme|dunno|ya|yeah|yep|nope|ok|okay|thx|btw|omg|lol|haha|imo|tbh|fwiw|lmk|asap)\b/gi;
  const spokenMatches = text.match(spokenAbbrevPattern) || [];
  const spokenDensity = wordCount > 0 ? spokenMatches.length / wordCount : 0;

  // Document length bucket
  const docLengthBucket = wordCount < 100 ? 'micro'
    : wordCount < 500 ? 'short'
    : wordCount < 2000 ? 'medium'
    : wordCount < 8000 ? 'long'
    : 'very-long';

  // Bullet/list density
  const bulletLines = (text.match(/^\s*[-•*]\s+/gm) || []).length;
  const totalLines = text.split('\n').filter(Boolean).length;
  const bulletDensity = totalLines > 0 ? bulletLines / totalLines : 0;

  // Header density (markdown-style)
  const headerLines = (text.match(/^#{1,4}\s+/gm) || []).length;
  const headerDensity = totalLines > 0 ? headerLines / totalLines : 0;

  // Formal signal: presence of business phrases
  const formalPatterns = /\b(pursuant|herein|aforementioned|notwithstanding|shall|heretofore|whereas|accordingly|furthermore|therefore|thus|hence|scope of work|deliverables|engagement|proposal|investment|phases?)\b/gi;
  const formalCount = (text.match(formalPatterns) || []).length;
  const formalDensity = wordCount > 0 ? formalCount / wordCount : 0;

  // Salutation / greeting (email-style)
  const hasGreeting = /^(hi|hello|hey|dear|good\s+(morning|afternoon|evening))\b/im.test(text.slice(0, 200));
  const hasSignOff = /\b(best|regards|thanks|cheers|sincerely|warm regards|take care)\b[\s,]*([a-z]{1,24}|[a-z]{1,3})?[\s,.]*$/im.test(text.slice(-300));

  return {
    avgSentenceLen,
    avgParaLen,
    wordCount,
    contractionDensity,
    spokenDensity,
    docLengthBucket,
    bulletDensity,
    headerDensity,
    formalDensity,
    hasGreeting,
    hasSignOff,
  };
}

// ── Register classification ────────────────────────────────────────────────

/**
 * Score a feature set against each canonical register.
 * Returns array of { register, score } sorted descending.
 */
function scoreRegisters(features) {
  const {
    avgSentenceLen, avgParaLen, wordCount, contractionDensity, spokenDensity,
    docLengthBucket, bulletDensity, headerDensity, formalDensity,
    hasGreeting, hasSignOff,
  } = features;

  const scores = {};

  // proposal: long, formal, structured, has bullets/headers
  scores['proposal'] = 0
    + (formalDensity > 0.02 ? 2 : 0)
    + (['long', 'very-long'].includes(docLengthBucket) ? 2 : 0)
    + (bulletDensity > 0.1 ? 1 : 0)
    + (headerDensity > 0.02 ? 1 : 0)
    + (avgSentenceLen > 18 ? 1 : 0);

  // memo: medium, structured, has headers/bullets (the everyday memo)
  scores['memo'] = 0
    + (['medium', 'long'].includes(docLengthBucket) ? 2 : 0)
    + (headerDensity > 0.04 ? 2 : 0)
    + (bulletDensity > 0.15 ? 1 : 0)
    + (formalDensity > 0.01 ? 1 : 0)
    + (contractionDensity < 0.02 ? 1 : 0);

  // business-memo: a memo at the formal/structured end — like memo but more
  // formal language, with a greeting/sign-off (it is sent to someone).
  scores['business-memo'] = 0
    + (['medium', 'long'].includes(docLengthBucket) ? 2 : 0)
    + (formalDensity > 0.02 ? 2 : 0)
    + (headerDensity > 0.04 ? 1 : 0)
    + ((hasGreeting || hasSignOff) ? 1 : 0)
    + (contractionDensity < 0.015 ? 1 : 0);

  // deck: short-medium, bullets heavy, minimal prose (a punchy pitch deck)
  scores['deck'] = 0
    + (['short', 'medium'].includes(docLengthBucket) ? 2 : 0)
    + (bulletDensity > 0.25 ? 3 : bulletDensity > 0.1 ? 1 : 0)
    + (avgSentenceLen < 15 ? 1 : 0)
    + (headerDensity > 0.05 ? 1 : 0);

  // business-ppt: a deck at the formal/structured end — bullets + headers but
  // more formal language than a pitch deck.
  scores['business-ppt'] = 0
    + (bulletDensity > 0.2 ? 2 : bulletDensity > 0.1 ? 1 : 0)
    + (headerDensity > 0.05 ? 2 : 0)
    + (formalDensity > 0.015 ? 2 : 0)
    + (avgSentenceLen < 16 ? 1 : 0);

  // whitepaper: very long, low bullet, formal, long sentences
  scores['whitepaper'] = 0
    + (['long', 'very-long'].includes(docLengthBucket) ? 3 : 0)
    + (formalDensity > 0.02 ? 2 : 0)
    + (bulletDensity < 0.05 ? 1 : 0)
    + (avgSentenceLen > 20 ? 1 : 0)
    + (headerDensity > 0.02 ? 1 : 0);

  // public-post: short-medium, no headers, no bullets, punchy (social post)
  scores['public-post'] = 0
    + (['short', 'medium'].includes(docLengthBucket) ? 2 : 0)
    + (bulletDensity < 0.05 ? 1 : 0)
    + (headerDensity < 0.02 ? 1 : 0)
    + (avgSentenceLen < 20 ? 1 : 0)
    + (contractionDensity > 0.02 ? 1 : 0);

  // essay: medium-long, no headers, no bullets, flowing analytical prose
  scores['essay'] = 0
    + (['medium', 'long'].includes(docLengthBucket) ? 2 : 0)
    + (bulletDensity < 0.03 ? 2 : 0)
    + (headerDensity < 0.02 ? 2 : 0)
    + (avgParaLen > 50 ? 1 : 0)
    + (avgSentenceLen > 15 ? 1 : 0);

  // personal-essay: an essay in a personal voice — flowing prose but warmer,
  // more contractions and spoken cadence than the analytical essay.
  scores['personal-essay'] = 0
    + (['medium', 'long'].includes(docLengthBucket) ? 2 : 0)
    + (bulletDensity < 0.03 ? 1 : 0)
    + (headerDensity < 0.02 ? 1 : 0)
    + (contractionDensity > 0.03 ? 2 : 0)
    + (spokenDensity > 0.01 ? 1 : 0);

  // speech: medium-long, flowing, contractions, no bullets, spoken
  scores['speech'] = 0
    + (['medium', 'long'].includes(docLengthBucket) ? 2 : 0)
    + (contractionDensity > 0.03 ? 2 : 0)
    + (bulletDensity < 0.05 ? 1 : 0)
    + (spokenDensity > 0.005 ? 1 : 0)
    + (avgSentenceLen > 12 && avgSentenceLen < 25 ? 1 : 0);

  // heartfelt: medium, emotional, flowing, contractions
  scores['heartfelt'] = 0
    + (['short', 'medium'].includes(docLengthBucket) ? 2 : 0)
    + (contractionDensity > 0.04 ? 2 : 0)
    + (bulletDensity < 0.03 ? 1 : 0)
    + (spokenDensity > 0.01 ? 1 : 0);

  // bio: short-medium, third-person, formal, no bullets
  scores['bio'] = 0
    + (['short', 'medium'].includes(docLengthBucket) ? 2 : 0)
    + (formalDensity > 0.005 ? 1 : 0)
    + (bulletDensity < 0.05 ? 1 : 0)
    + (contractionDensity < 0.02 ? 1 : 0);

  return Object.entries(scores)
    .map(([register, score]) => ({ register, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Tier-0 classification. Returns { register, confidence, scores, needsDisambiguation }.
 * needsDisambiguation=true when top two scores are within 20% of the top score.
 */
export function classifyRegister(features) {
  if (!features) return { register: 'essay', confidence: 0.5, scores: [], needsDisambiguation: false };

  const sorted = scoreRegisters(features);
  const top = sorted[0];
  const second = sorted[1];

  const gap = top.score > 0
    ? (top.score - second.score) / top.score
    : 0;

  const needsDisambiguation = gap < 0.2 && top.score > 0;

  return {
    register: top.register,
    confidence: Math.min(0.95, 0.5 + gap * 2),
    scores: sorted.slice(0, 3),
    needsDisambiguation,
    topTwo: [top.register, second.register],
  };
}

/**
 * Haiku disambiguation for ambiguous Tier-0 results.
 * Returns { register, confidence } or falls back to Tier-0 winner on error.
 */
export async function disambiguateWithHaiku(text, topTwo, tier0Register) {
  try {
    const excerpt = text.slice(0, 1500).replace(/\s+/g, ' ');
    const msg = await llmCreate({
      model: modelFor('fast'),
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: `Classify this writing sample as one of these two registers: "${topTwo[0]}" or "${topTwo[1]}".

Registers:
- proposal: client-facing consulting/business proposal, SOW, engagement letter
- memo: internal structured memo with headers
- deck: slide deck content, bulleted, brief
- whitepaper: long-form formal research document
- work-email: professional email with greeting and sign-off
- personal-email: casual personal email
- sms-business: short professional SMS
- sms-casual: short casual SMS
- post: social media or blog post
- essay: long-form personal essay or reflection
- speech: spoken word / toast / talk
- heartfelt: personal emotional writing (vows, letters)
- bio: third-person biography or about section

Text excerpt:
---
${excerpt}
---

Respond with JSON only: {"register": "<one of the two options>", "confidence": <0.0-1.0>}`
      }],
    }, 'voice-disambiguate');

    const raw = msg.content[0]?.text?.trim() ?? '';
    const parsed = JSON.parse(raw);
    if (topTwo.includes(parsed.register)) {
      return { register: parsed.register, confidence: parsed.confidence ?? 0.7 };
    }
    return { register: tier0Register, confidence: 0.6 };
  } catch {
    return { register: tier0Register, confidence: 0.6 };
  }
}

// ── Voice doc augmentation ─────────────────────────────────────────────────

/**
 * Append an "## Evidence from samples" section to an existing voice doc.
 * Append-only — never replaces existing content.
 * If --force-augment is set, replaces the Evidence section.
 *
 * Returns updated content string, or null on failure.
 */
export async function augmentVoiceDoc(voiceDocPath, samples, { forceAugment = false } = {}) {
  if (!existsSync(voiceDocPath)) return null;
  if (!samples || samples.length === 0) return null;

  const existing = readFileSync(voiceDocPath, 'utf8');

  // Build excerpt block from samples (first 800 chars each)
  const excerpts = samples
    .slice(0, 5)
    .map((s, i) => `### Sample ${i + 1} (${s.filename})\n${s.text.slice(0, 800).trim()}`)
    .join('\n\n');

  try {
    const msg = await llmCreate({
      model: modelFor('balanced'),
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are analyzing writing samples to extract voice patterns for a voice document.

Existing voice doc:
---
${existing.slice(0, 2000)}
---

Writing samples for the "${basename(voiceDocPath, '.md')}" register:
---
${excerpts}
---

Write a concise "## Evidence from samples" section (200-400 words) that:
1. Names 3-5 specific patterns observed ACROSS the samples (not just one)
2. Uses short, direct bullets — "Pattern: example quoted from text"
3. Notes anything that contrasts with or refines the existing voice doc
4. Never restates what the voice doc already says — only add new evidence

Start directly with "## Evidence from samples" — no preamble.`
      }],
    }, 'voice-augment');

    const evidenceSection = msg.content[0]?.text?.trim() ?? '';
    if (!evidenceSection) return null;

    // Remove existing Evidence section if force-augment
    let base = existing;
    if (forceAugment) {
      base = existing.replace(/\n##\s+Evidence from samples[\s\S]*?(?=\n##\s+|\n---\s*$|$)/m, '').trimEnd();
    } else if (existing.includes('## Evidence from samples')) {
      // Already has section — skip
      return null;
    }

    return base.trimEnd() + '\n\n' + evidenceSection + '\n';
  } catch {
    return null;
  }
}

// ── voice.md synthesis ─────────────────────────────────────────────────────

/**
 * Synthesize user/contexts/voice.md from all updated voice docs.
 * One ## section per detected register.
 *
 * Returns the file content string, or null on failure.
 */
export async function synthesizeVoiceMd(detectedRegisters) {
  if (!detectedRegisters || detectedRegisters.length === 0) return null;

  const voiceDocSummaries = detectedRegisters
    .map(reg => {
      const docPath = resolve(VOICES_DIR, `${reg}.md`);
      if (!existsSync(docPath)) return null;
      const content = readFileSync(docPath, 'utf8');
      return `### ${reg}\n${content.slice(0, 1000).trim()}`;
    })
    .filter(Boolean)
    .join('\n\n---\n\n');

  try {
    const msg = await llmCreate({
      model: modelFor('balanced'),
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Create a voice.md index for these detected writing registers.

Voice documents:
---
${voiceDocSummaries}
---

Write a concise voice.md with:
1. A brief intro paragraph (2 sentences max) about the overall voice character
2. One ## section per register (use the register name as the heading)
3. Each section: 3-5 bullets summarizing the most distinctive traits for that register
4. Focus on actionable patterns a writer could use — not meta-commentary

Start with a title line: "# Voice Index" then the intro, then the register sections.
Do not include preamble or explanation outside the document.`
      }],
    }, 'voice-synthesize');

    return msg.content[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

// ── Gmail sent-mail fetch ──────────────────────────────────────────────────

/**
 * Fetch up to maxResults sent emails from Gmail for an account.
 * Returns array of { text, subject, date } objects.
 * Throws on token failure — caller logs and skips.
 */
export async function fetchGmailSentMail(email, getValidAccessToken, { maxResults = 200 } = {}) {
  const token = await getValidAccessToken(email);
  if (!token) throw new Error(`Gmail source skipped: token refresh failed for ${email}`);

  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=SENT&maxResults=${maxResults}`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status}`);
  const listData = await listRes.json();
  const messages = listData.messages || [];

  const results = [];
  for (const { id } of messages.slice(0, maxResults)) {
    try {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
      );
      if (!msgRes.ok) continue;
      const msg = await msgRes.json();

      const subject = msg.payload?.headers?.find(h => h.name === 'Subject')?.value ?? '';
      const date = msg.payload?.headers?.find(h => h.name === 'Date')?.value ?? '';
      const text = extractMimePart(msg.payload);
      if (!text || text.trim().length < 50) continue;

      results.push({ text, subject, date, source: `gmail:${email}` });
    } catch {
      // skip individual message errors
    }
  }

  return results;
}

/**
 * Recursively extract text/plain MIME part from Gmail message payload.
 */
function extractMimePart(payload) {
  if (!payload) return null;

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const found = extractMimePart(part);
      if (found) return found;
    }
  }

  return null;
}

function decodeBase64Url(str) {
  try {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}
