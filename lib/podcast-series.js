import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  DEFAULT_PODCAST_SCRIPT_MODE,
  DEFAULT_PODCAST_SCRIPT_AGENT,
  DEFAULT_PODCAST_SCRIPT_AGENT_MODEL,
  DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
  normalizePodcastScriptAgent,
  normalizePodcastScriptAgentModel,
  normalizePodcastScriptAgentProvider,
  normalizePodcastScriptInstructions,
  normalizePodcastScriptMode,
} from './podcast-script.js';
import {
  DEFAULT_TTS_INSTRUCTIONS,
  DEFAULT_TTS_PROVIDER,
  DEFAULT_TTS_VOICE,
  defaultTtsModelForProvider,
  defaultTtsVoiceForProvider,
  normalizeTtsInstructions,
  normalizeTtsModel,
  normalizeTtsProvider,
  normalizeTtsVoice,
  readPodcastRenderManifest,
} from './podcast-tts.js';
import {
  createPodcastRenderJob,
  getPodcastRenderJob,
} from './podcast-jobs.js';
import { USER_MEDIA_DIR } from './robotdojo-paths.js';

const SERIES_VERSION = 1;
const runningSeries = new Set();
const runnerOptions = new Map();
let atomicWriteSeq = 0;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function nowIso(now = () => new Date()) {
  return now().toISOString();
}

function seriesRoot(options = {}) {
  return resolve(options.mediaDir || USER_MEDIA_DIR, 'podcast', 'series');
}

function seriesPath(id, options = {}) {
  return join(seriesRoot(options), `${id}.json`);
}

function cleanEpisode(episode, index, total, options = {}) {
  const libraryId = String(episode.libraryId || (options.source === 'library' ? episode.id : '') || '').replace(/^lib-/, '').trim();
  return {
    sequence: Number(episode.sequence || index + 1),
    total: Number(episode.total || total),
    title: String(episode.title || `Episode ${index + 1}`).trim(),
    url: String(episode.url || '').trim(),
    libraryId,
    sourceName: episode.sourceName || episode.source || 'Paul Graham',
    status: episode.status || 'queued',
    renderJobId: episode.renderJobId || null,
    render: episode.render || null,
    error: episode.error || null,
    updatedAt: episode.updatedAt || null,
  };
}

function makeSeriesId({
  source,
  episodes,
  provider,
  model,
  voice,
  instructions,
  scriptMode,
  scriptInstructions,
  scriptAgent,
  scriptAgentProvider,
  scriptAgentModel,
}) {
  return sha256(JSON.stringify({
    version: SERIES_VERSION,
    source,
    provider,
    model,
    voice,
    instructions,
    scriptMode,
    scriptInstructions,
    scriptAgent,
    scriptAgentProvider,
    scriptAgentModel,
    refs: episodes.map((episode) => (
      episode.libraryId ? `library:${episode.libraryId}` : `url:${episode.url}`
    )),
  })).slice(0, 32);
}

