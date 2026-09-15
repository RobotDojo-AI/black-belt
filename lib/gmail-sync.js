/**
 * Gmail sync pipeline — fetches messages, stores in emails table, resolves
 * senders into the people graph.
 *
 * INSERT OR IGNORE on the emails table makes every sync idempotent. Body
 * text is preferred over HTML; HTML is stripped when text is absent.
 * Newsletters (List-Unsubscribe header present) are stored but skipped for
 * entity resolution.
 */

import db from './db.js';
import { getValidAccessToken, listConnectedGoogleAccounts } from './google-oauth.js';
import { parseAddressList } from './email.js';
import { recordEmailParticipants } from './people-seed.js';
import { insertTimelineEvent } from './timeline-schema.js';

// st_fd14cdd4: parseAddressList moved to lib/email.js (shared with the
// drop-folder import path). Re-exported here for existing importers
// (scripts/backfill-email-participants.js, tests).
export { parseAddressList } from './email.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const LIST_PAGE_SIZE = 100;
const BODY_CONCURRENCY = 10;

async function gmailGet(accessToken, path) {
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function decodeBase64Url(str) {
  if (!str) return '';
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extractBody(payload) {
  let text = '', html = '';
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (payload.mimeType === 'text/plain') text = decoded;
    else if (payload.mimeType === 'text/html') html = decoded;
  }
  for (const part of payload.parts || []) {
    const { text: t, html: h } = extractBody(part);
    if (t && !text) text = t;
    if (h && !html) html = h;
  }
  return { text, html };
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function findHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

/**
 * Detect newsletter / transactional emails from the full RFC signal set.
 *
 * WHY widened from List-Unsubscribe-only (story st_1027f38e):
 *   The original predicate caught the dominant newsletter class but missed
 *   transactional mail (Auto-Submitted receipts, Precedence: bulk system
 *   notifications, Feedback-ID feedback-loop mailers, X-Auto-Response-
 *   Suppress no-reply machines, noreply@ sender local-parts). Tantei found
 *   148,161 newsletter chunks already embedded — but transactional was
 *   uncounted because the flag never matched it. Widening here flips the
 *   is_newsletter flag on every signal class so the existing chunk-worker
 *   SQL pre-filter `is_newsletter=0 AND list_unsubscribe IS NULL` catches
 *   all junk classes uniformly.
 *
 * WHY UNION-additive (not replacement): the original List-Unsubscribe path
 *   continues to flag the same set it always did; the four additional RFC
 *   signals and the noreply sender check are new conditions joined with OR.
 *   Existing rows in `emails` keep their current is_newsletter value —
 *   widening only affects newly-synced emails per the failure-manifest
 *   contract.
 *
 * @returns {boolean}
 */
function detectNewsletter(headers, listUnsub, senderEmail) {
  if (listUnsub) return true;
  if (findHeader(headers, 'List-Id')) return true;
  if (findHeader(headers, 'Feedback-ID')) return true;

  // RFC 3834: Auto-Submitted MAY be "no" (= human-authored) or any other
  // value indicating an automaton sent the message. Anything not literally
  // "no" or empty means automated.
  const autoSub = findHeader(headers, 'Auto-Submitted');
  if (autoSub && autoSub.toLowerCase().trim() !== 'no') return true;

  // Precedence: bulk|list|junk indicates a mailing-list / bulk system
  // message per RFC 2076 de-facto usage.
  const precedence = findHeader(headers, 'Precedence');
  if (precedence && /^(bulk|list|junk)$/i.test(precedence.trim())) return true;

  // X-Auto-Response-Suppress: DR|AutoReply|All|OOF|NDR|RN — Microsoft Exchange
  // header used by senders that expect no auto-responses; signals the message
  // itself is automated.
  const xAuto = findHeader(headers, 'X-Auto-Response-Suppress');
  if (xAuto && /\b(DR|AutoReply|All|NDR|OOF|RN)\b/i.test(xAuto)) return true;

  // Sender local-part: noreply / no-reply / donotreply / do-not-reply.
  if (senderEmail) {
    const at = senderEmail.lastIndexOf('@');
    const local = (at > 0 ? senderEmail.slice(0, at) : senderEmail).toLowerCase();
    if (/(noreply|no-reply|donotreply|do-not-reply)/.test(local)) return true;
  }

  return false;
}

function parseSender(from) {
  const m = from.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);
  return {
    name:  m?.[1]?.trim() || from,
    email: m?.[2]?.trim() || from,
  };
}

export function parseGmailReceivedAt(dateHeader, internalDate, now = Date.now()) {
  const minPlausibleMs = Date.parse('1990-01-01T00:00:00Z');
  const internalMs = Number.parseInt(String(internalDate || ''), 10);
  const fallback = Number.isFinite(internalMs) && internalMs >= minPlausibleMs
    ? new Date(internalMs).toISOString()
    : new Date(now).toISOString();

  if (!dateHeader) return fallback;
  const parsedMs = new Date(dateHeader).getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (!Number.isFinite(parsedMs)) return fallback;
  if (parsedMs < minPlausibleMs || parsedMs > now + oneDayMs) return fallback;
  return new Date(parsedMs).toISOString();
}

export function isImpossibleGmailReceivedAt(value, now = Date.now()) {
  const ms = new Date(value || '').getTime();
  const minPlausibleMs = Date.parse('1990-01-01T00:00:00Z');
  const oneDayMs = 24 * 60 * 60 * 1000;
  return !Number.isFinite(ms) || ms < minPlausibleMs || ms > now + oneDayMs;
}

function existingEmailRowsById(ids) {
  const rows = new Map();
  const batchSize = 500;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    if (!batch.length) continue;
    const placeholders = batch.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT id, received_at FROM emails WHERE id IN (${placeholders})`).all(...batch)) {
      rows.set(row.id, row);
    }
  }
  return rows;
}

const getExistingEmail = db.prepare('SELECT id, received_at FROM emails WHERE id = ?');

const updateEmailReceivedAt = db.prepare(`
  UPDATE emails SET received_at = ? WHERE id = ?
`);

const insertEmail = db.prepare(`
  INSERT OR IGNORE INTO emails
    (id, thread_id, subject, sender, sender_email, snippet, body_text,
     labels, is_read, is_starred, received_at, account_id, is_newsletter, list_unsubscribe)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function recordEmailTimeline({ id, subject, senderEmail, receivedAt, accountId, isNewsletter }) {
  if (!id || !receivedAt) return;
  insertTimelineEvent({
    sourceType: 'email',
    sourceId: id,
    eventDate: receivedAt,
    eventType: 'email',
    summary: (subject || senderEmail || 'Email').slice(0, 220),
    content: `${subject || ''}\n${senderEmail || ''}`,
    metadata: { account_id: accountId || null, is_newsletter: !!isNewsletter },
  });
}

export async function syncGmailAccount(email, opts = {}) {
  const { fullSync = false, maxMessages = fullSync ? null : 500, since } = opts;
  const stats = { synced: 0, skipped: 0, errors: 0, repaired: 0, remaining: 0 };

  let accessToken;
  try {
    accessToken = await getValidAccessToken(email);
  } catch (err) {
    console.error(`[gmail-sync] auth failed for ${email}: ${err.message}`);
    db.prepare(`UPDATE accounts SET last_error=? WHERE vendor='google' AND type='email' AND email=?`)
      .run(err.message.slice(0, 500), email);
    return { ...stats, error: err.message };
  }
  if (!accessToken) {
    console.warn(`[gmail-sync] no valid token for ${email}`);
    db.prepare(`UPDATE accounts SET last_error='no_token' WHERE vendor='google' AND type='email' AND email=?`)
      .run(email);
    return { ...stats, error: 'no_token' };
  }

  const accountRow = db.prepare(
    `SELECT id FROM accounts WHERE vendor = 'google' AND type = 'email' AND email = ? LIMIT 1`
  ).get(email);
  const accountId = accountRow?.id || null;
  try {
    const profile = await gmailGet(accessToken, '/profile');
    const available = Number(profile?.messagesTotal);
    if (Number.isFinite(available)) stats.available = available;
  } catch (err) {
    stats.profile_error = err.message;
  }

  const queryParts = [];
  if (!fullSync && since) {
    const afterDate = Math.floor(since.getTime() / 1000);
    queryParts.push(`after:${afterDate}`);
  }
  // st_f1a40461: explicit historical window backfill. Routine syncs only move
  // FORWARD (after: a recent date) and the first sync caps the fetch newest-first,
  // so pre-2015 history is never reached. A `before:` window (with maxMessages
  // null) pulls that backlog: e.g. {before: 2015-01-01} fetches everything older.
  if (opts.before instanceof Date) queryParts.push(`before:${Math.floor(opts.before.getTime() / 1000)}`);
  if (opts.after instanceof Date) queryParts.push(`after:${Math.floor(opts.after.getTime() / 1000)}`);
  const q = queryParts.join(' ');

  const messageIds = [];
  let pageToken = null;
  const hasCap = Number.isFinite(maxMessages) && maxMessages > 0;
  let nextListLog = 1000;

  while (!hasCap || messageIds.length < maxMessages) {
    const remaining = hasCap ? maxMessages - messageIds.length : LIST_PAGE_SIZE;
    const batchSize = Math.min(LIST_PAGE_SIZE, remaining);
    const qs = new URLSearchParams({ maxResults: String(batchSize) });
    if (opts.includeSpamTrash !== false) qs.set('includeSpamTrash', 'true');
    if (q) qs.set('q', q);
    if (pageToken) qs.set('pageToken', pageToken);

    let page;
    try {
      page = await gmailGet(accessToken, `/messages?${qs}`);
    } catch (err) {
      console.error(`[gmail-sync] list failed: ${err.message}`);
      stats.errors++;
      break;
    }

    if (!page.messages?.length) break;
    for (const m of page.messages) messageIds.push(m.id);
    if (fullSync && messageIds.length >= nextListLog) {
      console.info(`[gmail-sync] ${email}: listed=${messageIds.length}`);
      nextListLog += 1000;
    }
    pageToken = page.nextPageToken || null;
    if (!pageToken) break;
  }

  const existingById = fullSync ? existingEmailRowsById(messageIds) : new Map();
  const rawFetchTargetIds = fullSync
    ? messageIds.filter((id) => {
      const existing = existingById.get(id);
      return !existing || isImpossibleGmailReceivedAt(existing.received_at);
    })
    : messageIds;
  const maxFetchMessages = Number.isFinite(opts.maxFetchMessages) && opts.maxFetchMessages > 0
    ? Math.floor(opts.maxFetchMessages)
    : null;
  const fetchTargetIds = maxFetchMessages
    ? rawFetchTargetIds.slice(0, maxFetchMessages)
    : rawFetchTargetIds;
  if (fullSync) {
    const skippedExisting = messageIds.length - rawFetchTargetIds.length;
    stats.remaining = rawFetchTargetIds.length - fetchTargetIds.length;
    stats.skipped += skippedExisting;
    console.info(`[gmail-sync] ${email}: skipped_existing=${skippedExisting} fetch=${fetchTargetIds.length}/${messageIds.length} remaining=${stats.remaining}`);
  }

  const chunks = [];
  for (let i = 0; i < fetchTargetIds.length; i += BODY_CONCURRENCY) {
    chunks.push(fetchTargetIds.slice(i, i + BODY_CONCURRENCY));
  }

  let nextBodyLog = 100;
  for (const chunk of chunks) {
    const fetched = await Promise.allSettled(
      chunk.map(id => gmailGet(accessToken, `/messages/${id}?format=full`))
    );

    for (const result of fetched) {
      if (result.status === 'rejected') {
        stats.errors++;
        continue;
      }
      const msg = result.value;

      const headers    = msg.payload?.headers || [];
      const subject    = findHeader(headers, 'Subject');
      const from       = findHeader(headers, 'From');
      const date       = findHeader(headers, 'Date');
      const listUnsub  = findHeader(headers, 'List-Unsubscribe') || null;
      // Story st_87a0d072 Phase 1: capture To/Cc/Bcc into email_participants.
      // WHY all three: a relationship signal requires knowing WHO else was on
      // the thread, not just who sent it. CC frequency in particular is a
      // weak-but-present tie-strength signal (Granovetter / Gilbert & Karahalios).
      const toHeader   = findHeader(headers, 'To') || '';
      const ccHeader   = findHeader(headers, 'Cc') || '';
      const bccHeader  = findHeader(headers, 'Bcc') || '';
      const sender     = parseSender(from);
      const labels     = JSON.stringify(msg.labelIds || []);
      const isRead     = !(msg.labelIds || []).includes('UNREAD') ? 1 : 0;
      const isStarred  = (msg.labelIds || []).includes('STARRED') ? 1 : 0;
      const isNewsletter = detectNewsletter(headers, listUnsub, sender.email) ? 1 : 0;
      const receivedAt = parseGmailReceivedAt(date, msg.internalDate);

      const existing = existingById.get(msg.id) || getExistingEmail.get(msg.id);
      if (existing) {
        if (isImpossibleGmailReceivedAt(existing.received_at)) {
          updateEmailReceivedAt.run(receivedAt, msg.id);
          recordEmailTimeline({ id: msg.id, subject, senderEmail: sender.email, receivedAt, accountId, isNewsletter });
          stats.repaired++;
        }
        stats.skipped++;
        continue;
      }

      const { text, html } = extractBody(msg.payload || {});
      const bodyText = text || (html ? stripHtml(html) : '');

      insertEmail.run(
        msg.id, msg.threadId || '', subject, sender.name, sender.email,
        msg.snippet || '', bodyText, labels, isRead, isStarred,
        receivedAt, accountId, isNewsletter, listUnsub
      );
      stats.synced++;
      recordEmailTimeline({ id: msg.id, subject, senderEmail: sender.email, receivedAt, accountId, isNewsletter });

      // Participants + sender seeding — the shared interchange module
      // (st_fd14cdd4 AC6; behavior-preserving refactor of the inline
      // st_87a0d072 logic: sender + every parsed To/Cc/Bcc into
      // email_participants, non-newsletter sender resolved create-or-link).
      try {
        recordEmailParticipants(db, msg.id, {
          sender: { email: sender.email, name: sender.name },
          to: parseAddressList(toHeader),
          cc: parseAddressList(ccHeader),
          bcc: parseAddressList(bccHeader),
        }, { isNewsletter: !!isNewsletter, source: 'email' });
      } catch (err) {
        // Non-fatal: email row is already inserted; participants are an additive index.
        console.warn(`[gmail-sync] participant insert failed for ${msg.id}: ${err.message}`);
      }
    }
    const processed = stats.synced + stats.skipped + stats.errors;
    if (fullSync && processed >= nextBodyLog) {
      console.info(`[gmail-sync] ${email}: processed=${processed}/${messageIds.length} synced=${stats.synced} skipped=${stats.skipped} repaired=${stats.repaired} errors=${stats.errors} remaining=${stats.remaining}`);
      nextBodyLog += 100;
    }
  }

  console.info(`[gmail-sync] ${email}: synced=${stats.synced} skipped=${stats.skipped} repaired=${stats.repaired} errors=${stats.errors} remaining=${stats.remaining}`);
  if (accountId) {
    const imported = db.prepare(`SELECT COUNT(*) AS c FROM emails WHERE account_id=?`).get(accountId)?.c || 0;
    stats.imported = imported;
    if (Number.isFinite(stats.available)) {
      const coverageRemaining = Math.max(0, stats.available - imported);
      stats.remaining = Math.max(stats.remaining, coverageRemaining);
      stats.coverage_state = coverageRemaining > 0 ? 'partial' : 'ok';
    }
  }
  db.prepare(`UPDATE accounts SET synced_at=datetime('now'), last_error=NULL WHERE vendor='google' AND type='email' AND email=?`)
    .run(email);
  return { email, ...stats };
}

export async function syncAllGmailAccounts(opts = {}) {
  const emails = listConnectedGoogleAccounts();
  if (!emails.length) return { synced: 0, accounts: 0 };

  const fullSyncEmails = new Set((opts.fullSyncEmails || []).map((email) => String(email).toLowerCase()));
  let total = 0;
  const errors = [];
  const results = [];
  for (const email of emails) {
    const shouldFullSync = opts.fullSync || fullSyncEmails.has(String(email).toLowerCase());
    const result = await syncGmailAccount(email, {
      ...opts,
      fullSync: shouldFullSync,
      since: shouldFullSync ? null : opts.since,
      maxMessages: shouldFullSync ? (opts.fullSyncMaxMessages ?? null) : opts.maxMessages,
    });
    results.push(result);
    total += result.synced;
    if (result.error) errors.push(`${email}: ${result.error}`);
  }

  const partial = results.filter((result) => result.coverage_state === 'partial').length;
  return { synced: total, accounts: emails.length, results, partial, ...(errors.length ? { errors } : {}) };
}
