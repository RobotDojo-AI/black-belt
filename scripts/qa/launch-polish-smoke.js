#!/usr/bin/env node
/**
 * Launch polish browser smoke.
 *
 * Visible readiness gate for the private-beta path. Account pages intentionally
 * do not wait for network idle because shell/background fetches can keep
 * running after the page is already usable.
 */

import { mkdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { readKeychainSecret } from '../../lib/keychain.js';
import { assertRelayQaUrl } from './live-url-guard.js';

const headless = process.argv.includes('--headless') || !process.argv.includes('--headed');
let baseUrl;
try {
  baseUrl = assertRelayQaUrl(process.env.QA_BASE_URL || process.env.ROBOTDOJO_QA_BASE_URL || 'https://robotdojo.ai', 'launch-polish-smoke base URL');
} catch (err) {
  console.error(`[launch-polish-smoke] ${err.message}`);
  process.exit(1);
}
const outDir = resolve(tmpdir(), 'robotdojo-qa', 'launch-polish-smoke');

function readKeychainToken() {
  return readKeychainSecret('ROBOTDOJO_AUTH_TOKEN') || '';
}

const envToken = process.env.QA_AUTH_TOKEN || process.env.ROBOTDOJO_AUTH_TOKEN || '';
const token = envToken && envToken !== 'test-token' ? envToken : readKeychainToken() || envToken || 'test-token';
const qaServerName = process.env.QA_SERVER_NAME || 'dojo';
const viewports = [
  { name: 'desktop', width: 1440, height: 950 },
  { name: 'mobile', width: 390, height: 844 },
];

const surfaces = [
  { path: '/', name: 'home', must: [/Private Beta/i, /Install Robot Dojo|Install locally/i] },
  { path: '/ask?topic=install', name: 'ask-install', must: [/Ask about install and setup|Install|setup/i] },
  { path: '/install-success', name: 'install-success', must: [/Install complete/i, /Open Integrations/i, /Open chat help/i] },
  { path: '/chat?context=setup-guide&prompt=How%20do%20I%20finish%20setting%20up%20Robot%20Dojo%3F', name: 'post-install-chat-help', must: [/Good morning|Good afternoon|Good evening|All|Sonnet|flag/i], controls: ['.chat-input', '.send-circle'] },
  { path: '/account/integrations', name: 'account-integrations', must: [/Integrations/i, /Connected|Missing|Recover|No data yet|Key present|Token present|Credential/i] },
  { path: '/account/imports', name: 'account-imports', must: [/Imports|Import drop zone/i] },
  { path: '/account/remote-access', name: 'account-remote-access', must: [/Admin/i, /Login token/i] },
  { path: '/account/general', name: 'account-general', must: [/Admin|Account/i] },
  { path: '/account/agents', name: 'account-agents', must: [/Agents/i, /AGENTS|identity|agent|persona|load/i] },
  { path: '/account/feature-request', name: 'account-feature-request', must: [/Feature Request/i, /Send|Request|email/i] },
  { path: '/account/referrals', name: 'account-referrals', must: [/Invite a Friend/i, /Invite|Founder|YC|relationship/i] },
  { path: '/chat', name: 'chat', must: [/Good morning|Good afternoon|Good evening|All|Sonnet|flag/i], controls: ['.chat-input', '.send-circle'] },
];

const stale = [
  new RegExp(['Get', 'Started', 'Free'].join(' '), 'i'),
  new RegExp(['ping', 'me', 'for', 'access'].join(' '), 'i'),
  /\/chat\?q=/i,
  new RegExp('\\b' + ['Tele', 'gram'].join('') + '\\b', 'i'),
  new RegExp(['not', 'configured'].join('-'), 'i'),
];

const unfinished = [
  /\bcoming soon\b/i,
  /\bTODO\b/i,
  /\blorem ipsum\b/i,
];

function sameOrigin(url) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function probeServer(url) {
  return new Promise((resolveProbe) => {
    const transport = String(url).startsWith('http://') ? httpRequest : request;
    const req = transport(url, { method: 'GET', rejectUnauthorized: false, timeout: 1500 }, (res) => {
      res.resume();
      resolveProbe(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolveProbe(false));
    req.on('timeout', () => {
      req.destroy();
      resolveProbe(false);
    });
    req.end();
  });
}

async function waitForServer() {
  const healthUrl = new URL('/api/server-health', baseUrl).toString();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await probeServer(healthUrl)) return;
    await sleep(500);
  }
  throw new Error(`server did not become reachable at ${healthUrl}`);
}

async function hasHorizontalOverflow(page) {
  return page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollWidth > root.clientWidth + 8) return true;
    return Array.from(document.querySelectorAll('table, .acct-card, .integ-table-wrap, .accounts-feed'))
      .some((el) => {
        const style = getComputedStyle(el);
        return el.scrollWidth > el.clientWidth + 8 && style.overflowX === 'visible';
      });
  });
}

async function hasBoundingLeak(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const candidates = Array.from(document.querySelectorAll([
      '.general-row',
      '.general-link',
      '.acct-card',
      '.acct-card-name',
      '.acct-card-service',
      '.integ-table td',
      '.imports-data-table td',
      '.remote-access-row',
      '.chat-input',
      '.send-circle',
      '.label-item',
      '.label-icon',
      '.label-name',
      '.nav-add-ctx',
    ].join(',')));
    return candidates.some((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return false;
      if (rect.left < -6 || rect.right > vw + 6) return true;
      if (el.scrollWidth > el.clientWidth + 8 && style.overflowX === 'visible') return true;
      return false;
    });
  });
}

