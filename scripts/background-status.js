#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import config from '../lib/config.js';

const root = process.env.ROBOTDOJO_REPO_ROOT || resolve(import.meta.dirname, '..');
const home = process.env.HOME || homedir();
const launchDir = process.env.ROBOTDOJO_LAUNCH_AGENTS_DIR || resolve(home, 'Library/LaunchAgents');
const manifest = JSON.parse(readFileSync(resolve(root, 'config/launch-agents.json'), 'utf8'));
const appPort = Number(process.env.ROBOTDOJO_APP_PORT || config.ports.app);
const healthTimeoutMs = Number(process.env.ROBOTDOJO_BACKGROUND_STATUS_TIMEOUT_MS || 2500);

export function defaultHealthUrls(port = appPort) {
  return [
    `http://127.0.0.1:${port + 1}/api/server-health`,
    `https://127.0.0.1:${port}/api/server-health`,
    `http://127.0.0.1:${port}/api/server-health`,
  ];
}

function launchState(label) {
  const result = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8' });
  if (result.status !== 0) return { loaded: false, running: false, state: 'not-loaded' };
  return { loaded: true, running: /state = running/.test(result.stdout), state: (/state = ([^\n]+)/.exec(result.stdout)?.[1] || 'loaded').trim() };
}

export async function probeServerHealth({
  timeoutMs = healthTimeoutMs,
  fetchImpl = globalThis.fetch,
  curlImpl = fetchImpl === globalThis.fetch ? probeWithCurl : null,
  urls = defaultHealthUrls(),
} = {}) {
  const attempts = [];
  for (const url of urls) {
    const started = Date.now();
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      const body = await res.text();
      let json = null;
      try { json = JSON.parse(body); } catch {}
      const ok = res.ok && json?.status === 'ok';
      const attempt = {
        url,
        ok,
        status: res.status,
        status_text: json?.status || null,
        duration_ms: Date.now() - started,
      };
      attempts.push(attempt);
      if (ok) return { ok: true, url, attempts };
    } catch (err) {
      const fetchError = err?.name === 'TimeoutError' ? 'timeout' : (err?.message || String(err));
      if (curlImpl) {
        try {
          const curl = curlImpl(url, timeoutMs);
          const ok = curl.ok && curl.json?.status === 'ok';
          const attempt = {
            url,
            ok,
            status: curl.status,
            status_text: curl.json?.status || null,
            transport: 'curl',
            fetch_error: fetchError,
            duration_ms: Date.now() - started,
          };
          attempts.push(attempt);
          if (ok) return { ok: true, url, attempts };
          continue;
        } catch (curlErr) {
          attempts.push({
            url,
            ok: false,
            error: fetchError,
            curl_error: curlErr?.message || String(curlErr),
            duration_ms: Date.now() - started,
          });
          continue;
        }
      }
      attempts.push({
        url,
        ok: false,
        error: fetchError,
        duration_ms: Date.now() - started,
      });
    }
  }
  return { ok: false, url: null, attempts };
}

function probeWithCurl(url, timeoutMs) {
  const maxTime = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = ['-sS', '--max-time', String(maxTime), '--write-out', '\n%{http_code}'];
  if (/^https:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/)/.test(url)) {
    args.push('-k');
  }
  args.push(url);
  const result = spawnSync('curl', args, {
    encoding: 'utf8',
    timeout: timeoutMs + 1000,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `curl exited ${result.status}`).trim());
  }
  const output = String(result.stdout || '');
  const splitAt = output.lastIndexOf('\n');
  const body = splitAt >= 0 ? output.slice(0, splitAt) : output;
  const status = splitAt >= 0 ? Number(output.slice(splitAt + 1)) : 0;
  let json = null;
  try { json = JSON.parse(body); } catch {}
  return { ok: status >= 200 && status < 300, status, json };
}

const labels = new Set((manifest.agents || []).map(a => a.label));
const required = ['com.robotdojo.server', 'com.robotdojo.sync', 'com.robotdojo.chunk-worker', 'com.robotdojo.topic-edit-watcher', 'com.robotdojo.integration-monitor', 'com.robotdojo.login-probe', 'com.robotdojo.backup'];

async function main() {
  const agents = [];
  const failures = [];

  for (const label of required) {
    const plist = resolve(launchDir, `${label}.plist`);
    const state = launchState(label);
    const row = { label, installed: existsSync(plist), ...state };
    agents.push(row);
    if (!labels.has(label)) failures.push(`${label}: missing from product manifest`);
    if (!row.installed) failures.push(`${label}: plist missing`);
    if (!row.loaded) failures.push(`${label}: not loaded`);
  }

  const serverPlist = resolve(launchDir, 'com.robotdojo.server.plist');
  if (existsSync(serverPlist)) {
    const text = readFileSync(serverPlist, 'utf8');
    for (const bad of ['ROBOTDOJO_CHAT_SIMULATE', 'ROBOTDOJO_DROP_WATCHER_DISABLED']) {
      if (text.includes(bad)) failures.push(`com.robotdojo.server: unsafe env ${bad}`);
    }
  }

  const serverHealth = await probeServerHealth();
  if (!serverHealth.ok) {
    failures.push('com.robotdojo.server: HTTP health probe failed');
  }

  const ok = failures.length === 0;
  const payload = {
    ok,
    safe_to_resume_integrations: ok,
    checked_at: new Date().toISOString(),
    server_health: serverHealth,
    agents,
    failures,
  };

  console.log(JSON.stringify(payload, null, 2));
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}
