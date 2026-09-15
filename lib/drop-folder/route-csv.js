/**
 * CSV router.
 *
 * Sniffs the header row to decide:
 *   - contacts   → name/email/phone columns  → entities + Uncategorized
 *   - receipts   → merchant/amount/date      → family/finances
 *   - generic    → everything else           → Uncategorized
 */

import { readFile } from 'node:fs/promises';
import { topicForDocType } from '../taxonomy.js';

function firstLine(text) {
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

function splitCsvLine(line) {
  return line.split(',').map(s => s.trim().replace(/^["']+|["']+$/g, '').toLowerCase());
}

function looksLikeContacts(headers) {
  const hasName = headers.some(h => /^(first.?name|given.?name|name|full.?name)$/.test(h));
  const hasContact = headers.some(h => /email|phone|mobile|tel/.test(h));
  return hasName && hasContact;
}

function looksLikeReceipts(headers) {
  const hasMerchant = headers.some(h => /merchant|vendor|store|payee|description/.test(h));
  const hasAmount = headers.some(h => /amount|total|price|charge|cost/.test(h));
  const hasDate = headers.some(h => /date|time|when/.test(h));
  return hasMerchant && hasAmount && hasDate;
}

export async function routeCsv({ path: filePath }) {
  let text = '';
  try { text = await readFile(filePath, 'utf8'); }
  catch (err) {
    const topic = topicForDocType('csv');
    return {
      doc_type: 'csv',
      topic_t1: topic.t1,
      topic_t2: topic.t2,
      extracted_json: null,
      entity_refs: null,
      confidence: 0,
      error: `read failed: ${err.message}`,
    };
  }

  const headerLine = firstLine(text);
  const headers = splitCsvLine(headerLine);
  const rowCount = Math.max(0, text.split(/\r?\n/).filter(Boolean).length - 1);

  if (looksLikeContacts(headers)) {
    const topic = topicForDocType('contacts_csv');
    return {
      doc_type: 'contacts_csv',
      topic_t1: topic.t1,
      topic_t2: topic.t2,
      extracted_json: JSON.stringify({ headers, row_count: rowCount }),
      entity_refs: null,
      confidence: 0.9,
    };
  }

  if (looksLikeReceipts(headers)) {
    const topic = topicForDocType('receipts_csv');
    return {
      doc_type: 'receipts_csv',
      topic_t1: topic.t1,
      topic_t2: topic.t2,
      extracted_json: JSON.stringify({ headers, row_count: rowCount }),
      entity_refs: null,
      confidence: 0.9,
    };
  }

  const topic = topicForDocType('csv');
  return {
    doc_type: 'csv',
    topic_t1: topic.t1,
    topic_t2: topic.t2,
    extracted_json: JSON.stringify({ headers, row_count: rowCount }),
    entity_refs: null,
    confidence: 0.4,
    prompt_user: 'Unrecognized CSV — tell me what this is (contacts, receipts, etc.)',
  };
}
