#!/usr/bin/env node
/**
 * Launch surface browser smoke.
 *
 * Visits the first-session surfaces and fails on rendered stale baggage,
 * page errors, console errors, or same-origin network failures.
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { readKeychainSecret } from '../../lib/keychain.js';
import { assertRelayQaUrl } from './live-url-guard.js';

const headless = process.argv.includes('--headless') || !process.argv.includes('--headed');
let baseUrl;
try {
  baseUrl = assertRelayQaUrl(process.env.QA_BASE_URL || process.env.ROBOTDOJO_QA_BASE_URL || 'https://robotdojo.ai', 'launch-surface-smoke base URL');
} catch (err) {
  console.error(`[launch-surface-smoke] ${err.message}`);
  process.exit(1);
}
const outDir = resolve(tmpdir(), 'robotdojo-qa', 'launch-surface-smoke');
function readKeychainToken() {
  return readKeychainSecret('ROBOTDOJO_AUTH_TOKEN') || '';
}

const envToken = process.env.ROBOTDOJO_AUTH_TOKEN || '';
const token = envToken && envToken !== 'test-token' ? envToken : readKeychainToken() || envToken || 'test-token';
const qaServerName = process.env.QA_SERVER_NAME || 'dojo';

const SURFACES = [
  {
    path: '/',
    name: 'home',
    must: [/Private Beta/i, /Install locally|Install Robot Dojo/i, /White Belt/i, /Black Belt/i],
  },
  {
    path: '/ask',
    name: 'ask',
    must: [/Ask Robot Dojo|public docs/i, /Robot Dojo/i],
  },
  {
    path: '/chat?context=setup-guide&prompt=How%20do%20I%20finish%20setting%20up%20Robot%20Dojo%3F',
    name: 'setup-chat-help',
    must: [/Good morning|Good afternoon|Good evening|All|Sonnet|flag/i],
  },
  {
    path: '/account/integrations',
    name: 'account-integrations',
    must: [/Integrations|Foundation Models|Google|API Key/i],
  },
  {
    path: '/account/remote-access',
    name: 'account-remote-access',
    must: [/Remote Access|token|slug|This Mac/i],
  },
  {
    path: '/chat',
    name: 'chat',
    must: [/Robot Dojo|Chat|message|Ask/i],
  },
];

const STALE = [
  /\bSamurai\b/i,
  /fine[- ]?tuning/i,
  /FAQ bot|FAQ assistant/i,
  /Get Started Free/i,
  /account#billing/i,
  /\$199\/mo/i,
];

function sameOrigin(url) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless });
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 950 },
});
const page = await context.newPage();
const failures = [];

async function attachProductionSession() {
  if (!token || token === 'test-token') {
    failures.push('auth missing real QA token');
    return;
  }
  const base = new URL(baseUrl);
  const isApex = base.hostname === 'robotdojo.ai' || base.hostname.split('.').length <= 2;
  const payload = isApex ? { server: qaServerName, token } : { token };
  const resp = await context.request.post(`${baseUrl}/api/auth/token`, {
    data: payload,
    headers: { 'content-type': 'application/json' },
  }).catch((err) => {
    failures.push(`auth request ${err.message}`);
    return null;
  });
  if (!resp) return;
  if (!resp.ok()) {
    failures.push(`auth status ${resp.status()}`);
  }
}

page.on('console', (msg) => {
  if (msg.type() === 'error') failures.push(`console ${msg.text()}`);
});
page.on('pageerror', (err) => failures.push(`pageerror ${err.message}`));
page.on('response', (res) => {
  const status = res.status();
  if (status >= 400 && sameOrigin(res.url())) {
    const path = new URL(res.url()).pathname;
    failures.push(`network ${status} ${path}`);
  }
});

await page.addInitScript((value) => {
  window.localStorage.setItem('robotdojo_token', value);
}, token);
await attachProductionSession();

for (const surface of SURFACES) {
  const url = new URL(surface.path, baseUrl).toString();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const body = await page.locator('body').innerText().catch(() => '');
  for (const re of surface.must) {
    if (!re.test(body)) failures.push(`${surface.name} missing ${re}`);
  }
  for (const re of STALE) {
    if (re.test(body)) failures.push(`${surface.name} stale ${re}`);
  }
  await page.screenshot({ path: resolve(outDir, `${surface.name}.png`), fullPage: true });
}

await browser.close();

if (failures.length) {
  console.error(`launch surface smoke FAIL base=${baseUrl}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`launch surface smoke PASS base=${baseUrl} screenshots=${outDir}`);
