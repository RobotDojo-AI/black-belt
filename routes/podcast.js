import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import config from '../lib/config.js';
import {
  PAUL_GRAHAM_INDEX_URL,
  parsePaulGrahamIndex,
} from '../lib/podcast.js';
import {
  articleFromPlainText,
  articleFromUploadBuffer,
  deletePodcastEpisode,
  deletePodcastPlaylist,
  getPodcastEpisodeArticle,
  listPodcastPlaylistEpisodes,
  listPodcastEpisodes,
  renamePodcastPlaylist,
  reorderPodcastPlaylist,
  upsertPodcastEpisodeFromArticle,
} from '../lib/podcast-library.js';
import {
  DEFAULT_PODCAST_SCRIPT_AGENT,
  DEFAULT_PODCAST_SCRIPT_AGENT_MODEL,
  DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
  DEFAULT_PODCAST_SCRIPT_MODE,
} from '../lib/podcast-script.js';
import {
  DEFAULT_TTS_INSTRUCTIONS,
  DEFAULT_TTS_PROVIDER,
  defaultTtsVoiceForProvider,
  normalizeTtsProvider,
  renderPodcastAudio,
  streamPodcastAudioChunk,
} from '../lib/podcast-tts.js';
import {
  createPodcastRenderJob,
  deletePodcastRenderJob,
  deletePodcastRenderJobsBySourceKeys,
  getPodcastRenderJob,
  repairPodcastRenderJob,
} from '../lib/podcast-jobs.js';
import { listPodcastListeningItems } from '../lib/podcast-listening.js';
import {
  deletePodcastProgress,
  listPodcastProgress,
  upsertPodcastProgress,
} from '../lib/podcast-progress.js';
import {
  createPodcastSeries,
  getPodcastSeries,
  listPodcastSeries,
  pausePodcastSeriesQueue,
  startPodcastSeriesQueue,
  startNextPodcastSeriesItem,
} from '../lib/podcast-series.js';
// Input machinery (fetch / SSRF guard / cache / discover / articleFromUrl)
// moved to lib/link-corpus.js (st_64d7e5ff P1). Caching is now opt-in per call;
// every podcast call keeps its prior behavior (PG-only cache by default).
import {
  articleFromUrl,
  authorArchivePlaylistTitle,
  discoverFeedUrlsFromHtml,
  discoverIndexArticleLinksFromHtml,
  fetchFeedUrlLive,
  fetchTextUrl,
  htmlDocumentTitle,
  isA16zAuthorPage,
  isLikelyCollectionUrl,
  parseFeedItems,
} from '../lib/link-corpus.js';

// Re-exported for tests/podcast.test.js, which imports fetchTextUrl from this
// module. The definition now lives in lib/link-corpus.js.
export { fetchTextUrl };

const routes = new Hono();
const PG_CACHE_MS = 6 * 60 * 60 * 1000;
let pgCache = null;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function splitPlainText(text) {
  const normalized = String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return [];
  const paragraphs = normalized
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : [normalized.replace(/\s+/g, ' ')];
}

function textArticleFromBody(body = {}) {
  const paragraphs = Array.isArray(body.paragraphs) && body.paragraphs.length
    ? body.paragraphs.map((p) => String(p || '').trim()).filter(Boolean)
    : splitPlainText(body.text || '');
  const text = paragraphs.join('\n\n');
  return {
    title: String(body.title || '').trim() || paragraphs[0]?.slice(0, 80) || 'Untitled',
    url: String(body.url || '').trim(),
    sourceName: String(body.sourceName || '').trim() || 'Text',
    sourceKey: String(body.sourceKey || '').trim(),
    libraryId: String(body.libraryId || '').replace(/^lib-/, '').trim(),
    paragraphs,
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    charCount: text.length,
  };
}

function playlistOptionsFromBody(body = {}) {
  const playlist = body.playlist && typeof body.playlist === 'object' ? body.playlist : body;
  const playlistId = String(playlist.id || playlist.playlistId || '').trim();
  if (!playlistId) return {};
  return {
    playlistId,
    playlistTitle: playlist.title || playlist.playlistTitle || '',
    playlistSourceUrl: playlist.sourceUrl || playlist.playlistSourceUrl || '',
    playlistIndex: playlist.index ?? playlist.playlistIndex,
    playlistTotal: playlist.total ?? playlist.playlistTotal,
    playlistAddedAt: playlist.addedAt || playlist.playlistAddedAt || '',
  };
}

function playlistOptionsFromForm(form) {
  const playlistId = String(form.get('playlistId') || '').trim();
  if (!playlistId) return {};
  return {
    playlistId,
    playlistTitle: form.get('playlistTitle') || '',
    playlistIndex: form.get('playlistIndex'),
    playlistTotal: form.get('playlistTotal'),
    playlistAddedAt: form.get('playlistAddedAt') || '',
  };
}

