/**
 * Outlook email sync via Microsoft Graph.
 * Stores into the same `emails` table as Gmail sync.
 * Skips newsletters (List-Unsubscribe header present).
 * Uses INSERT OR IGNORE — safe to re-run.
 */
import db from './db.js';
import { getValidMicrosoftAccessToken, listConnectedMicrosoftAccounts } from './microsoft-oauth.js';
import { detectNewsletterFromGraphHeaders } from './email.js';
import { recordEmailParticipants } from './people-seed.js';
import config from './config.js';
import { insertTimelineEvent } from './timeline-schema.js';

const GRAPH_USERS = 'https://graph.microsoft.com/v1.0/users';

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

// ── Graph helpers ─────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractBody(message) {
  const body = message.body || {};
  if (body.contentType === 'text') return body.content || '';
  if (body.contentType === 'html') return stripHtml(body.content || '');
  return message.bodyPreview || '';
}

function parseSender(from) {
  const ea = from?.emailAddress;
  if (!ea) return { name: '', email: '' };
  return { name: ea.name || ea.address || '', email: (ea.address || '').toLowerCase() };
}

function extractListUnsubscribe(headers) {
  if (!Array.isArray(headers)) return null;
  const hdr = headers.find(h => h.name?.toLowerCase() === 'list-unsubscribe');
  return hdr?.value || null;
}

/** Graph recipient list → lowercased address array (shape: [{emailAddress:{address,name}}]). */
function recipientAddresses(recipients) {
  if (!Array.isArray(recipients)) return [];
  return recipients
    .map((r) => String(r?.emailAddress?.address || '').trim().toLowerCase())
    .filter((addr) => addr.includes('@'));
}

async function graphFetch(url, accessToken) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(config.timeouts.api),
  });

  if (res.status === 401) throw new Error('401 Unauthorized — token may be expired');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph API error ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function syncFolder(folderUrl, accessToken, accountId, maxMessages, sinceDate, { beforeDate = null, earlyStop = true } = {}) {
  const pageSize = Math.min(maxMessages, 50);

  // st_fd14cdd4 AC6: toRecipients/ccRecipients added so Microsoft participants
  // reach the entity graph for the first time. Verified at build with a live
  // $select probe under the granted Mail.ReadWrite app role (HTTP 200, both
  // fields populated) before this wiring was written.
  const params = new URLSearchParams({
    '$select': 'id,conversationId,subject,from,toRecipients,ccRecipients,bodyPreview,body,isRead,flag,receivedDateTime,internetMessageHeaders',
    '$orderby': 'receivedDateTime desc',
    '$top': String(pageSize),
  });

  if (sinceDate) {
    params.set('$filter', `receivedDateTime ge ${sinceDate instanceof Date ? sinceDate.toISOString() : sinceDate}`);
  }
  // st_fd14cdd4 (reopen, directive 2): the history walk pages BACKWARD from the
  // oldest stored message (`lt` watermark), mirroring the Gmail history
  // backfill's walk-backward contract (scripts/backfill-email-history.js).
  // Graph requires the filtered property to lead $orderby — receivedDateTime
  // does, same combo the live `ge` filter already exercises.
  if (beforeDate) {
    params.set('$filter', `receivedDateTime lt ${beforeDate instanceof Date ? beforeDate.toISOString() : beforeDate}`);
  }

  let url = `${folderUrl}?${params}`;
  let synced = 0;
  let consecutiveExisting = 0;

  while (url && synced < maxMessages) {
    const data = await graphFetch(url, accessToken);
    if (!data.value?.length) break;

    const tx = db.transaction((messages) => {
      for (const msg of messages) {
        const listUnsub = extractListUnsubscribe(msg.internetMessageHeaders);
        const sender = parseSender(msg.from);
        // st_d142f701 AC20: parity with Gmail. The full RFC signal set
        // (List-Unsubscribe, List-Id, Feedback-ID, Auto-Submitted,
        // Precedence, X-Auto-Response-Suppress, noreply@ sender) is checked
        // by detectNewsletterFromGraphHeaders so Outlook newsletter chunks
        // get filtered at the same chunk-worker SQL pre-filter as Gmail.
        const isNewsletter = detectNewsletterFromGraphHeaders(
          msg.internetMessageHeaders, listUnsub, sender.email
        ) ? 1 : 0;

        const bodyText = extractBody(msg);
        const receivedAt = msg.receivedDateTime
          ? new Date(msg.receivedDateTime).toISOString()
          : new Date().toISOString();

        const result = insertEmail.run(
          msg.id,
          msg.conversationId || msg.id,
          msg.subject || '',
          sender.name,
          sender.email,
          msg.bodyPreview || '',
          bodyText,
          '[]',
          msg.isRead ? 1 : 0,
          msg.flag?.flagStatus === 'flagged' ? 1 : 0,
          receivedAt,
          accountId,
          isNewsletter,
          listUnsub,
        );

        if (result.changes > 0) {
          synced++;
          consecutiveExisting = 0;
          recordEmailTimeline({
            id: msg.id,
            subject: msg.subject || '',
            senderEmail: sender.email,
            receivedAt,
            accountId,
            isNewsletter,
          });
          // st_fd14cdd4 AC6: Microsoft participants captured for the first
          // time — sender + To/Cc into the universal interchange, sender
          // seeded create-or-link (newsletter-guarded, parity with Gmail).
          try {
            recordEmailParticipants(db, msg.id, {
              sender: { email: sender.email, name: sender.name },
              to: recipientAddresses(msg.toRecipients),
              cc: recipientAddresses(msg.ccRecipients),
            }, { isNewsletter: !!isNewsletter, source: 'email' });
          } catch (err) {
            console.warn(`[outlook] participant insert failed for ${msg.id}: ${err.message}`);
          }
        } else {
          consecutiveExisting++;
        }
      }
    });

    tx(data.value);

    // WHY gated: the incremental sync walks NEWEST-first, so 50 consecutive
    // already-stored rows mean it re-entered covered ground — stop. A history
    // walk (beforeDate) starts at the covered boundary ON PURPOSE; stopping on
    // existing rows there would abort the walk at its first overlap page.
    if (earlyStop && consecutiveExisting >= 50) break;

    url = data['@odata.nextLink'] || null;
  }

  return synced;
}

