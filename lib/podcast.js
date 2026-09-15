export const PAUL_GRAHAM_INDEX_URL = 'https://paulgraham.com/articles.html';

const PAUL_GRAHAM_SKIP_PATHS = new Set([
  '/lispweb.html',
]);

const ENTITY_MAP = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  aacute: '\u00e1',
  eacute: '\u00e9',
  iacute: '\u00ed',
  oacute: '\u00f3',
  uacute: '\u00fa',
  ntilde: '\u00f1',
  Aacute: '\u00c1',
  Eacute: '\u00c9',
  Iacute: '\u00cd',
  Oacute: '\u00d3',
  Uacute: '\u00da',
  Ntilde: '\u00d1',
};

export function decodeHtmlEntities(value = '') {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity) => {
    if (ENTITY_MAP[entity] !== undefined) return ENTITY_MAP[entity];
    const key = entity.toLowerCase();
    if (key[0] === '#') {
      const isHex = key.startsWith('#x');
      const raw = isHex ? key.slice(2) : key.slice(1);
      const code = Number.parseInt(raw, isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITY_MAP[key] ?? match;
  });
}

function stripTags(value = '') {
  return decodeHtmlEntities(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function articleIdFromUrl(url) {
  const parsed = new URL(url);
  const filename = parsed.pathname.split('/').filter(Boolean).pop() || 'article';
  return filename.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function urlPathname(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

function applyPaulGrahamOrderingCorrections(essays) {
  const corrected = [...essays];
  const prop62Index = corrected.findIndex((essay) => urlPathname(essay.url) === '/prop62.html');
  if (prop62Index < 0) return corrected;

  const [prop62] = corrected.splice(prop62Index, 1);
  const pittsburghIndex = corrected.findIndex((essay) => urlPathname(essay.url) === '/pgh.html');
  if (pittsburghIndex < 0) {
    corrected.unshift(prop62);
    return corrected;
  }
  corrected.splice(pittsburghIndex + 1, 0, prop62);
  return corrected;
}

export function parsePaulGrahamIndex(html, baseUrl = PAUL_GRAHAM_INDEX_URL) {
  const raw = String(html || '');
  const introIndex = raw.indexOf("If you're not sure");
  const mainMarker = '<br /><table border="0" cellspacing="0" cellpadding="0" width="435"';
  const mainIndex = raw.indexOf(mainMarker, introIndex >= 0 ? introIndex : 0);
  const source = mainIndex >= 0 ? raw.slice(mainIndex) : raw;
  const anchors = [];
  const seen = new Set();
  const anchorRe = /<a\s+[^>]*href=(["']?)([^"'\s>]+)\1[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of source.matchAll(anchorRe)) {
    const href = match[2];
    const title = stripTags(match[3]);
    if (!title) continue;

    let parsed;
    try {
      parsed = new URL(href, baseUrl);
    } catch {
      continue;
    }
    parsed.hash = '';
    parsed.search = '';

    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host !== 'paulgraham.com') continue;
    if (!path.endsWith('.html')) continue;
    if (PAUL_GRAHAM_SKIP_PATHS.has(path)) continue;
    if (['/articles.html', '/index.html', '/rss.html'].includes(path)) continue;
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);

    anchors.push({
      id: `pg-${articleIdFromUrl(parsed.href)}`,
      title,
      url: parsed.href,
      source: 'Paul Graham',
    });
  }

  const oldestFirst = applyPaulGrahamOrderingCorrections(anchors.reverse());
  return oldestFirst.map((essay, index) => ({
    ...essay,
    sequence: index + 1,
    total: oldestFirst.length,
  }));
}

function removeNonContentHtml(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<form\b[\s\S]*?<\/form>/gi, ' ')
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
}

function htmlToParagraphs(html) {
  const withBreaks = removeNonContentHtml(html)
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

function titleFromHtml(html) {
  const h1 = String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) return stripTags(h1[1]);

  const og = String(html || '').match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || String(html || '').match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i);
  if (og?.[1]) return decodeHtmlEntities(og[1]).trim();

  const title = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) return stripTags(title[1]);

  return '';
}

