/**
 * Email router (.eml / .mbox).
 *
 * v1: parse just the headers needed for classification (From, To, Subject,
 * Date). Ambiguous source files stay in Uncategorized; extracted messages and
 * entities carry the durable meaning.
 *
 * st_d142f701 AC19: also insert parsed messages into the `emails` table so
 * RAG / chat see drop-folder emails alongside live Gmail / Outlook syncs.
 * Rows are attached to stable `imports` provider accounts so Accounts can
 * show one line per archive source detected from user config, file names, or
 * sender domains.
 */

import { readFile } from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import db from '../db.js';
import { detectNewsletterFromLookup, parseAddressList } from '../email.js';
import { recordEmailParticipants } from '../people-seed.js';
import { insertTimelineEvent } from '../timeline-schema.js';
import { topicForDocType } from '../taxonomy.js';
import { unknownTopicPair } from '../topic-routing-policy.js';

const MAX_MBOX_MESSAGE_BYTES = 1_000_000;

function parseHeaders(text) {
  const end = text.search(/\r?\n\r?\n/);
  const head = end > -1 ? text.slice(0, end) : text.slice(0, 4096);
  const headers = {};
  let currentKey = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] += ' ' + line.trim();
      continue;
    }
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (!m) continue;
    currentKey = m[1].toLowerCase();
    headers[currentKey] = m[2].trim();
  }
  return headers;
}

// Return the body text — everything after the empty line that separates
// headers from body. Strips a trailing newline. No MIME decoding — the
// drop-folder path is a fallback ingestion surface; HTML and multipart parts
// are folded into one text block. Truncated to 100KB to bound row size.
function parseBody(text) {
  const end = text.search(/\r?\n\r?\n/);
  if (end < 0) return '';
  const body = text.slice(end).replace(/^\r?\n\r?\n/, '');
  return body.slice(0, 100_000).trim();
}

// Best-effort sender name + email parse. Mirrors lib/gmail-sync.js's parseSender
// but tolerates the broader format set seen in .eml exports.
function parseSenderField(from) {
  if (!from) return { name: '', email: '' };
  const m = String(from).match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);
  const email = (m?.[2] || from).trim().toLowerCase();
  return {
    name: (m?.[1] || from).trim(),
    email: email.includes('@') ? email : '',
  };
}

const insertDropFolderEmailStmt = db.prepare(`
  INSERT OR IGNORE INTO emails
    (id, thread_id, subject, sender, sender_email, snippet, body_text,
     labels, is_read, is_starred, received_at, synced_at, account_id,
     is_newsletter, list_unsubscribe)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
`);

const upsertImportAccountStmt = db.prepare(`
  INSERT INTO accounts
    (id, provider, vendor, type, email, display_name, status, metadata, created_at, updated_at)
  VALUES (?, 'imports', 'imports', 'email', ?, ?, 'active', ?, datetime('now'), datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    email = excluded.email,
    display_name = excluded.display_name,
    metadata = excluded.metadata,
    updated_at = datetime('now')
`);

const linkImportSourceStmt = db.prepare(`
  INSERT OR IGNORE INTO email_import_sources (email_id, account_id)
  VALUES (?, ?)
`);

let importLabelCache = null;

function loadImportLabels() {
  if (importLabelCache) return importLabelCache;
  const root = resolve(import.meta.dirname, '..', '..');
  const candidates = [
    resolve(root, 'user', 'imports', 'sources.json'),
    resolve(root, 'config', 'private.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const archive = parsed?.import_labels?.archive || parsed?.email_sources || parsed?.archive;
      if (archive && typeof archive === 'object') {
        importLabelCache = archive;
        return importLabelCache;
      }
    } catch { /* optional local config */ }
  }
  importLabelCache = {};
  return importLabelCache;
}

function slugify(value) {
  return String(value || 'imported-email')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'imported-email';
}

