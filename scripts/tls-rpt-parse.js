#!/usr/bin/env node
/**
 * TLS-RPT aggregate report parser — fetches reports from Gmail, parses JSON,
 * appends results to ~/.robotdojo/logs/tls-rpt.log.
 *
 * Usage:
 *   node scripts/tls-rpt-parse.js --setup      # one-time: create Gmail label + filter
 *   node scripts/tls-rpt-parse.js              # parse new reports, append to log
 *   node scripts/tls-rpt-parse.js --dry-run    # parse without side effects
 *   node scripts/tls-rpt-parse.js --account X  # use specific Gmail account
 *
 * RFC 8460 — JSON-over-HTTPS attachment format (.json.gz).
 */
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { gunzipSync } from 'zlib';
import { homedir } from 'os';
import { join } from 'path';
import { getValidAccessToken, listConnectedGoogleAccounts } from '../lib/google-oauth.js';
import { secret } from '../lib/config.js';

const ACCOUNT         = (() => { const i = process.argv.indexOf('--account'); return i >= 0 ? process.argv[i + 1] : listConnectedGoogleAccounts()[0]; })();
const DRY_RUN         = process.argv.includes('--dry-run');
const SETUP           = process.argv.includes('--setup');
const GMAIL           = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REPORTS_LABEL   = 'tls-rpt/reports';
const PROCESSED_LABEL = 'tls-rpt/processed';
const SENDER_FILTER   = 'from:noreply-smtp-tls-reporting@google.com';
const LOG_PATH        = join(homedir(), '.robotdojo', 'logs', 'tls-rpt.log');
const LOG_DIR         = join(homedir(), '.robotdojo', 'logs');

const CERT_FAIL_TYPES = new Set([
  'certificate-expired',
  'certificate-host-mismatch',
  'certificate-not-trusted',
  'certificate-revoked',
]);

const ts   = () => new Date().toISOString().slice(11, 19);
const log  = (m) => console.info(`[${ts()}] ${m}`);
const warn = (m) => console.warn(`[${ts()}] WARN ${m}`);

async function gGet(token, path) {
  const r = await fetch(`${GMAIL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Gmail GET ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function gPost(token, path, body) {
  const r = await fetch(`${GMAIL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Gmail POST ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function ensureLabel(token, name) {
  const { labels = [] } = await gGet(token, '/labels');
  const existing = labels.find(l => l.name === name);
  if (existing) return existing.id;
  const created = await gPost(token, '/labels', {
    name,
    messageListVisibility: 'show',
    labelListVisibility:   'labelShow',
  });
  log(`created label: ${name} (${created.id})`);
  return created.id;
}

async function ensureFilter(token, reportsLabelId) {
  const res     = await gGet(token, '/settings/filters');
  const filters = res.filter || [];
  if (filters.some(f => f.action?.addLabelIds?.includes(reportsLabelId))) {
    log('filter already exists');
    return;
  }
  await gPost(token, '/settings/filters', {
    criteria: { query: SENDER_FILTER },
    action:   { addLabelIds: [reportsLabelId], removeLabelIds: [] },
  });
  log(`created filter: ${SENDER_FILTER} → ${REPORTS_LABEL}`);
}

function decodeBase64Url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function findGzAttachmentPart(payload) {
  const filename = payload.filename || '';
  if (/\.json\.gz$/i.test(filename) || payload.mimeType === 'application/gzip') return payload;
  for (const part of payload.parts || []) {
    const found = findGzAttachmentPart(part);
    if (found) return found;
  }
  return null;
}

async function fetchAttachmentBuffer(token, msgId, part) {
  const data = part.body?.data
    ?? (await gGet(token, `/messages/${msgId}/attachments/${part.body.attachmentId}`)).data;
  if (!data) throw new Error('attachment has neither inline data nor attachmentId');
  return decodeBase64Url(data);
}

export async function runTlsRptParse({ dryRun = false, account = ACCOUNT } = {}) {
  const token = await getValidAccessToken(account);
  if (!token) {
    console.error(`no token for account: ${account}`);
    process.exit(1);
  }

  const reportsLabelId   = await ensureLabel(token, REPORTS_LABEL);
  const processedLabelId = await ensureLabel(token, PROCESSED_LABEL);

  if (SETUP) {
    await ensureFilter(token, reportsLabelId);
    log('setup complete');
    return { processed: 0, failed: 0, certFails: 0 };
  }

  const listRes  = await gGet(token, `/messages?labelIds=${reportsLabelId}&maxResults=50`);
  const messages = listRes.messages || [];

  if (messages.length === 0) {
    log('0 reports found');
    return { processed: 0, failed: 0, certFails: 0 };
  }

  log(`found ${messages.length} report(s)`);
  let processed = 0, failed = 0, certFails = 0;

  for (const { id } of messages) {
    try {
      const msg     = await gGet(token, `/messages/${id}?format=full`);
      const subject = (msg.payload?.headers || []).find(h => h.name === 'Subject')?.value || '';
      const part    = findGzAttachmentPart(msg.payload || {});

      if (!part) {
        warn(`${id} ("${subject}") — no .json.gz attachment found, skipping`);
        continue;
      }

      const buf    = await fetchAttachmentBuffer(token, id, part);
      const report = JSON.parse(gunzipSync(buf).toString('utf-8'));

      // Count certificate failures across all policies
      let reportCertFails = 0;
      for (const policy of report['policies'] || []) {
        for (const detail of policy['failure-details'] || []) {
          if (
            CERT_FAIL_TYPES.has(detail['result-type']) &&
            (detail['total-failure-session-count'] || 0) > 0
          ) {
            reportCertFails++;
          }
        }
      }
      certFails += reportCertFails;

      const entry = {
        ts:           new Date().toISOString(),
        msg_id:       id,
        org_name:     report['organization-name'],
        report_id:    report['report-id'],
        date_range:   report['date-range'],
        policies:     (report['policies'] || []).map(p => ({
          domain:        p['policy']?.['policy-domain'],
          policy_type:   p['policy']?.['policy-type'],
          cert_fails:    (p['failure-details'] || []).filter(d =>
            CERT_FAIL_TYPES.has(d['result-type']) && (d['total-failure-session-count'] || 0) > 0
          ).length,
        })),
        cert_fails:   reportCertFails,
      };

      if (dryRun) {
        console.log(JSON.stringify(entry, null, 2));
      } else {
        if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
        appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
        await gPost(token, `/messages/${id}/modify`, {
          addLabelIds:    [processedLabelId],
          removeLabelIds: [reportsLabelId, 'UNREAD'],
        });
        log(`${report['organization-name'] || id} — cert_fails: ${reportCertFails}`);
      }
      processed++;
    } catch (e) {
      warn(`message ${id} failed: ${e.message}`);
      failed++;
    }
  }

  return { processed, failed, certFails };
}

if (process.argv[1]?.endsWith('tls-rpt-parse.js')) {
  runTlsRptParse({ dryRun: DRY_RUN }).then(({ processed, failed, certFails }) => {
    log(`done — processed: ${processed}, failed: ${failed}, certFails: ${certFails}`);
  }).catch(e => {
    console.error(`ERR: ${e.message}`);
    process.exit(1);
  });
}
