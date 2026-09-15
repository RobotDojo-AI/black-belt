/**
 * Drop-folder classifier.
 *
 * Returns: { doc_type, topic_t1, topic_t2, confidence, router }
 *
 * Strategy (fastest to slowest; each layer short-circuits):
 *   1. Filename patterns    — e.g. `tax_return*.pdf`, `receipt*.html`
 *   2. MIME / extension     — e.g. `.pdf`, `.csv`, `.jpg`, `.eml`
 *   3. Content sniffer      — first 1 KB: form numbers, ENV-var headers, ...
 *   4. LLM escalation       — only for deterministically-ambiguous files
 *
 * `router` is the logical router name (pdf, csv, image, archive, email,
 * credentials, generic). `topic_t1/t2` are ontology hints — routers may
 * override after deep extraction. No T3 — two tiers only.
 *
 * Invariant: returns a plain object. Never throws for unknown files; falls
 * back to `{doc_type:'other', router:'generic', confidence:0.1}`.
 * Ambiguous topic_t1/t2 are set to childless Uncategorized until
 * classification or recalc earns a sharper scope.
 */

import { readFile, stat } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { topicForDocType } from '../taxonomy.js';
import { unknownTopicPair } from '../topic-routing-policy.js';

// --- Filename patterns ------------------------------------------------------

const FILENAME_RULES = [
  // --- Import source file types (must precede document rules to short-circuit archive/email routers) ---
  // Google Takeout is a .zip/.tgz archive of Gmail/Calendar/Drive — route it to
  // the archive extractor (which unpacks and re-queues each inner file through
  // the full classify→route pipeline) instead of 'generic', which only indexed
  // the archive and never imported its contents. st_fcdbe84f AC7.
  { re: /takeout-\d{8}T\d{6}Z/i,
    doc_type: 'google_takeout',   router: 'archive', ...unknownTopicPair() },
  { re: /LinkedInDataExport/i,
    doc_type: 'linkedin_export',  router: 'generic', ...unknownTopicPair() },
  { re: /\.pst$/i,
    doc_type: 'email_archive',    router: 'generic', ...unknownTopicPair() },
  // Apple Health zip exports → archive router (extract first, then re-queue)
  { re: /apple[\s_-]?health.*\.zip$|^export\.zip$/i,
    doc_type: 'health_export',    router: 'archive', t1: 'personal', t2: 'health' },
  // Apple Health XML + re-queued FHIR clinical records → health router
  { re: /apple[\s_-]?health|^export\.xml$/i,
    doc_type: 'health_export',    router: 'health',  t1: 'personal', t2: 'health' },
  // Individual FHIR clinical record JSONs (re-queued after zip extraction)
  { re: /^(AllergyIntolerance|Condition|DiagnosticReport|DocumentReference|Immunization|MedicationRequest|Observation|Patient|Procedure)-[0-9A-Fa-f-]{36}\.json$/,
    doc_type: 'fhir_resource',    router: 'health',  t1: 'personal', t2: 'health' },
  { re: /(memories|grok[\s_-]?export|claude[\s_-]?export|chatgpt|openai[\s_-]?export).*\.(?:json|zip)$|conversations\.(?:json|jsonl)$/i,
    doc_type: 'llm_export',       router: 'llm_export', ...unknownTopicPair() },
  // --- Document types ---
  { re: /lab[\s_-]?results?|labcorp|quest[\s_-]?diagnostics|bloodwork|blood[\s_-]?work|blood[\s_-]?panel|lab[\s_-]?report|labresult/i,
    doc_type: 'lab_report',       router: 'pdf',   t1: 'personal', t2: 'health' },
  { re: /\blab\b|results?[\s_-]?\d{4}|panel[\s_-]?\d{4}/i,
    doc_type: 'lab_report',       router: 'pdf',   t1: 'personal', t2: 'health' },
  { re: /tax[\s_-]?return|form[\s_-]?1040|w-?2|1099-(MISC|INT|DIV|NEC|B|R)/i,
    doc_type: 'tax_return',       router: 'pdf',   t1: 'family',   t2: 'finances' },
  { re: /utility[\s_-]?bill|electric[\s_-]?bill|gas[\s_-]?bill|water[\s_-]?bill/i,
    doc_type: 'utility_bill',     router: 'pdf',   t1: 'family',   t2: 'home' },
  { re: /lease|rental[\s_-]?agreement/i,
    doc_type: 'lease',            router: 'pdf',   t1: 'family',   t2: 'home' },
  { re: /mortgage|closing[\s_-]?disclosure|promissory[\s_-]?note/i,
    doc_type: 'mortgage',         router: 'pdf',   t1: 'family',   t2: 'home' },
  { re: /insurance|policy/i,
    doc_type: 'insurance_policy', router: 'pdf',   t1: 'family',   t2: 'home' },
  { re: /passport|drivers?[\s_-]?license|state[\s_-]?id/i,
    doc_type: 'id_document',      router: 'pdf',   t1: 'family',   t2: 'home' },
  { re: /receipt|invoice|order[\s_-]?confirmation/i,
    doc_type: 'receipt',          router: 'pdf',   t1: 'family',   t2: 'finances' },
  { re: /contacts?\b|vcard/i,
    doc_type: 'contacts_csv',     router: 'csv',   ...unknownTopicPair() },
  { re: /credential|secrets?|api[\s_-]?keys?|\.env/i,
    doc_type: 'credentials',      router: 'credentials', t1: null, t2: null },
];

