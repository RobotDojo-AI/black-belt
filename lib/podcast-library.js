import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, extname, join, posix, resolve } from 'node:path';

import JSZip from 'jszip';
import { marked } from 'marked';

import { decodeHtmlEntities, extractArticleFromHtml } from './podcast.js';
import { USER_MEDIA_DIR } from './robotdojo-paths.js';

const LIBRARY_VERSION = 1;
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function libraryRoot(options = {}) {
  return resolve(options.mediaDir || USER_MEDIA_DIR, 'podcast', 'library');
}

function libraryPath(options = {}) {
  return join(libraryRoot(options), 'episodes.json');
}

function nowIso(now = () => new Date()) {
  return now().toISOString();
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitPlainText(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];
  const paragraphs = normalized
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : [normalized.replace(/\s+/g, ' ')];
}

function estimateMinutes(wordCount) {
  return wordCount ? Math.max(1, Math.round(wordCount / 165)) : 0;
}

function sanitizeName(value) {
  return basename(String(value || 'upload'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\w .@()+,=\-]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'upload';
}

function titleFromFilename(filename) {
  return sanitizeName(filename).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';
}

function uploadedHtmlUrl(name) {
  return `https://upload.robotdojo.local/${encodeURIComponent(name)}`;
}

function articleFromHtmlUpload({ name, html, fallbackTitle = '' } = {}) {
  const article = extractArticleFromHtml(html, uploadedHtmlUrl(name || 'upload.html'));
  return {
    ...article,
    title: article.title === basename(article.url || '') && fallbackTitle ? fallbackTitle : article.title,
    url: '',
    sourceName: name,
  };
}

export function articleFromPlainText({
  title,
  text,
  sourceName = 'Text',
  url = '',
} = {}) {
  const paragraphs = splitPlainText(text);
  const body = paragraphs.join('\n\n');
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  return {
    title: String(title || '').trim() || paragraphs[0]?.slice(0, 80) || 'Untitled',
    url: String(url || '').trim(),
    sourceName: String(sourceName || '').trim() || 'Text',
    paragraphs,
    text: body,
    wordCount,
    charCount: body.length,
    estimatedMinutes: estimateMinutes(wordCount),
    extractedAt: nowIso(),
  };
}

function articleId(article) {
  return sha256(JSON.stringify({
    version: LIBRARY_VERSION,
    title: article.title || '',
    url: article.url || '',
    sourceName: article.sourceName || '',
    textHash: sha256(article.text || ''),
  })).slice(0, 32);
}

function episodeFromArticle(article, options = {}) {
  const id = options.id || articleId(article);
  const playlist = playlistFields(options);
  return {
    id,
    key: `lib-${id}`,
    type: 'custom',
    title: article.title,
    url: article.url || '',
    sourceName: article.sourceName || 'Text',
    wordCount: article.wordCount || 0,
    charCount: article.charCount || 0,
    estimatedMinutes: article.estimatedMinutes || estimateMinutes(article.wordCount || 0),
    addedAt: options.addedAt || nowIso(options.now),
    ...playlist,
    article: {
      ...article,
      id,
    },
  };
}

function playlistFields(options = {}) {
  const playlistId = String(options.playlistId || '').trim();
  if (!playlistId) return {};

  const fields = {
    playlistId,
    playlistAddedAt: validIso(options.playlistAddedAt) || nowIso(options.now),
  };
  const title = String(options.playlistTitle || '').trim();
  const sourceUrl = String(options.playlistSourceUrl || options.sourceUrl || '').trim();
  const index = Number(options.playlistIndex);
  const total = Number(options.playlistTotal);
  if (title) fields.playlistTitle = title;
  if (sourceUrl) fields.playlistSourceUrl = sourceUrl;
  if (Number.isFinite(index) && index >= 0) fields.playlistIndex = Math.floor(index);
  if (Number.isFinite(total) && total > 0) fields.playlistTotal = Math.floor(total);
  return fields;
}

function validIso(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

export function publicEpisode(episode) {
  if (!episode) return null;
  const { article, ...safe } = episode;
  return safe;
}

async function readLibrary(options = {}) {
  try {
    const parsed = JSON.parse(await readFile(libraryPath(options), 'utf8'));
    return {
      version: LIBRARY_VERSION,
      episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: LIBRARY_VERSION, episodes: [] };
    throw error;
  }
}

async function writeLibrary(library, options = {}) {
  const path = libraryPath(options);
  await mkdir(libraryRoot(options), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(library, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function listPodcastEpisodes(options = {}) {
  const library = await readLibrary(options);
  return library.episodes
    .slice()
    .sort(comparePodcastEpisodes)
    .map(publicEpisode);
}

function sortTime(episode) {
  return Date.parse(episode.playlistAddedAt || episode.addedAt || '') || 0;
}

function playlistIndex(episode) {
  const index = Number(episode.playlistIndex);
  return Number.isFinite(index) && index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function comparePodcastEpisodes(a, b) {
  const timeDiff = sortTime(b) - sortTime(a);
  if (timeDiff !== 0) return timeDiff;
  if (a.playlistId && a.playlistId === b.playlistId) {
    const indexDiff = playlistIndex(a) - playlistIndex(b);
    if (indexDiff !== 0) return indexDiff;
  }
  return String(b.addedAt || '').localeCompare(String(a.addedAt || ''))
    || String(a.title || '').localeCompare(String(b.title || ''));
}

export async function getPodcastEpisodeArticle(idOrKey, options = {}) {
  const id = String(idOrKey || '').replace(/^lib-/, '');
  const library = await readLibrary(options);
  const episode = library.episodes.find((candidate) => candidate.id === id || candidate.key === idOrKey);
  return episode?.article || null;
}

export async function upsertPodcastEpisodeFromArticle(article, options = {}) {
  if (!article?.text || (article.wordCount || 0) < 1) throw new Error('article_text_required');
  const episode = episodeFromArticle(article, options);
  const library = await readLibrary(options);
  const existingIndex = library.episodes.findIndex((candidate) => candidate.id === episode.id);
  if (existingIndex >= 0) {
    const existing = library.episodes[existingIndex];
    library.episodes[existingIndex] = {
      ...episode,
      addedAt: existing.addedAt || episode.addedAt,
    };
  } else {
    library.episodes.unshift(episode);
  }
  await writeLibrary(library, options);
  return publicEpisode(library.episodes.find((candidate) => candidate.id === episode.id));
}

export async function deletePodcastEpisode(idOrKey, options = {}) {
  const id = String(idOrKey || '').replace(/^lib-/, '');
  if (!id) return null;
  const library = await readLibrary(options);
  const index = library.episodes.findIndex((candidate) => candidate.id === id || candidate.key === idOrKey);
  if (index < 0) return null;
  const [removed] = library.episodes.splice(index, 1);
  await writeLibrary(library, options);
  return publicEpisode(removed);
}

export async function deletePodcastPlaylist(playlistId, options = {}) {
  const id = String(playlistId || '').trim();
  if (!id) return [];
  const library = await readLibrary(options);
  const removed = [];
  const kept = [];
  for (const episode of library.episodes) {
    if (String(episode.playlistId || '') === id) removed.push(episode);
    else kept.push(episode);
  }
  if (!removed.length) return [];
  await writeLibrary({ ...library, episodes: kept }, options);
  return removed.map(publicEpisode);
}

export async function listPodcastPlaylistEpisodes(playlistId, options = {}) {
  const id = String(playlistId || '').trim();
  if (!id) return [];
  const library = await readLibrary(options);
  return library.episodes
    .filter((episode) => String(episode.playlistId || '') === id)
    .sort(comparePodcastEpisodes)
    .map(publicEpisode);
}

export async function renamePodcastPlaylist(playlistId, title, options = {}) {
  const id = String(playlistId || '').trim();
  const nextTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!id) return [];
  if (!nextTitle) throw new Error('playlist_title_required');

  const library = await readLibrary(options);
  let changed = false;
  const episodes = library.episodes.map((episode) => {
    if (String(episode.playlistId || '') !== id) return episode;
    changed = true;
    return {
      ...episode,
      playlistTitle: nextTitle,
    };
  });

  if (!changed) return [];
  await writeLibrary({ ...library, episodes }, options);
  return episodes
    .filter((episode) => String(episode.playlistId || '') === id)
    .sort(comparePodcastEpisodes)
    .map(publicEpisode);
}

export async function reorderPodcastPlaylist(playlistId, episodeIds = [], options = {}) {
  const id = String(playlistId || '').trim();
  const requestedIds = (Array.isArray(episodeIds) ? episodeIds : [])
    .map((episodeId) => String(episodeId || '').replace(/^lib-/, '').trim())
    .filter(Boolean);
  if (!id) return [];
  if (!requestedIds.length) throw new Error('playlist_order_required');

  const library = await readLibrary(options);
  const current = library.episodes
    .filter((episode) => String(episode.playlistId || '') === id)
    .sort(comparePodcastEpisodes);
  if (!current.length) return [];

  const playlistIds = new Set(current.map((episode) => episode.id));
  const orderedIds = [];
  const seen = new Set();
  for (const episodeId of requestedIds) {
    if (!playlistIds.has(episodeId) || seen.has(episodeId)) continue;
    orderedIds.push(episodeId);
    seen.add(episodeId);
  }
  if (!orderedIds.length) throw new Error('playlist_order_required');

  for (const episode of current) {
    if (!seen.has(episode.id)) orderedIds.push(episode.id);
  }
  const indexById = new Map(orderedIds.map((episodeId, index) => [episodeId, index]));
  const total = current.length;
  const episodes = library.episodes.map((episode) => {
    if (String(episode.playlistId || '') !== id) return episode;
    return {
      ...episode,
      playlistIndex: indexById.get(episode.id),
      playlistTotal: total,
    };
  });

  await writeLibrary({ ...library, episodes }, options);
  return episodes
    .filter((episode) => String(episode.playlistId || '') === id)
    .sort(comparePodcastEpisodes)
    .map(publicEpisode);
}

async function extractPdfText(buffer) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocxText(buffer) {
  const { default: mammoth } = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
}

function xmlAttribute(fragment, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(fragment || '').match(new RegExp(`\\b${escaped}\\s*=\\s*([\"'])(.*?)\\1`, 'i'));
  return match?.[2] ? decodeHtmlEntities(match[2]).trim() : '';
}

function stripXmlToText(xml) {
  return decodeHtmlEntities(String(xml || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function zipPath(basePath, href) {
  const raw = String(href || '').split('#')[0].split('?')[0];
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {}
  return posix.normalize(posix.join(posix.dirname(basePath), decoded)).replace(/^\/+/, '');
}

async function readZipText(zip, path) {
  const file = zip.file(path);
  return file ? file.async('string') : '';
}

async function epubPackagePath(zip) {
  const container = await readZipText(zip, 'META-INF/container.xml');
  const rootfile = container.match(/<rootfile\b[^>]*>/i)?.[0] || '';
  const fullPath = xmlAttribute(rootfile, 'full-path');
  if (fullPath && zip.file(fullPath)) return fullPath;
  const opf = Object.keys(zip.files).find((path) => path.toLowerCase().endsWith('.opf'));
  if (opf) return opf;
  throw new Error('epub_package_not_found');
}

function epubTitle(opf, fallbackTitle) {
  const match = String(opf || '').match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)
    || String(opf || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return stripXmlToText(match?.[1] || '') || fallbackTitle;
}

function parseEpubManifest(opf, opfPath) {
  const manifest = new Map();
  for (const match of String(opf || '').matchAll(/<item\b[^>]*>/gi)) {
    const tag = match[0];
    const id = xmlAttribute(tag, 'id');
    const href = xmlAttribute(tag, 'href');
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      path: zipPath(opfPath, href),
      mediaType: xmlAttribute(tag, 'media-type'),
      properties: xmlAttribute(tag, 'properties'),
    });
  }

  const spine = [];
  for (const match of String(opf || '').matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = xmlAttribute(match[0], 'idref');
    if (idref && manifest.has(idref)) spine.push(manifest.get(idref));
  }
  return {
    manifest,
    spine,
  };
}

function isReadableEpubItem(item) {
  if (!item) return false;
  const type = String(item.mediaType || '').toLowerCase();
  const path = String(item.path || '').toLowerCase();
  const properties = String(item.properties || '').toLowerCase();
  if (properties.split(/\s+/).includes('nav')) return false;
  return type.includes('xhtml') || type.includes('html') || path.endsWith('.xhtml') || path.endsWith('.html') || path.endsWith('.htm');
}

async function extractEpubArticle(buffer, name) {
  const zip = await JSZip.loadAsync(buffer);
  const opfPath = await epubPackagePath(zip);
  const opf = await readZipText(zip, opfPath);
  const fallbackTitle = titleFromFilename(name);
  const title = epubTitle(opf, fallbackTitle);
  const { manifest, spine } = parseEpubManifest(opf, opfPath);
  const orderedItems = (spine.length ? spine : [...manifest.values()])
    .filter(isReadableEpubItem);
  if (!orderedItems.length) throw new Error('epub_text_not_found');

  const paragraphs = [];
  const seenPaths = new Set();
  for (const item of orderedItems) {
    if (seenPaths.has(item.path)) continue;
    seenPaths.add(item.path);
    const html = await readZipText(zip, item.path);
    if (!html) continue;
    const article = extractArticleFromHtml(html, uploadedHtmlUrl(`${name}/${item.path}`));
    const itemParagraphs = article.paragraphs.length ? article.paragraphs : splitPlainText(stripXmlToText(html));
    if (article.title && article.title !== title && article.title !== basename(item.path)) {
      paragraphs.push(article.title);
    }
    paragraphs.push(...itemParagraphs);
  }

  return articleFromPlainText({
    title,
    text: paragraphs.join('\n\n'),
    sourceName: name,
  });
}

export async function articleFromUploadBuffer({
  filename,
  mimeType = '',
  buffer,
} = {}, options = {}) {
  const name = sanitizeName(filename);
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const maxBytes = options.maxBytes || DEFAULT_MAX_UPLOAD_BYTES;
  if (!data.length) throw new Error('file_empty');
  if (data.byteLength > maxBytes) throw new Error('file_too_large');

  const ext = extname(name).toLowerCase();
  const type = String(mimeType || '').toLowerCase();
  if (ext === '.pdf' || type === 'application/pdf') {
    const text = await extractPdfText(data);
    return articleFromPlainText({ title: titleFromFilename(name), text, sourceName: name });
  }
  if (ext === '.docx' || type.includes('wordprocessingml.document')) {
    const text = await extractDocxText(data);
    return articleFromPlainText({ title: titleFromFilename(name), text, sourceName: name });
  }
  if (ext === '.epub' || type === 'application/epub+zip') {
    return extractEpubArticle(data, name);
  }
  if (ext === '.html' || ext === '.htm' || type.includes('html')) {
    const html = data.toString('utf8');
    return articleFromHtmlUpload({ name, html, fallbackTitle: titleFromFilename(name) });
  }
  if (ext === '.md' || ext === '.markdown' || type === 'text/markdown') {
    const html = marked.parse(data.toString('utf8'), { async: false });
    return articleFromHtmlUpload({ name, html, fallbackTitle: titleFromFilename(name) });
  }
  if (['.txt', '.csv'].includes(ext) || type.startsWith('text/')) {
    return articleFromPlainText({ title: titleFromFilename(name), text: data.toString('utf8'), sourceName: name });
  }
  throw new Error('unsupported_file_type');
}