async function deletePodcastProgressKeys(keys = []) {
  const seen = new Set();
  for (const key of keys) {
    const clean = String(key || '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    await deletePodcastProgress(clean);
  }
}

function sourceKeysForEpisode(episode = {}) {
  const id = String(episode.id || '').replace(/^lib-/, '').trim();
  return [
    id,
    id ? `lib-${id}` : '',
    episode.key,
    episode.url,
  ].filter(Boolean);
}

async function deletePodcastSourceArtifacts(episodes = []) {
  const keys = episodes.flatMap(sourceKeysForEpisode);
  await deletePodcastProgressKeys(keys);
  await deletePodcastRenderJobsBySourceKeys(keys);
}

function isArticleImportSkipError(error) {
  const message = error?.message || '';
  return message === 'unsupported_content_type'
    || message === 'article_text_not_found'
    || message === 'file_empty'
    || message === 'file_too_large'
    || /^fetch_failed_4\d\d$/.test(message);
}

function minimumWordsForIndexImport(pageUrl) {
  return isA16zAuthorPage(pageUrl) ? 8 : 20;
}

async function importIndexEpisodesFromUrl(url, body = {}) {
  const { text, finalUrl } = await fetchTextUrl(url, 4, { cache: false });
  const links = await discoverIndexArticleLinksFromHtml(text, finalUrl);
  if (!links.length) throw new Error('index_links_not_found');

  const imported = [];
  let lastError = null;
  const minimumWords = minimumWordsForIndexImport(finalUrl);
  for (const link of links) {
    try {
      const article = await articleFromUrl(link.url);
      if (!article.text || article.wordCount < minimumWords) throw new Error('article_text_not_found');
      imported.push({ link, article });
    } catch (error) {
      lastError = error;
      if (!isArticleImportSkipError(error)) throw error;
    }
  }
  if (!imported.length) throw lastError || new Error('index_articles_not_found');

  const importedWithDates = imported.every((item) => (
    Number.isFinite(Date.parse(item.article?.publishedAt || item.article?.published || item.link?.publishedAt || ''))
  ));
  const orderedImported = importedWithDates
    ? imported.slice().sort((a, b) => (
      Date.parse(a.article?.publishedAt || a.article?.published || a.link?.publishedAt || '')
      - Date.parse(b.article?.publishedAt || b.article?.published || b.link?.publishedAt || '')
    ))
    : imported;

  const playlist = body.playlist && typeof body.playlist === 'object' ? body.playlist : {};
  const playlistId = String(playlist.id || playlist.playlistId || '').trim()
    || `index-${sha256(finalUrl).slice(0, 16)}`;
  const playlistTitle = String(
    playlist.title
    || playlist.playlistTitle
    || authorArchivePlaylistTitle(text, finalUrl)
    || htmlDocumentTitle(text, finalUrl)
    || 'Imported articles',
  ).trim();
  const playlistAddedAt = playlist.addedAt || playlist.playlistAddedAt || new Date().toISOString();
  const total = orderedImported.length;
  const episodes = [];
  const articles = [];
  for (let index = 0; index < orderedImported.length; index += 1) {
    const item = orderedImported[index];
    const episode = await upsertPodcastEpisodeFromArticle(item.article, {
      playlistId,
      playlistTitle,
      playlistSourceUrl: finalUrl,
      playlistIndex: index,
      playlistTotal: total,
      playlistAddedAt,
    });
    episodes.push(episode);
    articles.push(item.article);
  }

  return {
    playlist: {
      id: playlistId,
      title: playlistTitle,
      total,
      addedAt: playlistAddedAt,
      sourceUrl: finalUrl,
    },
    episodes,
    articles,
  };
}

async function importFeedEpisodesFromUrl(url, body = {}) {
  const { text, finalUrl } = await fetchFeedUrlLive(url);
  const feed = parseFeedItems(text, finalUrl);
  const playlist = body.playlist && typeof body.playlist === 'object' ? body.playlist : {};
  const playlistId = String(playlist.id || playlist.playlistId || '').trim()
    || `feed-${sha256(finalUrl).slice(0, 16)}`;
  const playlistTitle = String(playlist.title || playlist.playlistTitle || feed.title || 'Feed').trim();
  const playlistAddedAt = playlist.addedAt || playlist.playlistAddedAt || new Date().toISOString();
  const total = feed.items.length;
  const episodes = [];
  const articles = [];
  for (let index = 0; index < feed.items.length; index += 1) {
    const item = feed.items[index];
    const article = await articleFromUrl(item.url);
    if (!article.text || article.wordCount < 20) throw new Error('article_text_not_found');
    const episode = await upsertPodcastEpisodeFromArticle(article, {
      playlistId,
      playlistTitle,
      playlistSourceUrl: finalUrl,
      playlistIndex: index,
      playlistTotal: total,
      playlistAddedAt,
    });
    episodes.push(episode);
    articles.push(article);
  }
  return {
    playlist: {
      id: playlistId,
      title: playlistTitle,
      total,
      addedAt: playlistAddedAt,
      sourceUrl: finalUrl,
    },
    episodes,
    articles,
  };
}

async function importDiscoveredFeedEpisodesFromUrl(url, body = {}) {
  const { text, finalUrl } = await fetchTextUrl(url, 4, { cache: false });
  const feedUrls = discoverFeedUrlsFromHtml(text, finalUrl);
  if (!feedUrls.length) throw new Error('feed_not_found');

  let lastError = null;
  for (const feedUrl of feedUrls) {
    try {
      return await importFeedEpisodesFromUrl(feedUrl, body);
    } catch (error) {
      lastError = error;
      if (!isFeedProbeFallbackError(error)) throw error;
    }
  }
  throw lastError || new Error('feed_not_found');
}

async function importCollectionEpisodesFromUrl(url, body = {}) {
  try {
    const feedImport = await importFeedEpisodesFromUrl(url, body);
    if (feedImport?.episodes?.length) return feedImport;
  } catch (feedError) {
    if (!isFeedProbeFallbackError(feedError)) throw feedError;
  }

  if (isLikelyCollectionUrl(url)) {
    try {
      const discoveredFeedImport = await importDiscoveredFeedEpisodesFromUrl(url, body);
      if (discoveredFeedImport?.episodes?.length) return discoveredFeedImport;
    } catch (feedError) {
      if (!isFeedProbeFallbackError(feedError)) throw feedError;
    }

    const indexImport = await importIndexEpisodesFromUrl(url, body);
    if (indexImport?.episodes?.length) return indexImport;
  }

  return null;
}

function isFeedProbeFallbackError(error) {
  const message = error?.message || '';
  return message === 'unsupported_content_type'
    || message === 'feed_not_found'
    || /^fetch_failed_4\d\d$/.test(message);
}

async function articleForRender(body = {}) {
  if (body.article && typeof body.article === 'object') return textArticleFromBody(body.article);
  if (body.text || body.paragraphs) return textArticleFromBody(body);
  if (body.url) return articleFromUrl(body.url);
  throw new Error('render_source_required');
}

function renderErrorStatus(error) {
  const message = error?.message || '';
  if (message === 'invalid_json') return 400;
  if (message === 'render_source_required' || message === 'article_required' || message === 'series_episodes_required' || message === 'progress_key_required') return 400;
  if (message === 'episode_not_found' || message === 'render_job_not_found') return 404;
  if (message === 'unsupported_content_type') return 415;
  if (message === 'response_too_large' || message === 'file_too_large') return 413;
  if (message === 'file_empty') return 422;
  if (message === 'article_text_required' || message === 'article_text_not_found') return 422;
  if (message === 'openai_billing_not_active' || message === 'openai_quota_exceeded') return 402;
  if (message === 'script_agent_empty_output') return 502;
  if (message.endsWith('_key_missing')) return 503;
  if (message.startsWith('provider_not_configured')) return 503;
  if (message.startsWith('tts_provider_failed_')) return 502;
  if (message === 'fetch_timeout') return 504;
  if (message.startsWith('fetch_failed_') || message === 'host_lookup_failed') return 502;
  if (message.startsWith('blocked_') || message === 'invalid_protocol' || message === 'invalid_url') return 400;
  return 500;
}

function episodeErrorStatus(error) {
  const message = error?.message || '';
  if (message === 'invalid_json' || message === 'invalid_form_data' || message === 'file_required' || message === 'playlist_title_required' || message === 'playlist_source_required' || message === 'playlist_order_required') return 400;
  if (message === 'unsupported_file_type') return 415;
  if (message === 'file_too_large') return 413;
  if (message === 'file_empty' || message === 'article_text_required' || message === 'article_text_not_found' || message === 'index_links_not_found' || message === 'index_articles_not_found') return 422;
  return renderErrorStatus(error);
}

async function loadPaulGrahamPayload() {
  const now = Date.now();
  if (pgCache && pgCache.expiresAt > now) return pgCache.payload;

  const { text, finalUrl } = await fetchTextUrl(PAUL_GRAHAM_INDEX_URL);
  const essays = parsePaulGrahamIndex(text, finalUrl);
  const payload = {
    source: 'Paul Graham',
    sourceUrl: PAUL_GRAHAM_INDEX_URL,
    ordering: 'oldest_first',
    count: essays.length,
    essays,
    generatedAt: new Date().toISOString(),
  };
  pgCache = { payload, expiresAt: now + PG_CACHE_MS };
  return payload;
}

async function articleForSeriesItem(item) {
  const article = await articleFromUrl(item.url);
  if (!article.text || article.wordCount < 20) throw new Error('article_text_not_found');
  return article;
}

async function articleForSavedSeriesItem(item) {
  const article = await getPodcastEpisodeArticle(item.libraryId);
  if (!article) throw new Error('episode_not_found');
  if (!article.text || article.wordCount < 20) throw new Error('article_text_not_found');
  return article;
}

async function articleForAnySeriesItem(item) {
  if (item.libraryId) return articleForSavedSeriesItem(item);
  return articleForSeriesItem(item);
}

export async function resumeAutoRenderPodcastSeries(options = {}) {
  const series = await listPodcastSeries(options);
  const resumable = series.filter((item) => (
    item?.autoRender === true
    && item.status !== 'ready'
    && item.items?.some((episode) => episode.url || episode.libraryId)
  ));
  const resumed = [];
  for (const item of resumable) {
    try {
      const started = await startPodcastSeriesQueue(
        item.id,
        { articleForItem: articleForAnySeriesItem },
        options,
      );
      if (started) resumed.push(started);
    } catch (error) {
      console.warn('[podcast] auto-render resume failed', item.id, error?.message || error);
    }
  }
  return {
    resumed: resumed.length,
    series: resumed,
  };
}

function providerStatus() {
  const openaiConfigured = Boolean(config.openaiKey);
  const speechifyConfigured = Boolean(config.speechifyApiKey);
  return {
    defaults: {
      ttsProvider: DEFAULT_TTS_PROVIDER,
      scriptAgentProvider: DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
    },
    providers: [
      {
        id: 'openai',
        label: 'OpenAI',
        configured: openaiConfigured,
        key: 'OPENAI_API_KEY',
        setupUrl: '/account/integrations?provider=openai&action=key',
        checkUrl: '/api/podcast/providers/openai/check',
        capabilities: ['tts', 'script'],
      },
      {
        id: 'speechify',
        label: 'Speechify',
        configured: speechifyConfigured,
        key: 'SPEECHIFY_API_KEY',
        setupUrl: '/account/integrations?provider=speechify&action=key',
        checkUrl: '/api/podcast/providers/speechify/check',
        capabilities: ['tts'],
      },
    ],
    scriptAgent: {
      provider: DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
      model: DEFAULT_PODCAST_SCRIPT_AGENT_MODEL,
      configured: openaiConfigured,
      key: 'OPENAI_API_KEY',
    },
  };
}

function providerCheckArticle(provider) {
  const label = provider === 'speechify' ? 'Speechify' : 'OpenAI';
  const text = [
    `Robot Dojo ${label} voice check.`,
    'This short private sample confirms the configured podcast voice can render cleanly before you queue a long episode.',
  ].join(' ');
  return {
    title: `${label} Voice Check`,
    sourceName: 'Robot Dojo',
    url: '',
    paragraphs: [text],
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    charCount: text.length,
  };
}

routes.get('/api/podcast/providers', (c) => c.json(providerStatus()));

routes.post('/api/podcast/providers/:id/check', async (c) => {
  const providerId = String(c.req.param('id') || '').trim().toLowerCase();
  if (!['openai', 'speechify'].includes(providerId)) return c.json({ error: 'provider_not_found' }, 404);

  let body = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  try {
    const provider = normalizeTtsProvider(providerId);
    const render = await renderPodcastAudio({
      article: providerCheckArticle(provider),
      provider,
      model: body.model,
      voice: body.voice || defaultTtsVoiceForProvider(provider),
      instructions: body.instructions || DEFAULT_TTS_INSTRUCTIONS,
      scriptMode: DEFAULT_PODCAST_SCRIPT_MODE,
      scriptInstructions: '',
      scriptAgent: false,
    });
    return c.json({
      ok: true,
      provider,
      model: render.model,
      voice: render.voice,
      render,
    });
  } catch (error) {
    return c.json({ ok: false, error: error?.message || 'provider_check_failed' }, renderErrorStatus(error));
  }
});

routes.get('/api/podcast/pg-essays', async (c) => {
  try {
    return c.json(await loadPaulGrahamPayload());
  } catch (error) {
    return c.json({ error: error?.message || 'pg_fetch_failed' }, renderErrorStatus(error));
  }
});

routes.post('/api/podcast/series/pg', async (c) => {
  let body = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  try {
    const payload = await loadPaulGrahamPayload();
    const series = await createPodcastSeries({
      source: 'pg',
      title: 'Paul Graham Essays',
      ordering: 'oldest_first',
      episodes: payload.essays,
      provider: body.provider || DEFAULT_TTS_PROVIDER,
      model: body.model,
      voice: body.voice || defaultTtsVoiceForProvider(body.provider || DEFAULT_TTS_PROVIDER),
      instructions: body.instructions || DEFAULT_TTS_INSTRUCTIONS,
      scriptMode: body.scriptMode || DEFAULT_PODCAST_SCRIPT_MODE,
      scriptInstructions: body.scriptInstructions || '',
      scriptAgent: body.scriptAgent ?? DEFAULT_PODCAST_SCRIPT_AGENT,
      scriptAgentProvider: body.scriptAgentProvider || DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
      scriptAgentModel: body.scriptAgentModel || DEFAULT_PODCAST_SCRIPT_AGENT_MODEL,
    });
    const active = body.autoRender === true || series.autoRender
      ? await startPodcastSeriesQueue(series.id, { articleForItem: articleForAnySeriesItem })
      : series;
    return c.json({ series: active }, active?.status === 'running' ? 202 : 200);
  } catch (error) {
    return c.json({ error: error?.message || 'series_create_failed' }, renderErrorStatus(error));
  }
});

routes.post('/api/podcast/series/library', async (c) => {
  let body = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  try {
    const ids = Array.isArray(body.episodeIds)
      ? body.episodeIds.map((id) => String(id || '').replace(/^lib-/, '').trim()).filter(Boolean)
      : [];
    if (!ids.length) throw new Error('series_episodes_required');

    const articles = [];
    for (const id of ids) {
      const article = await getPodcastEpisodeArticle(id);
      if (!article) throw new Error('episode_not_found');
      if (!article.text || article.wordCount < 1) throw new Error('article_text_not_found');
      articles.push({ id, article });
    }

    const total = articles.length;
    const episodes = articles.map(({ id, article }, index) => ({
      sequence: index + 1,
      total,
      title: article.title || `Episode ${index + 1}`,
      url: article.url || '',
      libraryId: id,
      sourceName: article.sourceName || 'Saved',
    }));
    const series = await createPodcastSeries({
      source: 'library',
      title: String(body.title || '').trim() || (total === 1 ? episodes[0].title : 'Saved Articles'),
      ordering: 'custom',
      episodes,
      provider: body.provider || DEFAULT_TTS_PROVIDER,
      model: body.model,
      voice: body.voice || defaultTtsVoiceForProvider(body.provider || DEFAULT_TTS_PROVIDER),
      instructions: body.instructions || DEFAULT_TTS_INSTRUCTIONS,
      scriptMode: body.scriptMode || DEFAULT_PODCAST_SCRIPT_MODE,
      scriptInstructions: body.scriptInstructions || '',
      scriptAgent: body.scriptAgent ?? DEFAULT_PODCAST_SCRIPT_AGENT,
      scriptAgentProvider: body.scriptAgentProvider || DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
      scriptAgentModel: body.scriptAgentModel || DEFAULT_PODCAST_SCRIPT_AGENT_MODEL,
    });
    const active = body.autoRender === true || series.autoRender
      ? await startPodcastSeriesQueue(series.id, { articleForItem: articleForAnySeriesItem })
      : series;
    return c.json({ series: active }, active?.status === 'running' ? 202 : 200);
  } catch (error) {
    return c.json({ error: error?.message || 'series_create_failed' }, renderErrorStatus(error));
  }
});

routes.get('/api/podcast/series/:id', async (c) => {
  try {
    let series = await getPodcastSeries(c.req.param('id'));
    if (!series) return c.json({ error: 'series_not_found' }, 404);
    if (series.status === 'running') {
      series = series.autoRender
        ? await startPodcastSeriesQueue(
          series.id,
          { articleForItem: articleForAnySeriesItem },
        )
        : await startNextPodcastSeriesItem(
          series.id,
          { articleForItem: articleForAnySeriesItem },
        );
    }
    return c.json({ series });
  } catch (error) {
    const message = error?.message || 'series_status_failed';
    return c.json({ error: message }, message === 'invalid_series_id' ? 400 : 500);
  }
});

routes.post('/api/podcast/series/:id/next', async (c) => {
  try {
    const series = await getPodcastSeries(c.req.param('id'));
    if (!series) return c.json({ error: 'series_not_found' }, 404);
    if (!series.items?.some((item) => item.url || item.libraryId)) {
      return c.json({ error: 'unsupported_series_source' }, 400);
    }
    const next = await startNextPodcastSeriesItem(
      series.id,
      { articleForItem: articleForAnySeriesItem },
    );
    return c.json({ series: next }, next?.status === 'running' ? 202 : 200);
  } catch (error) {
    return c.json({ error: error?.message || 'series_next_failed' }, renderErrorStatus(error));
  }
});

routes.post('/api/podcast/series/:id/render-all', async (c) => {
  try {
    const series = await getPodcastSeries(c.req.param('id'));
    if (!series) return c.json({ error: 'series_not_found' }, 404);
    if (!series.items?.some((item) => item.url || item.libraryId)) {
      return c.json({ error: 'unsupported_series_source' }, 400);
    }
    const next = await startPodcastSeriesQueue(
      series.id,
      { articleForItem: articleForAnySeriesItem },
    );
    return c.json({ series: next }, next?.status === 'running' ? 202 : 200);
  } catch (error) {
    return c.json({ error: error?.message || 'series_render_all_failed' }, renderErrorStatus(error));
  }
});

routes.post('/api/podcast/series/:id/pause', async (c) => {
  try {
    const series = await pausePodcastSeriesQueue(c.req.param('id'));
    if (!series) return c.json({ error: 'series_not_found' }, 404);
    return c.json({ series });
  } catch (error) {
    return c.json({ error: error?.message || 'series_pause_failed' }, renderErrorStatus(error));
  }
});

routes.get('/api/podcast/article', async (c) => {
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'url_required' }, 400);

  try {
    const article = await articleFromUrl(url);
    if (!article.text || article.wordCount < 20) {
      return c.json({ error: 'article_text_not_found' }, 422);
    }
    return c.json({ article });
  } catch (error) {
    return c.json({ error: error?.message || 'article_fetch_failed' }, renderErrorStatus(error));
  }
});

