#!/usr/bin/env node
/**
 * st_24c158ae — cold chat TTFT probe (VC2).
 *
 * Runs `launchctl kickstart -k gui/<uid>/com.robotdojo.server`, polls
 * the installed server log for `[warmup] complete` (timeout 180s),
 * then issues one authenticated chat turn and asserts TTFT meets the cold
 * SLA via assertTTFT(elapsed, 'cold').
 *
 * Why relay-only: browser/app QA must exercise the same path the user sees.
 *
 * Output: progress on stderr, final JSON summary on stdout. Exit 0 pass /
 * 1 fail with diagnostic.
 */

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { assertTTFT } from '../../config/sla.js';
import { assertRelayQaUrl } from './live-url-guard.js';

const BASE_URL = assertRelayQaUrl(process.env.QA_BASE_URL || 'https://robotdojo.ai', 'QA_BASE_URL');
const RELAY_SLUG = process.env.ROBOTDOJO_QA_RELAY_SLUG || 'dojo';
const CHAT_STREAM_URL = `${BASE_URL}/api/chat/stream`;
const CONVERSATION_ID = `qa-cold-ttft-${process.pid}-${Date.now()}`;
const LAUNCHD_LABEL = 'com.robotdojo.server';
const LAUNCHD_PLIST = join(homedir(), 'Library/LaunchAgents/com.robotdojo.server.plist');
const SERVER_LOG = process.env.ROBOTDOJO_SERVER_LOG
  || join(process.env.ROBOTDOJO_CONFIG || join(homedir(), '.robotdojo'), 'logs/robotdojo-server.out.log');
const WARMUP_TIMEOUT_MS = 180_000;
const WARMUP_POLL_MS = 3000;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-ms') args.maxMs = Number(argv[++i]);
  }
  return args;
}

function readKeychainToken() {
  try {
    return execSync(
      'security find-generic-password -s "robotdojo-ROBOTDOJO_AUTH_TOKEN" -w',
      { encoding: 'utf8' },
    ).trim();
  } catch (err) {
    console.error(`FAIL: could not read keychain token: ${err?.message}`);
    process.exit(1);
  }
}

function kickstart() {
  const uid = process.getuid?.() ?? 502;
  const service = `gui/${uid}/${LAUNCHD_LABEL}`;
  try {
    execSync(`launchctl kickstart -k ${service}`, {
      stdio: 'pipe',
      timeout: 10_000,
    });
    process.stderr.write(`kickstart ok (uid=${uid})\n`);
    return true;
  } catch (err) {
    process.stderr.write(`kickstart missed loaded service; bootstrapping ${LAUNCHD_LABEL}\n`);
    try {
      execSync(`launchctl bootstrap gui/${uid} ${JSON.stringify(LAUNCHD_PLIST)}`, {
        stdio: 'pipe',
        timeout: 10_000,
      });
      process.stderr.write(`bootstrap ok (uid=${uid})\n`);
      return true;
    } catch (bootstrapErr) {
      process.stderr.write(`kickstart FAIL: ${err?.message}\nbootstrap FAIL: ${bootstrapErr?.message}\n`);
      return false;
    }
  }
}

async function waitForWarmupComplete(baselineByteOffset) {
  // Only look at log bytes ADDED after baselineByteOffset — prior boots'
  // [warmup] complete entries are stale and must not satisfy the wait.
  // Sleep 3s first to absorb launchctl flakiness (process not yet replaced).
  await sleep(3000);
  const deadline = Date.now() + WARMUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (existsSync(SERVER_LOG)) {
        const currentSize = statSync(SERVER_LOG).size;
        if (currentSize > baselineByteOffset) {
          // Read only the new bytes.
          const fd = readFileSync(SERVER_LOG);
          const newBytes = fd.slice(baselineByteOffset, currentSize);
          const newText = newBytes.toString('utf8');
          if (newText.includes('[warmup] complete')) {
            const matchLine = newText.split('\n').find(l => l.includes('[warmup] complete'));
            process.stderr.write(`warmup-complete seen (new): ${matchLine?.trim()}\n`);
            return true;
          }
        }
      }
    } catch { /* ignore */ }
    await sleep(WARMUP_POLL_MS);
  }
  return false;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function issueColdTurn(token) {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: 'reply ok cold' }],
    conversationId: CONVERSATION_ID,
    qaTestChat: true,
  });
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(CHAT_STREAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Cookie': `rd_server=${encodeURIComponent(RELAY_SLUG)}`,
        'X-RobotDojo-QA-Simulate': '1',
        'X-RobotDojo-Test-Chat': '1',
      },
      body,
    });
  } catch (err) {
    return { elapsed_ms: Date.now() - t0, error: `fetch failed: ${err?.message}` };
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '(no body)');
    return { elapsed_ms: Date.now() - t0, error: `HTTP ${resp.status}: ${t.slice(0, 200)}` };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload) continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === 'delta') {
          const elapsed = Date.now() - t0;
          try { await reader.cancel(); } catch { /* ignore */ }
          return { elapsed_ms: elapsed };
        }
      } catch { /* ignore */ }
    }
  }
  return { elapsed_ms: Date.now() - t0, error: 'stream ended without delta' };
}

async function main() {
  const args = parseArgs(process.argv);
  process.stderr.write(`max-ms hint: ${args.maxMs ?? '(none)'} — assertTTFT enforces canonical cold bound\n`);

  const token = readKeychainToken();
  // Capture log byte offset BEFORE kickstart so waitForWarmupComplete only
  // matches NEW [warmup] complete entries, not stale ones from prior boots.
  let baselineByteOffset = 0;
  try {
    if (existsSync(SERVER_LOG)) baselineByteOffset = statSync(SERVER_LOG).size;
  } catch { /* ignore */ }
  process.stderr.write(`baseline log offset: ${baselineByteOffset}\n`);
  const start = Date.now();
  const kicked = kickstart();
  if (!kicked) {
    process.stderr.write('FAIL: kickstart failed\n');
    process.exit(1);
  }

  const ok = await waitForWarmupComplete(baselineByteOffset);
  const warmupMs = Date.now() - start;
  if (!ok) {
    process.stderr.write(`FAIL: warmup did not complete within ${WARMUP_TIMEOUT_MS}ms\n`);
    process.exit(1);
  }

  // Give the post-warmup boot another beat to settle.
  await sleep(2000);

  const result = await issueColdTurn(token);
  const summary = {
    warmup_ms: warmupMs,
    chat: result,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');

  if (result.error) {
    process.stderr.write(`FAIL: cold turn errored: ${result.error}\n`);
    process.exit(1);
  }

  try {
    assertTTFT(result.elapsed_ms, 'cold');
  } catch (slaErr) {
    process.stderr.write(`FAIL: ${slaErr.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`PASS: cold TTFT ${result.elapsed_ms}ms (warmup ${warmupMs}ms)\n`);
  process.exit(0);
}

main().catch(err => {
  console.error(`FATAL: ${err?.stack || err}`);
  process.exit(1);
});