/**
 * One bounded history pass for a Microsoft mailbox (st_fd14cdd4 reopen,
 * directive 2 — "history must be included"). Fetches up to `maxMessages`
 * messages strictly OLDER than `before` from `/messages` (the unfiltered
 * endpoint spans every mail folder, so a separate SentItems pass is not
 * needed) and stores them through the exact same insert + participants +
 * seeding path the live sync uses. Caller (scripts/backfill-participants.js
 * --source mshistory) loops passes with the stored-oldest watermark until
 * the mailbox floor is reached or the slice budget elapses.
 *
 * @param {string} email — connected Microsoft mailbox (accounts row exists)
 * @param {{ before: Date, maxMessages?: number }} opts
 * @returns {Promise<{synced: number, error?: string}>}
 */
export async function syncOutlookHistorySlice(email, { before, maxMessages = 200 } = {}) {
  if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
    return { synced: 0, error: 'history slice requires a valid `before` Date watermark' };
  }
  const acctRow = db.prepare(`SELECT id FROM accounts WHERE vendor='microsoft' AND type='email' AND email=?`).get(email);
  const accountId = acctRow?.id || email;

  let accessToken;
  try {
    accessToken = await getValidMicrosoftAccessToken(email);
  } catch (err) {
    return { synced: 0, error: err.message };
  }

  try {
    const synced = await syncFolder(
      `${GRAPH_USERS}/${encodeURIComponent(email)}/messages`,
      accessToken, accountId, maxMessages, null,
      { beforeDate: before, earlyStop: false },
    );
    // synced_at is deliberately NOT touched: it means "last live sync"; a
    // history pass over 2010-era mail must not mask a stalled live sync.
    return { synced };
  } catch (err) {
    return { synced: 0, error: err.message };
  }
}

export async function syncOutlookAccount(email, opts = {}) {
  const { maxMessages = 500, sinceDate } = opts;

  const acctRow = db.prepare(`SELECT id FROM accounts WHERE vendor='microsoft' AND type='email' AND email=?`).get(email);
  const accountId = acctRow?.id || email;

  let accessToken;
  try {
    accessToken = await getValidMicrosoftAccessToken(email);
  } catch (err) {
    console.error(`[outlook] cannot get token for ${email}:`, err.message);
    db.prepare(`UPDATE accounts SET last_error=? WHERE vendor='microsoft' AND type='email' AND email=?`)
      .run(err.message.slice(0, 500), email);
    return { synced: 0, error: err.message };
  }

  const base = `${GRAPH_USERS}/${encodeURIComponent(email)}`;

  let synced = 0;
  try {
    const inbox = await syncFolder(`${base}/messages`, accessToken, accountId, maxMessages, sinceDate);
    const sent  = await syncFolder(`${base}/mailFolders/SentItems/messages`, accessToken, accountId, maxMessages, sinceDate);
    synced = inbox + sent;
  } catch (err) {
    console.error(`[outlook] sync failed for ${email}:`, err.message);
    return { synced, error: err.message };
  }

  if (synced > 0) console.info(`[outlook] synced ${synced} new emails for ${email}`);
  db.prepare(`UPDATE accounts SET synced_at=datetime('now'), last_error=NULL WHERE vendor='microsoft' AND type='email' AND email=?`)
    .run(email);
  return { synced };
}

export async function syncAllOutlookAccounts(opts = {}) {
  const accounts = listConnectedMicrosoftAccounts('email');
  if (!accounts.length) return { synced: 0, accounts: 0 };

  let total = 0;
  const errors = [];

  for (const email of accounts) {
    const result = await syncOutlookAccount(email, opts);
    total += result.synced;
    if (result.error) errors.push(`${email}: ${result.error}`);
  }

  return {
    synced: total,
    accounts: accounts.length,
    ...(errors.length ? { errors } : {}),
  };
}
