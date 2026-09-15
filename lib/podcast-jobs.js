import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import config from './config.js';
import {
  createPodcastRenderPlan,
  DEFAULT_TTS_INSTRUCTIONS,
  DEFAULT_TTS_PROVIDER,
  defaultTtsVoiceForProvider,
  invalidatePodcastRenderCache,
  readPodcastRenderManifest,
  renderPodcastAudio,
} from './podcast-tts.js';
import { USER_MEDIA_DIR } from './robotdojo-paths.js';

const JOB_VERSION = 1;
const runningJobs = new Set();
const runnerOptions = new Map();
let atomicWriteSeq = 0;

function nowIso(now = () => new Date()) {
  return now().toISOString();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function jobsRoot(options = {}) {
  return resolve(options.mediaDir || USER_MEDIA_DIR, 'podcast', 'jobs');
}

function jobPath(id, options = {}) {
  return join(jobsRoot(options), `${id}.json`);
}

function cleanArticle(article = {}) {
  const paragraphs = Array.isArray(article.paragraphs)
    ? article.paragraphs.map((p) => String(p || '').trim()).filter(Boolean)
    : [];
  const text = String(article.text || paragraphs.join('\n\n')).trim();
  const libraryId = String(article.libraryId || '').replace(/^lib-/, '').trim();
  const sourceKey = String(article.sourceKey || (libraryId ? `lib-${libraryId}` : article.url || '') || '').trim();
  return {
    title: String(article.title || '').trim() || 'Untitled',
    url: String(article.url || '').trim(),
    sourceName: String(article.sourceName || '').trim() || 'Text',
    libraryId,
    sourceKey,
    paragraphs,
    text,
  };
}

function publicJob(job) {
  if (!job) return null;
  const { input, ...safe } = job;
  return safe;
}

function jobSourceKeys(job = {}) {
  const keys = new Set();
  const add = (value) => {
    const clean = String(value || '').trim();
    if (clean) keys.add(clean);
  };
  const article = job.input?.article || {};
  const render = job.render || {};
  const plan = job.plan || {};
  const libraryIds = [
    article.libraryId,
    render.libraryId,
    plan.libraryId,
  ].map((id) => String(id || '').replace(/^lib-/, '').trim()).filter(Boolean);

  for (const id of libraryIds) {
    add(id);
    add(`lib-${id}`);
  }
  add(article.sourceKey);
  add(render.sourceKey);
  add(plan.sourceKey);
  add(article.url);
  add(render.sourceUrl);
  add(plan.sourceUrl);
  return keys;
}

async function writeAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteSeq = (atomicWriteSeq + 1) % Number.MAX_SAFE_INTEGER;
  const tmp = `${path}.${process.pid}.${Date.now()}.${atomicWriteSeq}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

async function writeJob(job, options = {}) {
  const path = jobPath(job.id, options);
  await writeAtomic(path, `${JSON.stringify(job, null, 2)}\n`);
  return job;
}

async function readJob(id, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) throw new Error('invalid_job_id');
  try {
    return JSON.parse(await readFile(jobPath(id, options), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      await rm(jobPath(id, options), { force: true }).catch(() => {});
      return null;
    }
    throw error;
  }
}

function makeJobId(plan) {
  return sha256(JSON.stringify({
    version: JOB_VERSION,
    renderId: plan.id,
    provider: plan.provider,
    model: plan.model,
    voice: plan.voice,
    instructions: plan.instructions,
    script: plan.script,
  })).slice(0, 32);
}

async function markReadyFromCache(job, options = {}) {
  const cached = await readPodcastRenderManifest(job.renderId, options);
  if (!cached) return null;
  return {
    ...job,
    status: 'ready',
    progress: {
      totalChunks: cached.totalChunks || cached.chunks.length,
      completedChunks: cached.totalChunks || cached.chunks.length,
    },
    render: { ...cached, cached: true },
    updatedAt: nowIso(options.now),
    completedAt: nowIso(options.now),
    error: null,
  };
}

async function hasPlayableReadyRender(job, options = {}) {
  if (!job || job.status !== 'ready') return false;
  const id = job.renderId || job.render?.id;
  if (!id) return false;
  return Boolean(await readPodcastRenderManifest(id, options));
}

async function requeueRenderJob(job, options = {}) {
  return writeJob({
    ...job,
    status: 'queued',
    render: null,
    completedAt: null,
    progress: {
      totalChunks: job.progress?.totalChunks || job.plan?.totalChunks || 0,
      completedChunks: 0,
    },
    error: null,
    updatedAt: nowIso(options.now),
  }, options);
}

async function requeueStaleReadyJob(job, options = {}) {
  return requeueRenderJob(job, options);
}

async function runJob(id, options = {}) {
  if (runningJobs.has(id)) return;
  runningJobs.add(id);
  try {
    let job = await readJob(id, options);
    if (!job) return;

    const cached = await markReadyFromCache(job, options);
    if (cached) {
      await writeJob(cached, options);
      return;
    }

    job = {
      ...job,
      status: 'running',
      startedAt: job.startedAt || nowIso(options.now),
      updatedAt: nowIso(options.now),
      error: null,
    };
    await writeJob(job, options);

    const render = await renderPodcastAudio({
      article: job.input.article,
      provider: job.plan.provider || DEFAULT_TTS_PROVIDER,
      model: job.plan.model,
      voice: job.plan.voice || defaultTtsVoiceForProvider(job.plan.provider || DEFAULT_TTS_PROVIDER),
      instructions: job.plan.instructions || DEFAULT_TTS_INSTRUCTIONS,
      scriptMode: job.plan.script?.mode,
      scriptInstructions: job.plan.script?.instructions,
      scriptAgent: job.plan.script?.agent?.enabled,
      scriptAgentProvider: job.plan.script?.agent?.provider,
      scriptAgentModel: job.plan.script?.agent?.model,
      apiKey: options.apiKey,
      openaiApiKey: options.openaiApiKey || config.openaiKey,
      speechifyApiKey: options.speechifyApiKey || config.speechifyApiKey,
      fetchImpl: options.fetchImpl || globalThis.fetch,
      mediaDir: options.mediaDir,
      now: options.now,
      onProgress: async (progress) => {
        const current = await readJob(id, options);
        if (!current) return;
        await writeJob({
          ...current,
          status: 'running',
          progress: {
            totalChunks: progress.totalChunks,
            completedChunks: Math.max(
              Number(current.progress?.completedChunks || 0),
              Number(progress.completedChunks || 0),
            ),
            currentChunk: progress.currentChunk,
          },
          updatedAt: nowIso(options.now),
        }, options);
      },
    });

    const complete = {
      ...job,
      status: 'ready',
      renderId: render.id || job.renderId,
      render,
      progress: {
        totalChunks: render.totalChunks || render.chunks.length,
        completedChunks: render.totalChunks || render.chunks.length,
      },
      updatedAt: nowIso(options.now),
      completedAt: nowIso(options.now),
      error: null,
    };
    await writeJob(complete, options);
  } catch (error) {
    const job = await readJob(id, options).catch(() => null);
    if (job) {
      await writeJob({
        ...job,
        status: 'failed',
        error: error?.message || 'render_failed',
        updatedAt: nowIso(options.now),
      }, options).catch(() => {});
    }
  } finally {
    runningJobs.delete(id);
  }
}

export async function schedulePodcastRenderJob(id, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) throw new Error('invalid_job_id');
  const merged = { ...(runnerOptions.get(id) || {}), ...options };
  runnerOptions.set(id, merged);
  if (!runningJobs.has(id)) setImmediate(() => runJob(id, runnerOptions.get(id) || {}));
}

export async function createPodcastRenderJob({
  article,
  provider,
  model,
  voice,
  instructions,
  scriptMode,
  scriptInstructions,
  scriptAgent,
  scriptAgentProvider,
  scriptAgentModel,
} = {}, options = {}) {
  const clean = cleanArticle(article);
  const planProvider = provider || DEFAULT_TTS_PROVIDER;
  const plan = createPodcastRenderPlan({
    article: clean,
    provider: planProvider,
    model,
    voice: voice || defaultTtsVoiceForProvider(planProvider),
    instructions: instructions || DEFAULT_TTS_INSTRUCTIONS,
    scriptMode,
    scriptInstructions,
    scriptAgent,
    scriptAgentProvider,
    scriptAgentModel,
  });
  const id = makeJobId(plan);
  const existing = await readJob(id, options);
  if (existing?.status === 'ready' && await hasPlayableReadyRender(existing, options)) {
    return publicJob(existing);
  }

  const base = existing || {
    version: JOB_VERSION,
    id,
    renderId: plan.id,
    status: 'queued',
    createdAt: nowIso(options.now),
    input: { article: clean },
    plan,
    render: null,
    progress: {
      totalChunks: plan.totalChunks,
      completedChunks: 0,
    },
    error: null,
  };

  const cached = await markReadyFromCache(base, options);
  const job = cached || {
    ...base,
    status: ['running', 'queued'].includes(base.status) ? base.status : 'queued',
    updatedAt: nowIso(options.now),
    plan,
    input: { article: clean },
    progress: ['running', 'queued'].includes(base.status)
      ? (base.progress || { totalChunks: plan.totalChunks, completedChunks: 0 })
      : { totalChunks: plan.totalChunks, completedChunks: 0 },
    render: null,
    completedAt: null,
    error: null,
  };
  await writeJob(job, options);
  if (job.status !== 'ready') await schedulePodcastRenderJob(job.id, options);
  return publicJob(job);
}

export async function getPodcastRenderJob(id, options = {}) {
  let job = await readJob(id, options);
  if (!job) return null;
  if (job.status === 'ready' && !(await hasPlayableReadyRender(job, options))) {
    job = await requeueStaleReadyJob(job, options);
  }
  if (job.status === 'queued' || job.status === 'running') {
    await schedulePodcastRenderJob(job.id, options);
  }
  return publicJob(job);
}

export async function repairPodcastRenderJob(id, options = {}) {
  const job = await readJob(id, options);
  if (!job) return null;
  const renderId = job.renderId || job.render?.id;
  if (renderId) await invalidatePodcastRenderCache(renderId, options);
  const queued = await requeueRenderJob(job, options);
  await schedulePodcastRenderJob(queued.id, options);
  return publicJob(queued);
}

export async function deletePodcastRenderJob(id, options = {}) {
  const job = await readJob(id, options);
  if (!job) return null;
  const renderId = job.renderId || job.render?.id;
  if (renderId) await invalidatePodcastRenderCache(renderId, options).catch(() => {});
  await rm(jobPath(job.id, options), { force: true });
  return publicJob(job);
}

export async function listReadyPodcastRenderJobs(options = {}) {
  let files;
  try {
    files = await readdir(jobsRoot(options));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const jobs = [];
  for (const file of files) {
    if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
    const job = await readJob(file.replace(/\.json$/, ''), options);
    if (job?.status !== 'ready' || !job.render) continue;
    if (!(await hasPlayableReadyRender(job, options))) {
      const queued = await requeueStaleReadyJob(job, options);
      await schedulePodcastRenderJob(queued.id, options);
      continue;
    }
    jobs.push(publicJob(job));
  }
  return jobs;
}

export async function deletePodcastRenderJobsBySourceKeys(keys = [], options = {}) {
  const targets = new Set(
    (Array.isArray(keys) ? keys : [keys])
      .map((key) => String(key || '').trim())
      .filter(Boolean),
  );
  if (!targets.size) return [];

  let files;
  try {
    files = await readdir(jobsRoot(options));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const removed = [];
  for (const file of files) {
    if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
    const id = file.replace(/\.json$/, '');
    const job = await readJob(id, options);
    if (!job) continue;
    const keysForJob = jobSourceKeys(job);
    if (![...targets].some((key) => keysForJob.has(key))) continue;

    const renderId = job.renderId || job.render?.id;
    if (renderId) await invalidatePodcastRenderCache(renderId, options).catch(() => {});
    await rm(jobPath(id, options), { force: true });
    removed.push(publicJob(job));
  }
  return removed;
}
