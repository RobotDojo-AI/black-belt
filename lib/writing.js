/**
 * lib/writing.js — writing ontology (infra).
 *
 * Two speakers. Three layers each. One resolver every surface uses.
 *
 *   writing
 *     miyagi  (shipped, PII-free)   config/agent-voice/
 *     owner   (private)             wk_user/user-voice/
 *       voice.md
 *       structure/*.md     kind of piece (reply, memo, essay, …)
 *       formatting/*.md    place (web, coding-agent, email, gmail, …)
 *
 * Nested drafts are generateDraft(), not specialist subagents.
 * Web/mobile call it from the apply_voice tool. Coding agents call it
 * from /write. Same function.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, WK_USER_VOICE_DIR } from './robotdojo-paths.js';

export const INTELLIGENCE_TIER = 'orchestration';

export const SPEAKERS = ['miyagi', 'owner'];
export const LAYERS = ['voice', 'structure', 'formatting'];

export const MIYAGI_WRITING_DIR = join(REPO_ROOT, 'config', 'agent-voice');
export const OWNER_WRITING_DIR = WK_USER_VOICE_DIR;

const SPEAKER_ROOT = {
  miyagi: MIYAGI_WRITING_DIR,
  owner: OWNER_WRITING_DIR,
};

function listMd(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function readOptional(path) {
  try {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export function speakerRoot(speaker) {
  const root = SPEAKER_ROOT[speaker];
  if (!root) throw new Error(`unknown writing speaker: ${speaker}`);
  return root;
}

/** Absolute path for a layer file. slug is required for structure/formatting. */
export function writingPath(speaker, layer, slug = null) {
  if (!SPEAKERS.includes(speaker)) throw new Error(`unknown writing speaker: ${speaker}`);
  if (!LAYERS.includes(layer)) throw new Error(`unknown writing layer: ${layer}`);
  const root = speakerRoot(speaker);
  if (layer === 'voice') return join(root, 'voice.md');
  if (!slug) throw new Error(`${layer} requires a slug`);
  return join(root, layer, `${slug}.md`);
}

export function listWriting(speaker, layer) {
  if (layer === 'voice') {
    const path = writingPath(speaker, 'voice');
    return existsSync(path) ? [{ slug: 'voice', path }] : [];
  }
  return listMd(join(speakerRoot(speaker), layer)).map((path) => ({
    slug: path.split('/').pop().replace(/\.md$/, ''),
    path,
  }));
}

export function readWriting(speaker, layer, slug = null) {
  const path = writingPath(speaker, layer, slug);
  const body = readOptional(path);
  return body ? { speaker, layer, slug: slug || 'voice', path, body } : null;
}

function fileMtime(path) {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return '0';
  }
}