async function hasChatSidebarIconFallback(page) {
  return page.evaluate(() => {
    const icons = Array.from(document.querySelectorAll('.app-sidebar .material-symbols-outlined.label-icon'));
    return icons.some((el) => {
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || '').trim();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return false;
      return rect.width > 36 || text.includes('-') || /\s/.test(text);
    });
  });
}

async function attachProductionSession(context, failures, label) {
  if (!token || token === 'test-token') {
    failures.push(`${label} auth missing real QA token`);
    return;
  }
  const base = new URL(baseUrl);
  const isApex = base.hostname === 'robotdojo.ai' || base.hostname.split('.').length <= 2;
  const payload = isApex ? { server: qaServerName, token } : { token };
  const resp = await context.request.post(`${baseUrl}/api/auth/token`, {
    data: payload,
    headers: { 'content-type': 'application/json' },
  }).catch((err) => {
    failures.push(`${label} auth request ${err.message}`);
    return null;
  });
  if (!resp) return;
  if (!resp.ok()) {
    failures.push(`${label} auth status ${resp.status()}`);
  }
}

mkdirSync(outDir, { recursive: true });
await waitForServer();
const browser = await chromium.launch({ headless });
const failures = [];

for (const viewport of viewports) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
  await context.addInitScript((value) => {
    try {
      window.localStorage.setItem('robotdojo_token', value);
    } catch {
      // Chromium error documents deny localStorage; the navigation failure is
      // recorded separately, so this setup hook should not add noise.
    }
  }, token);
  await attachProductionSession(context, failures, viewport.name);
  let currentSurfaceName = 'startup';

  context.on('page', (page) => {
    page.setDefaultNavigationTimeout(10000);
  });
  context.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('fonts.gstatic.com') || text.includes('Failed to load resource: net::ERR_FAILED')) return;
    if (text.includes('/api/auth/me') || text.includes('401 (Unauthorized)')) return;
    if (msg.type() === 'error') failures.push(`${viewport.name} ${currentSurfaceName} console ${text}`);
  });
  context.on('pageerror', (err) => failures.push(`${viewport.name} ${currentSurfaceName} pageerror ${err.message}`));
  context.on('response', (res) => {
    const status = res.status();
    if (status >= 400 && sameOrigin(res.url())) {
      if (status === 401 && new URL(res.url()).pathname === '/api/auth/me') return;
      failures.push(`${viewport.name} ${currentSurfaceName} network ${status} ${new URL(res.url()).pathname}`);
    }
  });

  for (const surface of surfaces) {
    currentSurfaceName = surface.name;
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(10000);
    const targetUrl = new URL(surface.path, baseUrl).toString();
    const response = await page.goto(targetUrl, { waitUntil: 'commit' }).catch((err) => {
      failures.push(`${viewport.name} ${surface.name} navigation ${err.message}`);
      return null;
    });
    if (!response) {
      await page.close().catch(() => {});
      continue;
    }
    await page.waitForSelector('body', { state: 'visible', timeout: 3000 }).catch((err) => {
      failures.push(`${viewport.name} ${surface.name} body ${err.message}`);
    });
    await page.waitForTimeout(surface.path.startsWith('/account') ? 900 : 500);
    await page.waitForFunction((requirements) => {
      const text = document.body?.innerText || '';
      return requirements.every(({ source, flags }) => new RegExp(source, flags).test(text));
    }, surface.must.map((re) => ({ source: re.source, flags: re.flags })), { timeout: 2500 }).catch(() => {});
    const body = await page.locator('body').innerText().catch(() => '');
    const minTextLength = surface.path.includes('/chat') ? 45 : surface.path.includes('feature-request') ? 150 : surface.path.startsWith('/account') ? 220 : 80;
    if (body.trim().length < minTextLength) failures.push(`${viewport.name} ${surface.name} blank or too sparse`);
    for (const re of surface.must) {
      if (!re.test(body)) failures.push(`${viewport.name} ${surface.name} missing ${re}`);
    }
    for (const selector of surface.controls || []) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (!count) failures.push(`${viewport.name} ${surface.name} missing control ${selector}`);
    }
    for (const re of stale) {
      if (re.test(body)) failures.push(`${viewport.name} ${surface.name} stale ${re}`);
    }
    if (surface.path.startsWith('/account')) {
      for (const re of unfinished) {
        if (re.test(body)) failures.push(`${viewport.name} ${surface.name} unfinished ${re}`);
      }
    }
    if (await hasHorizontalOverflow(page)) failures.push(`${viewport.name} ${surface.name} horizontal overflow`);
    if (await hasBoundingLeak(page)) failures.push(`${viewport.name} ${surface.name} bounding leak`);
    if (surface.path.includes('/chat') && await hasChatSidebarIconFallback(page)) {
      failures.push(`${viewport.name} ${surface.name} sidebar icon fallback`);
    }
    await page.screenshot({ path: resolve(outDir, `${viewport.name}-${surface.name}.png`), fullPage: true });
    await page.close().catch(() => {});
  }
  await context.close();
}

await browser.close();

if (failures.length) {
  console.error(`launch polish smoke FAIL base=${baseUrl}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`launch polish smoke PASS base=${baseUrl} screenshots=${outDir}`);
