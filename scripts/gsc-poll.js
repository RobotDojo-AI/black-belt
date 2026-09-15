#!/usr/bin/env node
/**
 * Google Search Console poller — checks indexing + structured data for Robot Dojo
 * public pages using the GSC URL Inspection API. Optionally scans a configured
 * Gmail inbox for unread sc-noreply@google.com alerts.
 *
 * Usage:
 *   node scripts/gsc-poll.js --setup      # create Gmail labels, move misrouted email
 *   node scripts/gsc-poll.js              # poll GSC, log results
 *   node scripts/gsc-poll.js --dry-run    # print findings without writing
 *   node scripts/gsc-poll.js --account X  # use specific Gmail account
 *
 * Requires webmasters.readonly OAuth scope — re-auth with oauth-callback-server.js
 * after adding the scope.
 */
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getValidAccessToken, listConnectedGoogleAccounts } from '../lib/google-oauth.js';

const ACCOUNT  = (() => { const i = process.argv.indexOf('--account'); return i >= 0 ? process.argv[i + 1] : listConnectedGoogleAccounts()[0]; })();
const DRY_RUN  = process.argv.includes('--dry-run');
const SETUP    = process.argv.includes('--setup');
const GMAIL    = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GSC_BASE = 'https://www.googleapis.com/webmasters/v3';
const INSPECT  = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const LOG_PATH = join(homedir(), '.robotdojo', 'logs', 'gsc.log');
const LOG_DIR  = join(homedir(), '.robotdojo', 'logs');

const GSC_ALERT_INBOX = process.env.ROBOTDOJO_GSC_ALERT_INBOX || ACCOUNT;

// Sites of interest — maps domain prefix to key pages to inspect
const SITE_PAGES = {
  'robotdojo.ai':     ['/', '/privacy', '/terms', '/licensing'],
};

