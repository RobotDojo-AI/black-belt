#!/usr/bin/env node
/**
 * Local browser smoke for the final structure migration.
 *
 * Verifies the migrated Account/Imports/Chat surfaces against the running
 * local app. This is intentionally local-only: production freshness is proven
 * separately after commit/deploy through /version.json.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { readKeychainSecret } from '../../lib/keychain.js';

function defaultBaseUrl() {
  const portFile = join(homedir(), '.robotdojo', '.http-port');
  const port = existsSync(portFile)
    ? readFileSync(portFile, 'utf8').trim()
    : (process.env.PORT_APP || '4339');
  return `http://127.0.0.1:${port}`;
}

function token() {
  return process.env.ROBOTDOJO_AUTH_TOKEN
    || readKeychainSecret('ROBOTDOJO_AUTH_TOKEN', { timeout: 1000 })
    || 'test-token';
}

const headless = process.argv.includes('--headless') || !process.argv.includes('--headed');
const baseUrl = (process.env.ROBOTDOJO_LOCAL_SMOKE_URL || defaultBaseUrl()).replace(/\/$/, '');
const authToken = token();
const outDir = resolve(tmpdir(), 'robotdojo-qa', 'final-structure-local-smoke');
const failures = [];

const surfaces = [
  {
    name: 'account-integrations',
    path: '/account/integrations',
    must: [/Integrations/i, /Foundation Models|Google|API Key/i],
  },
  {
    name: 'account-imports',
    path: '/account/imports',
    must: [/Imports|Import drop zone/i, /~\/robotdojo\/user\/inbox/i, /Files in import history|No imports yet/i],
  },
  {
    name: 'account-how-to',
    path: '/account/how-to',
    must: [/How To Robot/i, /Integrations/i, /memory/i],
  },
  {
    name: 'chat',
    path: '/chat?context=setup-guide&prompt=How%20do%20I%20import%20my%20data%3F',
    waitUntil: 'domcontentloaded',
    must: [/Robot Dojo|Chat|message|Ask/i],
  },
];

function sameOrigin(url) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function ignoredNetworkFailure(url) {
  try {
    const path = new URL(url).pathname;
    return path === '/favicon.ico';
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

page.on('console', (msg) => {
  if (msg.type() === 'error') failures.push(`console ${msg.text()}`);
});

page.on('pageerror', (err) => failures.push(`pageerror ${err.message}`));

page.on('response', (res) => {
  const status = res.status();
  if (status >= 400 && sameOrigin(res.url()) && !ignoredNetworkFailure(res.url())) {
    failures.push(`network ${status} ${new URL(res.url()).pathname}`);
  }
});

try {
  await page.addInitScript((value) => {
    window.localStorage.setItem('robotdojo_token', value);
  }, authToken);

  for (const surface of surfaces) {
    await page.goto(`${baseUrl}${surface.path}`, {
      waitUntil: surface.waitUntil || 'networkidle',
      timeout: 20000,
    });
    const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    for (const re of surface.must) {
      if (!re.test(body)) failures.push(`${surface.name} missing ${re}`);
    }
    await page.screenshot({ path: resolve(outDir, `${surface.name}.png`), fullPage: true });
  }

  const setupResp = await page.evaluate(async (value) => {
    const res = await fetch('/api/setup/progress', {
      headers: { Authorization: `Bearer ${value}` },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }, authToken);

  if (setupResp.status !== 200) {
    failures.push(`setup progress status ${setupResp.status}`);
  } else {
    const steps = Array.isArray(setupResp.body?.steps) ? setupResp.body.steps : [];
    const drop = steps.find((step) => step.id === 'drop-folder');
    if (!drop) failures.push('setup progress missing drop-folder step');
    const serialized = JSON.stringify(drop || {});
    if (!serialized.includes('~/robotdojo/user/inbox')) {
      failures.push('setup drop-folder step does not reference ~/robotdojo/user/inbox');
    }
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`final structure local smoke FAIL base=${baseUrl}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`final structure local smoke PASS base=${baseUrl} screenshots=${outDir}`);
