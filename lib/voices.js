/**
 * Voices — per-user voice profile cache backed by the owner voice corpus's
 * per-register docs under wk_user/user-voice/structure/*.md (each `# Voice: <Name>`).
 * TTL-cached in memory (60s). Profiles drive synthesis style and persona in chat
 * (the apply_voice / list_voices chat tools). NOTE: config/voices/ was retired by
 * st_73169c14 — the owner voice corpus now lives under wk_user/user-voice/.
 */
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const VOICE_ROOT = resolve(homedir(), 'robotdojo/user/workbenches/user/wk_user/user-voice');
const VOICES_DIR = join(VOICE_ROOT, 'structure');
const VOICE_MD = join(VOICE_ROOT, 'voice.md');
const VOICES_TTL = 60_000;

let _cache = null;
let _cacheAt = 0;

function ensureDir() {
  if (!existsSync(VOICES_DIR)) mkdirSync(VOICES_DIR, { recursive: true });
}

function readVoiceFile(slug) {
  const filePath = resolve(VOICES_DIR, `${slug}.md`);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf8').trim();
}

function baseVoiceEntry() {
  if (!existsSync(VOICE_MD)) return null;
  const content = readFileSync(VOICE_MD, 'utf8').trim();
  if (!content) return null;
  return {
    slug: 'voice',
    name: 'Your writing',
    content,
    description: 'Compounded from your files and sent mail.',
  };
}

function buildCache() {
  ensureDir();
  const files = existsSync(VOICES_DIR)
    ? readdirSync(VOICES_DIR).filter(f => f.endsWith('.md'))
    : [];
  const entries = [];
  const base = baseVoiceEntry();
  if (base) entries.push(base);
  for (const f of files) {
    const slug = f.slice(0, -3);
    if (slug === 'voice') continue;
    const content = readVoiceFile(slug);
    if (!content) continue;
    const firstLine = content.split('\n').find(l => l.trim()) || '';
    const name = firstLine.replace(/^#+\s*(Voice:\s*)?/, '').trim() || slug;
    const descLine = content.split('\n').find((l, i) => i > 0 && l.trim() && !l.startsWith('#')) || '';
    entries.push({ slug, name, content, description: descLine.slice(0, 120) });
  }
  return entries;
}

function getCache() {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < VOICES_TTL) return _cache;
  _cache = buildCache();
  _cacheAt = now;
  return _cache;
}

export function loadVoices() {
  return getCache();
}

export function getVoice(slug) {
  const entry = getCache().find(v => v.slug === slug);
  return entry ? entry.content : null;
}

export function listVoices() {
  return getCache().map(({ slug, name, description }) => ({ slug, name, description }));
}

export function invalidateVoiceCache() {
  _cache = null;
  _cacheAt = 0;
}
