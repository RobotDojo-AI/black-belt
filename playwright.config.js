// Root-level shim — delegates to scripts/qa/playwright.config.js.
// Allows `npx playwright test <path>` from the repo root without --config.
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.QA_BASE_URL || 'https://localhost:4338';

export default defineConfig({
  testDir: './scripts/qa/tests',
  outputDir: '/tmp/playwright-test-results',
  globalSetup: join(__dirname, 'scripts/qa/global-setup.js'),
  timeout: 20_000,
  retries: 1,
  use: {
    baseURL: BASE_URL,
    headless: process.env.QA_HEADLESS === '1',
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
    colorScheme: 'light',
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  reporter: [['list'], ['json', { outputFile: '/tmp/qa-results.json' }]],
});
