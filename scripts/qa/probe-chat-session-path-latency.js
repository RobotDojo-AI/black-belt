#!/usr/bin/env node
/**
 * Probe real chat latency through the browser session path.
 *
 * This intentionally avoids Bearer auth for /api/chat/stream. It logs in once
 * per target, reuses rdj_session + rd_server cookies, then measures:
 *   - first_status_ms: request start -> first status/phase frame
 *   - first_delta_ms: request start -> first assistant delta frame
 *
 * Defaults compare the three paths that matter for relay work:
 *   local  -> Mac internal HTTP server
 *   direct -> direct SNI subdomain
 *   apex   -> robotdojo.ai through Vercel middleware
 *
 * Use --login-path local to create one signed session locally and reuse it for
 * every target. The cookie format is portable across the relay paths, and this
 * avoids tripping the token-login rate limiter during repeated latency probes.
 */

import { execFileSync } from 'node:child_process';
import config from '../../lib/config.js';

const DEFAULT_SERVER = process.env.ROBOTDOJO_QA_RELAY_SLUG
  || process.env.ROBOTDOJO_DEVICE_SLUG
  || readKeychainSecret('ROBOTDOJO_DEVICE_SLUG')
  || 'dojo';

const DEFAULT_TARGETS = {
  local: `http://127.0.0.1:${Number(config.ports.app) + 1}`,
  direct: `https://${DEFAULT_SERVER}.robotdojo.ai`,
  apex: 'https://robotdojo.ai',
};

function readKeychainSecret(name) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', `robotdojo-${name}`, '-w'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function authToken() {
  return process.env.QA_DOJO_TOKEN
    || process.env.ROBOTDOJO_AUTH_TOKEN
    || readKeychainSecret('ROBOTDOJO_AUTH_TOKEN');
}

function parseArgs(argv) {
  const args = {
    turns: 5,
    spacingMs: 0,
    server: DEFAULT_SERVER,
    paths: ['local', 'direct', 'apex'],
    loginPath: 'per-path',
    prompt: 'reply ok',
    timeoutMs: 60_000,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--turns') args.turns = Number(argv[++i]);
    else if (arg === '--spacing-ms') args.spacingMs = Number(argv[++i]);
    else if (arg === '--server') args.server = String(argv[++i] || '').trim();
    else if (arg === '--paths') args.paths = String(argv[++i] || '').split(',').map((v) => v.trim()).filter(Boolean);
    else if (arg === '--login-path') args.loginPath = String(argv[++i] || '').trim();
    else if (arg === '--prompt') args.prompt = String(argv[++i] || '');
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg.startsWith('--target-')) {
      const name = arg.slice('--target-'.length);
      DEFAULT_TARGETS[name] = String(argv[++i] || '').replace(/\/$/, '');
      if (!args.paths.includes(name)) args.paths.push(name);
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
  }
  args.turns = Math.max(1, Math.trunc(args.turns) || 1);
  args.spacingMs = Math.max(0, Math.trunc(args.spacingMs) || 0);
  args.timeoutMs = Math.max(1000, Math.trunc(args.timeoutMs) || 60_000);
  return args;
}

function usage() {
  process.stdout.write(`Usage:
  node scripts/qa/probe-chat-session-path-latency.js --turns 5 --paths local,direct,apex

Options:
  --turns N
  --spacing-ms N
  --server dojo
  --paths local,direct,apex
  --login-path per-path|local|direct|apex
  --target-name https://custom.example
  --prompt "reply ok"
  --timeout-ms 60000
`);
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  const cookies = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const rest = value.slice(i).toLowerCase();
    if (rest.startsWith('expires=')) inExpires = true;
    if (inExpires && char === ';') inExpires = false;
    if (char === ',' && !inExpires) {
      cookies.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  cookies.push(value.slice(start).trim());
  return cookies.filter(Boolean);
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  return splitSetCookieHeader(headers.get('set-cookie') || '');
}

function cookiePairs(setCookies) {
  const pairs = [];
  for (const cookie of setCookies) {
    const pair = String(cookie).split(';')[0]?.trim();
    if (pair && pair.includes('=')) pairs.push(pair);
  }
  return pairs;
}

async function login({ baseUrl, token, server, timeoutMs }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, server, redirect: '/chat' }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
    }
    const pairs = cookiePairs(getSetCookies(res.headers));
    if (!pairs.some((pair) => pair.startsWith('rdj_session='))) {
      throw new Error(`login returned no rdj_session cookie: ${pairs.join('; ')}`);
    }
    if (!pairs.some((pair) => pair.startsWith('rd_server='))) pairs.push(`rd_server=${encodeURIComponent(server)}`);
    return {
      ok: true,
      login_ms: Date.now() - started,
      cookie: pairs.join('; '),
    };
  } finally {
    clearTimeout(timer);
  }
}

function quantile(values, q) {
  const sorted = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[index];
}

