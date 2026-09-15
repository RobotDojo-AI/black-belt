/**
 * link-corpus.js — generic "fetch a linked corpus → ordered articles".
 *
 * Compute tier: Tier 0 (local, deterministic — HTTP fetch, HTML parse,
 * readability extraction). No LLM anywhere; nothing here writes a DB row.
 *
 * The input machinery for the podcast player and the book engine lives here.
 * It was extracted verbatim from routes/podcast.js (thin-facade fix, st_64d7e5ff
 * P1) and generalized past the Paul-Graham special case:
 *
 *   - fetch / SSRF-guard / cache / discover / articleFromUrl move here unchanged
 *     in behavior; routes/podcast.js now imports them.
 *   - Caching is OPT-IN per call. `fetchTextUrl` previously cached only when the
 *     URL was paulgraham.com; that gate is PRESERVED so podcast behavior is
 *     byte-for-byte identical, and a `cache:true` option additionally enables
 *     caching for any host (the book engine passes it so an arbitrary corpus is
 *     fetched once and reused). SSRF guard + TTL are untouched.
 *   - extractCorpusArticle + resolveCorpus are new — the book engine's ordered
 *     Article[] entry. For paulgraham.com, extractCorpusArticle re-carves the
 *     body with a corrected terminal boundary (the podcast extractor cuts at the
 *     first <hr>, truncating essays that use an internal <hr> as a section
 *     break) and strips the YC banner + "If you liked this" promo. Every other
 *     source flows through the generic readability extractor unchanged.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  decodeHtmlEntities,
  extractArticleFromHtml,
  parsePaulGrahamIndex,
} from './podcast.js';
import { articleFromUploadBuffer } from './podcast-library.js';
import { USER_MEDIA_DIR } from './robotdojo-paths.js';

const MAX_ARTICLE_BYTES = 2 * 1024 * 1024;
const MAX_URL_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FEED_ITEMS = optionalPositiveInteger(process.env.ROBOTDOJO_PODCAST_MAX_FEED_ITEMS);
const MAX_INDEX_ITEMS = optionalPositiveInteger(process.env.ROBOTDOJO_PODCAST_MAX_INDEX_ITEMS);
const MAX_AUTHOR_INDEX_ITEMS = optionalPositiveInteger(process.env.ROBOTDOJO_PODCAST_MAX_AUTHOR_INDEX_ITEMS) || MAX_INDEX_ITEMS;
const SOURCE_CACHE_MS = Number(process.env.ROBOTDOJO_PODCAST_SOURCE_CACHE_MS || 7 * 24 * 60 * 60 * 1000);
const URL_FETCH_TIMEOUT_MS = Number(process.env.ROBOTDOJO_PODCAST_FETCH_TIMEOUT_MS || 8_000);
const A16Z_ALGOLIA_APP_ID = 'WSGRH40UZZ';
const A16Z_ALGOLIA_SEARCH_KEY = 'be4c2008dbb90c57dc09a716a759777d';
const A16Z_LOCALIZED_PATH_PREFIXES = new Set([
  'ar', 'de', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl',
  'pl', 'pt', 'ru', 'sv', 'tr', 'vi', 'zh',
]);

const DOCUMENT_URL_EXTENSIONS = ['.pdf', '.docx', '.epub', '.md', '.markdown'];
const COLLECTION_URL_SEGMENTS = new Set([
  'archive', 'archives', 'article', 'articles', 'blog', 'essay', 'essays',
  'newsletter', 'newsletters', 'post', 'posts', 'rss', 'writing', 'writings',
]);
const INDEX_LINK_SKIP_LABELS = new Set([
  'about', 'archive', 'archives', 'articles', 'blog', 'books', 'contact',
  'feed', 'home', 'index', 'login', 'newer', 'newest', 'next', 'older',
  'oldest', 'previous', 'privacy', 'rss', 'subscribe', 'tags',
]);
const INDEX_LINK_SKIP_PATH_SEGMENTS = new Set([
  'about', 'archive', 'archives', 'author', 'authors', 'category',
  'categories', 'feed', 'login', 'privacy', 'rss', 'subscribe', 'tag', 'tags',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function optionalPositiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function reachedOptionalLimit(count, limit) {
  return Number.isFinite(limit) && count >= limit;
}

function limitItems(items, limit) {
  return Number.isFinite(limit) ? items.slice(0, Math.max(1, limit)) : items;
}

export function sourceCacheRoot() {
  return resolve(USER_MEDIA_DIR, 'podcast', 'source-cache');
}

export function sourceCachePath(url) {
  return join(sourceCacheRoot(), `${sha256(url)}.json`);
}

export function isPaulGrahamUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '').toLowerCase() === 'paulgraham.com';
  } catch {
    return false;
  }
}

async function writeAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

async function readSourceCache(url, { maxAgeMs = SOURCE_CACHE_MS } = {}) {
  try {
    const cached = JSON.parse(await readFile(sourceCachePath(url), 'utf8'));
    if (!cached?.text || !cached?.finalUrl || !cached?.fetchedAt) return null;
    const age = Date.now() - Date.parse(cached.fetchedAt);
    if (maxAgeMs !== Infinity && (!Number.isFinite(age) || age > maxAgeMs)) return null;
    return {
      text: String(cached.text),
      finalUrl: String(cached.finalUrl),
      cached: true,
      fetchedAt: cached.fetchedAt,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

async function writeSourceCache(url, payload) {
  if (!payload?.text || !payload?.finalUrl) return;
  await writeAtomic(sourceCachePath(url), `${JSON.stringify({
    url,
    finalUrl: payload.finalUrl,
    text: payload.text,
    fetchedAt: new Date().toISOString(),
  })}\n`);
}

function fetchTimeoutError() {
  return new Error('fetch_timeout');
}

async function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw fetchTimeoutError();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(fetchTimeoutError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function isPrivateIp(address) {
  const value = String(address || '').toLowerCase();
  if (!value) return true;
  if (value.includes(':')) {
    return value === '::1'
      || value === '::'
      || value.startsWith('fc')
      || value.startsWith('fd')
      || value.startsWith('fe80:');
  }
  const parts = value.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

export async function assertUrlAllowed(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('invalid_url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid_protocol');

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname === 'metadata.google.internal'
  ) {
    throw new Error('blocked_private_host');
  }

  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('blocked_private_host');
    return parsed;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('host_lookup_failed');
  }
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('blocked_private_host');
  }

  return parsed;
}

async function readTextLimited(res, signal) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_ARTICLE_BYTES) throw new Error('response_too_large');

  const reader = res.body?.getReader?.();
  if (!reader) return (await withAbort(res.text(), signal)).slice(0, MAX_ARTICLE_BYTES);

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await withAbort(reader.read(), signal);
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ARTICLE_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new Error('response_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBufferLimited(res, signal, maxBytes = MAX_URL_FILE_BYTES) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('file_too_large');

  const reader = res.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await withAbort(res.arrayBuffer(), signal));
    if (buffer.byteLength > maxBytes) throw new Error('file_too_large');
    return buffer;
  }

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await withAbort(reader.read(), signal);
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error('file_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function hasDocumentUrlExtension(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return DOCUMENT_URL_EXTENSIONS.some((extension) => pathname.endsWith(extension));
  } catch {
    return false;
  }
}

export function filenameFromUrl(url, contentType = '') {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'article';
  }

  const raw = parsed.pathname.split('/').filter(Boolean).pop() || '';
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {}

  if (/\.[a-z0-9]+$/i.test(name)) return name;

  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const extension = type === 'application/pdf'
    ? '.pdf'
    : type === 'application/epub+zip'
      ? '.epub'
      : type.includes('wordprocessingml.document')
        ? '.docx'
        : type === 'text/markdown'
          ? '.md'
          : '';
  return `${name || parsed.hostname || 'article'}${extension}`;
}

export function isLikelyCollectionUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => part.toLowerCase().replace(/\.(?:html?|php|aspx?)$/i, ''));
    if (parts.length === 0) return true;
    const last = parts[parts.length - 1] || '';
    const previous = parts[parts.length - 2] || '';
    if (parts.includes('author') || parts.includes('authors')) return true;
    if (COLLECTION_URL_SEGMENTS.has(last)) return true;
    if (/^(?:page-?)?\d+$/i.test(last) && (COLLECTION_URL_SEGMENTS.has(previous) || previous === 'page')) return true;
    return parts.some((part) => ['archive', 'archives'].includes(part));
  } catch {
    return false;
  }
}

async function fetchTextUrlLive(initialUrl, maxRedirects = 4, { timeoutMs = URL_FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  let current = initialUrl;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const parsed = await assertUrlAllowed(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(parsed.href, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,text/plain;q=0.9,*/*;q=0.4',
          'User-Agent': 'RobotDojoPodcast/1.0',
        },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) throw new Error('invalid_redirect');
        current = new URL(location, parsed.href).href;
        continue;
      }

      if (!res.ok) throw new Error(`fetch_failed_${res.status}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType && hasDocumentUrlExtension(parsed.href)) {
        throw new Error('unsupported_content_type');
      }
      if (contentType && !/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
        throw new Error('unsupported_content_type');
      }

      return { text: await readTextLimited(res, controller.signal), finalUrl: parsed.href };
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) throw fetchTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('too_many_redirects');
}

export async function fetchFileUrlLive(initialUrl, maxRedirects = 4, { timeoutMs = URL_FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  let current = initialUrl;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const parsed = await assertUrlAllowed(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(parsed.href, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: [
            'application/pdf',
            'application/epub+zip',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/markdown;q=0.9',
            'text/plain;q=0.8',
            'text/html;q=0.8',
            '*/*;q=0.3',
          ].join(','),
          'User-Agent': 'RobotDojoPodcast/1.0',
        },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) throw new Error('invalid_redirect');
        current = new URL(location, parsed.href).href;
        continue;
      }

      if (!res.ok) throw new Error(`fetch_failed_${res.status}`);
      const contentType = res.headers.get('content-type') || '';
      const buffer = await readBufferLimited(res, controller.signal);
      return { buffer, finalUrl: parsed.href, contentType };
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) throw fetchTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('too_many_redirects');
}

export async function fetchFeedUrlLive(initialUrl, maxRedirects = 4, { timeoutMs = URL_FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  let current = initialUrl;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const parsed = await assertUrlAllowed(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(parsed.href, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/rss+xml,application/atom+xml,application/feed+json;q=0.7,application/xml;q=0.6,text/xml;q=0.6,*/*;q=0.2',
          'User-Agent': 'RobotDojoPodcast/1.0',
        },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) throw new Error('invalid_redirect');
        current = new URL(location, parsed.href).href;
        continue;
      }

      if (!res.ok) throw new Error(`fetch_failed_${res.status}`);
      const contentType = res.headers.get('content-type') || '';
      if (contentType && !/rss|atom|xml|json|text\/plain/i.test(contentType)) {
        throw new Error('unsupported_content_type');
      }
      return { text: await readTextLimited(res, controller.signal), finalUrl: parsed.href, contentType };
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) throw fetchTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('too_many_redirects');
}

/**
 * Fetch a text/html URL, optionally caching to the shared source-cache.
 *
 * Caching is OPT-IN per call, preserving the pre-extraction podcast behavior:
 *   - default (no cache option): cache only paulgraham.com, exactly as before.
 *   - cache:true: cache ANY host (the book engine passes this so an arbitrary
 *     corpus is fetched once and reused; cache growth is bounded by the finite
 *     corpus per build).
 *   - cache:false: never cache (the podcast index/discovery probes pass this so
 *     a16z/generic imports stay always-live).
 * The cache key is sha256(url) under {media}/podcast/source-cache — back-compat
 * with the 232 cached PG files. SSRF guard + TTL are unchanged.
 */
export async function fetchTextUrl(initialUrl, maxRedirects = 4, options = {}) {
  const parsed = await assertUrlAllowed(initialUrl);
  const cacheable = options.cache === true
    || (options.cache !== false && isPaulGrahamUrl(parsed.href));
  if (cacheable) {
    const cached = await readSourceCache(parsed.href, { maxAgeMs: options.cacheMaxAgeMs ?? SOURCE_CACHE_MS });
    if (cached) return cached;
  }

  try {
    const payload = await fetchTextUrlLive(parsed.href, maxRedirects, options);
    if (cacheable) {
      await writeSourceCache(parsed.href, payload).catch(() => {});
      if (payload.finalUrl !== parsed.href) await writeSourceCache(payload.finalUrl, payload).catch(() => {});
    }
    return payload;
  } catch (error) {
    if (cacheable) {
      const stale = await readSourceCache(parsed.href, { maxAgeMs: Infinity });
      if (stale) return { ...stale, stale: true };
    }
    throw error;
  }
}

function xmlBlocks(xml, tagName) {
  const safeTag = String(tagName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${safeTag}\\b[^>]*>([\\s\\S]*?)<\\/${safeTag}>`, 'gi');
  return [...String(xml || '').matchAll(re)].map((match) => match[1]);
}

