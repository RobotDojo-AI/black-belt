// Playwright config used by scripts/qa/run.js.
// Identical to the root-level shim — both point at the same testDir and
// globalSetup. Two copies exist because run.js's `--config <path>` flag
// is hardcoded to scripts/qa/playwright.config.js.
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertRelayQaUrl } from './live-url-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const BASE_URL = assertRelayQaUrl(process.env.QA_BASE_URL || 'https://robotdojo.ai', 'QA_BASE_URL');

export default defineConfig({
  testDir: join(__dirname, 'tests'),
  outputDir: '/tmp/playwright-test-results',
  globalSetup: join(__dirname, 'global-setup.js'),
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: BASE_URL,
    headless: process.env.QA_HEADLESS !== '0',
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
    colorScheme: 'light',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: process.env.ROBOTDOJO_AUTH_TOKEN
      ? { Authorization: `Bearer ${process.env.ROBOTDOJO_AUTH_TOKEN}` }
      : undefined,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  reporter: [['list'], ['json', { outputFile: '/tmp/qa-results.json' }]],
});