async function writeAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteSeq = (atomicWriteSeq + 1) % Number.MAX_SAFE_INTEGER;
  const tmp = `${path}.${process.pid}.${Date.now()}.${atomicWriteSeq}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

async function writeSeries(series, options = {}) {
  await writeAtomic(seriesPath(series.id, options), `${JSON.stringify(series, null, 2)}\n`);
  return series;
}

async function readSeries(id, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) throw new Error('invalid_series_id');
  try {
    return JSON.parse(await readFile(seriesPath(id, options), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function repairInvalidReadySeriesRenders(series, options = {}) {
  if (!series) return null;
  let changed = false;
  const items = [];
  for (const item of series.items || []) {
    if (item.status === 'ready' && item.render) {
      const renderId = item.render.id;
      const manifest = renderId ? await readPodcastRenderManifest(renderId, options) : null;
      if (!manifest) {
        changed = true;
        items.push({
          ...item,
          status: 'queued',
          renderJobId: null,
          render: null,
          error: 'invalid_audio_bytes',
          updatedAt: nowIso(options.now),
        });
        continue;
      }
    }
    items.push(item);
  }
  if (!changed) return refreshSeriesStatus(series);
  const repaired = refreshSeriesStatus({
    ...series,
    items,
    autoRender: false,
    completedAt: null,
    updatedAt: nowIso(options.now),
  });
  await writeSeries(repaired, options);
  return repaired;
}

function progressFor(series) {
  const completedEpisodes = series.items.filter((item) => item.status === 'ready').length;
  const running = series.items.find((item) => item.status === 'running');
  const next = series.items.find((item) => item.status === 'queued' || item.status === 'failed') || null;
  return {
    totalEpisodes: series.items.length,
    completedEpisodes,
    currentSequence: running?.sequence || next?.sequence || null,
    nextTitle: next?.title || null,
  };
}

function refreshSeriesStatus(series) {
  const completed = series.items.filter((item) => item.status === 'ready').length;
  const running = series.items.some((item) => item.status === 'running');
  const failed = series.items.some((item) => item.status === 'failed');
  const next = series.items.some((item) => item.status === 'queued');
  const autoRender = series.autoRender === true;
  let status = 'idle';
  if (completed === series.items.length) status = 'ready';
  else if (running || autoRender) status = 'running';
  else if (failed) status = 'failed';
  else if (next || completed > 0) status = 'paused';
  return {
    ...series,
    autoRender,
    status,
    progress: progressFor(series),
  };
}

function seriesQueueConcurrency(options = {}) {
  const source = options.seriesConcurrency === undefined
    ? process.env.ROBOTDOJO_PODCAST_SERIES_CONCURRENCY || 1
    : options.seriesConcurrency;
  const raw = Number(source);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 3) : 1;
}

function publicSeries(series) {
  if (!series) return null;
  return {
    version: series.version,
    id: series.id,
    source: series.source,
    title: series.title,
    ordering: series.ordering,
    status: series.status,
    autoRender: series.autoRender === true,
    plan: series.plan,
    progress: series.progress,
    items: series.items.map((item) => ({
      sequence: item.sequence,
      total: item.total,
      title: item.title,
      url: item.url,
      libraryId: item.libraryId || '',
      sourceName: item.sourceName,
      status: item.status,
      renderJobId: item.renderJobId,
      render: item.render,
      error: item.error,
      updatedAt: item.updatedAt,
    })),
    createdAt: series.createdAt,
    updatedAt: series.updatedAt,
    completedAt: series.completedAt || null,
    error: series.error || null,
  };
}

export async function createPodcastSeries({
  source = 'pg',
  title = 'Paul Graham Essays',
  ordering = 'oldest_first',
  episodes = [],
  provider = DEFAULT_TTS_PROVIDER,
  model,
  voice = DEFAULT_TTS_VOICE,
  instructions = DEFAULT_TTS_INSTRUCTIONS,
  scriptMode = DEFAULT_PODCAST_SCRIPT_MODE,
  scriptInstructions = '',
  scriptAgent = DEFAULT_PODCAST_SCRIPT_AGENT,
  scriptAgentProvider = DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
  scriptAgentModel = DEFAULT_PODCAST_SCRIPT_AGENT_MODEL,
} = {}, options = {}) {
  const cleanEpisodes = episodes
    .map((episode, index) => cleanEpisode(episode, index, episodes.length, { source }))
    .filter((episode) => (episode.url || episode.libraryId) && episode.title)
    .sort((a, b) => a.sequence - b.sequence);
  if (!cleanEpisodes.length) throw new Error('series_episodes_required');

  const cleanProvider = normalizeTtsProvider(provider);
  const cleanPlan = {
    provider: cleanProvider,
    model: normalizeTtsModel(model || defaultTtsModelForProvider(cleanProvider), cleanProvider),
    voice: normalizeTtsVoice(voice || defaultTtsVoiceForProvider(cleanProvider), cleanProvider),
    instructions: normalizeTtsInstructions(instructions),
    scriptMode: normalizePodcastScriptMode(scriptMode),
    scriptInstructions: normalizePodcastScriptInstructions(scriptInstructions),
    scriptAgent: normalizePodcastScriptAgent(scriptAgent),
    scriptAgentProvider: normalizePodcastScriptAgentProvider(scriptAgentProvider),
    scriptAgentModel: normalizePodcastScriptAgentModel(scriptAgentModel),
    totalEpisodes: cleanEpisodes.length,
  };
  const id = makeSeriesId({
    source,
    episodes: cleanEpisodes,
    provider: cleanPlan.provider,
    model: cleanPlan.model,
    voice: cleanPlan.voice,
    instructions: cleanPlan.instructions,
    scriptMode: cleanPlan.scriptMode,
    scriptInstructions: cleanPlan.scriptInstructions,
    scriptAgent: cleanPlan.scriptAgent,
    scriptAgentProvider: cleanPlan.scriptAgentProvider,
    scriptAgentModel: cleanPlan.scriptAgentModel,
  });
  const existing = await readSeries(id, options);
  if (existing) return publicSeries(await repairInvalidReadySeriesRenders(existing, options));

  const series = refreshSeriesStatus({
    version: SERIES_VERSION,
    id,
    source,
    title,
    ordering,
    status: 'idle',
    autoRender: false,
    plan: cleanPlan,
    progress: { totalEpisodes: cleanEpisodes.length, completedEpisodes: 0 },
    items: cleanEpisodes,
    createdAt: nowIso(options.now),
    updatedAt: nowIso(options.now),
    completedAt: null,
    error: null,
  });
  await writeSeries(series, options);
  return publicSeries(series);
}

async function waitForRenderJob(jobId, options = {}) {
  const pollMs = options.pollMs || 200;
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await getPodcastRenderJob(jobId, options);
    if (!job) throw new Error('render_job_not_found');
    if (job.status === 'ready' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('render_job_timeout');
}

async function markSeriesItemFailed(id, index, error, options = {}) {
  const series = await readSeries(id, options).catch(() => null);
  if (!series) return;
  if (index >= 0) {
    series.items[index] = {
      ...series.items[index],
      status: 'failed',
      error: error?.message || 'series_render_failed',
      updatedAt: nowIso(options.now),
    };
  }
  await writeSeries(refreshSeriesStatus({
    ...series,
    updatedAt: nowIso(options.now),
    error: error?.message || 'series_render_failed',
  }), options);
}

async function renderSeriesItemJob(series, index, { articleForItem } = {}, options = {}) {
  const item = series.items[index];
  if (!item) throw new Error('series_item_not_found');
  const article = await articleForItem(item);
  const renderJob = await createPodcastRenderJob({
    article,
    provider: series.plan.provider || DEFAULT_TTS_PROVIDER,
    model: series.plan.model,
    voice: series.plan.voice,
    instructions: series.plan.instructions,
    scriptMode: series.plan.scriptMode || DEFAULT_PODCAST_SCRIPT_MODE,
    scriptInstructions: series.plan.scriptInstructions || '',
    scriptAgent: series.plan.scriptAgent,
    scriptAgentProvider: series.plan.scriptAgentProvider,
    scriptAgentModel: series.plan.scriptAgentModel,
  }, options);
  const completeJob = renderJob.status === 'ready'
    ? renderJob
    : await waitForRenderJob(renderJob.id, options);

  if (completeJob.status !== 'ready') {
    throw new Error(completeJob.error || 'render_job_failed');
  }
  return completeJob;
}

async function renderNextSeriesItemUnlocked(id, { articleForItem } = {}, options = {}) {
  if (typeof articleForItem !== 'function') throw new Error('article_resolver_required');
  let series = await repairInvalidReadySeriesRenders(await readSeries(id, options), options);
  if (!series) return null;
  series = refreshSeriesStatus(series);
  if (series.status === 'ready') return publicSeries(series);

  const index = series.items.findIndex((item) => item.status !== 'ready');
  if (index < 0) {
    series = refreshSeriesStatus({ ...series, autoRender: false, completedAt: nowIso(options.now), updatedAt: nowIso(options.now) });
    await writeSeries(series, options);
    return publicSeries(series);
  }

  series.items[index] = {
    ...series.items[index],
    status: 'running',
    error: null,
    updatedAt: nowIso(options.now),
  };
  series = refreshSeriesStatus({ ...series, updatedAt: nowIso(options.now), error: null });
  await writeSeries(series, options);

  try {
    const completeJob = await renderSeriesItemJob(series, index, { articleForItem }, options);

    series = await readSeries(id, options);
    series.items[index] = {
      ...series.items[index],
      status: 'ready',
      renderJobId: completeJob.id,
      render: completeJob.render,
      error: null,
      updatedAt: nowIso(options.now),
    };
    series = refreshSeriesStatus({
      ...series,
      updatedAt: nowIso(options.now),
      autoRender: series.items.every((item) => item.status === 'ready') ? false : series.autoRender === true,
      completedAt: series.items.every((item) => item.status === 'ready') ? nowIso(options.now) : null,
      error: null,
    });
    await writeSeries(series, options);
    return publicSeries(series);
  } catch (error) {
    await markSeriesItemFailed(id, index, error, options).catch(() => {});
    throw error;
  }
}

async function renderNextSeriesBatchUnlocked(id, { articleForItem } = {}, options = {}) {
  if (typeof articleForItem !== 'function') throw new Error('article_resolver_required');
  let series = await repairInvalidReadySeriesRenders(await readSeries(id, options), options);
  if (!series) return null;
  series = refreshSeriesStatus(series);
  if (series.status === 'ready') return publicSeries(series);

  const capacity = seriesQueueConcurrency(options);
  let indices = series.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === 'running')
    .map(({ index }) => index);

  if (indices.length < capacity) {
    for (let index = 0; index < series.items.length && indices.length < capacity; index += 1) {
      const item = series.items[index];
      if (item.status !== 'queued' && item.status !== 'failed') continue;
      series.items[index] = {
        ...item,
        status: 'running',
        error: null,
        updatedAt: nowIso(options.now),
      };
      indices.push(index);
    }
  }

  indices = [...new Set(indices)].sort((a, b) => a - b);
  if (!indices.length) return publicSeries(series);

  series = refreshSeriesStatus({ ...series, updatedAt: nowIso(options.now), error: null });
  await writeSeries(series, options);

  const results = await Promise.allSettled(
    indices.map((index) => renderSeriesItemJob(series, index, { articleForItem }, options)),
  );
  const current = await readSeries(id, options);
  const nextItems = [...current.items];
  let firstError = null;
  results.forEach((result, offset) => {
    const index = indices[offset];
    if (result.status === 'fulfilled') {
      nextItems[index] = {
        ...nextItems[index],
        status: 'ready',
        renderJobId: result.value.id,
        render: result.value.render,
        error: null,
        updatedAt: nowIso(options.now),
      };
      return;
    }
    firstError ||= result.reason;
    nextItems[index] = {
      ...nextItems[index],
      status: 'failed',
      error: result.reason?.message || 'series_render_failed',
      updatedAt: nowIso(options.now),
    };
  });

  series = refreshSeriesStatus({
    ...current,
    items: nextItems,
    updatedAt: nowIso(options.now),
    autoRender: nextItems.every((item) => item.status === 'ready') ? false : current.autoRender === true,
    completedAt: nextItems.every((item) => item.status === 'ready') ? nowIso(options.now) : null,
    error: firstError ? firstError.message || 'series_render_failed' : null,
  });
  await writeSeries(series, options);
  if (firstError) throw firstError;
  return publicSeries(series);
}

async function disableSeriesAutoRender(id, options = {}) {
  const series = await readSeries(id, options);
  if (!series) return null;
  const items = runningSeries.has(id)
    ? series.items
    : series.items.map((item) => (
      item.status === 'running'
        ? { ...item, status: 'queued', updatedAt: nowIso(options.now) }
        : item
    ));
  const next = refreshSeriesStatus({
    ...series,
    items,
    autoRender: false,
    updatedAt: nowIso(options.now),
  });
  await writeSeries(next, options);
  return next;
}

async function prepareSeriesAutoRender(id, options = {}) {
  let series = await repairInvalidReadySeriesRenders(await readSeries(id, options), options);
  if (!series) return null;
  series = refreshSeriesStatus(series);
  if (series.status === 'ready') {
    series = refreshSeriesStatus({
      ...series,
      autoRender: false,
      completedAt: series.completedAt || nowIso(options.now),
      updatedAt: nowIso(options.now),
    });
    await writeSeries(series, options);
    return series;
  }

  let running = series.items.filter((item) => item.status === 'running').length;
  const capacity = seriesQueueConcurrency(options);
  if (running < capacity) {
    for (let index = 0; index < series.items.length && running < capacity; index += 1) {
      if (series.items[index].status === 'ready' || series.items[index].status === 'running') continue;
      series.items[index] = {
        ...series.items[index],
        status: 'running',
        error: null,
        updatedAt: nowIso(options.now),
      };
      running += 1;
    }
  }

  series = refreshSeriesStatus({
    ...series,
    autoRender: true,
    updatedAt: nowIso(options.now),
    error: null,
  });
  await writeSeries(series, options);
  return series;
}

export async function runNextPodcastSeriesItem(id, { articleForItem } = {}, options = {}) {
  if (typeof articleForItem !== 'function') throw new Error('article_resolver_required');
  if (runningSeries.has(id)) return publicSeries(await readSeries(id, options));
  runningSeries.add(id);
  try {
    await disableSeriesAutoRender(id, options);
    return await renderNextSeriesItemUnlocked(id, { articleForItem }, options);
  } finally {
    runningSeries.delete(id);
  }
}

export async function startNextPodcastSeriesItem(id, dependencies = {}, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) throw new Error('invalid_series_id');
  const merged = { dependencies, options };
  runnerOptions.set(id, merged);

  let series = await repairInvalidReadySeriesRenders(await readSeries(id, options), options);
  if (!series) return null;
  series = refreshSeriesStatus({ ...series, autoRender: false });
  if (series.status === 'ready') return publicSeries(series);

  if (!runningSeries.has(id)) {
    if (series.status !== 'running') {
      const index = series.items.findIndex((item) => item.status !== 'ready');
      if (index >= 0) {
        series.items[index] = {
          ...series.items[index],
          status: 'running',
          error: null,
          updatedAt: nowIso(options.now),
        };
        series = refreshSeriesStatus({ ...series, updatedAt: nowIso(options.now), error: null });
        await writeSeries(series, options);
      }
    } else if (!series.items.some((item) => item.status === 'running')) {
      const index = series.items.findIndex((item) => item.status !== 'ready');
      series.items[index] = {
        ...series.items[index],
        status: 'running',
        error: null,
        updatedAt: nowIso(options.now),
      };
      series = refreshSeriesStatus({ ...series, updatedAt: nowIso(options.now), error: null });
      await writeSeries(series, options);
    }
    setImmediate(() => {
      const run = runnerOptions.get(id);
      runNextPodcastSeriesItem(id, run?.dependencies || {}, run?.options || {}).catch(() => {});
    });
  }
  return publicSeries(series);
}

async function runPodcastSeriesQueueInternal(id, { articleForItem } = {}, options = {}, { prepare = true } = {}) {
  if (typeof articleForItem !== 'function') throw new Error('article_resolver_required');
  if (runningSeries.has(id)) return publicSeries(await readSeries(id, options));
  runningSeries.add(id);
  try {
    let series = prepare ? await prepareSeriesAutoRender(id, options) : await readSeries(id, options);
    if (!series) return null;
    series = refreshSeriesStatus(series);

    const concurrency = seriesQueueConcurrency(options);
    while (series?.autoRender === true && series.status !== 'ready') {
      if (concurrency > 1) await renderNextSeriesBatchUnlocked(id, { articleForItem }, options);
      else await renderNextSeriesItemUnlocked(id, { articleForItem }, options);
      series = refreshSeriesStatus(await readSeries(id, options));
      if (series.items.every((item) => item.status === 'ready')) {
        series = refreshSeriesStatus({
          ...series,
          autoRender: false,
          completedAt: series.completedAt || nowIso(options.now),
          updatedAt: nowIso(options.now),
        });
        await writeSeries(series, options);
        break;
      }
    }

    return publicSeries(refreshSeriesStatus(await readSeries(id, options)));
  } catch (error) {
    const series = await readSeries(id, options).catch(() => null);
    if (series) {
      await writeSeries(refreshSeriesStatus({
        ...series,
        autoRender: false,
        updatedAt: nowIso(options.now),
        error: error?.message || 'series_render_failed',
      }), options).catch(() => {});
    }
    throw error;
  } finally {
    runningSeries.delete(id);
  }
}

export async function runPodcastSeriesQueue(id, { articleForItem } = {}, options = {}) {
  return runPodcastSeriesQueueInternal(id, { articleForItem }, options, { prepare: true });
}

export async function startPodcastSeriesQueue(id, dependencies = {}, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) throw new Error('invalid_series_id');
  const merged = { dependencies, options };
  runnerOptions.set(id, merged);

  const series = await prepareSeriesAutoRender(id, options);
  if (!series) return null;
  if (!runningSeries.has(id)) {
    setImmediate(() => {
      const run = runnerOptions.get(id);
      runPodcastSeriesQueueInternal(id, run?.dependencies || {}, run?.options || {}, { prepare: false }).catch(() => {});
    });
  }
  return publicSeries(series);
}

export async function pausePodcastSeriesQueue(id, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) throw new Error('invalid_series_id');
  const series = await disableSeriesAutoRender(id, options);
  return series ? publicSeries(series) : null;
}

export async function getPodcastSeries(id, options = {}) {
  const series = await repairInvalidReadySeriesRenders(await readSeries(id, options), options);
  return series ? publicSeries(refreshSeriesStatus(series)) : null;
}

export async function listPodcastSeries(options = {}) {
  let files;
  try {
    files = await readdir(seriesRoot(options));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const series = [];
  for (const file of files) {
    if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
    const item = await repairInvalidReadySeriesRenders(await readSeries(file.replace(/\.json$/, ''), options), options);
    if (item) series.push(publicSeries(refreshSeriesStatus(item)));
  }
  return series;
}

export async function listReadyPodcastSeriesItems(options = {}) {
  const series = await listPodcastSeries(options);
  return series.flatMap((item) => item.items
    .filter((episode) => episode.status === 'ready' && episode.render)
    .map((episode) => ({
      kind: 'series',
      id: `${item.id}-${episode.sequence}`,
      title: episode.title,
      sourceName: episode.sourceName,
      sourceUrl: episode.url,
      libraryId: episode.libraryId || '',
      progressKey: episode.libraryId ? `lib-${episode.libraryId}` : (episode.url || ''),
      seriesId: item.id,
      seriesTitle: item.title,
      seriesSource: item.source,
      sequence: episode.sequence,
      total: episode.total,
      renderJobId: episode.renderJobId,
      render: episode.render,
      completedAt: episode.updatedAt || item.completedAt || item.updatedAt,
      updatedAt: episode.updatedAt || item.updatedAt,
    })));
}