routes.get('/api/podcast/episodes', async (c) => {
  try {
    const episodes = await listPodcastEpisodes();
    return c.json({ episodes, count: episodes.length });
  } catch (error) {
    return c.json({ error: error?.message || 'episodes_failed' }, 500);
  }
});

routes.get('/api/podcast/progress', async (c) => {
  try {
    const progress = await listPodcastProgress();
    return c.json({ progress });
  } catch (error) {
    return c.json({ error: error?.message || 'progress_failed' }, 500);
  }
});

routes.put('/api/podcast/progress', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  try {
    const progress = await upsertPodcastProgress(body.key, body.progress || body);
    return c.json({ progress });
  } catch (error) {
    return c.json({ error: error?.message || 'progress_save_failed' }, renderErrorStatus(error));
  }
});

routes.delete('/api/podcast/progress', async (c) => {
  try {
    const key = c.req.query('key');
    const progress = await deletePodcastProgress(key);
    if (!progress) return c.json({ error: 'progress_not_found' }, 404);
    return c.json({ progress });
  } catch (error) {
    return c.json({ error: error?.message || 'progress_delete_failed' }, renderErrorStatus(error));
  }
});

routes.get('/api/podcast/episodes/:id/article', async (c) => {
  try {
    const article = await getPodcastEpisodeArticle(c.req.param('id'));
    if (!article) return c.json({ error: 'episode_not_found' }, 404);
    return c.json({ article });
  } catch (error) {
    return c.json({ error: error?.message || 'episode_article_failed' }, 500);
  }
});