function htmlAttr(tag, name) {
  const safeName = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag || '').match(new RegExp(`\\b${safeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
  return value ? decodeHtmlEntities(value).trim() : '';
}

function metaContent(html, name) {
  const raw = String(html || '');
  const safeName = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byProperty = raw.match(new RegExp(`<meta[^>]+property=["']${safeName}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'))
    || raw.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${safeName}["'][^>]*>`, 'i'));
  if (byProperty?.[1]) return decodeHtmlEntities(byProperty[1]).trim();

  const byName = raw.match(new RegExp(`<meta[^>]+name=["']${safeName}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'))
    || raw.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${safeName}["'][^>]*>`, 'i'));
  return byName?.[1] ? decodeHtmlEntities(byName[1]).trim() : '';
}

function publishedAtFromHtml(html) {
  const direct = metaContent(html, 'article:published_time')
    || metaContent(html, 'datePublished')
    || metaContent(html, 'publish_date');
  if (direct && Number.isFinite(Date.parse(direct))) return new Date(direct).toISOString();

  const timeTag = String(html || '').match(/<time\b[^>]*>/i)?.[0] || '';
  const datetime = htmlAttr(timeTag, 'datetime');
  return datetime && Number.isFinite(Date.parse(datetime)) ? new Date(datetime).toISOString() : '';
}

function shortDateFromIso(iso) {
  const time = Date.parse(iso || '');
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

function innerHtmlForBalancedElement(html, startIndex, tagName) {
  const raw = String(html || '');
  const safeTag = String(tagName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openMatch = raw.slice(startIndex).match(new RegExp(`^<${safeTag}\\b[^>]*>`, 'i'));
  if (!openMatch) return '';

  const contentStart = startIndex + openMatch[0].length;
  const tagRe = new RegExp(`<\\/?${safeTag}\\b[^>]*>`, 'gi');
  tagRe.lastIndex = contentStart;
  let depth = 1;
  let match;
  while ((match = tagRe.exec(raw))) {
    if (match[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return raw.slice(contentStart, match.index);
    } else {
      depth += 1;
    }
  }
  return '';
}

function divContentByClass(html, className) {
  const raw = String(html || '');
  const safeClass = String(className || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const divRe = /<div\b[^>]*>/gi;
  let match;
  while ((match = divRe.exec(raw))) {
    const classAttr = htmlAttr(match[0], 'class');
    if (new RegExp(`(?:^|\\s)${safeClass}(?:\\s|$)`).test(classAttr)) {
      return innerHtmlForBalancedElement(raw, match.index, 'div');
    }
  }
  return '';
}

function paulGrahamContentHtml(html) {
  const raw = String(html || '');
  const titleImage = raw.match(/<img\b[^>]+alt=["'][^"']+["'][^>]*>\s*<br\s*\/?>\s*<br\s*\/?>\s*<font\b[^>]*>/i);
  const font = titleImage || raw.match(/<font\s+size=["']?2["']?\s+face=["']?verdana["']?[^>]*>/i);
  if (!font) return raw;

  const start = font.index + font[0].length;
  const tail = raw.slice(start);
  const nextTable = tail.search(/<\/td>\s*<\/tr>\s*<\/table>\s*<table\b/i);
  const hr = tail.search(/<hr\b/i);
  const candidates = [nextTable, hr].filter((index) => index >= 0);
  const end = candidates.length ? start + Math.min(...candidates) : raw.length;
  return raw.slice(start, end);
}

function genericContentHtml(html) {
  const raw = removeNonContentHtml(html);
  const a16zArticle = divContentByClass(raw, 'js-article-content');
  if (a16zArticle) return a16zArticle;

  const article = raw.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (article?.[1]) return article[1];

  const main = raw.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main?.[1]) return main[1];

  const body = raw.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body?.[1] || raw;
}

function parseLooseDate(paragraph) {
  const value = String(paragraph || '').trim();
  const match = value.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i);
  return match ? value : null;
}

function estimatedMinutes(wordCount) {
  if (!wordCount) return 0;
  return Math.max(1, Math.round(wordCount / 165));
}

export function extractArticleFromHtml(html, url) {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const isPaulGraham = host === 'paulgraham.com';
  const title = titleFromHtml(html) || parsed.pathname.split('/').filter(Boolean).pop() || 'Article';
  const publishedAt = publishedAtFromHtml(html);
  const contentHtml = isPaulGraham ? paulGrahamContentHtml(html) : genericContentHtml(html);
  let paragraphs = htmlToParagraphs(contentHtml);

  if (paragraphs.length < 2) {
    paragraphs = htmlToParagraphs(genericContentHtml(html));
  }

  const normalizedTitle = title.toLowerCase();
  paragraphs = paragraphs.filter((paragraph, index) => {
    if (index === 0 && paragraph.toLowerCase() === normalizedTitle) return false;
    if (/^(home|articles|books|faq|rss)$/i.test(paragraph)) return false;
    if (/^(?:\.{3}|…)read more$/i.test(paragraph)) return false;
    return paragraph.length > 1;
  });

  const text = paragraphs.join('\n\n');
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;

  return {
    title,
    url,
    sourceName: isPaulGraham ? 'Paul Graham' : host,
    published: parseLooseDate(paragraphs[0]) || shortDateFromIso(publishedAt),
    publishedAt,
    paragraphs,
    text,
    charCount: text.length,
    wordCount,
    estimatedMinutes: estimatedMinutes(wordCount),
    extractedAt: new Date().toISOString(),
  };
}
