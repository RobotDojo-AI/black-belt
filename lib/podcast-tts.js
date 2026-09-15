// INTELLIGENCE_TIER: orchestration — text-to-speech provider selection
// (Speechify/OpenAI TTS). Flagged by the naive `MODELS.` substring match
// (SPEECHIFY_MODELS.has / OPENAI_MODELS.has); this file makes no call
// against compute-tier.js's Anthropic MODELS at all. Declared to satisfy
// the gate rather than special-case the detector for one file.
export const INTELLIGENCE_TIER = 'orchestration';

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import config from './config.js';
import {
  DEFAULT_PODCAST_SCRIPT_AGENT,
  DEFAULT_PODCAST_SCRIPT_AGENT_MODEL,
  DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
  DEFAULT_PODCAST_SCRIPT_MODE,
  planPodcastScriptArticle,
  planPodcastScriptArticleWithAgent,
  normalizePodcastScriptAgent,
  normalizePodcastScriptAgentModel,
  normalizePodcastScriptAgentProvider,
} from './podcast-script.js';
import { USER_MEDIA_DIR } from './robotdojo-paths.js';

export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
export const SPEECHIFY_TTS_MODEL = 'simba-english';
export const DEFAULT_TTS_PROVIDER = 'openai';
export const DEFAULT_TTS_VOICE = 'cedar';
export const DEFAULT_SPEECHIFY_TTS_VOICE = 'george';
export const DEFAULT_TTS_INSTRUCTIONS = [
  'Read this as a polished long-form podcast narrator.',
  'Keep the voice warm, intelligent, and calm.',
  'Preserve the authorial cadence without sounding theatrical.',
].join(' ');

