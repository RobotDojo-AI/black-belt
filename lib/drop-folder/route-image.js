/**
 * Image router.
 *
 * v1: no heavyweight EXIF library — we pull the minimal fields we need
 * (DateTimeOriginal) by scanning the JPEG APP1/EXIF marker directly.
 * Failure modes are fine; we still record the file.
 *
 * Placement: Uncategorized until a stronger classifier or user
 * action proves a personal hobby scope. Capture date is stored in extracted_json.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { unknownTopicPair } from '../topic-routing-policy.js';

const DATE_TAGS_RE = /(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/;

async function sniffCaptureDate(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (!['.jpg', '.jpeg'].includes(ext)) return null;
  try {
    const buf = await readFile(filePath);
    // Search the first 128 KB only — EXIF lives at the start of the file.
    const head = buf.subarray(0, Math.min(buf.length, 128 * 1024)).toString('latin1');
    const match = head.match(DATE_TAGS_RE);
    if (!match) return null;
    const [, y, m, d, hh, mm, ss] = match;
    return { year: y, month: m, day: d, iso: `${y}-${m}-${d}T${hh}:${mm}:${ss}` };
  } catch {
    return null;
  }
}

export async function routeImage({ path: filePath }) {
  const date = await sniffCaptureDate(filePath);
  const topic = unknownTopicPair();

  return {
    doc_type: 'photo',
    topic_t1: topic.t1,
    topic_t2: topic.t2,
    extracted_json: date ? JSON.stringify({ captured_at: date.iso }) : null,
    entity_refs: null,
    confidence: date ? 0.8 : 0.4,
  };
}
