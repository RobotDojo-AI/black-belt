/**
 * book-interior.js — Article[] → print-ready interior PDF (per volume).
 *
 * Compute tier: Tier 0 (local, deterministic — HTML assembly + a headless
 * Chromium PDF render). No LLM; no DB writes.
 *
 * The interior is authored as CSS Paged Media and paginated by the Paged.js
 * polyfill loaded into the already-installed Playwright Chromium (no puppeteer,
 * no native binary). The stylesheet does the book work: a generated
 * table-of-contents whose page numbers come from `target-counter`, running
 * heads from `string-set`, page numbers from `counter(page)`, one essay per
 * `break-before: page`, and a mirrored inner (binding-side) margin via
 * `@page:left` / `@page:right`. The serif body face is embedded via `@font-face`
 * so the output PDF carries its own fonts (non-embedded fonts are the #1
 * print-on-demand rejection). Each volume renders as ONE Chromium page (~450pp)
 * — never one 1,800-page render.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { pdfPageCount } from './book-pdf.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGEDJS_POLYFILL = resolve(REPO_ROOT, 'node_modules', 'pagedjs', 'dist', 'paged.polyfill.js');

// Trim + bleed: 6×9 trim + 0.125" bleed each edge = 6.25×9.25in author size.
const PAGE_WIDTH_IN = 6.25;
const PAGE_HEIGHT_IN = 9.25;
const BASE_MARGIN_IN = 0.6;   // safety margin on the three non-binding edges
const GUTTER_MARGIN_IN = 0.8; // inner (spine-side) margin — ≥0.2" wider (Lulu binding)
// Body typography. Tuned against the real Georgia render so the four flagship
// volumes land at ~460–475 pages each — inside the 400–600 guardrail, near the
// ~450 target (measured density at 11.5pt/1.55 is ~300 words/page).
const BODY_FONT_PT = 11.5;
const BODY_LINE_HEIGHT = 1.55;

// Serif body face. Georgia ships as single TTFs on macOS (unlike Times.ttc), so
// each weight/style embeds cleanly as a data-URI. Overridable via env for other
// hosts; if no file resolves, the CSS falls back to a serif stack and Chromium
// still subsets+embeds whatever it renders with.
const FONT_DIR = process.env.ROBOTDOJO_BOOK_FONT_DIR || '/System/Library/Fonts/Supplemental';
const FONT_FILES = [
  { file: 'Georgia.ttf', weight: 'normal', style: 'normal' },
  { file: 'Georgia Bold.ttf', weight: 'bold', style: 'normal' },
  { file: 'Georgia Italic.ttf', weight: 'normal', style: 'italic' },
  { file: 'Georgia Bold Italic.ttf', weight: 'bold', style: 'italic' },
];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Stable, unique, valid HTML id + TOC href target for an essay. */
export function essayAnchorId(essay, index) {
  const raw = String(essay?.id || essay?.url || `essay-${index}`);
  const slug = raw
    .replace(/^https?:\/\/(www\.)?[^/]+\//, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'essay';
  return `e${index}-${slug}`;
}

/**
 * Embedded @font-face rules + the body font-family string. Reads the serif TTFs
 * and inlines them as data-URIs so the rendered PDF is self-contained.
 */
export function interiorFontFaces() {
  const faces = [];
  for (const { file, weight, style } of FONT_FILES) {
    const path = resolve(FONT_DIR, file);
    if (!existsSync(path)) continue;
    try {
      const b64 = readFileSync(path).toString('base64');
      faces.push(
        `@font-face{font-family:'BookSerif';`
        + `src:url(data:font/ttf;base64,${b64}) format('truetype');`
        + `font-weight:${weight};font-style:${style};font-display:block;}`,
      );
    } catch { /* skip a font that can't be read */ }
  }
  const bodyFont = faces.length
    ? `'BookSerif', Georgia, 'Times New Roman', serif`
    : `Georgia, 'Times New Roman', serif`;
  return { fontFaces: faces.join('\n'), bodyFont };
}

/**
 * interiorPrintCss(opts) → the CSS Paged Media stylesheet.
 *
 * opts: { fontFaces, bodyFont } (from interiorFontFaces). Front matter (title
 * page + TOC) suppresses the running head and page number; the page counter is
 * continuous, so the TOC's target-counter values are the true printed pages
 * where each essay begins.
 */
export function interiorPrintCss(opts = {}) {
  const { fontFaces = '', bodyFont = `Georgia, 'Times New Roman', serif` } = opts;
  return `
${fontFaces}

@page {
  size: ${PAGE_WIDTH_IN}in ${PAGE_HEIGHT_IN}in;
  margin: ${BASE_MARGIN_IN}in;
  @top-center { content: string(essaytitle); font: italic 9pt ${bodyFont}; color: #444; }
  @bottom-center { content: counter(page); font: 9pt ${bodyFont}; color: #444; }
}
/* Mirrored gutter: inner (spine-side) margin is wider on both recto and verso. */
@page:right { margin-left: ${GUTTER_MARGIN_IN}in; }  /* recto — spine on the left  */
@page:left  { margin-right: ${GUTTER_MARGIN_IN}in; } /* verso — spine on the right */
/* Front matter: no running head, no page number. */
@page frontmatter { @top-center { content: none; } @bottom-center { content: none; } }

html { hyphens: auto; }
body { font-family: ${bodyFont}; font-size: ${BODY_FONT_PT}pt; line-height: ${BODY_LINE_HEIGHT}; text-align: justify; hyphens: auto; color: #111; }

.frontmatter { page: frontmatter; }

.titlepage { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; height: 100%; }
.titlepage .vol-title { font-size: 30pt; font-weight: bold; margin: 0 0 0.4in; line-height: 1.1; }
.titlepage .vol-author { font-size: 15pt; font-style: italic; margin: 0 0 1.6in; }
.titlepage .vol-label { font-size: 13pt; letter-spacing: 0.04em; }
.titlepage .vol-source { position: absolute; bottom: 0.9in; font-size: 9.5pt; font-style: italic; line-height: 1.5; color: #555; text-align: center; }

#toc { break-before: right; }
#toc .toc-title { font-size: 18pt; font-weight: bold; margin: 0 0 0.4in; text-align: left; }
.toc-list { list-style: none; padding: 0; margin: 0; }
.toc-list li { margin: 0.06in 0; font-size: 10.5pt; }
.toc-list a { text-decoration: none; color: inherit; display: flex; align-items: baseline; }
.toc-list a .toc-lead { flex: 1 1 auto; border-bottom: 1px dotted #bbb; margin: 0 0.3em 0.16em; min-width: 0.4in; }
.toc-list a::after { content: target-counter(attr(href url), page); font-variant-numeric: tabular-nums; white-space: nowrap; }

article { break-before: page; }
article:first-of-type { break-before: right; } /* body opens on a recto */
/* Even-count pad: a trailing blank page. Uses the article break mechanism (the
   only page break proven reliable in a 500-page flow) and the frontmatter page
   so it carries no running head or page number. */
.pad-page { page: frontmatter; }
.pad-page p { text-indent: 0; }
article h1 { string-set: essaytitle content(text); font-size: 17pt; font-weight: bold; line-height: 1.2; margin: 0 0 0.28in; text-align: left; }
article p { margin: 0 0 0.02in; text-indent: 1.4em; orphans: 2; widows: 2; }
article p:first-of-type { text-indent: 0; }
`.trim();
}

/**
 * assembleVolumeHtml(volume, meta) → the interior HTML string: a title page, a
 * generated TOC listing each essay against its anchor, then one <article> per
 * essay. essayAnchorId ties each TOC href to its essay id so target-counter
 * always resolves.
 */
export function assembleVolumeHtml(volume, meta = {}) {
  const bookTitle = escapeHtml(meta.bookTitle || 'Essays');
  const author = escapeHtml(meta.author || '');
  const eraLabel = volume.eraLabel ? ` — ${escapeHtml(volume.eraLabel)}` : '';

  // Source attribution — makes the provenance unambiguous on every volume.
  let sourceHost = '';
  try { if (meta.sourceUrl) sourceHost = new URL(meta.sourceUrl).hostname.replace(/^www\./, ''); } catch { sourceHost = ''; }
  if (!sourceHost && /paul graham/i.test(author)) sourceHost = 'paulgraham.com';
  const sourceNote = sourceHost
    ? `Essays by ${author || 'the author'}, sourced from ${escapeHtml(sourceHost)}.<br>Compiled for personal use.`
    : '';

  const titlePage = `
<section class="frontmatter titlepage">
  <h1 class="vol-title" style="string-set:none;">${bookTitle}</h1>
  ${author ? `<p class="vol-author">${author}</p>` : ''}
  <p class="vol-label">Volume ${volume.index}${eraLabel}</p>
  ${sourceNote ? `<p class="vol-source">${sourceNote}</p>` : ''}
</section>`;

  const ids = volume.essays.map((essay, index) => essayAnchorId(essay, index));

  const tocItems = volume.essays
    .map((essay, index) => `<li><a href="#${ids[index]}"><span class="toc-t">${escapeHtml(essay.title || `Essay ${index + 1}`)}</span><span class="toc-lead"></span></a></li>`)
    .join('\n');
  const toc = `
<nav id="toc" class="frontmatter">
  <h2 class="toc-title">Contents</h2>
  <ol class="toc-list">
${tocItems}
  </ol>
</nav>`;

  const articles = volume.essays.map((essay, index) => {
    const paragraphs = (essay.paragraphs && essay.paragraphs.length
      ? essay.paragraphs
      : String(essay.text || '').split(/\n\n+/))
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join('\n');
    return `<article id="${ids[index]}">
  <h1>${escapeHtml(essay.title || `Essay ${index + 1}`)}</h1>
${paragraphs}
</article>`;
  }).join('\n');

  return `${titlePage}\n${toc}\n${articles}\n`;
}

function buildDocument(bodyHtml, css, polyfillJs, { padBlankPage = false } = {}) {
  const blank = padBlankPage
    ? '<article class="pad-page"><p>&nbsp;</p></article>'
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>${css}</style></head>
<body>
${bodyHtml}
${blank}
<script>window.PagedConfig={auto:true,after:(flow)=>{window.__pagedResult={total:flow.total};}};</script>
<script>${polyfillJs}</script>
</body></html>`;
}

async function renderPdfBytes(browser, doc, pageOptions, timeoutMs) {
  const page = await browser.newPage();
  try {
    await page.setContent(doc, { waitUntil: 'load', timeout: timeoutMs });
    await page.waitForFunction('window.__pagedResult && window.__pagedResult.total > 0', { timeout: timeoutMs });
    const total = await page.evaluate('window.__pagedResult.total');
    const pdf = await page.pdf(pageOptions);
    return { pdf, flowTotal: Number(total) || 0 };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * renderInteriorPdf(html, css, outPath, opts) → { path, pageCount }.
 *
 * Loads the Paged.js polyfill into a headless Chromium page, waits for
 * pagination, exports the PDF with the @page size, and writes outPath. Reads the
 * page count back from the rendered PDF; if it is odd, appends one blank page
 * and re-renders exactly once (perfect binding requires an even count).
 */
export async function renderInteriorPdf(html, css, outPath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const polyfillJs = await readFile(PAGEDJS_POLYFILL, 'utf8');
  const pageOptions = { preferCSSPageSize: true, printBackground: true };

  await mkdir(dirname(outPath), { recursive: true });
  const browser = opts.browser || await chromium.launch();
  try {
    let { pdf } = await renderPdfBytes(browser, buildDocument(html, css, polyfillJs), pageOptions, timeoutMs);
    await writeFile(outPath, pdf);
    let pageCount = await pdfPageCount(pdf);

    if (pageCount % 2 !== 0) {
      const padded = await renderPdfBytes(browser, buildDocument(html, css, polyfillJs, { padBlankPage: true }), pageOptions, timeoutMs);
      pdf = padded.pdf;
      await writeFile(outPath, pdf);
      pageCount = await pdfPageCount(pdf);
    }

    return { path: outPath, pageCount };
  } finally {
    if (!opts.browser) await browser.close().catch(() => {});
  }
}