function summarize(turns) {
  const deltas = turns.map((turn) => turn.first_delta_ms).filter((v) => Number.isFinite(v));
  const statuses = turns.map((turn) => turn.first_status_ms).filter((v) => Number.isFinite(v));
  return {
    turns: turns.length,
    first_status_ms: {
      min: statuses.length ? Math.min(...statuses) : null,
      p50: quantile(statuses, 0.5),
      p95: quantile(statuses, 0.95),
      max: statuses.length ? Math.max(...statuses) : null,
    },
    first_delta_ms: {
      min: deltas.length ? Math.min(...deltas) : null,
      p50: quantile(deltas, 0.5),
      p95: quantile(deltas, 0.95),
      max: deltas.length ? Math.max(...deltas) : null,
    },
  };
}

async function issueTurn({ baseUrl, cookie, prompt, turnIndex, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const result = {
    turn: turnIndex,
    first_status_ms: null,
    first_delta_ms: null,
    status_frame: null,
    phase_names: [],
    error: null,
  };

  try {
    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'x-robotdojo-test-chat': '1',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: `${prompt} ${turnIndex}` }],
        conversationId: `qa-session-path-${process.pid}-${Date.now()}-${turnIndex}`,
        qaTestChat: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      result.error = `HTTP ${res.status}: ${text.slice(0, 240)}`;
      return result;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          continue;
        }
        if (result.first_status_ms === null && (event.type === 'status' || event.type === 'phase')) {
          result.first_status_ms = Date.now() - started;
          result.status_frame = event.type === 'status' ? event : null;
        }
        if (event.type === 'phase' && event.name) result.phase_names.push(event.name);
        if (event.type === 'delta') {
          result.first_delta_ms = Date.now() - started;
          try { await reader.cancel(); } catch {}
          break outer;
        }
      }
    }
    return result;
  } catch (err) {
    result.error = err?.name === 'AbortError' ? 'timeout' : (err?.message || String(err));
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms) {
  if (!ms) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeTarget({ name, baseUrl, args, token, sharedLogin = null }) {
  const loginResult = sharedLogin || await login({
    baseUrl,
    token,
    server: args.server,
    timeoutMs: args.timeoutMs,
  });
  process.stderr.write(`${name} login_ms=${loginResult.login_ms}${sharedLogin ? ' shared=true' : ''}\n`);

  const turns = [];
  for (let i = 0; i < args.turns; i += 1) {
    const turn = await issueTurn({
      baseUrl,
      cookie: loginResult.cookie,
      prompt: args.prompt,
      turnIndex: i,
      timeoutMs: args.timeoutMs,
    });
    turns.push(turn);
    process.stderr.write(`${name} turn ${i}: ${JSON.stringify(turn)}\n`);
    if (i < args.turns - 1) await sleep(args.spacingMs);
  }

  return {
    name,
    base_url: baseUrl,
    login_ms: loginResult.login_ms,
    summary: summarize(turns),
    turns,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const token = authToken();
  if (!token) throw new Error('No QA_DOJO_TOKEN, ROBOTDOJO_AUTH_TOKEN, or robotdojo-ROBOTDOJO_AUTH_TOKEN Keychain value found');

  const targets = args.paths.map((name) => {
    const baseUrl = DEFAULT_TARGETS[name]?.replace(/\/$/, '');
    if (!baseUrl) throw new Error(`Unknown path "${name}". Use --target-${name} URL or one of ${Object.keys(DEFAULT_TARGETS).join(', ')}`);
    return { name, baseUrl };
  });

  let sharedLogin = null;
  if (args.loginPath && args.loginPath !== 'per-path') {
    const loginBaseUrl = DEFAULT_TARGETS[args.loginPath]?.replace(/\/$/, '');
    if (!loginBaseUrl) throw new Error(`Unknown --login-path "${args.loginPath}". Use per-path or one of ${Object.keys(DEFAULT_TARGETS).join(', ')}`);
    sharedLogin = await login({
      baseUrl: loginBaseUrl,
      token,
      server: args.server,
      timeoutMs: args.timeoutMs,
    });
    process.stderr.write(`shared login path=${args.loginPath} login_ms=${sharedLogin.login_ms}\n`);
  }

  const results = [];
  for (const target of targets) {
    results.push(await probeTarget({ ...target, args, token, sharedLogin }));
  }

  const byName = Object.fromEntries(results.map((result) => [result.name, result]));
  process.stdout.write(JSON.stringify({
    ok: results.every((result) => result.turns.every((turn) => !turn.error && Number.isFinite(turn.first_delta_ms))),
    server: args.server,
    turns: args.turns,
    paths: args.paths,
    login_path: args.loginPath,
    results: byName,
  }, null, 2) + '\n');
}

main().catch((err) => {
  console.error(`FAIL: ${err?.stack || err}`);
  process.exit(1);
});
