/**
 * book-pdf.js — deterministic PDF inspection for the book engine + its tests.
 *
 * Compute tier: Tier 0 (local, deterministic — parse a rendered PDF). No LLM;
 * no DB writes. Both the engine's post-render verification and the AC test files
 * read real rendered PDFs through here, so the "does it open / how many pages /
 * what size / fonts embedded / TOC text" logic lives in one place.
 *
 * Page count + per-page text come from pdf-parse (pdfjs under the hood). The
 * media box and embedded-font signal are read from the raw bytes: Chromium's
 * page.pdf() writes each page's /MediaBox uncompressed and subsets every used
 * font with a 6-letter subset prefix + a /FontFile program, so both are
 * reliably visible in the raw stream.
 */
import { readFile } from 'node:fs/promises';

async function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return readFile(input);
}

/** { total, pages: [{ num, text }], text } — throws if the PDF cannot open. */
export async function readPdf(input) {
  const data = await toBuffer(input);
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return {
      total: Number(result.total) || (Array.isArray(result.pages) ? result.pages.length : 0),
      pages: Array.isArray(result.pages) ? result.pages : [],
      text: String(result.text || ''),
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/** Page count via the PDF page tree — proves the file opens with >0 pages. */
export async function pdfPageCount(input) {
  const { total } = await readPdf(input);
  return total;
}

/**
 * Media box of the first page in points and inches. Chromium writes an
 * uncompressed `/MediaBox [x0 y0 x1 y1]` per page, so a raw read is reliable.
 */
export async function pdfMediaBox(input) {
  const raw = (await toBuffer(input)).toString('latin1');
  const match = raw.match(/\/MediaBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/);
  if (!match) return null;
  const [x0, y0, x1, y1] = match.slice(1).map(Number);
  const widthPt = Math.abs(x1 - x0);
  const heightPt = Math.abs(y1 - y0);
  return {
    widthPt,
    heightPt,
    widthIn: widthPt / 72,
    heightIn: heightPt / 72,
  };
}

/**
 * Embedded-font check. Chromium subsets every used font with a 6-uppercase-letter
 * subset prefix (e.g. `AAAAAA+Georgia`) and writes an embedded font program
 * (/FontFile, /FontFile2, or /FontFile3). A non-embedded standard font would
 * carry a bare /BaseFont with no subset prefix and no font program — the #1 POD
 * rejection. Returns { ok, baseFonts, unembedded, hasFontProgram }.
 */
export async function pdfEmbeddedFonts(input) {
  const raw = (await toBuffer(input)).toString('latin1');
  const baseFonts = [...new Set(
    [...raw.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-.]+)/g)].map((m) => m[1]),
  )];
  const hasFontProgram = /\/FontFile[23]?\b/.test(raw);
  const unembedded = baseFonts.filter((name) => !/^[A-Z]{6}\+/.test(name));
  return {
    ok: baseFonts.length > 0 && unembedded.length === 0 && hasFontProgram,
    baseFonts,
    unembedded,
    hasFontProgram,
  };
}

/** Concatenated text of the whole document (all pages). */
export async function pdfText(input) {
  const { text } = await readPdf(input);
  return text;
}

/** Per-page text array, index 0 = page 1. */
export async function pdfPageTexts(input) {
  const { pages } = await readPdf(input);
  return pages
    .slice()
    .sort((a, b) => (a.num || 0) - (b.num || 0))
    .map((page) => String(page.text || ''));
}
