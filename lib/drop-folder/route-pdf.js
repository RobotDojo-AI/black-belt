/**
 * PDF / document router.
 *
 * Uses Jikan's existing `lib/doc-classify.js` + `lib/doc-extract.js` to
 * determine the document type and pull structured fields. Results feed the
 * `key_documents` table (migration 005) AND the drop-folder `files` index.
 *
 * Text extraction from PDFs is out-of-scope for this router — we feed
 * whatever plain text the caller gives us (watcher reads PDF with system
 * utilities on macOS or skips extraction cleanly). Text-less PDFs still
 * get a `doc_type='other'` row so the file is tracked + moved.
 */

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import db from '../db.js';
import { topicForDocType } from '../taxonomy.js';
import { classifyDocument } from '../doc-classify.js';
import { extractDocument } from '../doc-extract.js';
import { insertTimelineEventForDb } from '../timeline-schema.js';

// --- key_documents bridge --------------------------------------------------
//
// Matches the 005_key_documents.sql schema. Dedup key is `raw_text_hash`
// (UNIQUE index), so INSERT OR IGNORE is the safe upsert.

const insertKeyDoc = db.prepare(`
  INSERT OR IGNORE INTO key_documents
    (source_id, source_type, doc_type, extracted_json, extraction_confidence,
     extraction_model, raw_text_hash, received_at)
  VALUES (?, 'drop_folder', ?, ?, ?, ?, ?, datetime('now'))
`);

const keyDocByHash = db.prepare(`
  SELECT id, source_id, source_type, doc_type, extracted_json, received_at,
         extraction_confidence, extraction_model, raw_text_hash
  FROM key_documents
  WHERE raw_text_hash = ?
`);

function recordKeyDocumentTimeline(row) {
  if (!row) return;
  try {
    insertTimelineEventForDb(db, {
      sourceType: 'key_document',
      sourceId: String(row.id),
      eventDate: row.received_at || new Date().toISOString(),
      eventType: row.doc_type || 'key_document',
      summary: row.doc_type || 'Key document',
      content: row.extracted_json || '',
      metadata: {
        source_id: row.source_id || null,
        source_type: row.source_type || null,
        received_at: row.received_at || null,
        extraction_confidence: row.extraction_confidence ?? null,
        extraction_model: row.extraction_model || null,
        raw_text_hash: row.raw_text_hash || null,
      },
    });
  } catch { /* projection only — recalc can rebuild from key_documents */ }
}

// --- Text extraction -------------------------------------------------------
//
// For v1 we only try plain-text PDFs (rare in the typical corpus but easy) and
// `.txt`/`.doc`-as-text. Binary PDFs require pdftotext. If the caller runs
// on macOS, the watcher can preflight with `textutil`/`pdftotext` and hand
// us `opts.text`.

async function bestEffortText(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (['.txt', '.md', '.rtf'].includes(ext)) {
    return readFile(filePath, 'utf8').catch(() => '');
  }
  // Heuristic: try reading as UTF-8 and keep only printable ASCII/Latin.
  // For locked PDFs this yields garbage → classifier returns null → we
  // record the file as `doc_type='other'`.
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.replace(/[^\x20-\x7E\n\t\r]/g, ' ');
  } catch {
    return '';
  }
}

// --- Public entry ----------------------------------------------------------

/**
 * Route a document file. Never moves the file itself — returns metadata so
 * the watcher can move it to the ontology path and write the files row.
 */
export async function routePdf({ path: filePath, originalName, text }) {
  const body = text ?? (await bestEffortText(filePath));

  let classification = null;
  try {
    classification = body ? await classifyDocument(body, { filename: originalName }) : null;
  } catch (err) {
    console.warn(`[route-pdf] classify failed: ${err.message}`);
  }

  if (!classification) {
    const topic = topicForDocType('other');
    return {
      doc_type: 'other',
      topic_t1: topic.t1,
      topic_t2: topic.t2,
      extracted_json: null,
      entity_refs: null,
      confidence: 0.1,
    };
  }

  let extracted = null;
  try {
    extracted = await extractDocument(body, classification.doc_type, { filename: originalName });
  } catch (err) {
    console.warn(`[route-pdf] extract failed: ${err.message}`);
  }

  // Persist into key_documents (source-of-truth for downstream).
  // Dedup by SHA-256 of the extracted body text.
  const rawHash = body
    ? crypto.createHash('sha256').update(body).digest('hex')
    : crypto.createHash('sha256').update(filePath).digest('hex');
  try {
    const result = insertKeyDoc.run(
      filePath,
      classification.doc_type,
      extracted ? JSON.stringify(extracted) : '{}',
      classification.confidence ?? 0.5,
      classification.extraction_model || 'drop-folder-router',
      rawHash,
    );
    if (result.changes > 0) recordKeyDocumentTimeline(keyDocByHash.get(rawHash));
  } catch (err) {
    console.warn(`[route-pdf] key_documents insert failed: ${err.message}`);
  }

  return {
    doc_type: classification.doc_type,
    topic_t1: topicForDocType(classification.doc_type).t1,
    topic_t2: topicForDocType(classification.doc_type).t2,
    extracted_json: extracted ? JSON.stringify(extracted) : null,
    entity_refs: null,
    confidence: classification.confidence ?? 0.5,
  };
}