const MAX_TTS_CHARS = 3800;
const MAX_INSTRUCTIONS_CHARS = 1200;
const MP3_PROBE_BYTES = 256 * 1024;
const TTS_RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const OPENAI_VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
]);
const SPEECHIFY_MODELS = new Set([
  'simba-english',
  'simba-multilingual',
  'simba-3.0',
]);
const OPENAI_MODELS = new Set([
  'gpt-4o-mini-tts',
  'gpt-4o-mini-tts-2025-12-15',
  'tts-1',
  'tts-1-hd',
]);
const TTS_PROVIDERS = new Set(['openai', 'speechify']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeTitle(value) {
  return String(value || 'Episode').replace(/\s+/g, ' ').trim().slice(0, 240) || 'Episode';
}

function safeSourceKey(article = {}) {
  const libraryId = String(article.libraryId || '').replace(/^lib-/, '').trim();
  const explicit = String(article.sourceKey || '').trim();
  return (explicit || (libraryId ? `lib-${libraryId}` : '') || String(article.url || '').trim()).slice(0, 500);
}

function safeLibraryId(article = {}) {
  return String(article.libraryId || '').replace(/^lib-/, '').trim().slice(0, 160);
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLongText(value, maxChars) {
  const chunks = [];
  const text = String(value || '').trim();
  for (let i = 0; i < text.length; i += maxChars) {
    const chunk = text.slice(i, i + maxChars).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

function splitParagraphForTts(paragraph, maxChars) {
  const text = String(paragraph || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|.+$/g) || [text];
  let buffer = '';
  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      if (buffer) {
        chunks.push(buffer);
        buffer = '';
      }
      chunks.push(...splitLongText(sentence, maxChars));
      continue;
    }
    const next = buffer ? `${buffer} ${sentence}` : sentence;
    if (next.length > maxChars && buffer) {
      chunks.push(buffer);
      buffer = sentence;
    } else {
      buffer = next;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

export function splitTextForTts(text, maxChars = MAX_TTS_CHARS) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const chunks = [];
  const paragraphs = normalized.split(/\n\s*\n+/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let buffer = '';
  for (const paragraph of paragraphs) {
    const paragraphChunks = splitParagraphForTts(paragraph, maxChars);
    for (const paragraphChunk of paragraphChunks) {
      const next = buffer ? `${buffer}\n\n${paragraphChunk}` : paragraphChunk;
      if (next.length > maxChars && buffer) {
        chunks.push(buffer);
        buffer = paragraphChunk;
      } else {
        buffer = next;
      }
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

export function normalizeTtsProvider(value) {
  const provider = String(value || DEFAULT_TTS_PROVIDER).trim().toLowerCase();
  return TTS_PROVIDERS.has(provider) ? provider : DEFAULT_TTS_PROVIDER;
}

export function defaultTtsVoiceForProvider(provider) {
  return normalizeTtsProvider(provider) === 'speechify'
    ? DEFAULT_SPEECHIFY_TTS_VOICE
    : DEFAULT_TTS_VOICE;
}

export function defaultTtsModelForProvider(provider) {
  return normalizeTtsProvider(provider) === 'speechify'
    ? SPEECHIFY_TTS_MODEL
    : OPENAI_TTS_MODEL;
}

export function normalizeTtsVoice(value, provider = DEFAULT_TTS_PROVIDER) {
  const cleanProvider = normalizeTtsProvider(provider);
  if (cleanProvider === 'speechify') {
    const voice = String(value || '').trim();
    return voice.slice(0, 160) || DEFAULT_SPEECHIFY_TTS_VOICE;
  }

  const voice = String(value || '').trim().toLowerCase();
  return OPENAI_VOICES.has(voice) ? voice : DEFAULT_TTS_VOICE;
}

export function normalizeTtsModel(value, provider = DEFAULT_TTS_PROVIDER) {
  const cleanProvider = normalizeTtsProvider(provider);
  const model = String(value || '').trim();
  if (cleanProvider === 'speechify') {
    return SPEECHIFY_MODELS.has(model) ? model : SPEECHIFY_TTS_MODEL;
  }
  return OPENAI_MODELS.has(model) ? model : OPENAI_TTS_MODEL;
}

export function normalizeTtsInstructions(value) {
  const instructions = String(value || '').replace(/\s+/g, ' ').trim();
  return (instructions || DEFAULT_TTS_INSTRUCTIONS).slice(0, MAX_INSTRUCTIONS_CHARS);
}

function mediaRoot(options = {}) {
  return resolve(options.mediaDir || USER_MEDIA_DIR, 'podcast', 'audio');
}

function renderDirectory(id, options = {}) {
  return join(mediaRoot(options), id);
}

function manifestPath(id, options = {}) {
  return join(renderDirectory(id, options), 'manifest.json');
}

function chunkUrl(id, filename) {
  return `/api/podcast/audio/${id}/${filename}`;
}

function buildRenderId({
  article,
  chunks,
  provider,
  voice,
  instructions,
  model,
  script,
}) {
  const payload = {
    version: 3,
    provider,
    model,
    voice,
    instructions,
    scriptMode: script?.mode || DEFAULT_PODCAST_SCRIPT_MODE,
    scriptInstructions: script?.instructions || '',
    scriptAgent: script?.agent?.enabled || false,
    scriptAgentProvider: script?.agent?.enabled ? script.agent.provider : '',
    scriptAgentModel: script?.agent?.enabled ? script.agent.model : '',
    title: safeTitle(article.title),
    url: article.url || '',
    textHash: sha256(chunks.join('\n\n')),
  };
  return sha256(JSON.stringify(payload)).slice(0, 32);
}

export function isLikelyMp3Header(bytes) {
  if (!bytes || bytes.length < 3) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

function id3TagLength(bytes) {
  if (!bytes || bytes.length < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  return 10
    + ((bytes[6] & 0x7f) << 21)
    + ((bytes[7] & 0x7f) << 14)
    + ((bytes[8] & 0x7f) << 7)
    + (bytes[9] & 0x7f);
}

function mp3FrameLength(bytes, offset = 0) {
  if (!bytes || offset + 4 > bytes.length) return 0;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return 0;

  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (versionBits === 0x01 || layerBits !== 0x01 || bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) {
    return 0;
  }

  const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const rates = versionBits === 0x03
    ? [44100, 48000, 32000]
    : versionBits === 0x02
      ? [22050, 24000, 16000]
      : [11025, 12000, 8000];
  const bitrate = (versionBits === 0x03 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex] * 1000;
  const sampleRate = rates[sampleRateIndex];
  if (!bitrate || !sampleRate) return 0;

  const coefficient = versionBits === 0x03 ? 144 : 72;
  return Math.floor((coefficient * bitrate) / sampleRate) + padding;
}

export function hasLikelyMp3FrameSequence(bytes, minFrames = 2) {
  if (!bytes || bytes.length < 4) return false;
  const id3End = id3TagLength(bytes);
  const scanStart = id3End && id3End < bytes.length ? id3End : 0;
  const scanLimit = Math.min(bytes.length - 4, scanStart + 8192);

  for (let start = scanStart; start <= scanLimit; start += 1) {
    let frames = 0;
    let offset = start;
    while (offset + 4 <= bytes.length) {
      const length = mp3FrameLength(bytes, offset);
      if (!length) break;
      frames += 1;
      if (frames >= minFrames) return true;
      offset += length;
    }
  }
  return false;
}

function isPlayableMp3Buffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 1024 && hasLikelyMp3FrameSequence(buffer);
}

async function readPrefix(path, length = 4) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function isPlayableMp3File(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 1024) return false;
    return hasLikelyMp3FrameSequence(await readPrefix(path, MP3_PROBE_BYTES));
  } catch {
    return false;
  }
}

function audioRangeError(message, size) {
  const error = new Error(message);
  error.status = 416;
  error.size = size;
  return error;
}

function parseAudioRangeHeader(value, size) {
  const header = String(value || '').trim();
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw audioRangeError('invalid_audio_range', size);

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw audioRangeError('invalid_audio_range', size);
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw audioRangeError('invalid_audio_range', size);
    }
    if (start >= size) throw audioRangeError('audio_range_not_satisfiable', size);
    if (start > end) throw audioRangeError('invalid_audio_range', size);
    end = Math.min(end, size - 1);
  }

  return {
    start,
    end,
    size,
    length: end - start + 1,
  };
}

async function readCachedManifest(id, options = {}) {
  try {
    const raw = await readFile(manifestPath(id, options), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.chunks) || parsed.chunks.length === 0) return null;
    for (const chunk of parsed.chunks) {
      if (!chunk?.filename || !(await isPlayableMp3File(join(renderDirectory(id, options), chunk.filename)))) {
        await rm(renderDirectory(id, options), { recursive: true, force: true }).catch(() => {});
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readPodcastRenderManifest(id, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) return null;
  return readCachedManifest(id, options);
}

export async function invalidatePodcastRenderCache(id, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) throw new Error('invalid_audio_id');
  await rm(renderDirectory(id, options), { recursive: true, force: true });
}

async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

function ttsRetryAttempts() {
  const raw = Number(process.env.ROBOTDOJO_TTS_RETRY_ATTEMPTS || 4);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 8) : 4;
}

function ttsRetryBaseMs() {
  const raw = Number(process.env.ROBOTDOJO_TTS_RETRY_BASE_MS || 750);
  return Number.isFinite(raw) && raw >= 0 ? raw : 750;
}

function ttsRetryMaxMs() {
  const raw = Number(process.env.ROBOTDOJO_TTS_RETRY_MAX_MS || 8000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 8000;
}

function ttsChunkConcurrency(value) {
  const source = value === undefined ? process.env.ROBOTDOJO_TTS_CHUNK_CONCURRENCY || 2 : value;
  const raw = Number(source);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 4) : 2;
}

function ttsRequestTimeoutMs() {
  const raw = Number(process.env.ROBOTDOJO_TTS_REQUEST_TIMEOUT_MS || 60_000);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 5 * 60_000) : 60_000;
}

function ttsTimeoutError() {
  const error = new Error('tts_provider_timeout');
  error.name = 'AbortError';
  error.code = 'ETIMEDOUT';
  error.retryable = true;
  return error;
}

function composeAbortSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timeout = null;
  const abortFromParent = () => {
    try {
      controller.abort(signal?.reason || new Error('tts_provider_aborted'));
    } catch {
      controller.abort();
    }
  };
  if (signal?.aborted) abortFromParent();
  else if (signal) signal.addEventListener('abort', abortFromParent, { once: true });
  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      try {
        controller.abort(ttsTimeoutError());
      } catch {
        controller.abort();
      }
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    abort(reason) {
      try {
        controller.abort(reason);
      } catch {
        controller.abort();
      }
    },
    cleanup() {
      if (timeout) clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', abortFromParent);
    },
  };
}

async function fetchWithTtsTimeout(fetchImpl, url, init = {}) {
  const timeoutMs = ttsRequestTimeoutMs();
  const abortable = composeAbortSignal(init.signal, timeoutMs);
  let timeout = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = ttsTimeoutError();
      abortable.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: abortable.signal }),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    abortable.cleanup();
  }
}

function retryAfterMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

function isRetryableTtsError(error) {
  if (error?.retryable === false) return false;
  if (error?.retryable === true) return true;
  if (TTS_RETRY_STATUSES.has(Number(error?.status))) return true;
  return error?.name === 'AbortError'
    || error?.code === 'ECONNRESET'
    || error?.code === 'ETIMEDOUT'
    || error?.code === 'ENOTFOUND'
    || error?.code === 'EAI_AGAIN';
}

function retryDelayMs(error, attempt) {
  const headerDelay = Number(error?.retryAfterMs);
  if (Number.isFinite(headerDelay) && headerDelay >= 0) return Math.min(headerDelay, ttsRetryMaxMs());
  const delay = ttsRetryBaseMs() * (2 ** attempt);
  return Math.min(delay, ttsRetryMaxMs());
}

async function withTtsRetry(operation) {
  const attempts = ttsRetryAttempts();
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !isRetryableTtsError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(error, attempt)));
    }
  }
  throw lastError;
}

async function synthesizeOpenAiChunkOnce(input, { apiKey, fetchImpl, voice, instructions, model, signal }) {
  const res = await fetchWithTtsTimeout(fetchImpl, 'https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      input,
      instructions,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const providerError = parseOpenAiProviderError(detail);
    const hardErrorCode = openAiHardFailureCode(providerError);
    const error = new Error(hardErrorCode || `tts_provider_failed_${res.status}`);
    error.status = res.status;
    error.retryable = hardErrorCode ? false : TTS_RETRY_STATUSES.has(res.status);
    error.retryAfterMs = retryAfterMs(res.headers.get('retry-after'));
    error.detail = detail.slice(0, 500);
    error.providerError = providerError;
    throw error;
  }
  return Buffer.from(await res.arrayBuffer());
}

