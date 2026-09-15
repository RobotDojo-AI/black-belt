#!/usr/bin/env node
/**
 * First-session browser smoke.
 *
 * Browser QA is relay-only. Do not start a localhost fixture here; that path
 * can hide apex middleware, cookie, cache, and relay bugs.
 */

import { spawn } from 'node:child_process';
import { assertRelayQaUrl } from './qa/live-url-guard.js';

let baseUrl;
try {
  baseUrl = assertRelayQaUrl(process.env.QA_BASE_URL || 'https://robotdojo.ai', 'check-first-session-browser-smoke base URL');
} catch (err) {
  console.error(`[check-first-session-browser-smoke] ${err.message}`);
  process.exit(1);
}

const child = spawn(process.execPath, [
  'scripts/qa/run.js',
  baseUrl,
  '--headless',
  'first-session-launch.spec.js',
], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, QA_BASE_URL: baseUrl },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
