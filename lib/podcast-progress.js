import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { USER_MEDIA_DIR } from './robotdojo-paths.js';

const PROGRESS_VERSION = 1;

function progressPath(options = {}) {
  return join(resolve(options.mediaDir || USER_MEDIA_DIR, 'podcast'), 'progress.json');
}

function nowIso(now = () => new Date()) {
  return now().toISOString();
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function optionalIso(value) {
  return value ? String(value) : null;
}

function normalizeProgress(key, progress = {}, options = {}) {
  const cleanKey = String(key || progress.key || '').trim();
  if (!cleanKey) throw new Error('progress_key_required');
  return {
    key: cleanKey,
    title: String(progress.title || '').slice(0, 300),
    chunkIndex: nonNegativeInteger(progress.chunkIndex),
    ttsChunkIndex: nonNegativeInteger(progress.ttsChunkIndex),
    ttsChunkOffset: nonNegativeInteger(progress.ttsChunkOffset),
    ttsTotalChunks: nonNegativeInteger(progress.ttsTotalChunks),
    done: progress.done === true,
    startedAt: optionalIso(progress.startedAt),
    completedAt: optionalIso(progress.completedAt),
    updatedAt: optionalIso(progress.updatedAt) || nowIso(options.now),
  };
}

async function readProgressStore(options = {}) {
  try {
    const parsed = JSON.parse(await readFile(progressPath(options), 'utf8'));
    const rawProgress = parsed.progress && typeof parsed.progress === 'object' ? parsed.progress : {};
    const progress = {};
    for (const [key, value] of Object.entries(rawProgress)) {
      try {
        progress[key] = normalizeProgress(key, value);
      } catch {}
    }
    return { version: PROGRESS_VERSION, progress };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: PROGRESS_VERSION, progress: {} };
    throw error;
  }
}

async function writeProgressStore(store, options = {}) {
  const path = progressPath(options);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function listPodcastProgress(options = {}) {
  const store = await readProgressStore(options);
  return store.progress;
}

export async function upsertPodcastProgress(key, progress = {}, options = {}) {
  const store = await readProgressStore(options);
  const entry = normalizeProgress(key, progress, options);
  store.progress[entry.key] = entry;
  await writeProgressStore(store, options);
  return entry;
}

export async function deletePodcastProgress(key, options = {}) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return null;
  const store = await readProgressStore(options);
  const existing = store.progress[cleanKey] || null;
  if (!existing) return null;
  delete store.progress[cleanKey];
  await writeProgressStore(store, options);
  return existing;
}