// Coverage states that are NOT actionable
const OK_STATES = new Set([
  'Submitted and indexed',
  'Indexed, not submitted in sitemap',
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

async function gscGet(token, path) {
  const r = await fetch(`${GSC_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`GSC GET ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function gscPost(token, url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`GSC POST → ${r.status}: ${(await r.text()).slice(0, 200)}`);
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

async function runSetup(token) {
  await ensureLabel(token, 'gsc/reports');
  const processedId = await ensureLabel(token, 'gsc/processed');

  // Move any misrouted GSC email from dmarc/reports to gsc/processed
  const { labels = [] } = await gGet(token, '/labels');
  const dmarcReportsLabel = labels.find(l => l.name === 'dmarc/reports');
  if (dmarcReportsLabel) {
    const listRes = await gGet(token, `/messages?labelIds=${dmarcReportsLabel.id}&q=from:sc-noreply@google.com&maxResults=50`);
    const messages = listRes.messages || [];
    if (messages.length > 0) {
      log(`moving ${messages.length} misrouted GSC email(s) from dmarc/reports to gsc/processed`);
      for (const { id } of messages) {
        if (!DRY_RUN) {
          await gPost(token, `/messages/${id}/modify`, {
            addLabelIds:    [processedId],
            removeLabelIds: [dmarcReportsLabel.id],
          });
        }
      }
      log(`moved ${messages.length} email(s)`);
    } else {
      log('no misrouted GSC email in dmarc/reports');
    }
  }

  log('setup complete');
  return { properties: 0, inspected: 0, issues: 0 };
}

// Extract structured data issues from richResultsResult — returns array of issue strings
function extractRichResultIssues(richResultsResult) {
  if (!richResultsResult) return [];
  const issues = [];
  for (const typeEntry of richResultsResult.richResultsItems || []) {
    for (const item of typeEntry.items || []) {
      for (const issue of item.issues || []) {
        if (issue.severity === 'ERROR' || issue.severity === 'WARNING') {
          issues.push(`[${issue.severity}] ${typeEntry.richResultType}: ${issue.issueMessage}`);
        }
      }
    }
  }
  return issues;
}

// Check GSC_ALERT_INBOX for unread sc-noreply emails; return count, subjects,
// and the matched threadIds so dispatchHeal can archive the originating thread
// after a successful fix (see lib/gsc-heal.js#archiveGscThread).
//
// WHY threadIds: a heal touches a property (e.g. robotdojo.ai/faq) and the
// originating Gmail thread is whichever sc-noreply@google.com thread mentioned
// that property's site URL. dispatchHeal matches by URL substring; this function
// only collects candidate thread IDs.
async function checkGscAlertInbox(dryRun) {
  if (!GSC_ALERT_INBOX) {
    warn('GSC inbox check skipped: no account configured');
    return { unread: 0, subjects: [], threadIds: [] };
  }
  let token;
  try {
    token = await getValidAccessToken(GSC_ALERT_INBOX);
  } catch (e) {
    warn(`GSC inbox check: no token for ${GSC_ALERT_INBOX}: ${e.message}`);
    return { unread: 0, subjects: [], threadIds: [] };
  }
  if (!token) {
    warn(`GSC inbox check: no token for ${GSC_ALERT_INBOX}`);
    return { unread: 0, subjects: [], threadIds: [] };
  }

  try {
    const listRes = await gGet(token, `/messages?q=from:sc-noreply@google.com+is:unread&maxResults=20`);
    const messages = listRes.messages || [];
    if (messages.length === 0) {
      log(`GSC inbox (${GSC_ALERT_INBOX}): no unread alerts`);
      return { unread: 0, subjects: [], threadIds: [] };
    }

    const subjects = [];
    const threadIds = [];
    for (const { id } of messages) {
      const msg = await gGet(token, `/messages/${id}?format=metadata&metadataHeaders=Subject`);
      const subjectHeader = (msg.payload?.headers || []).find(h => h.name === 'Subject');
      subjects.push(subjectHeader?.value || '(no subject)');
      if (msg.threadId) threadIds.push(msg.threadId);
    }

    log(`GSC inbox (${GSC_ALERT_INBOX}): ${messages.length} unread alert(s) — ${subjects.join(' | ')}`);

    // Mark as read so we don't re-alert the same messages
    if (!dryRun) {
      for (const { id } of messages) {
        await gPost(token, `/messages/${id}/modify`, { removeLabelIds: ['UNREAD'] });
      }
      log(`GSC inbox: marked ${messages.length} message(s) as read`);
    }

    return { unread: messages.length, subjects, threadIds };
  } catch (e) {
    warn(`GSC inbox check failed: ${e.message}`);
    return { unread: 0, subjects: [], threadIds: [] };
  }
}

export async function runGscPoll({ dryRun = false, account = ACCOUNT } = {}) {
  const token = await getValidAccessToken(account);
  if (!token) {
    console.error(`no token for account: ${account}`);
    process.exit(1);
  }

  if (SETUP) {
    return runSetup(token);
  }

  const inboxResult = await checkGscAlertInbox(dryRun);

  // Enumerate verified properties
  let sitesData;
  try {
    sitesData = await gscGet(token, '/sites');
  } catch (e) {
    // 403 = missing webmasters scope — expected until re-auth.
    // WHY mention both scope names: st_ea15ae66 expansion upgrades the OAuth
    // scope from `webmasters.readonly` to `webmasters` (read+write) so that
    // sitemaps.submit becomes available after a heal. Re-auth covers both.
    if (e.message.includes('403')) {
      warn('GSC: 403 — re-auth with webmasters scope required (was webmasters.readonly)');
      return { properties: 0, inspected: 0, issues: inboxResult.unread, findings: [], threadIds: inboxResult.threadIds };
    }
    throw e;
  }

  const allSites = sitesData.siteEntry || [];
  const sites = allSites.filter(s =>
    Object.keys(SITE_PAGES).some(prefix => s.siteUrl?.includes(prefix))
  );

  log(`found ${sites.length} matching site(s) of ${allSites.length} verified`);

  let inspected = 0, issues = inboxResult.unread;
  const findings = [];

  for (const site of sites) {
    const siteUrl = site.siteUrl;
    const base = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
    const domainKey = Object.keys(SITE_PAGES).find(k => siteUrl.includes(k));
    const pages = SITE_PAGES[domainKey] || ['/'];

    for (const page of pages) {
      const inspectUrl = base + page;
      try {
        const res = await gscPost(token, INSPECT, {
          inspectionUrl: inspectUrl,
          siteUrl:       siteUrl,
          languageCode:  'en',
        });
        inspected++;

        const result = res.inspectionResult?.indexStatusResult;
        const coverageState = result?.coverageState || 'Unknown';
        const hasManualAction = (res.inspectionResult?.manualActionsResult?.manualActionIssues || []).length > 0;
        const richIssues = extractRichResultIssues(res.inspectionResult?.richResultsResult);
        const hasRichIssues = richIssues.length > 0;

        const isIssue = !OK_STATES.has(coverageState) || hasManualAction || hasRichIssues;
        if (isIssue) issues++;

        // Per-finding shape — extended for dispatchHeal (st_ea15ae66 expansion).
        // indexing_state, page_fetch_state, verdict, google_canonical, user_canonical
        // come from the URL Inspection API response and let the fixer registry
        // dispatch on structural state instead of brittle coverage_state strings.
        // - indexing_state: BLOCKED_BY_META_TAG identifies noindex pages
        // - page_fetch_state: NOT_FOUND identifies dead URLs in the sitemap
        // - google_canonical vs user_canonical mismatch identifies canonical drift
        const entry = {
          ts:                new Date().toISOString(),
          url:               inspectUrl,
          site:              siteUrl,
          coverage_state:    coverageState,
          indexing_state:    result?.indexingState || null,
          page_fetch_state:  result?.pageFetchState || null,
          verdict:           res.inspectionResult?.verdict || null,
          google_canonical:  result?.googleCanonical || null,
          user_canonical:    result?.userCanonical || null,
          manual_action:     hasManualAction,
          rich_issues:       richIssues,
          is_issue:          isIssue,
          last_crawl:        result?.lastCrawlTime,
          sitemap:           result?.sitemap,
        };

        if (dryRun) {
          console.log(JSON.stringify(entry, null, 2));
        } else {
          if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
          appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
        }

        const richTag = hasRichIssues ? ` [RICH: ${richIssues.join('; ')}]` : '';
        log(`${inspectUrl} — ${coverageState}${hasManualAction ? ' [MANUAL ACTION]' : ''}${richTag}${isIssue ? ' ← issue' : ''}`);
        findings.push(entry);
      } catch (e) {
        warn(`inspect ${inspectUrl} failed: ${e.message}`);
      }
    }
  }

  // findings + threadIds are returned for dispatchHeal (st_ea15ae66 expansion).
  // findings: per-URL inspection records with structural fields the fixer
  //   registry dispatches on (indexing_state, page_fetch_state, manual_action,
  //   canonical drift). Existing fields like coverage_state remain for back-compat.
  // threadIds: Gmail thread IDs of the originating sc-noreply@google.com alerts.
  //   dispatchHeal calls archiveGscThread per healed property; matching threadId
  //   to property URL is best-effort heuristic (URL substring in subject/snippet).
  return { properties: sites.length, inspected, issues, findings, threadIds: inboxResult.threadIds };
}

if (process.argv[1]?.endsWith('gsc-poll.js')) {
  runGscPoll({ dryRun: DRY_RUN }).then(({ properties, inspected, issues }) => {
    log(`done — properties: ${properties}, inspected: ${inspected}, issues: ${issues}`);
  }).catch(e => {
    console.error(`ERR: ${e.message}`);
    process.exit(1);
  });
}