routes.delete('/api/podcast/episodes/:id', async (c) => {
  try {
    const episode = await deletePodcastEpisode(c.req.param('id'));
    if (!episode) return c.json({ error: 'episode_not_found' }, 404);
    await deletePodcastSourceArtifacts([episode]);
    return c.json({ episode });
  } catch (error) {
    return c.json({ error: error?.message || 'episode_delete_failed' }, episodeErrorStatus(error));
  }
});

routes.delete('/api/podcast/playlists/:id', async (c) => {
  try {
    const episodes = await deletePodcastPlaylist(c.req.param('id'));
    if (!episodes.length) return c.json({ error: 'playlist_not_found' }, 404);
    await deletePodcastSourceArtifacts(episodes);
    return c.json({ playlistId: c.req.param('id'), episodes, count: episodes.length });
  } catch (error) {
    return c.json({ error: error?.message || 'playlist_delete_failed' }, episodeErrorStatus(error));
  }
});

routes.patch('/api/podcast/playlists/:id', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  try {
    const episodes = await renamePodcastPlaylist(c.req.param('id'), body.title || body.playlistTitle);
    if (!episodes.length) return c.json({ error: 'playlist_not_found' }, 404);
    return c.json({
      playlistId: c.req.param('id'),
      title: episodes[0]?.playlistTitle || '',
      episodes,
      count: episodes.length,
    });
  } catch (error) {
    return c.json({ error: error?.message || 'playlist_rename_failed' }, episodeErrorStatus(error));
  }
});

