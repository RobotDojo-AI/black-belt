import { readPodcastRenderManifest } from './podcast-tts.js';
import { listReadyPodcastRenderJobs } from './podcast-jobs.js';
import { listReadyPodcastSeriesItems } from './podcast-series.js';
import { listPodcastEpisodes } from './podcast-library.js';

function estimateMinutes(render = {}) {
  const chars = Number(render.totalChars || 0);
  return chars ? Math.max(1, Math.round(chars / 900)) : 0;
}

function dateValue(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function renderId(render = {}) {
  return String(render.id || '').trim();
}

function progressKeyFor(item = {}) {
  const libraryId = String(item.libraryId || item.render?.libraryId || item.plan?.libraryId || '').replace(/^lib-/, '').trim();
  return String(
    item.progressKey
      || item.render?.sourceKey
      || item.plan?.sourceKey
      || (libraryId ? `lib-${libraryId}` : '')
      || item.sourceUrl
      || item.render?.sourceUrl
      || item.plan?.sourceUrl
      || item.id
      || '',
  ).trim();
}

function sourceIdentityKeys(item = {}) {
  const keys = new Set();
  const add = (value) => {
    const clean = String(value || '').trim();
    if (clean) keys.add(clean);
  };
  const libraryId = String(item.libraryId || item.render?.libraryId || item.plan?.libraryId || '').replace(/^lib-/, '').trim();
  if (libraryId) {
    add(libraryId);
    add(`lib-${libraryId}`);
  }
  add(item.progressKey);
  add(item.sourceUrl);
  add(item.render?.sourceKey);
  add(item.render?.sourceUrl);
  add(item.plan?.sourceKey);
  add(item.plan?.sourceUrl);
  return keys;
}

function hasSeenSource(item = {}, seenSourceKeys = new Set()) {
  return [...sourceIdentityKeys(item)].some((key) => seenSourceKeys.has(key));
}

function rememberSource(item = {}, seenSourceKeys = new Set()) {
  for (const key of sourceIdentityKeys(item)) seenSourceKeys.add(key);
}

function itemFromSeries(item) {
  return {
    kind: 'series',
    id: `series-${item.seriesId}-${item.sequence}`,
    title: item.title,
    sourceName: item.sourceName || item.seriesTitle || 'Series',
    sourceUrl: item.sourceUrl || item.render?.sourceUrl || '',
    libraryId: item.libraryId || item.render?.libraryId || '',
    progressKey: progressKeyFor(item),
    seriesId: item.seriesId,
    seriesTitle: item.seriesTitle,
    seriesSource: item.seriesSource,
    sequence: item.sequence,
    total: item.total,
    renderJobId: item.renderJobId,
    render: item.render,
    estimatedMinutes: estimateMinutes(item.render),
    completedAt: item.completedAt || item.render?.generatedAt || null,
    updatedAt: item.updatedAt || item.completedAt || item.render?.generatedAt || null,
  };
}

function libraryEpisodeMap(episodes = []) {
  const map = new Map();
  for (const episode of episodes) {
    const id = String(episode.id || episode.libraryId || '').replace(/^lib-/, '').trim();
    if (id) map.set(id, episode);
  }
  return map;
}

function playlistSequence(episode = {}) {
  const index = Number(episode.playlistIndex);
  return Number.isFinite(index) && index >= 0 ? Math.floor(index) + 1 : null;
}

function libraryContextForItem(item = {}, libraryById = new Map()) {
  const id = String(item.libraryId || item.render?.libraryId || item.plan?.libraryId || '').replace(/^lib-/, '').trim();
  return id ? libraryById.get(id) || null : null;
}

function applyLibraryContext(item, libraryById = new Map()) {
  const episode = libraryContextForItem(item, libraryById);
  if (!episode) return item;
  return {
    ...item,
    sourceName: item.sourceName || episode.sourceName || '',
    playlistId: episode.playlistId || item.playlistId || '',
    playlistTitle: episode.playlistTitle || item.playlistTitle || '',
    playlistSourceUrl: episode.playlistSourceUrl || item.playlistSourceUrl || '',
    sequence: item.sequence || playlistSequence(episode),
    total: item.total || episode.playlistTotal || null,
  };
}

function itemFromJob(job, libraryById = new Map()) {
  const render = job.render || {};
  const item = {
    id: `render-${render.id || job.id}`,
    sourceUrl: render.sourceUrl || job.plan?.sourceUrl || '',
    libraryId: render.libraryId || job.plan?.libraryId || '',
    render,
    plan: job.plan || {},
  };
  const ready = {
    kind: 'render',
    id: item.id,
    title: render.title || job.plan?.title || 'Episode',
    sourceName: render.sourceName || job.plan?.sourceName || 'AI Voice',
    sourceUrl: item.sourceUrl,
    libraryId: item.libraryId,
    progressKey: progressKeyFor(item),
    seriesId: null,
    seriesTitle: null,
    seriesSource: null,
    sequence: null,
    total: null,
    renderJobId: job.id,
    render,
    estimatedMinutes: estimateMinutes(render),
    completedAt: job.completedAt || render.generatedAt || null,
    updatedAt: job.updatedAt || job.completedAt || render.generatedAt || null,
  };
  return applyLibraryContext(ready, libraryById);
}

async function hasPlayableRender(render, options = {}) {
  const id = renderId(render);
  if (!id) return false;
  return Boolean(await readPodcastRenderManifest(id, options));
}

export async function listPodcastListeningItems(options = {}) {
  const [seriesItems, renderJobs, libraryEpisodes] = await Promise.all([
    listReadyPodcastSeriesItems(options),
    listReadyPodcastRenderJobs(options),
    listPodcastEpisodes(options),
  ]);
  const libraryById = libraryEpisodeMap(libraryEpisodes);

  const seenRenderIds = new Set();
  const seenSourceKeys = new Set();
  const items = [];

  for (const entry of seriesItems) {
    if (entry.libraryId && !libraryById.has(String(entry.libraryId).replace(/^lib-/, '').trim())) continue;
    const item = applyLibraryContext(itemFromSeries(entry), libraryById);
    if (!(await hasPlayableRender(item.render, options))) continue;
    const id = renderId(item.render);
    if (id) seenRenderIds.add(id);
    rememberSource(item, seenSourceKeys);
    items.push(item);
  }

  for (const job of renderJobs) {
    const item = itemFromJob(job, libraryById);
    if (!(await hasPlayableRender(item.render, options))) continue;
    const id = renderId(item.render);
    if (id && seenRenderIds.has(id)) continue;
    if (hasSeenSource(item, seenSourceKeys)) continue;
    if (id) seenRenderIds.add(id);
    rememberSource(item, seenSourceKeys);
    items.push(item);
  }

  items.sort((a, b) => {
    if (a.seriesId && a.seriesId === b.seriesId) {
      return Number(a.sequence || 0) - Number(b.sequence || 0);
    }
    return dateValue(b.completedAt || b.updatedAt) - dateValue(a.completedAt || a.updatedAt);
  });

  return items;
}
