#!/usr/bin/env node
/**
 * DMARC aggregate report parser — fetches reports from Gmail, parses XML,
 * appends results to ~/.robotdojo/logs/dmarc.log.
 *
 * Usage:
 *   node scripts/dmarc-parse.js --setup      # one-time: create Gmail label + filter
 *   node scripts/dmarc-parse.js              # parse new reports, append to log
 *   node scripts/dmarc-parse.js --dry-run    # parse without side effects (prints JSON)
 *   node scripts/dmarc-parse.js --account X  # use specific Gmail account
 *
 * Tier 0 only — no LLM calls. DMARC XML schema is fixed (RFC 7489).
 */
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { gunzipSync } from 'zlib';
import { homedir } from 'os';
import { join } from 'path';
import { getValidAccessToken, listConnectedGoogleAccounts } from '../lib/google-oauth.js';
import { secret } from '../lib/config.js';

const ACCOUNT         = (() => { const i = process.argv.indexOf('--account'); return i >= 0 ? process.argv[i + 1] : listConnectedGoogleAccounts()[0]; })();
const DRY_RUN         = process.argv.includes('--dry-run');
const SETUP           = process.argv.includes('--setup');
const GMAIL           = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REPORTS_LABEL   = 'dmarc/reports';
const PROCESSED_LABEL = 'dmarc/processed';
const DMARC_RUA_TO    = secret('DMARC_RUA_EMAIL') || (() => { const a = ACCOUNT || ''; return a.replace('@', '+dmarc@'); })();
const LOG_PATH        = join(homedir(), '.robotdojo', 'logs', 'dmarc.log');
const LOG_DIR         = join(homedir(), '.robotdojo', 'logs');

const ts   = () => new Date().toISOString().slice(11, 19);
const log  = (m) => console.info(`[${ts()}] ${m}`);
const warn = (m) => console.warn(`[${ts()}] WARN ${m}`);

// ── Gmail API helpers ────────────────────────────────────────────────────────

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

// ── XML parser ───────────────────────────────────────────────────────────────

function parseTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 's'));
  return m ? m[1].trim() : null;
}

function parseAllTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gs');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

export function parseDmarcXml(xml) {
  const meta     = parseTag(xml, 'report_metadata') || '';
  const policy   = parseTag(xml, 'policy_published') || '';
  const records  = parseAllTags(xml, 'record').map(block => {
    const row        = parseTag(block, 'row') || '';
    const policyEval = parseTag(block, 'policy_evaluated') || '';
    const authBlock  = parseTag(block, 'auth_results') || '';
    const spfBlock   = parseTag(authBlock, 'spf') || '';
    const dkimBlocks = parseAllTags(authBlock, 'dkim').map(d => ({
      domain:   parseTag(d, 'domain'),
      result:   parseTag(d, 'result'),
      selector: parseTag(d, 'selector'),
    }));
    return {
      source_ip:   parseTag(row, 'source_ip'),
      count:       parseInt(parseTag(row, 'count') || '0', 10),
      disposition: parseTag(policyEval, 'disposition'),
      dkim:        parseTag(policyEval, 'dkim'),
      spf:         parseTag(policyEval, 'spf'),
      dkim_detail: dkimBlocks,
      spf_domain:  parseTag(spfBlock, 'domain'),
      spf_result:  parseTag(spfBlock, 'result'),
    };
  });

  const total = records.reduce((s, r) => s + r.count, 0);
  const pass  = records.filter(r => r.dkim === 'pass' && r.spf === 'pass').reduce((s, r) => s + r.count, 0);

  return {
    reporter:      parseTag(meta, 'org_name'),
    reporter_email: parseTag(meta, 'email'),
    report_id:     parseTag(meta, 'report_id'),
    period_begin:  parseInt(parseTag(parseTag(meta, 'date_range') || '', 'begin') || '0', 10),
    period_end:    parseInt(parseTag(parseTag(meta, 'date_range') || '', 'end') || '0', 10),
    domain:        parseTag(policy, 'domain'),
    policy:        parseTag(policy, 'p'),
    pct:           parseInt(parseTag(policy, 'pct') || '100', 10),
    records,
    total,
    pass,
    fail: total - pass,
  };
}

// ── attachment extraction ─────────────────────────────────────────────────────