routes.post('/api/podcast/playlists/:id/reorder', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  try {
    const episodes = await reorderPodcastPlaylist(c.req.param('id'), body.episodeIds || body.episodes || body.order);
    if (!episodes.length) return c.json({ error: 'playlist_not_found' }, 404);
    return c.json({
      playlistId: c.req.param('id'),
      episodes,
      count: episodes.length,
    });
  } catch (error) {
    return c.json({ error: error?.message || 'playlist_reorder_failed' }, episodeErrorStatus(error));
  }
});

routes.post('/api/podcast/playlists/:id/refresh', async (c) => {
  try {
    const current = await listPodcastPlaylistEpisodes(c.req.param('id'));
    if (!current.length) return c.json({ error: 'playlist_not_found' }, 404);
    const existingIds = new Set(current.map((episode) => String(episode.id || '').trim()).filter(Boolean));
    const sourceUrl = current.find((episode) => episode.playlistSourceUrl)?.playlistSourceUrl || '';
    if (!sourceUrl) throw new Error('playlist_source_required');
    const first = current[0];
    const collectionImport = await importCollectionEpisodesFromUrl(sourceUrl, {
      playlist: {
        id: c.req.param('id'),
        title: first.playlistTitle || '',
        addedAt: first.playlistAddedAt || first.addedAt || '',
        sourceUrl,
      },
    });
    if (!collectionImport?.episodes?.length) throw new Error('playlist_source_required');
    const addedCount = collectionImport.episodes
      .filter((episode) => !existingIds.has(String(episode.id || '').trim()))
      .length;
    const importedIds = new Set(collectionImport.episodes.map((episode) => String(episode.id || '').trim()).filter(Boolean));
    const removedEpisodes = current.filter((episode) => !importedIds.has(String(episode.id || '').trim()));
    if (removedEpisodes.length) {
      await deletePodcastSourceArtifacts(removedEpisodes);
      for (const episode of removedEpisodes) {
        await deletePodcastEpisode(episode.id);
      }
    }
    return c.json({
      ...collectionImport,
      addedCount,
      removedCount: removedEpisodes.length,
      unchanged: addedCount === 0 && removedEpisodes.length === 0,
    });
  } catch (error) {
    return c.json({ error: error?.message || 'playlist_refresh_failed' }, episodeErrorStatus(error));
  }
});