function xmlTagText(fragment, tagName) {
  const safeTag = String(tagName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${safeTag}\\b[^>]*>([\\s\\S]*?)<\\/${safeTag}>`, 'i');
  const match = String(fragment || '').match(re);
  if (!match?.[1]) return '';
  return decodeHtmlEntities(match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function xmlAttr(tag, name) {
  const safeName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag || '').match(new RegExp(`\\b${safeName}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match?.[2] ? decodeHtmlEntities(match[2]).trim() : '';
}

function htmlAttr(tag, name) {
  const safeName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag || '').match(new RegExp(`\\b${safeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
  return value ? decodeHtmlEntities(value).trim() : '';
}

function stripHtmlText(value = '') {
  return decodeHtmlEntities(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function htmlDocumentTitle(html, pageUrl) {
  const raw = String(html || '');
  const og = raw.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || raw.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i);
  if (og?.[1]) return decodeHtmlEntities(og[1]).trim();
  const h1 = raw.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) return stripHtmlText(h1[1]);
  const title = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) return stripHtmlText(title[1]);
  try {
    return new URL(pageUrl).hostname;
  } catch {
    return 'Imported articles';
  }
}

export function authorArchivePlaylistTitle(html, pageUrl) {
  try {
    const parsed = new URL(pageUrl);
    const parts = parsed.pathname.split('/').filter(Boolean).map((part) => part.toLowerCase());
    if (!parts.includes('author') && !parts.includes('authors')) return '';
  } catch {
    return '';
  }

  const h1 = String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1?.[1] ? stripHtmlText(h1[1]).replace(/\s+/g, ' ').trim() : '';
  return title ? `${title} Articles` : '';
}

function normalizedHostname(urlOrHostname = '') {
  try {
    return new URL(urlOrHostname).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(urlOrHostname || '').replace(/^www\./, '').toLowerCase();
  }
}

export function isA16zAuthorPage(pageUrl) {
  try {
    const parsed = new URL(pageUrl);
    const parts = parsed.pathname.split('/').filter(Boolean).map((part) => part.toLowerCase());
    return normalizedHostname(parsed.hostname) === 'a16z.com'
      && (parts.includes('author') || parts.includes('authors'));
  } catch {
    return false;
  }
}

function a16zSearchIndexFromHtml(html) {
  const raw = String(html || '');
  const match = raw.match(/window\.search_index\s*=\s*(['"])([^'"]+)\1/i)
    || raw.match(/\bsearch_index\b[^'"]*(['"])(a16z_posts[^'"]*)\1/i);
  return match?.[2] || 'a16z_posts_v2';
}

function a16zAuthorSlugFromHtml(html, pageUrl) {
  const raw = String(html || '');
  const component = raw.match(/<[^>]+data-feed-component=(["'])author\1[^>]*>/i)?.[0] || '';
  const fromComponent = htmlAttr(component, 'data-author');
  if (fromComponent) return fromComponent;
  try {
    const parsed = new URL(pageUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const authorIndex = parts.findIndex((part) => part.toLowerCase() === 'author' || part.toLowerCase() === 'authors');
    return authorIndex >= 0 ? String(parts[authorIndex + 1] || '').trim() : '';
  } catch {
    return '';
  }
}

function shouldKeepA16zAuthorHit(hit = {}) {
  if (String(hit.type || '').toLowerCase() !== 'article') return false;
  if (hit.is_hidden === true || hit.hide_from_search_results === true) return false;
  const title = stripHtmlText(hit.title_custom || hit.title || '');
  if (!title || /^video:/i.test(title)) return false;

  let parsed;
  try {
    parsed = new URL(String(hit.url || ''), 'https://a16z.com');
  } catch {
    return false;
  }
  if (normalizedHostname(parsed.hostname) !== 'a16z.com') return false;
  parsed.hash = '';
  parsed.search = '';
  if (isA16zLocalizedPath(parsed.pathname)) return false;
  if (!isWrittenArticlePath(parsed.pathname)) return false;
  return true;
}

function isA16zLocalizedPath(pathname = '') {
  const first = String(pathname || '').split('/').filter(Boolean)[0]?.toLowerCase() || '';
  return A16Z_LOCALIZED_PATH_PREFIXES.has(first);
}

async function fetchA16zAuthorArticleHits(html, pageUrl, { fetchImpl = globalThis.fetch } = {}) {
  const authorSlug = a16zAuthorSlugFromHtml(html, pageUrl);
  if (!authorSlug) return [];
  const indexName = a16zSearchIndexFromHtml(html);
  const hits = [];
  const maxItems = MAX_AUTHOR_INDEX_ITEMS;
  let page = 0;
  let nbPages = 1;

  while (page < nbPages && !reachedOptionalLimit(hits.length, maxItems)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
    let res;
    const remaining = Number.isFinite(maxItems) ? Math.max(1, maxItems - hits.length) : 100;
    try {
      res = await fetchImpl(`https://${A16Z_ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-algolia-api-key': A16Z_ALGOLIA_SEARCH_KEY,
          'x-algolia-application-id': A16Z_ALGOLIA_APP_ID,
        },
        body: JSON.stringify({
          query: '',
          page,
          hitsPerPage: Math.min(100, remaining),
          facetFilters: [
            `author_slug:${authorSlug}`,
            'type:Article',
            'is_hidden:false',
          ],
          attributesToRetrieve: [
            'author', 'author_slug', 'date', 'date_timestamp',
            'hide_from_search_results', 'is_hidden', 'title',
            'title_custom', 'type', 'url',
          ],
        }),
      });
      if (!res.ok) throw new Error(`algolia_fetch_failed_${res.status}`);
      const data = await withAbort(res.json(), controller.signal);
      nbPages = Math.max(1, Number(data.nbPages || 1));
      hits.push(...(Array.isArray(data.hits) ? data.hits : []));
      page += 1;
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) throw fetchTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return limitItems(hits, maxItems);
}