// --- Extension → router ----------------------------------------------------

const EXTENSION_ROUTER = {
  '.pdf':  { router: 'pdf',         doc_type: 'document' },
  '.doc':  { router: 'pdf',         doc_type: 'document' },
  '.docx': { router: 'pdf',         doc_type: 'document' },
  '.rtf':  { router: 'pdf',         doc_type: 'document' },
  '.xlsx': { router: 'xlsx',        doc_type: 'agency_xlsx' },
  '.xls':  { router: 'xlsx',        doc_type: 'agency_xlsx' },
  '.csv':  { router: 'csv',         doc_type: 'csv' },
  '.tsv':  { router: 'csv',         doc_type: 'csv' },
  '.jpg':  { router: 'image',       doc_type: 'photo' },
  '.jpeg': { router: 'image',       doc_type: 'photo' },
  '.png':  { router: 'image',       doc_type: 'photo' },
  '.heic': { router: 'image',       doc_type: 'photo' },
  '.tiff': { router: 'image',       doc_type: 'photo' },
  '.zip':  { router: 'archive',     doc_type: 'archive' },
  '.tar':  { router: 'archive',     doc_type: 'archive' },
  '.tgz':  { router: 'archive',     doc_type: 'archive' },
  '.gz':   { router: 'archive',     doc_type: 'archive' },
  '.eml':  { router: 'email',       doc_type: 'email' },
  '.mbox': { router: 'email',       doc_type: 'email_mbox' },
  '.env':  { router: 'credentials', doc_type: 'credentials' },
  '.key':  { router: 'credentials', doc_type: 'credentials' },
  '.pst':  { router: 'generic',     doc_type: 'email_archive' },
  '.xml':  { router: 'generic',     doc_type: 'document' },
  '.json': { router: 'generic',     doc_type: 'document' },
};

const MIME_ROUTER = {
  'application/pdf':              { router: 'pdf',      doc_type: 'document' },
  'text/csv':                     { router: 'csv',      doc_type: 'csv' },
  'message/rfc822':               { router: 'email',    doc_type: 'email' },
  'application/zip':              { router: 'archive',  doc_type: 'archive' },
  'application/x-tar':            { router: 'archive',  doc_type: 'archive' },
  'application/gzip':             { router: 'archive',  doc_type: 'archive' },
};

// --- Content sniffers -------------------------------------------------------