routes.get('/api/podcast/listening', async (c) => {
  try {
    const episodes = await listPodcastListeningItems();
    return c.json({ episodes, count: episodes.length });
  } catch (error) {
    return c.json({ error: error?.message || 'listening_failed' }, 500);
  }
});

routes.post('/api/podcast/episodes/text', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  try {
    const article = articleFromPlainText({
      title: body.title,
      text: body.text,
      sourceName: 'Text',
    });
    if (!article.text || article.wordCount < 20) return c.json({ error: 'article_text_not_found' }, 422);
    const episode = await upsertPodcastEpisodeFromArticle(article, playlistOptionsFromBody(body));
    return c.json({ episode, article });
  } catch (error) {
    return c.json({ error: error?.message || 'episode_save_failed' }, episodeErrorStatus(error));
  }
});

routes.post('/api/podcast/episodes/url', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  try {
    const collectionImport = await importCollectionEpisodesFromUrl(body.url, body);
    if (collectionImport?.episodes?.length) return c.json(collectionImport);

    const article = await articleFromUrl(body.url);
    if (!article.text || article.wordCount < 20) return c.json({ error: 'article_text_not_found' }, 422);
    const episode = await upsertPodcastEpisodeFromArticle(article, playlistOptionsFromBody(body));
    return c.json({ episode, article });
  } catch (error) {
    return c.json({ error: error?.message || 'episode_url_failed' }, episodeErrorStatus(error));
  }
});

