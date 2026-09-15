/**
 * book-cover.js — full-wrap paperback cover (per volume).
 *
 * Compute tier: Tier 0 (local, deterministic — HTML assembly + a single-page
 * Chromium render). No LLM; no DB writes.
 *
 * A perfect-bound wrap cover is one physical sheet laid out [back][spine][front]
 * left-to-right. Its width is two trim widths plus the spine, and the spine
 * width is a function of the interior page count and paper caliper. The layout
 * is a minimal typographic front + spine (the owner's chosen v1 — no artwork).
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { interiorFontFaces } from './book-interior.js';

// A wrap-cover FACE (front or back) is trim width + bleed on the OUTER edge
// only — the inner edge butts against the spine and carries no bleed. So a
// face is 6" trim + 0.125" outer bleed = 6.125", NOT the interior page's 6.25"
// (which has bleed on both sides). Using 6.25 makes the wrap 0.25" too wide and
// Lulu rejects the cover ("PDF dimensions ... need to be within ..."). Height
// gets bleed top AND bottom: 9" trim + 0.25" = 9.25".
const FACE_WIDTH_IN = 6.125;
const COVER_HEIGHT_IN = 9.25;
// Spine text only renders when the spine is wide enough to be legible.
const MIN_SPINE_TEXT_IN = 0.0625;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * spineWidthInches(pageCount) → interior thickness in inches.
 *
 * pageCount / 444 + 0.06: 444 pages per inch is Lulu's white 60# uncoated
 * caliper for the flagship SKU, plus a 0.06" cover-wrap allowance. The SKU/paper
 * is the to-verify constant; the formula is the documented spine model.
 */
export function spineWidthInches(pageCount) {
  const pages = Math.max(0, Number(pageCount) || 0);
  return pages / 444 + 0.06;
}

export function coverWidthInches(spineIn) {
  return 2 * FACE_WIDTH_IN + (Number(spineIn) || 0);
}

// Per-volume palette — a distinct rich field colour per volume so the set reads
// as a collected-works series on the shelf. { bg, deep (spine/back), ink (text),
// motif (ring tint) }. Cycles for volumes beyond the palette length.
const VOLUME_PALETTE = [
  { bg: '#1f4e57', deep: '#173b42', ink: '#f4f1e8', motif: '#ffffff', accent: '#e7c46b' }, // petrol teal
  { bg: '#6e2b34', deep: '#521f26', ink: '#f4ece6', motif: '#ffffff', accent: '#e0a96d' }, // oxblood
  { bg: '#2c3363', deep: '#20264c', ink: '#eeeef4', motif: '#ffffff', accent: '#8fa5df' }, // indigo
  { bg: '#274734', deep: '#1c3427', ink: '#eef2ec', motif: '#ffffff', accent: '#cdb87a' }, // forest
];

function paletteFor(index) {
  return VOLUME_PALETTE[(Math.max(1, index) - 1) % VOLUME_PALETTE.length];
}

function toRoman(n) {
  const map = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  let v = Math.max(0, Math.floor(Number(n) || 0));
  for (const [val, sym] of map) { while (v >= val) { out += sym; v -= val; } }
  return out || 'I';
}

// A generative concentric-ring motif (ideas radiating outward), rendered as
// inline SVG so it stays crisp in the PDF. Subtle low-opacity strokes in the
// palette's motif tint. Centred off-canvas bottom so text stays legible.
function ringMotif(color, id) {
  const rings = [];
  for (let i = 1; i <= 13; i++) {
    const r = i * 0.62;
    const op = (0.16 - i * 0.007).toFixed(3);
    rings.push(`<circle cx="3.1" cy="8.9" r="${r.toFixed(2)}" fill="none" stroke="${color}" stroke-width="0.012" opacity="${op}"/>`);
  }
  return `<svg class="motif" viewBox="0 0 6.125 9.25" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${rings.join('')}</svg>`;
}

/**
 * assembleCoverHtml(volume, meta, spineIn) → single-page wrap HTML laid out
 * [back][spine][front]. A distinguished collected-works design: a per-volume
 * colour field, a concentric-ring motif, a keyline frame, and a strong
 * typographic hierarchy (author · title · volume in roman numerals · era). The
 * spine and back match the field colour; the back carries a short colophon.
 * Dimensions are unchanged from the validated wrap geometry.
 */
