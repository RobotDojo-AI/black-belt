/**
 * PDF OCR via pdftoppm + Claude Haiku vision.
 *
 * Used as a fallback when pdf-parse returns insufficient text (scanned/image PDFs).
 * Renders pages at 300 DPI (minimum for reliable accuracy) and sends up to 6 pages
 * to Claude Haiku with a vision prompt, returning the same structured lab result
 * format that the text-based extraction pipeline expects.
 *
 * Prerequisites: `pdftoppm` must be installed (brew install poppler).
 *
 * @module health-pdf-ocr
 */

// INTELLIGENCE_TIER: extraction — Haiku vision OCR returns the same
// structured lab-result fields the deterministic pdf-parse path would; a
// closed extraction, not freeform synthesis.
export const INTELLIGENCE_TIER = 'extraction';

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { llmCreate } from './llm-gateway.js';
import { modelFor } from './model-lane.js';

const OCR_PROMPT = `Extract ALL lab test results from the following lab report images.

Return a JSON array. Each element must have:
- "name": exact test name as shown in the report
- "value": numeric value only (number, no units)
- "unit": unit of measurement (string)
- "date": collection date in YYYY-MM-DD format (use the date hint if not visible)
- "ref_low": lower bound of reference range (number or null)
- "ref_high": upper bound of reference range (number or null)
- "flag": "H" if high, "L" if low, "N" if normal, null if not indicated

Rules:
- Include EVERY numeric result — vitals, lab panels, urine studies, bone density, body composition
- If date not found in images, use the date hint provided
- If this is not a lab report or has no numeric values, return []
- Return ONLY the JSON array, no prose, no code fences`;

/**
 * OCR a PDF file by rendering pages as images and sending to Claude Haiku vision.
 *
 * @param {string} filePath - absolute path to the PDF
 * @param {string} dateHint - fallback date in YYYY-MM-DD format
 * @returns {Promise<Array|null>} parsed lab results array, or null on failure
 */
export async function ocrPdf(filePath, dateHint) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdf-ocr-'));
  try {
    execFileSync('pdftoppm', ['-r', '300', '-png', '-l', '10', filePath, join(tmpDir, 'page')], { timeout: 30000 });
    const pages = readdirSync(tmpDir).filter(f => f.endsWith('.png')).sort();
    if (pages.length === 0) return null;

    const imageContent = pages.slice(0, 6).map(p => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: readFileSync(join(tmpDir, p)).toString('base64') },
    }));

    const msg = await llmCreate({
      model: modelFor('fast'),
      max_tokens: 4096,
      system: OCR_PROMPT,
      messages: [{ role: 'user', content: [...imageContent, { type: 'text', text: `Date hint: ${dateHint}` }] }],
    }, 'health-pdf-ocr');
    const raw = msg.content[0]?.text || '[]';
    const stripped = raw.replace(/```(?:json)?\n?/g, '').trim();
    const arrMatch = stripped.match(/\[[\s\S]*\]/);
    const jsonStr = arrMatch ? arrMatch[0] : stripped;
    try { return JSON.parse(jsonStr); } catch { return []; }
  } catch (e) {
    return null;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