routes.post('/api/podcast/episodes/upload', async (c) => {
  let form;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'invalid_form_data' }, 400);
  }

  try {
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('file_required');
    const article = await articleFromUploadBuffer({
      filename: file.name || 'upload',
      mimeType: file.type || 'application/octet-stream',
      buffer: Buffer.from(await file.arrayBuffer()),
    });
    if (!article.text || article.wordCount < 20) return c.json({ error: 'article_text_not_found' }, 422);
    const episode = await upsertPodcastEpisodeFromArticle(article, playlistOptionsFromForm(form));
    return c.json({ episode, article });
  } catch (error) {
    return c.json({ error: error?.message || 'episode_upload_failed' }, episodeErrorStatus(error));
  }
});

routes.post('/api/podcast/render', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  try {
    const article = await articleForRender(body);
    if (!article.text || article.wordCount < 20) {
      return c.json({ error: 'article_text_not_found' }, 422);
    }
    const render = await renderPodcastAudio({
      article,
      provider: body.provider || DEFAULT_TTS_PROVIDER,
      model: body.model,
      voice: body.voice || defaultTtsVoiceForProvider(body.provider || DEFAULT_TTS_PROVIDER),
      instructions: body.instructions || DEFAULT_TTS_INSTRUCTIONS,
      scriptMode: body.scriptMode || DEFAULT_PODCAST_SCRIPT_MODE,
      scriptInstructions: body.scriptInstructions || '',
      scriptAgent: body.scriptAgent ?? DEFAULT_PODCAST_SCRIPT_AGENT,
      scriptAgentProvider: body.scriptAgentProvider || DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
      scriptAgentModel: body.scriptAgentModel || DEFAULT_PODCAST_SCRIPT_AGENT_MODEL,
    });
    return c.json({ render });
  } catch (error) {
    return c.json({ error: error?.message || 'render_failed' }, renderErrorStatus(error));
  }
});

