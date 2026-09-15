#!/usr/bin/env node
/**
 * Entry point for headed browser QA.
 * Usage: node scripts/qa/run.js [base-url] [--headed] [spec...]
 *
 * Why this exists: automated browser tests with real assertions catch what
 * LLM "manual checks" never will — layout breaks, JS errors, failed API calls,
 * auth gates that silently pass when they shouldn't.
 */
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readKeychainSecret } from '../../lib/keychain.js';
import { assertRelayQaUrl } from './live-url-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const inputBaseUrl = process.argv[2] || 'https://robotdojo.ai';
let BASE_URL;
try {
  BASE_URL = assertRelayQaUrl(inputBaseUrl, 'scripts/qa/run.js base URL');
} catch (err) {
  console.error(`[qa] ${err.message}`);
  process.exit(1);
}

async function probeServer(baseUrl) {
  const apiHealthRes = await fetch(`${baseUrl}/api/server-health`).catch(() => null);
  if (apiHealthRes?.ok) return true;
  const rootRes = await fetch(`${baseUrl}/`).catch(() => null);
  return Boolean(rootRes?.ok);
}

async function waitForServer(baseUrl, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probeServer(baseUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// Sanity-check the server is reachable before launching a browser.
// Try /api/server-health first; /health is the Health app route.
try {
  if (!await waitForServer(BASE_URL)) {
    console.error(`[qa] Server not reachable at ${BASE_URL}. Start it first.`);
    process.exit(1);
  }
} catch {
  console.error(`[qa] Server not reachable at ${BASE_URL}. Start it first.`);
  process.exit(1);
}

// Install Chromium on first run if not present.
// macOS stores browsers in ~/Library/Caches/ms-playwright; Linux uses ~/.cache/ms-playwright.
const cacheRoots = [
  join(process.env.HOME, 'Library', 'Caches', 'ms-playwright'),
  join(process.env.HOME, '.cache', 'ms-playwright'),
];
const playwrightInstalled = cacheRoots.some(dir => existsSync(join(dir, 'chromium-1217')) || existsSync(dir) && spawnSync('find', [dir, '-name', 'chromium-*', '-type', 'd'], { encoding: 'utf8' }).stdout.trim().length > 0);
if (!playwrightInstalled) {
  console.log('[qa] Installing Playwright browsers (first run)...');
  execSync('npx playwright install --with-deps chromium', { stdio: 'inherit' });
}

const configPath = join(__dirname, 'playwright.config.js');

// Inject Keychain secrets that Playwright specs need for auth-gated tests.
// WHY: run.js inherits process.env but Keychain values aren't env vars by default.
// Specs that call page.request with a session cookie (login.spec.js) need SESSION_SECRET.
const keychainKeys = {
  SESSION_SECRET: 'robotdojo-SESSION_SECRET',
  ROBOTDOJO_AUTH_TOKEN: 'robotdojo-ROBOTDOJO_AUTH_TOKEN',
};
const keychainEnv = {};
for (const [envKey, keychainKey] of Object.entries(keychainKeys)) {
  if (!process.env[envKey]) {
    try {
      const value = readKeychainSecret(keychainKey);
      if (value) keychainEnv[envKey] = value;
    } catch { /* not in Keychain — spec will skip or handle */ }
  }
}

// For production runs: generate a signed session cookie so Playwright can navigate
// HTML pages through Vercel middleware (which requires rdj_session, not just Bearer).
// Bearer token covers /api/* but Vercel middleware blocks HTML page loads without a cookie.
let qaSessionCookie = '';
if (BASE_URL.includes('robotdojo.ai')) {
  try {
    const repoRoot = join(__dirname, '..', '..');
    qaSessionCookie = execSync(
      'node --input-type=module',
      {
        input: `
import db from '${repoRoot}/lib/db.js';
import { createSession } from '${repoRoot}/lib/session.js';
const admin = db.prepare('SELECT id FROM users WHERE is_admin=1').get();
if (!admin) { process.stderr.write('no admin user\\n'); process.exit(1); }
const { cookieValue } = await createSession(admin.id);
process.stdout.write(cookieValue);
`,
        encoding: 'utf8',
        env: { ...process.env, ...keychainEnv, ROBOTDOJO_ALLOW_PLAINTEXT: '1' },
      }
    ).trim();
    console.log('[qa] Session cookie generated for production page auth');
  } catch (e) {
    console.warn('[qa] Session cookie gen failed:', e.message.split('\n')[0]);
  }
}

const env = { ...process.env, ...keychainEnv, QA_BASE_URL: BASE_URL };
if (qaSessionCookie) env.QA_SESSION_COOKIE = qaSessionCookie;

if (process.argv.includes('--headed')) env.QA_HEADLESS = '0';
if (process.argv.includes('--headless')) env.QA_HEADLESS = '1';

const passthroughFlags = process.argv.slice(3).filter((arg) =>
  /^--workers(=|$)/.test(arg)
  || /^--grep(=|$)/.test(arg)
  || /^--project(=|$)/.test(arg)
  || /^--timeout(=|$)/.test(arg)
);

// Collect spec file patterns from argv (positional args after base-url, not flags).
// flatMap + split handles zsh callers that pass a single space-joined string rather
// than multiple args — behaviour differs from bash which word-splits $VAR by default.
const specPatterns = process.argv.slice(3)
  .filter(a => !a.startsWith('--'))
  .flatMap(p => p.split(/\s+/).filter(Boolean));

const result = spawnSync(
  'npx',
  ['playwright', 'test', '--config', configPath, ...passthroughFlags, ...specPatterns],
  { stdio: 'inherit', env }
);

process.exit(result.status ?? 1);