export function assembleCoverHtml(volume, meta = {}, spineIn = 0) {
  const bookTitle = escapeHtml(meta.bookTitle || 'Essays');
  const author = escapeHtml(meta.author || '');
  const era = volume.eraLabel ? escapeHtml(volume.eraLabel) : '';
  const roman = toRoman(volume.index);
  const totalVolumes = Number(meta.totalVolumes) || 0;
  const setLabel = totalVolumes ? `Volume ${roman} of ${toRoman(totalVolumes)}` : `Volume ${roman}`;
  const { fontFaces, bodyFont } = interiorFontFaces();
  const coverWidthIn = coverWidthInches(spineIn);
  const showSpineText = spineIn >= MIN_SPINE_TEXT_IN;
  const p = paletteFor(volume.index);

  const spineInner = showSpineText
    ? `<div class="spine-text"><span class="s-name">${author || bookTitle}</span><span class="s-sep">&middot;</span><span class="s-title">${bookTitle}</span><span class="s-sep">&middot;</span><span class="s-vol">${roman}</span></div>`
    : '';

  // Cover-art branch: a full-bleed public-domain painting + a typographic band.
  // meta.coverArt is an array of { vol, dataUri, title, artist, date, source };
  // pick this volume's entry. Falls through to the generative design if absent.
  const artList = Array.isArray(meta.coverArt) ? meta.coverArt : (meta.coverArt ? [meta.coverArt] : []);
  const art = artList.find((a) => Number(a.vol) === Number(volume.index)) || null;
  if (art && art.dataUri) {
    const credit = `${escapeHtml(art.title)}${art.artist ? `, ${escapeHtml(art.artist)}` : ''}${art.date ? ` (${escapeHtml(art.date)})` : ''}`;
    const source = escapeHtml(art.source || 'Public domain');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
${fontFaces}
@page { size: ${coverWidthIn}in ${COVER_HEIGHT_IN}in; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
.wrap { display: flex; width: ${coverWidthIn}in; height: ${COVER_HEIGHT_IN}in; font-family: ${bodyFont}; overflow: hidden; }
.face { position: relative; height: 100%; overflow: hidden; }
.front { width: ${FACE_WIDTH_IN}in; background: ${p.deep}; color: ${p.ink}; }
.back  { width: ${FACE_WIDTH_IN}in; background: ${p.deep}; color: ${p.ink}; }
.spine { width: ${spineIn}in; height: 100%; background: ${p.deep}; color: ${p.ink}; display: flex; align-items: center; justify-content: center; }
/* front: painting fills the face; a solid band across the lower third holds type */
.artwrap { position: absolute; top: 0; left: 0; right: 0; bottom: 2.7in; overflow: hidden; }
.artwrap img { width: 100%; height: 100%; object-fit: cover; object-position: center 42%; display: block; }
.artwrap::after { content: ''; position: absolute; inset: 0; box-shadow: inset 0 -0.5in 0.5in -0.25in ${p.deep}; }
.band { position: absolute; left: 0; right: 0; bottom: 0; height: 2.85in; background: ${p.deep}; }
.band-rule { position: absolute; top: 0.34in; left: 0.62in; right: 0.62in; height: 1.4pt; background: ${p.accent}; }
.band-inner { position: absolute; left: 0.62in; right: 0.62in; top: 0.6in; bottom: 0.68in; display: flex; flex-direction: column; align-items: center; text-align: center; }
.kicker { font-size: 12.5pt; letter-spacing: 0.32em; text-transform: uppercase; }
.title { font-size: 46pt; line-height: 1.0; margin: 0.16in 0 0; }
.spacer { flex: 1; }
.vol { font-size: 13.5pt; letter-spacing: 0.16em; text-transform: uppercase; }
.era { font-size: 11pt; letter-spacing: 0.08em; margin-top: 0.08in; color: ${p.accent}; }
/* spine */
.spine-text { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; font-size: ${spineIn >= 0.55 ? '11pt' : '9pt'}; letter-spacing: 0.06em; display: flex; align-items: center; gap: 0.18in; }
.s-sep { opacity: 0.6; } .s-vol { color: ${p.accent}; }
/* back */
.b-inner { position: absolute; top: 0.7in; bottom: 0.7in; left: 0.68in; right: 0.68in; display: flex; flex-direction: column; }
.b-kicker { font-size: 11pt; letter-spacing: 0.28em; text-transform: uppercase; opacity: 0.85; }
.b-blurb { margin-top: 0.32in; font-size: 12pt; line-height: 1.55; max-width: 4.5in; }
.b-spacer { flex: 1; }
.b-rule { width: 100%; height: 0.6pt; background: ${p.ink}; opacity: 0.3; margin: 0.16in 0; }
.b-credit { font-size: 9.5pt; line-height: 1.4; opacity: 0.82; }
.b-meta { font-size: 10.5pt; letter-spacing: 0.04em; opacity: 0.9; margin-bottom: 0.06in; }
</style></head>
<body>
<div class="wrap">
  <div class="face back">
    <div class="b-inner">
      <div class="b-kicker">Collected Essays</div>
      <div class="b-blurb">The complete essays${author ? ` of ${author}` : ''}, gathered from ${author && /paul graham/i.test(author) ? 'paulgraham.com' : 'the web'} and set in order, oldest to newest &mdash; the writing worth keeping on a shelf, to read, mark, and return to.</div>
      <div class="b-spacer"></div>
      <div class="b-meta">${escapeHtml(setLabel)}${era ? ` &nbsp;&middot;&nbsp; ${era}` : ''}</div>
      <div class="b-rule"></div>
      <div class="b-credit">Cover: <em>${credit}</em>. ${source}.</div>
    </div>
  </div>
  <div class="spine">${spineInner}</div>
  <div class="face front">
    <div class="artwrap"><img src="${art.dataUri}" alt=""></div>
    <div class="band">
      <div class="band-rule"></div>
      <div class="band-inner">
        ${author ? `<div class="kicker">${author}</div>` : ''}
        <div class="title">${bookTitle}</div>
        <div class="spacer"></div>
        <div class="vol">${escapeHtml(setLabel)}</div>
        ${era ? `<div class="era">${era}</div>` : ''}
      </div>
    </div>
  </div>
</div>
</body></html>`;
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
${fontFaces}
@page { size: ${coverWidthIn}in ${COVER_HEIGHT_IN}in; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
.wrap { display: flex; width: ${coverWidthIn}in; height: ${COVER_HEIGHT_IN}in; font-family: ${bodyFont}; overflow: hidden; }
.face { position: relative; height: 100%; overflow: hidden; }
.motif { position: absolute; inset: 0; width: 100%; height: 100%; }
.front { width: ${FACE_WIDTH_IN}in; background: ${p.bg}; color: ${p.ink}; }
.back  { width: ${FACE_WIDTH_IN}in; background: ${p.bg}; color: ${p.ink}; }
.spine { width: ${spineIn}in; height: 100%; background: ${p.deep}; color: ${p.ink}; display: flex; align-items: center; justify-content: center; }
.frame { position: absolute; top: 0.62in; bottom: 0.62in; left: 0.55in; right: 0.55in; border: 0.6pt solid ${p.ink}; opacity: 0.45; }
/* front content */
.f-inner { position: absolute; top: 0.62in; bottom: 0.62in; left: 0.62in; right: 0.62in; display: flex; flex-direction: column; align-items: center; text-align: center; }
.f-author { margin-top: 0.5in; font-size: 13pt; letter-spacing: 0.34em; text-transform: uppercase; }
.f-rule { width: 0.9in; height: 1.4pt; background: ${p.accent}; margin: 0.5in 0; }
.f-title { font-size: 52pt; line-height: 1.0; margin: 0; }
.f-sub { margin-top: 0.14in; font-size: 12.5pt; font-style: italic; opacity: 0.86; }
.f-spacer { flex: 1; }
.f-vol { font-size: 15pt; letter-spacing: 0.16em; text-transform: uppercase; }
.f-era { font-size: 11.5pt; letter-spacing: 0.08em; margin-top: 0.1in; color: ${p.accent}; }
/* spine */
.spine-text { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; font-size: ${spineIn >= 0.55 ? '11pt' : '9pt'}; letter-spacing: 0.06em; display: flex; align-items: center; gap: 0.18in; }
.s-sep { opacity: 0.6; }
.s-vol { color: ${p.accent}; letter-spacing: 0.1em; }
/* back */
.b-inner { position: absolute; top: 0.62in; bottom: 0.62in; left: 0.62in; right: 0.62in; display: flex; flex-direction: column; }
.b-kicker { font-size: 11pt; letter-spacing: 0.28em; text-transform: uppercase; opacity: 0.8; }
.b-blurb { margin-top: 0.35in; font-size: 12pt; line-height: 1.5; max-width: 4.4in; }
.b-spacer { flex: 1; }
.b-meta { font-size: 10.5pt; letter-spacing: 0.04em; opacity: 0.85; }
.b-rule { width: 100%; height: 0.6pt; background: ${p.ink}; opacity: 0.35; margin: 0.18in 0; }
.b-imprint { font-size: 9.5pt; font-style: italic; opacity: 0.7; }
</style></head>
<body>
<div class="wrap">
  <div class="face back">
    ${ringMotif(p.motif, 'b')}
    <div class="frame"></div>
    <div class="b-inner">
      <div class="b-kicker">Collected Essays</div>
      <div class="b-blurb">The complete essays${author ? ` of ${author}` : ''}, gathered in ${totalVolumes ? `${toRoman(totalVolumes).toLowerCase() === 'iv' ? 'four' : totalVolumes} volumes` : 'a set'} and set in order, oldest to newest &mdash; the writing worth keeping on a shelf, to read, mark, and return to.</div>
      <div class="b-spacer"></div>
      <div class="b-rule"></div>
      <div class="b-meta">${setLabel}${era ? ` &nbsp;&middot;&nbsp; ${era}` : ''}</div>
      <div class="b-imprint">${bookTitle}${author ? ` &middot; ${author}` : ''}</div>
    </div>
  </div>
  <div class="spine">${spineInner}</div>
  <div class="face front">
    ${ringMotif(p.motif, 'f')}
    <div class="frame"></div>
    <div class="f-inner">
      ${author ? `<div class="f-author">${author}</div>` : ''}
      <div class="f-rule"></div>
      <div class="f-title">${bookTitle}</div>
      ${era ? `<div class="f-sub">${era}</div>` : ''}
      <div class="f-spacer"></div>
      <div class="f-vol">${escapeHtml(setLabel)}</div>
      ${era ? `<div class="f-era">${era}</div>` : ''}
    </div>
  </div>
</div>
</body></html>`;
}

/**
 * renderCoverPdf(html, outPath, { spineIn }) → { path, widthIn, heightIn }.
 * Renders one wrap page at (2×6.125 + spine)in × 9.25in.
 *
 * Two-pass, because Chromium's `page.pdf()` silently DROPS a large image that
 * is positioned at the right edge of a wide (>~13in) page — the full-bleed
 * painting on the front cover — while `page.screenshot()` paints it correctly.
 * So: (1) render the cover HTML and screenshot it at print DPI; (2) wrap that
 * single full-page raster in the PDF (a full-page image renders reliably in
 * page.pdf(), unlike a positioned one). The cover becomes a high-DPI raster —
 * standard for print covers, and Lulu-accepted (job 313313-class).
 */
export async function renderCoverPdf(html, outPath, opts = {}) {
  const spineIn = Number(opts.spineIn) || 0;
  const widthIn = coverWidthInches(spineIn);
  const scale = opts.scale || 3; // 96px/in × 3 ≈ 288 DPI
  const vpW = Math.round(widthIn * 96);
  const vpH = Math.round(COVER_HEIGHT_IN * 96);
  await mkdir(dirname(outPath), { recursive: true });
  const browser = opts.browser || await chromium.launch();
  try {
    // Pass 1 — render + screenshot the cover at print DPI.
    const ctx = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: vpW, height: vpH } });
    let shot;
    try {
      const page = await ctx.newPage();
      try {
        await page.setContent(html, { waitUntil: 'load', timeout: opts.timeoutMs ?? 60_000 });
        shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: vpW, height: vpH } });
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await ctx.close().catch(() => {});
    }

    // Pass 2 — wrap the full-page raster in a PDF at the exact physical size.
    const wrap = `<!doctype html><html><head><style>@page{size:${widthIn}in ${COVER_HEIGHT_IN}in;margin:0}html,body{margin:0;padding:0}img{width:${widthIn}in;height:${COVER_HEIGHT_IN}in;display:block}</style></head><body><img src="data:image/png;base64,${shot.toString('base64')}"></body></html>`;
    const page = await browser.newPage();
    try {
      await page.setContent(wrap, { waitUntil: 'load', timeout: opts.timeoutMs ?? 60_000 });
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, pageRanges: '1' });
      await writeFile(outPath, pdf);
    } finally {
      await page.close().catch(() => {});
    }
    return { path: outPath, widthIn, heightIn: COVER_HEIGHT_IN };
  } finally {
    if (!opts.browser) await browser.close().catch(() => {});
  }
}
