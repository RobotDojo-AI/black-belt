/**
 * lib/session-open-pack.js — owner voice + prefs inlined at session open.
 *
 * The coding-agent hole was "Read if not already injected." Hosts dump a
 * pointer; models skip the files. Owner voice lived behind /write only.
 *
 * This module inlines the bytes. generate-identity.js puts them in every
 * coding-agent bootstrap. lib/chat/system-prompt.js puts them on the identity
 * block (web + mobile). Keep-warm ping stays identity-off, so this pack never
 * rides the wire.
 *
 * Missing files degrade to '' — first-user machines without wk_user still boot.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WK_USER_CONTEXT_PATH, WK_USER_VOICE_DIR } from './robotdojo-paths.js';

const PREF_HEADINGS = [
  '## How he works',
  '## AI interaction patterns',
  '## What works',
  '## What gets corrected',
  '## Calibration',
];

const OWNER_VOICE_HEADER = [
  '# Writing — owner',
  '',
  'How the owner writes to the world. Inlined at session open. Nested drafts use this tree. Replies stay Miyagi.',
  '',
  '- voice.md — tone and style',
  '- structure/ — blocking and flow by kind of piece',
  '- formatting/ — what survives the destination',
  '',
  'One speaker per block. Check.md is a review pass, not a layer.',
].join('\n');

let _voiceCache = null; // { key, body }
let _prefCache = null;

function cleanMarkdown(markdown) {
  let body = String(markdown || '');
  body = body.replace(/^---\n[\s\S]*?\n---\n/, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(/\n{3,}/g, '\n\n');
  return body.trim();
}

function extractHeadingSection(markdown, heading) {
  const lines = String(markdown || '').split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return '';
  const level = (heading.match(/^#+/) || ['#'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function fileKey(path) {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return '0';
  }
}

function readOptional(path) {
  try {
    if (!existsSync(path)) return '';
    return cleanMarkdown(readFileSync(path, 'utf8'));
  } catch {
    return '';
  }
}

function listMarkdown(dir) {
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

function relVoiceLabel(voiceDir, absPath) {
  const prefix = voiceDir.endsWith('/') ? voiceDir : `${voiceDir}/`;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

/**
 * Owner writing tree: voice + structure + formatting.
 * Samples and check.md stay out (check is a review pass).
 */
export function buildOwnerVoicePack({ voiceDir = WK_USER_VOICE_DIR } = {}) {
  const files = [
    join(voiceDir, 'voice.md'),
    join(voiceDir, 'learned.md'),
    ...listMarkdown(join(voiceDir, 'structure')),
    ...listMarkdown(join(voiceDir, 'formatting')),
  ];
  const key = `${voiceDir}|${files.map(fileKey).join('|')}`;
  if (_voiceCache && _voiceCache.key === key) return _voiceCache.body;

  const sections = [];
  for (const path of files) {
    const body = readOptional(path);
    if (!body) continue;
    sections.push(`<!-- source: wk_user/user-voice/${relVoiceLabel(voiceDir, path)} -->\n${body}`);
  }
  const pack = sections.length ? [OWNER_VOICE_HEADER, ...sections].join('\n\n') : '';
  _voiceCache = { key, body: pack };
  return pack;
}

/**
 * Preference sections from wk_user/context.md. Coding agents do not get the
 * identity card; web/mobile already inject the full card and should skip this
 * to avoid doubling How he works / What gets corrected.
 */
export function buildPreferencePack({ contextPath = WK_USER_CONTEXT_PATH } = {}) {
  const key = `${contextPath}|${fileKey(contextPath)}`;
  if (_prefCache && _prefCache.key === key) return _prefCache.body;

  const raw = readOptional(contextPath);
  if (!raw) {
    _prefCache = { key, body: '' };
    return '';
  }
  const parts = [];
  for (const heading of PREF_HEADINGS) {
    const section = extractHeadingSection(raw, heading);
    if (section) parts.push(section);
  }
  const body = parts.length
    ? `# Owner preferences\n\n${parts.join('\n\n')}`
    : '';
  _prefCache = { key, body };
  return body;
}

/** Coding-agent bootstrap: voice + prefs. */
export function buildCodingAgentOwnerPack(opts = {}) {
  return [buildOwnerVoicePack(opts), buildPreferencePack(opts)].filter(Boolean).join('\n\n');
}

export function _clearSessionOpenPackCache() {
  _voiceCache = null;
  _prefCache = null;
}