async function discoverA16zAuthorArticleLinks(html, pageUrl) {
  if (!isA16zAuthorPage(pageUrl)) return [];
  const hits = await fetchA16zAuthorArticleHits(html, pageUrl);
  const links = [];
  const seen = new Set();
  for (const hit of hits) {
    if (!shouldKeepA16zAuthorHit(hit)) continue;
    const parsed = new URL(String(hit.url || ''), 'https://a16z.com');
    parsed.hash = '';
    parsed.search = '';
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    links.push({
      title: stripHtmlText(hit.title_custom || hit.title || ''),
      url: parsed.href,
      publishedAt: hit.date_timestamp
        ? new Date(Number(hit.date_timestamp) * 1000).toISOString()
        : String(hit.date || ''),
    });
    if (reachedOptionalLimit(links.length, MAX_AUTHOR_INDEX_ITEMS)) break;
  }

  const ordered = links
    .slice()
    .sort((a, b) => Date.parse(a.publishedAt || '') - Date.parse(b.publishedAt || ''));
  return ordered.map((link, index, all) => ({
    ...link,
    sequence: index + 1,
    total: all.length,
  }));
}

export function discoverFeedUrlsFromHtml(html, pageUrl) {
  const urls = [];
  const seen = new Set();
  const raw = String(html || '');
  for (const match of raw.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = htmlAttr(tag, 'rel').toLowerCase();
    const type = htmlAttr(tag, 'type').toLowerCase();
    const href = htmlAttr(tag, 'href');
    if (!href || !rel.split(/\s+/).includes('alternate')) continue;
    if (!/(?:rss|atom|feed|xml)/i.test(type) && !/(?:rss|atom|feed)\b|\.xml(?:[?#]|$)/i.test(href)) continue;
    try {
      const resolved = new URL(href, pageUrl).href;
      if (!seen.has(resolved)) {
        seen.add(resolved);
        urls.push(resolved);
      }
    } catch {}
  }
  return urls;
}

function shouldKeepIndexArticleLink(candidate, page, label) {
  if (!['http:', 'https:'].includes(candidate.protocol)) return false;
  if (candidate.hostname.replace(/^www\./, '').toLowerCase() !== page.hostname.replace(/^www\./, '').toLowerCase()) return false;

  candidate.hash = '';
  candidate.search = '';
  if (candidate.href === page.href) return false;
  if (normalizedHostname(page.hostname) === 'a16z.com' && isA16zLocalizedPath(candidate.pathname)) return false;

  const cleanLabel = String(label || '').replace(/\s+/g, ' ').trim();
  if (!cleanLabel || cleanLabel.length < 3) return false;
  if (INDEX_LINK_SKIP_LABELS.has(cleanLabel.toLowerCase())) return false;

  const path = candidate.pathname.toLowerCase();
  if (/\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|mjs|mp3|mp4|mov|zip|gz|tar)$/i.test(path)) return false;
  const parts = path.split('/').filter(Boolean).map((part) => part.replace(/\.(?:html?|php|aspx?)$/i, ''));
  if (!parts.length) return false;
  if (parts.some((part) => INDEX_LINK_SKIP_PATH_SEGMENTS.has(part))) return false;
  if (parts.length === 1 && INDEX_LINK_SKIP_LABELS.has(parts[0])) return false;

  return true;
}

function feedItemBlocksFromHtml(html) {
  const raw = String(html || '');
  const authorIndex = raw.indexOf('data-feed-component="author"');
  if (authorIndex < 0) return [];
  const source = authorIndex >= 0 ? raw.slice(authorIndex) : raw;
  return [...source.matchAll(/<div\b[^>]*data-feed-item[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi)]
    .map((match) => match[0]);
}

function hasAudioOrAnnouncementIcon(block) {
  return [...String(block || '').matchAll(/<i\b[^>]*class=(["'])(.*?)\1/gi)]
    .some((match) => /icon-headphone|icon-speaker/i.test(match[2] || ''));
}

function isWrittenArticlePath(pathname) {
  const path = String(pathname || '').toLowerCase();
  if (!path || path === '/') return false;
  if (/\/(?:podcast|announcement)(?:\/|$)/.test(path)) return false;
  return true;
}

export function discoverAuthorWrittenArticleLinksFromHtml(html, pageUrl) {
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }

  const links = [];
  const seen = new Set();
  for (const block of feedItemBlocksFromHtml(html)) {
    if (hasAudioOrAnnouncementIcon(block)) continue;
    const anchor = String(block || '').match(/<a\b[^>]*href=(["']?)([^"'\s>]+)\1[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;

    let candidate;
    try {
      candidate = new URL(anchor[2], page.href);
    } catch {
      continue;
    }
    if (candidate.hostname.replace(/^www\./, '').toLowerCase() !== page.hostname.replace(/^www\./, '').toLowerCase()) continue;
    candidate.hash = '';
    candidate.search = '';
    if (!isWrittenArticlePath(candidate.pathname)) continue;
    if (seen.has(candidate.href)) continue;

    const title = stripHtmlText(anchor[3]);
    if (!title) continue;
    seen.add(candidate.href);
    links.push({
      title,
      url: candidate.href,
    });
    if (reachedOptionalLimit(links.length, MAX_INDEX_ITEMS)) break;
  }

  return links.reverse().map((link, index, all) => ({
    ...link,
    sequence: index + 1,
    total: all.length,
  }));
}

export async function discoverIndexArticleLinksFromHtml(html, pageUrl) {
  if (isPaulGrahamUrl(pageUrl)) {
    try {
      const parsed = new URL(pageUrl);
      if (parsed.pathname.toLowerCase() === '/articles.html') {
        return limitItems(parsePaulGrahamIndex(html, pageUrl), MAX_INDEX_ITEMS);
      }
    } catch {}
  }

  if (isA16zAuthorPage(pageUrl)) {
    try {
      const a16zLinks = await discoverA16zAuthorArticleLinks(html, pageUrl);
      if (a16zLinks.length) return a16zLinks;
    } catch {}
  }

  const authorWrittenLinks = discoverAuthorWrittenArticleLinksFromHtml(html, pageUrl);
  if (authorWrittenLinks.length) return authorWrittenLinks;

  let page;
  try {
    page = new URL(pageUrl);
    page.hash = '';
    page.search = '';
  } catch {
    return [];
  }

  const links = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=(["']?)([^"'\s>]+)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[2];
    const title = stripHtmlText(match[3]);
    let candidate;
    try {
      candidate = new URL(href, page.href);
    } catch {
      continue;
    }
    if (!shouldKeepIndexArticleLink(candidate, page, title)) continue;
    if (seen.has(candidate.href)) continue;
    seen.add(candidate.href);
    links.push({
      title,
      url: candidate.href,
    });
    if (reachedOptionalLimit(links.length, MAX_INDEX_ITEMS)) break;
  }
  return links;
}

export function parseFeedItems(xml, feedUrl) {
  const raw = String(xml || '');
  const looksLikeFeed = /<rss\b|<feed\b|<rdf:RDF\b/i.test(raw);
  if (!looksLikeFeed) throw new Error('feed_not_found');
  const feedTitle = xmlTagText(raw, 'title') || new URL(feedUrl).hostname;
  const rssItems = xmlBlocks(raw, 'item').map((block) => ({
    title: xmlTagText(block, 'title'),
    url: xmlTagText(block, 'link') || xmlTagText(block, 'guid'),
    published: xmlTagText(block, 'pubDate') || xmlTagText(block, 'dc:date') || xmlTagText(block, 'published') || xmlTagText(block, 'updated'),
  }));
  const atomItems = xmlBlocks(raw, 'entry').map((block) => {
    const links = [...String(block || '').matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
    const alternate = links.find((tag) => !xmlAttr(tag, 'rel') || xmlAttr(tag, 'rel') === 'alternate') || links[0] || '';
    return {
      title: xmlTagText(block, 'title'),
      url: xmlAttr(alternate, 'href') || xmlTagText(block, 'id'),
      published: xmlTagText(block, 'published') || xmlTagText(block, 'updated'),
    };
  });
  const items = (rssItems.length ? rssItems : atomItems)
    .map((item) => {
      let href = '';
      try {
        href = new URL(item.url, feedUrl).href;
      } catch {}
      return {
        ...item,
        url: href,
        publishedAt: Date.parse(item.published || '') || 0,
      };
    })
    .filter((item) => item.url && item.title);
  if (!items.length) throw new Error('feed_items_not_found');
  const ordered = items.some((item) => item.publishedAt)
    ? items.sort((a, b) => (a.publishedAt || Number.MAX_SAFE_INTEGER) - (b.publishedAt || Number.MAX_SAFE_INTEGER))
    : items.reverse();
  return {
    title: feedTitle,
    items: limitItems(ordered, MAX_FEED_ITEMS),
  };
}

export async function articleFromUrl(url) {
  try {
    const { text, finalUrl } = await fetchTextUrl(url);
    return extractArticleFromHtml(text, finalUrl);
  } catch (error) {
    if (error?.message !== 'unsupported_content_type') throw error;
  }

  const { buffer, finalUrl, contentType } = await fetchFileUrlLive(url);
  const article = await articleFromUploadBuffer({
    filename: filenameFromUrl(finalUrl, contentType),
    mimeType: contentType || 'application/octet-stream',
    buffer,
  });
  return {
    ...article,
    url: finalUrl,
  };
}

// ── Corpus extraction (book engine) ──────────────────────────────────────────

// The Paul-Graham YC banner appears in several markup variants — an orange
// table cell (bgcolor #ff9922 OR #ffc888, and sometimes wrapped in an HTML
// comment) whose text is one of "Want to start a startup? … Get funded by Y
// Combinator", "Like to build things? Try Hacker News", or "… Winter/Summer
// Founders Program". Anchoring the strip on the banner PHRASE inside a bgcolor
// cell catches every colour variant and only removes a cell that is actually a
// banner. Validated against all 231 cached essays: 0 banner leaks, 0 promo
// leaks, 0 essays below the completeness floor, footnote markers preserved.
const PG_BANNER_CELL_RE = /<td[^>]*bgcolor=[^>]*>(?:(?!<\/td)[\s\S])*?(?:Want to start a startup\?|Like to build things\?|Get funded by|Founders Program)(?:(?!<\/td)[\s\S])*?<\/td\s*>/gi;
// The trailing "If you liked this … you may also like …" promo table.
const PG_PROMO_TABLE_RE = /<table[^>]*>(?:(?!<table)[\s\S])*?If you liked this[\s\S]*?<\/table>/gi;
// "… Translation" anchor links (localized-copy pointers, not article text).
const PG_TRANSLATION_LINK_RE = /<a[^>]*>[^<]*Translation[^<]*<\/a>/gi;

/**
 * The corrected Paul-Graham content region.
 *
 * WHY this exists: lib/podcast.js#paulGrahamContentHtml ends the body at the
 * FIRST <hr>, but several essays use an internal <hr> as a section break, so it
 * truncates real content (javacover 133/~1,360 words, diff 58, airbnb 251/~1,370)
 * and drops appendices/postscripts (icad "Appendix: Power", laundry). The fix:
 *   1. drop HTML comments + scripts first — commented-out banners (sfp) and the
 *      invisible "midden" of author notes (laundry) are not article text, and
 *      keeping them would leak boilerplate or inflate the word count with text a
 *      reader never sees on the page;
 *   2. start after the title-image / verdana font block, exactly as today;
 *   3. take the region to </body> (NOT the first <hr>), keeping internal <hr>s;
 *   4. strip the YC banner cell + promo table + Translation links.
 */
function paulGrahamCorpusRegion(html) {
  const raw = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  const titleImage = raw.match(/<img\b[^>]+alt=["'][^"']+["'][^>]*>\s*<br\s*\/?>\s*<br\s*\/?>\s*<font\b[^>]*>/i);
  const font = titleImage || raw.match(/<font\s+size=["']?2["']?\s+face=["']?verdana["']?[^>]*>/i);
  const start = font ? font.index + font[0].length : 0;
  const bodyEnd = raw.search(/<\/body>/i);
  let region = raw.slice(start, bodyEnd > start ? bodyEnd : raw.length);
  region = region.replace(PG_BANNER_CELL_RE, ' ');
  region = region.replace(PG_PROMO_TABLE_RE, ' ');
  region = region.replace(PG_TRANSLATION_LINK_RE, ' ');
  return region;
}

// Paragraph splitter — mirrors lib/podcast.js#htmlToParagraphs so the corrected
// PG carve produces the same paragraph shape as the podcast extractor. Kept
// local (a pure transform) so lib/podcast.js stays untouched.
function htmlRegionToParagraphs(html) {
  const withBreaks = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|blockquote|li|tr|h[1-6])\s*>/gi, '\n\n')
    .replace(/<(p|div|section|article|blockquote|li|tr|h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ');
  const text = decodeHtmlEntities(withBreaks.replace(/<[^>]*>/g, ' '))
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return [];
  return text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * extractCorpusArticle(html, url) — wraps extractArticleFromHtml. For a
 * paulgraham.com URL it replaces the (truncated) body with the corrected carve
 * above; every other source passes through the generic extractor unchanged.
 * Returns the same Article shape with complete body + footnotes + appendices
 * and no promo/banner boilerplate.
 */
export function extractCorpusArticle(html, url) {
  const base = extractArticleFromHtml(html, url);
  if (!isPaulGrahamUrl(url)) return base;

  const region = paulGrahamCorpusRegion(html);
  const normalizedTitle = String(base.title || '').toLowerCase();
  const paragraphs = htmlRegionToParagraphs(region).filter((paragraph, index) => {
    if (index === 0 && paragraph.toLowerCase() === normalizedTitle) return false;
    if (/^(home|articles|books|faq|rss)$/i.test(paragraph)) return false;
    if (/^(?:\.{3}|…)read more$/i.test(paragraph)) return false;
    return paragraph.length > 1;
  });

  const text = paragraphs.join('\n\n');
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
  return {
    ...base,
    paragraphs,
    text,
    charCount: text.length,
    wordCount,
    estimatedMinutes: wordCount ? Math.max(1, Math.round(wordCount / 165)) : 0,
  };
}

// Bounded-concurrency map that preserves input order. The book engine fetches a
// whole corpus; running each essay sequentially with an 8s timeout would be
// slow on a live source, and unbounded parallelism is a poor citizen against a
// single origin. Order is preserved because results are written by index.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * resolveCorpus(source, options) — the book engine's only fetch entry.
 *
 *   { kind:'index', url, instructions } → fetch the index → discover article
 *     links via the GENERIC discovery path (Paul Graham is one branch inside
 *     discoverIndexArticleLinksFromHtml, recognised by hostname; a non-PG source
 *     flows through the author/anchor branches with no PG code path) → fetch +
 *     extractCorpusArticle each link → ordered Article[]. Threads cache:true
 *     into EVERY fetchTextUrl call so an arbitrary host is cached under the
 *     unchanged source-cache without altering podcast behavior.
 *   { kind:'pdf', filePath | url } → read bytes → articleFromUploadBuffer →
 *     single Article.
 *
 * Returns { sourceLabel, ordering, essays }. ordering is 'index_oldest_first'
 * for an index (the discovery order IS the resolved order — for PG that is
 * parsePaulGrahamIndex's oldest-first index order) or 'as_supplied' for a PDF.
 *
 * cacheMaxAgeMs defaults to Infinity: a book build prefers already-cached bytes
 * for determinism/offline (the 232 PG files build with zero network); a source
 * with no cache file still fetches live and then caches.
 */
export async function resolveCorpus(source = {}, options = {}) {
  const cacheMaxAgeMs = options.cacheMaxAgeMs ?? Infinity;
  const concurrency = options.concurrency ?? 6;
  const fetchImpl = options.fetchImpl;
  const cache = options.cache ?? true;
  const fetchOpts = { cache, cacheMaxAgeMs, ...(fetchImpl ? { fetchImpl } : {}) };

  if (source.kind === 'pdf') {
    let buffer;
    let name;
    let sourceUrl = '';
    if (source.filePath) {
      buffer = await readFile(source.filePath);
      name = basename(source.filePath);
      sourceUrl = source.filePath;
    } else if (source.url) {
      const fetched = await fetchFileUrlLive(source.url, 4, fetchImpl ? { fetchImpl } : {});
      buffer = fetched.buffer;
      name = filenameFromUrl(fetched.finalUrl, fetched.contentType);
      sourceUrl = fetched.finalUrl;
    } else {
      throw new Error('pdf_source_required');
    }
    const article = await articleFromUploadBuffer({
      filename: name,
      mimeType: 'application/pdf',
      buffer,
    });
    return {
      sourceLabel: article.title || name || 'Document',
      ordering: 'as_supplied',
      essays: [{ ...article, url: sourceUrl }],
    };
  }

  if (source.kind === 'index') {
    if (!source.url) throw new Error('index_source_required');
    const { text, finalUrl } = await fetchTextUrl(source.url, 4, fetchOpts);
    const links = await discoverIndexArticleLinksFromHtml(text, finalUrl);
    if (!links.length) throw new Error('index_links_not_found');

    const resolved = await mapWithConcurrency(links, concurrency, async (link) => {
      try {
        const fetched = await fetchTextUrl(link.url, 4, fetchOpts);
        const article = extractCorpusArticle(fetched.text, fetched.finalUrl);
        if (!article.text || article.wordCount < 1) return null;
        return {
          ...article,
          url: link.url,
          title: article.title || link.title || '',
        };
      } catch {
        return null;
      }
    });
    const essays = resolved.filter(Boolean);
    if (!essays.length) throw new Error('index_articles_not_found');

    const sourceLabel = isPaulGrahamUrl(finalUrl)
      ? 'Paul Graham'
      : (authorArchivePlaylistTitle(text, finalUrl) || htmlDocumentTitle(text, finalUrl) || 'Imported corpus');
    return {
      sourceLabel,
      ordering: 'index_oldest_first',
      essays,
    };
  }

  throw new Error('unsupported_corpus_source');
}