function labelFromFileName(name) {
  const raw = basename(String(name || 'Imported Email'))
    .replace(/\.(eml|mbox)$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const trimmed = raw
    .replace(/\b(historical|history|mail|email|emails|archive|archives|export|exports|takeout|mbox|eml)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (trimmed || raw || 'Imported Email')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function configuredSourceFromName(name) {
  const lower = basename(String(name || '')).toLowerCase();
  const compactName = lower.replace(/[^a-z0-9]/g, '');
  const labels = loadImportLabels();
  for (const [slug, info] of Object.entries(labels)) {
    const matchers = [
      slug,
      ...(Array.isArray(info?.aliases) ? info.aliases : []),
      ...(Array.isArray(info?.patterns) ? info.patterns : []),
    ].filter(Boolean);
    if (matchers.some((matcher) => {
      const value = String(matcher).toLowerCase();
      const compact = value.replace(/[^a-z0-9]/g, '');
      return lower.includes(value) || (compact && compactName.includes(compact));
    })) {
      return {
        slug,
        label: info?.name || labelFromFileName(slug),
        accountKey: info?.email || info?.account_key || slug,
      };
    }
  }
  return null;
}

function sourceFromEmailFile({ filePath, originalName, senderEmail, ext }) {
  const name = originalName || filePath;
  const configured = configuredSourceFromName(name);
  if (configured) return configured;

  // st_f1a40461: archive-extracted files are re-queued as "<archive>__<file>" by
  // route-archive. Group them under ONE account named for the archive (the import
  // source) so a Takeout/PST with many folders is one account, not one per folder.
  const baseName = basename(String(name));
  const sep = baseName.indexOf('__');
  if (sep > 0) {
    const archiveLabel = labelFromFileName(baseName.slice(0, sep));
    if (archiveLabel) {
      const configuredArchive = configuredSourceFromName(baseName.slice(0, sep));
      return configuredArchive || { slug: slugify(archiveLabel), label: archiveLabel, accountKey: slugify(archiveLabel) };
    }
  }

  if (ext === '.mbox') {
    const label = labelFromFileName(name);
    return { slug: slugify(label), label, accountKey: slugify(label) };
  }

  const domain = senderEmail && senderEmail.includes('@')
    ? senderEmail.slice(senderEmail.lastIndexOf('@') + 1).toLowerCase()
    : '';
  if (domain) {
    return { slug: slugify(domain), label: domain, accountKey: domain };
  }

  const label = labelFromFileName(name);
  return { slug: slugify(label), label, accountKey: slugify(label) };
}

function ensureImportAccount(source) {
  const slug = slugify(source?.slug || source?.label || source?.accountKey);
  const id = `imports:email:${slug}`;
  const label = source?.label || labelFromFileName(slug);
  const accountKey = source?.accountKey || slug;
  upsertImportAccountStmt.run(
    id,
    accountKey,
    label,
    JSON.stringify({ source: 'drop_folder_email', import_slug: slug, label }),
  );
  return id;
}

function linkImportSource(emailId, accountId) {
  if (!emailId || !accountId) return;
  linkImportSourceStmt.run(emailId, accountId);
}

/**
 * Build a stable content-hash id for a drop-folder email so re-drops of the
 * same .eml dedupe cleanly. Falls back from the RFC 5322 Message-Id to a
 * SHA-256 of (sender_email, subject, received_at, body prefix).
 */
function dropFolderEmailId(messageId, senderEmail, subject, receivedAt, body) {
  // trim BEFORE stripping brackets: a folded Message-Id header arrives as
  // " <id@host>" (parseHeaders joins continuations with a space), and without
  // the trim the `^<` strip never fires — 60 live rows were stored as
  // `dropfolder: <id@host`, unmatchable by any provider-side Message-ID
  // lookup (st_fd14cdd4 reopen; scripts/backfill-participants.js
  // dropfolderIdCandidates carries the legacy shape for those rows).
  const trimmed = String(messageId || '').trim();
  if (trimmed) return `dropfolder:${trimmed.replace(/^<|>$/g, '')}`;
  const seed = [senderEmail || '', subject || '', receivedAt || '', String(body || '').slice(0, 500)].join('|');
  return `dropfolder:${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

/**
 * Insert a parsed drop-folder email into the canonical `emails` table.
 * Uses INSERT OR IGNORE on a content-hashed id so dropping the same .eml
 * twice is a no-op. account_id is NULL (no live OAuth account attached).
 *
 * Exported for tests and for the .mbox loop below.
 *
 * @param {object} row
 * @param {string} [row.id] — pre-computed id (skip dedup hash)
 * @param {string} row.subject
 * @param {string} row.senderName
 * @param {string} row.senderEmail
 * @param {string} row.body
 * @param {string} row.receivedAt — ISO timestamp string
 * @param {string} row.messageId — RFC 5322 Message-Id (may be empty)
 * @param {string} row.listUnsubscribe — List-Unsubscribe header value (may be null)
 * @param {boolean} row.isNewsletter
 * @param {string} [row.accountId] — imports provider account id
 * @param {string[]} [row.labels] — JSON labels to store with the email
 * @returns {{id: string, inserted: boolean}}
 */
export function insertDropFolderEmail(row) {
  const id = row.id || dropFolderEmailId(
    row.messageId, row.senderEmail, row.subject, row.receivedAt, row.body
  );
  const result = insertDropFolderEmailStmt.run(
    id,
    id, // thread_id — drop-folder rows do not belong to a thread; reuse id
    row.subject || '',
    row.senderName || '',
    row.senderEmail || '',
    (row.body || '').slice(0, 240), // snippet
    row.body || '',
    JSON.stringify(row.labels || []),
    0,    // is_read
    0,    // is_starred
    row.receivedAt || new Date().toISOString(),
    row.accountId || null,
    row.isNewsletter ? 1 : 0,
    row.listUnsubscribe || null,
  );
  const inserted = result.changes > 0;
  if (inserted) {
    insertTimelineEvent({
      sourceType: 'email',
      sourceId: id,
      eventDate: row.receivedAt || new Date().toISOString(),
      eventType: 'email',
      summary: (row.subject || row.senderEmail || 'Imported email').slice(0, 220),
      content: `${row.subject || ''}\n${row.senderEmail || ''}`,
      metadata: { account_id: row.accountId || null, is_newsletter: !!row.isNewsletter, source: 'drop_folder_email' },
    });
  }

  // st_fd14cdd4 AC6: import participants (sender + To/Cc) into the universal
  // interchange + sender seeding — same pipeline as live Gmail/Outlook syncs.
  // Unconditional on purpose: every write inside is INSERT OR IGNORE /
  // link-on-hit, so a re-dropped .eml stays a no-op, and re-parsing a
  // retained source file back-fills To/Cc onto rows stored before
  // st_fd14cdd4 (the AC7 retroactive path depends on this).
  try {
    recordEmailParticipants(db, id, {
      sender: { email: row.senderEmail, name: row.senderName },
      to: row.to,
      cc: row.cc,
    }, { isNewsletter: !!row.isNewsletter, source: 'email' });
  } catch (err) {
    console.warn(`[drop-folder:email] participant insert failed for ${id}: ${err.message}`);
  }
  return { id, inserted };
}

function senderDomain(from) {
  if (!from) return null;
  const m = from.match(/<([^>]+)>/) || from.match(/([^\s]+@[^\s]+)/);
  if (!m) return null;
  const email = m[1];
  const at = email.lastIndexOf('@');
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

function topicFromDomain(domain) {
  if (!domain) return unknownTopicPair();
  // Free-mail is a source signal, not proof the memory belongs under Personal.
  if (/^(gmail|yahoo|hotmail|outlook|proton|icloud)\.com$/.test(domain)) {
    return unknownTopicPair();
  }
  return { t1: 'work', t2: 'current-role' };
}

/**
 * Split an mbox file into individual RFC 5322 messages on `From ` boundary
 * lines (the historical mbox separator). Trailing newlines are trimmed.
 */
function buildEmailRow(text) {
  const headers = parseHeaders(text);
  const body = parseBody(text);
  const sender = parseSenderField(headers.from);
  const listUnsub = headers['list-unsubscribe'] || null;
  const lookup = (name) => headers[name.toLowerCase()] || null;
  const isNewsletter = detectNewsletterFromLookup(lookup, listUnsub, sender.email);
  const receivedAt = headers.date
    ? (() => { try { return new Date(headers.date).toISOString(); } catch { return new Date().toISOString(); } })()
    : new Date().toISOString();
  return {
    subject: headers.subject || '',
    senderName: sender.name,
    senderEmail: sender.email,
    body,
    receivedAt,
    messageId: headers['message-id'] || '',
    listUnsubscribe: listUnsub,
    isNewsletter,
    // st_fd14cdd4 AC6: To/Cc parsed from the already-parsed headers map so
    // import participants reach the universal interchange like live syncs.
    to: parseAddressList(headers.to),
    cc: parseAddressList(headers.cc),
  };
}

/**
 * Stream mbox messages without loading the archive into memory.
 *
 * A malformed or attachment-heavy message should not poison the whole import:
 * we cap the retained raw text for each message, keep scanning to the next
 * boundary, and let the caller count bad/truncated messages as skipped.
 */
async function streamMboxMessages(filePath, onMessage) {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let current = [];
  let currentBytes = 0;
  let truncated = false;

  async function flush() {
    if (!current.length) return;
    const text = current.join('\n');
    current = [];
    currentBytes = 0;
    const wasTruncated = truncated;
    truncated = false;
    if (text.trim()) await onMessage(text, { truncated: wasTruncated });
  }

  for await (const line of rl) {
    if (/^From /.test(line) && current.length > 0) {
      await flush();
      continue;
    }

    if (!truncated) {
      const nextBytes = currentBytes + Buffer.byteLength(line, 'utf8') + 1;
      if (nextBytes <= MAX_MBOX_MESSAGE_BYTES) {
        current.push(line);
        currentBytes = nextBytes;
      } else {
        truncated = true;
      }
    }
  }

  await flush();
}

export async function routeEmail({ path: filePath, originalName = null }) {
  const ext = extname(filePath).toLowerCase();
  const fileSource = configuredSourceFromName(originalName || filePath);

  if (ext === '.mbox') {
    const source = fileSource || sourceFromEmailFile({ filePath, originalName, senderEmail: '', ext });
    const accountId = ensureImportAccount(source);
    let inserted = 0;
    let skipped = 0;
    let seen = 0;
    let truncated = 0;
    let firstHeaders = null;

    try {
      await streamMboxMessages(filePath, (msg, info) => {
        seen++;
        try {
          if (!firstHeaders) firstHeaders = parseHeaders(msg);
          const row = buildEmailRow(msg);
          if (!row.senderEmail && !row.subject) {
            skipped++;
            return;
          }
          const { inserted: ok } = insertDropFolderEmail({
            ...row,
            accountId,
            labels: ['import', source.slug],
          });
          linkImportSource(row.id || dropFolderEmailId(row.messageId, row.senderEmail, row.subject, row.receivedAt, row.body), accountId);
          if (ok) inserted++;
          else skipped++;
          if (info?.truncated) truncated++;
        } catch (err) {
          skipped++;
        }
      });
    } catch (err) {
      const topic = topicForDocType('email_mbox');
      return {
        doc_type: 'email_mbox',
        topic_t1: topic.t1,
        topic_t2: topic.t2,
        extracted_json: JSON.stringify({
          import_source: source.label,
          account_id: accountId,
          emails_inserted: inserted,
          emails_skipped: skipped,
          emails_truncated: truncated,
          emails_seen: seen,
        }),
        entity_refs: null,
        confidence: inserted > 0 ? 0.6 : 0,
        error: `mbox stream failed: ${err.message}`,
      };
    }

    const topic = topicForDocType('email_mbox');
    return {
      doc_type: 'email_mbox',
      topic_t1: topic.t1,
      topic_t2: topic.t2,
      extracted_json: JSON.stringify({
        from: firstHeaders?.from || null,
        to: firstHeaders?.to || null,
        subject: firstHeaders?.subject || null,
        date: firstHeaders?.date || null,
        message_id: firstHeaders?.['message-id'] || null,
        sender_domain: firstHeaders ? senderDomain(firstHeaders.from) : null,
        import_source: source.label,
        account_id: accountId,
        emails_inserted: inserted,
        emails_skipped: skipped,
        emails_truncated: truncated,
        emails_seen: seen,
      }),
      entity_refs: null,
      confidence: inserted > 0 ? 0.75 : 0.4,
    };
  }

  let text = '';
  try { text = await readFile(filePath, 'utf8'); }
  catch (err) {
    const topic = topicForDocType(ext === '.mbox' ? 'email_mbox' : 'email');
    return {
      doc_type: ext === '.mbox' ? 'email_mbox' : 'email',
      topic_t1: topic.t1,
      topic_t2: topic.t2,
      extracted_json: null, entity_refs: null, confidence: 0,
      error: `read failed: ${err.message}`,
    };
  }

  const headers = parseHeaders(text);
  const domain = senderDomain(headers.from);
  const topic = topicFromDomain(domain);

  // st_d142f701 AC19: insert into the `emails` table so drop-folder emails
  // become visible to RAG / chat the same way Gmail and Outlook syncs do.
  // INSERT OR IGNORE on a content-hashed id makes the operation idempotent:
  // dropping the same .eml twice is a no-op. For .mbox, every message is
  // inserted via the same path; the split is on "From " separator lines.
  let inserted = 0;
  let skipped = 0;
  let sourceLabel = fileSource?.label || null;
  let accountId = null;
  try {
    const row = buildEmailRow(text);
    if (row.senderEmail || row.subject) {
      const source = fileSource || sourceFromEmailFile({ filePath, originalName, senderEmail: row.senderEmail, ext });
      sourceLabel = source.label;
      accountId = ensureImportAccount(source);
      const { inserted: ok } = insertDropFolderEmail({
        ...row,
        accountId,
        labels: ['import', source.slug],
      });
      linkImportSource(row.id || dropFolderEmailId(row.messageId, row.senderEmail, row.subject, row.receivedAt, row.body), accountId);
      if (ok) inserted++;
      else skipped++;
    } else {
      skipped++;
    }
  } catch (err) {
    console.warn(`[drop-folder:email] insert into emails failed: ${err.message}`);
    skipped++;
  }

  return {
    doc_type: ext === '.mbox' ? 'email_mbox' : 'email',
    topic_t1: topic.t1,
    topic_t2: topic.t2,
    extracted_json: JSON.stringify({
      from: headers.from || null,
      to: headers.to || null,
      subject: headers.subject || null,
      date: headers.date || null,
      message_id: headers['message-id'] || null,
      sender_domain: domain,
      import_source: sourceLabel,
      account_id: accountId,
      emails_inserted: inserted,
      emails_skipped: skipped,
      emails_seen: inserted + skipped,
    }),
    entity_refs: null,
    confidence: domain ? 0.75 : 0.4,
  };
}