function parseOpenAiProviderError(detail = '') {
  try {
    const parsed = JSON.parse(String(detail || ''));
    return parsed?.error && typeof parsed.error === 'object' ? parsed.error : null;
  } catch {
    return null;
  }
}

function openAiHardFailureCode(error = null) {
  const code = String(error?.code || error?.type || '').trim();
  if (code === 'billing_not_active') return 'openai_billing_not_active';
  if (code === 'insufficient_quota') return 'openai_quota_exceeded';
  return '';
}

async function synthesizeOpenAiChunk(input, options) {
  return withTtsRetry(() => synthesizeOpenAiChunkOnce(input, options));
}

async function synthesizeSpeechifyChunkOnce(input, { apiKey, fetchImpl, voice, model, signal }) {
  const res = await fetchWithTtsTimeout(fetchImpl, 'https://api.speechify.ai/v1/audio/speech', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input,
      voice_id: voice,
      audio_format: 'mp3',
      model,
    }),
  });
  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    const error = new Error(`tts_provider_failed_${res.status}`);
    error.status = res.status;
    error.retryable = TTS_RETRY_STATUSES.has(res.status);
    error.retryAfterMs = retryAfterMs(res.headers.get('retry-after'));
    error.detail = raw.slice(0, 500);
    throw error;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const error = new Error('tts_provider_invalid_audio');
    error.detail = raw.slice(0, 500);
    throw error;
  }
  if (!data?.audio_data) throw new Error('tts_provider_missing_audio');
  return Buffer.from(String(data.audio_data), 'base64');
}

async function synthesizeSpeechifyChunk(input, options) {
  return withTtsRetry(() => synthesizeSpeechifyChunkOnce(input, options));
}