function cleanMarkdown(markdown) {
  let body = String(markdown || '');
  body = body.replace(/^---\n[\s\S]*?\n---\n/, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(/\n{3,}/g, '\n\n');
  return body.trim();
}

let _packCache = new Map();

/**
 * Full inlined pack for one speaker: voice + every structure + every formatting.
 * Samples and check.md stay out of the generation pack (check is a review pass).
 */
export function buildSpeakerPack(speaker) {
  const root = speakerRoot(speaker);
  const files = [
    writingPath(speaker, 'voice'),
    ...(speaker === 'owner' ? [join(root, 'learned.md')] : []),
    ...listWriting(speaker, 'structure').map((e) => e.path),
    ...listWriting(speaker, 'formatting').map((e) => e.path),
  ];
  const key = `${speaker}|${files.map(fileMtime).join('|')}`;
  if (_packCache.has(key)) return _packCache.get(key);

  const header = [
    `# Writing — ${speaker}`,
    '',
    speaker === 'miyagi'
      ? 'How Miyagi talks to the owner. Voice, reply structure, this surface\'s formatting.'
      : 'How the owner writes to the world. Voice, structure by kind of piece, formatting by destination.',
    '',
    'One speaker per block. Nested drafts use the owner tree. The envelope stays Miyagi.',
  ].join('\n');

  const sections = [header];
  for (const path of files) {
    const raw = readOptional(path);
    if (!raw) continue;
    const rel = path.startsWith(root) ? path.slice(root.length + 1) : path;
    sections.push(`<!-- source: ${speaker}/${rel} -->\n${cleanMarkdown(raw)}`);
  }
  const body = sections.length > 1 ? sections.join('\n\n') : '';
  _packCache.set(key, body);
  return body;
}

export function _clearWritingPackCache() {
  _packCache = new Map();
}

function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/**
 * Isolated generate for one speaker. Returns { speaker, structure, formatting, body, sha256 }.
 * Chat models must not type this body. Freeze it.
 */
export async function generate({
  speaker = 'owner',
  brief,
  structure = null,
  formatting = null,
  extraContext = null,
  getClient,
} = {}) {
  if (!brief || !String(brief).trim()) {
    throw new Error('generate requires a brief');
  }
  if (!SPEAKERS.includes(speaker)) throw new Error(`unknown writing speaker: ${speaker}`);

  const voice = readWriting(speaker, 'voice');
  const structSlug = structure || (speaker === 'miyagi' ? 'reply' : null);
  const formatSlug = formatting || (speaker === 'miyagi' ? 'coding-agent' : null);
  const struct = structSlug ? readWriting(speaker, 'structure', structSlug) : null;
  const format = formatSlug ? readWriting(speaker, 'formatting', formatSlug) : null;
  if (structSlug && !struct && speaker === 'owner') {
    throw new Error(`unknown structure: ${structSlug}`);
  }
  if (formatSlug && !format && speaker === 'owner') {
    throw new Error(`unknown formatting: ${formatSlug}`);
  }

  const systemParts = [];
  if (speaker === 'owner') {
    systemParts.push(
      'You are drafting as the owner, in his writing. Return ONLY the sendable prose.',
      'Miyagi is not the speaker. Do not use chat-reply clipping, stage-approval numbering, or agent register.',
      '',
    );
  } else {
    systemParts.push(
      'You are Miyagi talking to the owner. Return ONLY the reply prose.',
      'Do not draft a letter in his name. Do not use sendable-email envelope unless asked.',
      '',
    );
  }
  if (voice) systemParts.push('## Voice (tone and style)', voice.body, '');
  if (struct) systemParts.push(`## Structure (${structSlug})`, struct.body, '');
  if (format) systemParts.push(`## Formatting (${formatSlug})`, format.body, '');
  if (extraContext) systemParts.push('## Context', extraContext, '');
  if (speaker === 'owner') {
    systemParts.push(
      'Match voice, structure, and formatting above. Complete sentences. Spell a term, then (ABBR). No nanny disclaimers.',
    );
  } else {
    systemParts.push('Match Miyagi voice and reply structure. Short. Direct. Stop when done.');
  }

  const { getAnthropicClient } = await import('./anthropic-client.js');
  const { MODELS } = await import('./compute-tier.js');
  const client = getClient || getAnthropicClient();
  const maxTokens = speaker === 'miyagi' ? 1200 : 4000;
  const msg = await client.messages.create({
    model: MODELS.sonnet,
    max_tokens: maxTokens,
    system: systemParts.join('\n'),
    messages: [{ role: 'user', content: String(brief) }],
  });
  const body = (msg.content[0]?.text || '').trim();
  if (!body) throw new Error('generate returned empty body');
  return {
    speaker,
    structure: structSlug,
    formatting: formatSlug,
    brief: String(brief),
    body,
    sha256: sha256(body),
    generated_at: new Date().toISOString(),
  };
}

/** Owner nested draft. Thin alias over generate({ speaker: 'owner' }). */
export async function generateDraft(opts = {}) {
  const block = await generate({ ...opts, speaker: 'owner' });
  return block.body;
}

/** Resolve a loose slug: formatting wins over structure (destination over type). */
export function resolveOwnerSelector(slug) {
  if (!slug) return { structure: null, formatting: null };
  const key = String(slug).toLowerCase();
  if (key === 'voice' || key === 'base' || key === 'your-writing') {
    return { structure: null, formatting: null };
  }
  if (existsSync(writingPath('owner', 'formatting', slug))) {
    return { structure: null, formatting: slug };
  }
  if (existsSync(writingPath('owner', 'structure', slug))) {
    return { structure: slug, formatting: null };
  }
  return null;
}

export function ownerCheckPath() {
  return join(OWNER_WRITING_DIR, 'check.md');
}