function decodeBase64Url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function findAttachmentPart(payload) {
  const ZIP_MIMES = ['application/zip', 'application/x-zip-compressed', 'application/gzip', 'application/octet-stream'];
  const filename  = payload.filename || '';
  if (ZIP_MIMES.includes(payload.mimeType) || /\.(zip|gz|xml)$/i.test(filename)) return payload;
  for (const part of payload.parts || []) {
    const found = findAttachmentPart(part);
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

function bufferToXml(buf, filename) {
  const name = (filename || '').toLowerCase();
  if (name.endsWith('.gz')) return gunzipSync(buf).toString('utf-8');
  if (name.endsWith('.xml')) return buf.toString('utf-8');
  // .zip or unknown — try unzip first, fall back to gunzip, then raw
  const tmp = `/tmp/dmarc-${process.pid}-${Date.now()}.zip`;
  try {
    writeFileSync(tmp, buf);
    return execFileSync('unzip', ['-p', tmp], { encoding: 'buffer' }).toString('utf-8');
  } catch {
    try { return gunzipSync(buf).toString('utf-8'); } catch {}
    return buf.toString('utf-8');
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// ── Gmail label + filter management ──────────────────────────────────────────

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
    criteria: { to: DMARC_RUA_TO },
    action:   { addLabelIds: [reportsLabelId], removeLabelIds: [] },
  });
  log(`created filter: to:${DMARC_RUA_TO} → ${REPORTS_LABEL}`);
}

// ── parse loop ────────────────────────────────────────────────────────────────

export async function runDmarcParse({ dryRun = false, account = ACCOUNT } = {}) {
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
    return { processed: 0, failed: 0, authFails: 0 };
  }

  const listRes  = await gGet(token, `/messages?labelIds=${reportsLabelId}&maxResults=50`);
  const messages = listRes.messages || [];

  if (messages.length === 0) {
    log('0 reports found');
    return { processed: 0, failed: 0, authFails: 0 };
  }

  log(`found ${messages.length} report(s)`);
  let processed = 0, failed = 0, authFails = 0;

  for (const { id } of messages) {
    try {
      const msg     = await gGet(token, `/messages/${id}?format=full`);
      const subject = (msg.payload?.headers || []).find(h => h.name === 'Subject')?.value || '';
      const part    = findAttachmentPart(msg.payload || {});

      if (!part) {
        warn(`${id} ("${subject}") — no attachment found, skipping`);
        continue;
      }

      const buf    = await fetchAttachmentBuffer(token, id, part);
      const xml    = bufferToXml(buf, part.filename || '');
      const report = parseDmarcXml(xml);

      const entry = {
        ts:        new Date().toISOString(),
        msg_id:    id,
        domain:    report.domain,
        reporter:  report.reporter,
        report_id: report.report_id,
        period:    report.period_begin ? new Date(report.period_begin * 1000).toISOString().slice(0, 10) : null,
        total:     report.total,
        pass:      report.pass,
        fail:      report.fail,
        ips:       [...new Set(report.records.map(r => r.source_ip).filter(Boolean))],
        failures:  report.records
          .filter(r => r.dkim !== 'pass' || r.spf !== 'pass')
          .map(r => ({ ip: r.source_ip, count: r.count, dkim: r.dkim, spf: r.spf })),
      };

      authFails += report.fail;

      if (dryRun) {
        console.log(JSON.stringify(entry, null, 2));
      } else {
        if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
        appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
        await gPost(token, `/messages/${id}/modify`, {
          addLabelIds:    [processedLabelId],
          removeLabelIds: [reportsLabelId, 'UNREAD'],
        });
        log(`${report.domain} / ${report.reporter} — ${report.pass}/${report.total} pass`);
      }
      processed++;
    } catch (e) {
      warn(`message ${id} failed: ${e.message}`);
      failed++;
    }
  }

  return { processed, failed, authFails };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('dmarc-parse.js')) {
  runDmarcParse({ dryRun: DRY_RUN }).then(({ processed, failed, authFails }) => {
    log(`done — processed: ${processed}, failed: ${failed}, authFails: ${authFails}`);
  }).catch(e => {
    console.error(`ERR: ${e.message}`);
    process.exit(1);
  });
}
