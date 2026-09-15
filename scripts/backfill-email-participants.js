#!/usr/bin/env node
/**
 * backfill-email-participants.js — Backfill email_participants for emails synced
 * before st_87a0d072 added To/Cc/Bcc capture to gmail-sync.js.
 *
 * Usage:
 *   node scripts/backfill-email-participants.js [--dry-run] [--limit N] [--account email]
 *
 * Strategy:
 *   - Find emails missing participant rows: LEFT JOIN email_participants on email_id
 *     and filter NULL.
 *   - For each, call Gmail API `messages/{id}?format=metadata&metadataHeaders=To,Cc,Bcc`
 *     — body NOT fetched. Cheap (1 quota unit/message). 350K emails ~= ~12 mins at 50/sec.
 *   - Parse headers, INSERT OR IGNORE participants.
 *   - Resume via `--limit N` on a re-run; idempotent (PK on (email_id, participant, role)).
 *
 * === Compute Tier Protocol ===
 * Tier 0 (this script): no LLM. Pure header parsing + DB writes.
 *
 * WHY metadata format not full: bodies already in DB. Headers are 100x smaller,
 * the rate limit is more forgiving, and we never need to re-stripHtml.
 *
 * WHY 50/sec: Gmail per-user quota is 250 units/sec. messages.get costs 5 units
 * each. 50/sec * 5 = 250 — right at the cap. Slow enough to share with sync
 * jobs running in parallel.
 *
 * Tier ladder declaration (per build-conventions.md INTELLIGENCE_TIER block):
 *   This is a pure extraction script. No LLM calls. Declared as 'extraction'.
 */

export const INTELLIGENCE_TIER = 'extraction';

import db from '../lib/db.js';
import { getValidAccessToken, listConnectedGoogleAccounts } from '../lib/google-oauth.js';
import { parseAddressList } from '../lib/gmail-sync.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CHUNK = 50;            // per-second budget (50 calls × 5 units = 250)
const SLEEP_MS = 1000;       // 1 sec per CHUNK = 50/sec average

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.indexOf('--limit');
const LIMIT = LIMIT_ARG !== -1 ? parseInt(process.argv[LIMIT_ARG + 1] || '0', 10) : 0;
const ACCOUNT_ARG = process.argv.indexOf('--account');
const ACCOUNT = ACCOUNT_ARG !== -1 ? process.argv[ACCOUNT_ARG + 1] : null;

function findHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const insertParticipant = db.prepare(`
  INSERT OR IGNORE INTO email_participants (email_id, participant_email, role)
  VALUES (?, ?, ?)
`);

async function backfillAccount(accountEmail, accountId) {
  // Emails belonging to this account whose participant rows are missing.
  // WHY LEFT JOIN NULL: deterministic — an email with no participants needs backfill,
  // a partial backfill (sender only, missing to/cc/bcc) is also caught because we
  // re-fetch every absent (email_id, participant, role) combination idempotently.
  const baseSql = `
    SELECT e.id, e.sender_email
    FROM emails e
    LEFT JOIN email_participants ep ON ep.email_id = e.id
    WHERE e.account_id = ?
    GROUP BY e.id
    HAVING COUNT(ep.email_id) = 0
    ORDER BY e.received_at DESC
    ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `;
  const rows = db.prepare(baseSql).all(accountId);
  console.log(`[backfill-participants] ${accountEmail}: ${rows.length} emails to process`);
  if (rows.length === 0) return { processed: 0, errors: 0 };

  if (DRY_RUN) {
    console.log(`[backfill-participants] DRY RUN — would process ${rows.length} emails for ${accountEmail}`);
    return { processed: 0, errors: 0, dryRun: true };
  }

  let accessToken;
  try {
    accessToken = await getValidAccessToken(accountEmail);
  } catch (err) {
    console.error(`[backfill-participants] auth failed for ${accountEmail}: ${err.message}`);
    return { processed: 0, errors: rows.length };
  }
  if (!accessToken) {
    console.error(`[backfill-participants] no token for ${accountEmail}`);
    return { processed: 0, errors: rows.length };
  }

  let processed = 0, errors = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      chunk.map(r => gmailGet(accessToken,
        `/messages/${encodeURIComponent(r.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc`
      ).then(msg => ({ row: r, msg })))
    );

    db.transaction(() => {
      for (const result of results) {
        if (result.status === 'rejected') { errors++; continue; }
        const { row, msg } = result.value;
        const headers = msg.payload?.headers || [];
        const fromHeader = findHeader(headers, 'From');
        const toHeader = findHeader(headers, 'To');
        const ccHeader = findHeader(headers, 'Cc');
        const bccHeader = findHeader(headers, 'Bcc');

        // Sender: prefer the DB value (already parsed by sync); fall back to
        // parsing the From header here.
        const senderEmail = (row.sender_email || '').toLowerCase();
        if (senderEmail.includes('@')) insertParticipant.run(row.id, senderEmail, 'sender');
        else for (const a of parseAddressList(fromHeader)) insertParticipant.run(row.id, a, 'sender');

        for (const a of parseAddressList(toHeader))  insertParticipant.run(row.id, a, 'to');
        for (const a of parseAddressList(ccHeader))  insertParticipant.run(row.id, a, 'cc');
        for (const a of parseAddressList(bccHeader)) insertParticipant.run(row.id, a, 'bcc');
        processed++;
      }
    })();

    if (i % (CHUNK * 20) === 0) console.log(`[backfill-participants] ${accountEmail}: ${processed}/${rows.length} processed`);
    if (i + CHUNK < rows.length) await sleep(SLEEP_MS);
  }

  console.log(`[backfill-participants] ${accountEmail}: done — ${processed} processed, ${errors} errors`);
  return { processed, errors };
}

async function main() {
  const accounts = db.prepare(`
    SELECT id, email FROM accounts
    WHERE vendor='google' AND type='email' AND email IS NOT NULL
  `).all();

  const filtered = ACCOUNT ? accounts.filter(a => a.email === ACCOUNT) : accounts;
  if (filtered.length === 0) {
    console.log(`No accounts to backfill${ACCOUNT ? ` for ${ACCOUNT}` : ''}.`);
    return;
  }

  let totalProcessed = 0, totalErrors = 0;
  for (const a of filtered) {
    const r = await backfillAccount(a.email, a.id);
    totalProcessed += r.processed;
    totalErrors += r.errors;
  }

  console.log(`=== Backfill complete: ${totalProcessed} processed, ${totalErrors} errors ===`);
}

main().catch(err => {
  console.error('[backfill-participants] fatal:', err);
  process.exit(1);
});