function apiKeyForProvider(provider, { apiKey, openaiApiKey, speechifyApiKey } = {}) {
  if (apiKey) return apiKey;
  if (provider === 'speechify') {
    return speechifyApiKey !== undefined ? speechifyApiKey : config.speechifyApiKey;
  }
  return openaiApiKey !== undefined ? openaiApiKey : config.openaiKey;
}

export async function renderPodcastAudio({
  article,
  provider,
  model,
  voice,
  instructions,
  scriptMode,
  scriptInstructions,
  scriptAgent = DEFAULT_PODCAST_SCRIPT_AGENT,
  scriptAgentProvider = DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
  scriptAgentModel = DEFAULT_PODCAST_SCRIPT_AGENT_MODEL,
  scriptAgentComplete,
  signal,
  apiKey,
  openaiApiKey,
  speechifyApiKey,
  fetchImpl = globalThis.fetch,
  mediaDir,
  now = () => new Date(),
  onProgress,
  chunkConcurrency,
} = {}) {
  if (!article) throw new Error('article_required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');

  const planned = await planPodcastScriptArticleWithAgent({
    article,
    mode: scriptMode,
    instructions: scriptInstructions,
    agent: scriptAgent,
    agentProvider: scriptAgentProvider,
    agentModel: scriptAgentModel,
    agentComplete: scriptAgentComplete,
    signal,
  });
  const renderArticle = planned.article;
  const script = planned.script;
  const text = normalizeWhitespace(renderArticle.text || (Array.isArray(renderArticle.paragraphs) ? renderArticle.paragraphs.join('\n\n') : ''));
  const chunks = splitTextForTts(text);
  if (!chunks.length) throw new Error('article_text_required');

  const cleanProvider = normalizeTtsProvider(provider);
  const cleanModel = normalizeTtsModel(model, cleanProvider);
  const cleanVoice = normalizeTtsVoice(voice, cleanProvider);
  const cleanInstructions = normalizeTtsInstructions(instructions);
  const resolvedApiKey = apiKeyForProvider(cleanProvider, { apiKey, openaiApiKey, speechifyApiKey });
  if (!resolvedApiKey) throw new Error(`${cleanProvider}_key_missing`);

  const id = buildRenderId({
    article,
    chunks,
    provider: cleanProvider,
    voice: cleanVoice,
    instructions: cleanInstructions,
    model: cleanModel,
    script,
  });
  const options = mediaDir ? { mediaDir } : {};
  const cached = await readCachedManifest(id, options);
  if (cached) return { ...cached, cached: true };

  const dir = renderDirectory(id, options);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const renderedChunks = new Array(chunks.length);
  let completedChunks = 0;
  let nextChunkIndex = 0;

  async function renderChunkAt(index) {
    const filename = `${String(index + 1).padStart(4, '0')}.mp3`;
    const path = join(dir, filename);
    await onProgress?.({
      renderId: id,
      status: 'running',
      totalChunks: chunks.length,
      completedChunks,
      currentChunk: index + 1,
    });
    if (!(await isPlayableMp3File(path))) {
      const audio = cleanProvider === 'speechify'
        ? await synthesizeSpeechifyChunk(chunks[index], {
          apiKey: resolvedApiKey,
          fetchImpl,
          voice: cleanVoice,
          model: cleanModel,
          signal,
        })
        : await synthesizeOpenAiChunk(chunks[index], {
          apiKey: resolvedApiKey,
          fetchImpl,
          voice: cleanVoice,
          instructions: cleanInstructions,
          model: cleanModel,
          signal,
        });
      if (!isPlayableMp3Buffer(audio)) throw new Error('tts_provider_invalid_audio');
      await writeAtomic(path, audio);
    }
    renderedChunks[index] = {
      index,
      filename,
      url: chunkUrl(id, filename),
      charCount: chunks[index].length,
    };
    completedChunks += 1;
    await onProgress?.({
      renderId: id,
      status: 'running',
      totalChunks: chunks.length,
      completedChunks,
      currentChunk: index + 1,
    });
  }

  async function renderWorker() {
    while (nextChunkIndex < chunks.length) {
      const index = nextChunkIndex;
      nextChunkIndex += 1;
      await renderChunkAt(index);
    }
  }

  const workerCount = Math.min(ttsChunkConcurrency(chunkConcurrency), chunks.length);
  const results = await Promise.allSettled(Array.from({ length: workerCount }, () => renderWorker()));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  if (!renderedChunks.every(Boolean)) throw new Error('tts_render_incomplete');

  const manifest = {
    id,
    status: 'ready',
    provider: cleanProvider,
    model: cleanModel,
    voice: cleanVoice,
    instructions: cleanInstructions,
    script,
    title: safeTitle(renderArticle.title),
    sourceName: renderArticle.sourceName || '',
    sourceUrl: renderArticle.url || '',
    sourceKey: safeSourceKey(article),
    libraryId: safeLibraryId(article),
    totalChars: text.length,
    totalChunks: renderedChunks.length,
    generatedAt: now().toISOString(),
    chunks: renderedChunks,
    cached: false,
  };
  await writeAtomic(manifestPath(id, options), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function createPodcastRenderPlan({
  article,
  provider,
  model,
  voice,
  instructions,
  scriptMode,
  scriptInstructions,
  scriptAgent = DEFAULT_PODCAST_SCRIPT_AGENT,
  scriptAgentProvider = DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
  scriptAgentModel = DEFAULT_PODCAST_SCRIPT_AGENT_MODEL,
} = {}) {
  if (!article) throw new Error('article_required');
  const planned = planPodcastScriptArticle({
    article,
    mode: scriptMode,
    instructions: scriptInstructions,
  });
  const renderArticle = planned.article;
  const script = planned.script;
  script.agent = {
    enabled: planned.script.mode === 'podcast' && normalizePodcastScriptAgent(scriptAgent),
    provider: normalizePodcastScriptAgentProvider(scriptAgentProvider),
    model: normalizePodcastScriptAgentModel(scriptAgentModel),
  };
  const text = normalizeWhitespace(renderArticle.text || (Array.isArray(renderArticle.paragraphs) ? renderArticle.paragraphs.join('\n\n') : ''));
  const chunks = splitTextForTts(text);
  if (!chunks.length) throw new Error('article_text_required');

  const cleanProvider = normalizeTtsProvider(provider);
  const cleanModel = normalizeTtsModel(model, cleanProvider);
  const cleanVoice = normalizeTtsVoice(voice, cleanProvider);
  const cleanInstructions = normalizeTtsInstructions(instructions);
  const id = buildRenderId({
    article,
    chunks,
    provider: cleanProvider,
    voice: cleanVoice,
    instructions: cleanInstructions,
    model: cleanModel,
    script,
  });
  return {
    id,
    provider: cleanProvider,
    model: cleanModel,
    voice: cleanVoice,
    instructions: cleanInstructions,
    script,
    title: safeTitle(renderArticle.title),
    sourceName: renderArticle.sourceName || '',
    sourceUrl: renderArticle.url || '',
    sourceKey: safeSourceKey(article),
    libraryId: safeLibraryId(article),
    totalChars: text.length,
    totalChunks: chunks.length,
  };
}

export async function streamPodcastAudioChunk(id, filename, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) throw new Error('invalid_audio_id');
  if (!/^\d{4}\.mp3$/.test(String(filename || ''))) throw new Error('invalid_audio_file');
  const root = mediaRoot(options);
  const path = resolve(root, id, filename);
  if (!path.startsWith(`${root}/`)) throw new Error('invalid_audio_path');
  const info = await stat(path);
  if (!info.isFile()) throw new Error('audio_not_found');
  if (info.size < 1024 || !hasLikelyMp3FrameSequence(await readPrefix(path, MP3_PROBE_BYTES))) {
    await rm(renderDirectory(id, options), { recursive: true, force: true }).catch(() => {});
    throw new Error('invalid_audio_bytes');
  }
  const range = parseAudioRangeHeader(options.range, info.size);
  return {
    stream: createReadStream(path, range ? { start: range.start, end: range.end } : undefined),
    size: info.size,
    range,
  };
}