// Recognise a creds file: ≥ 2 lines that look like `FOO=bar` or `foo: bar`.
function looksLikeCredentials(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 2) return false;
  const kvLines = lines.filter(l => /^[A-Z][A-Z0-9_]{1,}\s*=\s*\S/.test(l)
                                 || /^[a-z][a-z0-9_-]{1,}\s*:\s*\S/.test(l));
  return kvLines.length >= 2 && kvLines.length / lines.length > 0.5;
}

// Recognise a contacts-style CSV header row.
function looksLikeContactsCsv(headerLine) {
  const h = headerLine.toLowerCase();
  return /(^|,)(first.?name|given.?name|name)(,|$)/.test(h)
      && (h.includes('email') || h.includes('phone') || h.includes('mobile'));
}

function sniffContent(text) {
  if (looksLikeCredentials(text))    return { router: 'credentials', doc_type: 'credentials', confidence: 0.98 };
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  if (looksLikeContactsCsv(firstLine)) return { router: 'csv', doc_type: 'contacts_csv', confidence: 0.9 };
  if (/form\s*1040|irs/i.test(text))   return { router: 'pdf', doc_type: 'tax_return',   confidence: 0.85 };
  return null;
}

// --- Main entry point ------------------------------------------------------

/**
 * Classify one file on disk.
 *   @param {string} filePath absolute path to the file
 *   @param {object} [opts]
 *   @param {string} [opts.mimeType] caller-provided mime hint
 */
export async function classifyFile(filePath, opts = {}) {
  const name = basename(filePath);
  const ext = extname(name).toLowerCase();

  // 1. Filename pattern
  for (const rule of FILENAME_RULES) {
    if (rule.re.test(name)) {
      return {
        doc_type:  rule.doc_type,
        router:    rule.router,
        topic_t1:  rule.t1,
        topic_t2:  rule.t2,
        confidence: 0.9,
      };
    }
  }

  // 2. Extension / MIME
  const mime = opts.mimeType || null;
  const byMime = mime ? MIME_ROUTER[mime] : null;
  const byExt = EXTENSION_ROUTER[ext] || null;
  const hit = byExt || byMime;
  if (hit) {
    // 3. Content sniff — only for text-ish files, to upgrade router when clear.
    if (['.csv', '.tsv', '.env', '.txt', ''].includes(ext) || (mime || '').startsWith('text/')) {
      const snippet = await readSnippet(filePath).catch(() => null);
      if (snippet) {
        const sniff = sniffContent(snippet);
        const topic = sniff ? topicForDocType(sniff.doc_type) : null;
        if (sniff) {
          return {
            doc_type:  sniff.doc_type,
            router:    sniff.router,
            topic_t1:  topic.t1,
            topic_t2:  topic.t2,
            confidence: sniff.confidence,
          };
        }
      }
    }
    const topic = topicForDocType(hit.doc_type);
    return {
      doc_type:  hit.doc_type,
      router:    hit.router,
      topic_t1:  topic.t1,
      topic_t2:  topic.t2,
      confidence: 0.3,
    };
  }

  // 4. Last-resort content sniff for unknown extensions.
  const snippet = await readSnippet(filePath).catch(() => null);
  if (snippet) {
    const sniff = sniffContent(snippet);
    const topic = sniff ? topicForDocType(sniff.doc_type) : null;
    if (sniff) {
      return {
        doc_type:  sniff.doc_type,
        router:    sniff.router,
        topic_t1:  topic.t1,
        topic_t2:  topic.t2,
        confidence: sniff.confidence,
      };
    }
  }

  const topic = unknownTopicPair();
  return {
    doc_type:  'other',
    router:    'generic',
    topic_t1:  topic.t1,
    topic_t2:  topic.t2,
    confidence: 0.1,
  };
}

async function readSnippet(path, bytes = 1024) {
  const s = await stat(path);
  const size = Math.min(bytes, s.size);
  if (size === 0) return '';
  const fh = await readFile(path, { encoding: 'utf8' });
  return fh.slice(0, size);
}
