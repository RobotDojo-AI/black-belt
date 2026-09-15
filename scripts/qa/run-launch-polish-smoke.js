#!/usr/bin/env node
/**
 * Launch polish QA wrapper.
 *
 * Browser QA is relay-only. This wrapper used to start a localhost fixture;
 * now it delegates to the live relay smoke so launch review cannot pass on a
 * path users never see.
 */

import { spawn } from 'node:child_process';
import { assertRelayQaUrl } from './live-url-guard.js';

const headless = process.argv.includes('--headless') || !process.argv.includes('--headed');
let baseUrl;
try {
  baseUrl = assertRelayQaUrl(process.env.QA_BASE_URL || process.env.ROBOTDOJO_QA_BASE_URL || 'https://robotdojo.ai', 'run-launch-polish-smoke base URL');
} catch (err) {
  console.error(`[run-launch-polish-smoke] ${err.message}`);
  process.exit(1);
}

const child = spawn(process.execPath, [
  'scripts/qa/launch-polish-smoke.js',
  headless ? '--headless' : '--headed',
], {
  cwd: new URL('../..', import.meta.url),
  env: { ...process.env, QA_BASE_URL: baseUrl },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