routes.post('/api/podcast/render-jobs', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  try {
    const article = await articleForRender(body);
    if (!article.text || article.wordCount < 20) {
      return c.json({ error: 'article_text_not_found' }, 422);
    }
    const job = await createPodcastRenderJob({
      article,
      provider: body.provider || DEFAULT_TTS_PROVIDER,
      model: body.model,
      voice: body.voice || defaultTtsVoiceForProvider(body.provider || DEFAULT_TTS_PROVIDER),
      instructions: body.instructions || DEFAULT_TTS_INSTRUCTIONS,
      scriptMode: body.scriptMode || DEFAULT_PODCAST_SCRIPT_MODE,
      scriptInstructions: body.scriptInstructions || '',
      scriptAgent: body.scriptAgent ?? DEFAULT_PODCAST_SCRIPT_AGENT,
      scriptAgentProvider: body.scriptAgentProvider || DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
      scriptAgentModel: body.scriptAgentModel || DEFAULT_PODCAST_SCRIPT_AGENT_MODEL,
    });
    return c.json({ job }, job.status === 'ready' ? 200 : 202);
  } catch (error) {
    return c.json({ error: error?.message || 'render_job_failed' }, renderErrorStatus(error));
  }
});

routes.get('/api/podcast/render-jobs/:id', async (c) => {
  try {
    const job = await getPodcastRenderJob(c.req.param('id'));
    if (!job) return c.json({ error: 'job_not_found' }, 404);
    return c.json({ job });
  } catch (error) {
    const message = error?.message || 'job_status_failed';
    return c.json({ error: message }, message === 'invalid_job_id' ? 400 : 500);
  }
});

routes.post('/api/podcast/render-jobs/:id/repair', async (c) => {
  try {
    const job = await repairPodcastRenderJob(c.req.param('id'));
    if (!job) return c.json({ error: 'job_not_found' }, 404);
    return c.json({ job }, 202);
  } catch (error) {
    const message = error?.message || 'job_repair_failed';
    return c.json({ error: message }, message === 'invalid_job_id' ? 400 : renderErrorStatus(error));
  }
});

routes.delete('/api/podcast/render-jobs/:id', async (c) => {
  try {
    const job = await deletePodcastRenderJob(c.req.param('id'));
    if (!job) return c.json({ error: 'job_not_found' }, 404);
    return c.json({ job });
  } catch (error) {
    const message = error?.message || 'job_delete_failed';
    return c.json({ error: message }, message === 'invalid_job_id' ? 400 : 500);
  }
});

routes.get('/api/podcast/audio/:id/:file', async (c) => {
  try {
    const { stream, size, range } = await streamPodcastAudioChunk(c.req.param('id'), c.req.param('file'), {
      range: c.req.header('range') || '',
    });
    const headers = {
      'content-type': 'audio/mpeg',
      'accept-ranges': 'bytes',
      'content-length': String(range?.length || size),
      'cache-control': 'private, max-age=31536000, immutable',
    };
    if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${range.size}`;
    return new Response(Readable.toWeb(stream), {
      status: range ? 206 : 200,
      headers,
    });
  } catch (error) {
    const message = error?.message || 'audio_not_found';
    const status = error?.status || (message.startsWith('invalid_') ? 400 : 404);
    const headers = {
      'content-type': 'application/json',
      ...(error?.size ? {
        'content-range': `bytes */${error.size}`,
        'accept-ranges': 'bytes',
      } : {}),
    };
    return new Response(JSON.stringify({ error: message }), { status, headers });
  }
});

export default routes;
