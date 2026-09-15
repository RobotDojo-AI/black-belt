#!/usr/bin/env node
import { Agent, fetch as undiciFetch } from 'undici';
import { readKeychainSecret } from '../../lib/keychain.js';
import config from '../../lib/config.js';

const DEFAULT_BASE_URL = `https://localhost:${config.ports.app}`;
const SECRET_KEY_RE = /(token|secret|password|key|authorization|cookie)/i;

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    baseUrl: DEFAULT_BASE_URL,
    cleanup: true,
    timeoutMs: 30000,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cleanup') {
      opts.cleanup = true;
    } else if (arg === '--no-cleanup') {
      opts.cleanup = false;
    } else if (arg === '--base-url') {
      opts.baseUrl = argv[++i] || opts.baseUrl;
    } else if (arg.startsWith('--base-url=')) {
      opts.baseUrl = arg.slice('--base-url='.length);
    } else if (arg === '--timeout-ms') {
      opts.timeoutMs = Number.parseInt(argv[++i] || '', 10) || opts.timeoutMs;
    } else if (arg.startsWith('--timeout-ms=')) {
      opts.timeoutMs = Number.parseInt(arg.slice('--timeout-ms='.length), 10) || opts.timeoutMs;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return opts;
}

export function usage() {
  return [
    `Usage: node scripts/qa/live-data-plane-proof.js [--base-url ${DEFAULT_BASE_URL}] [--cleanup|--no-cleanup] [--timeout-ms 30000]`,
    '',
    'Calls the installed app admin data-plane proof endpoint. The database proof runs inside the app process and cleans up its QA rows by default.',
  ].join('\n');
}

export function readAuthToken() {
  return process.env.QA_AUTH_TOKEN
    || process.env.ROBOTDOJO_AUTH_TOKEN
    || readKeychainSecret('ROBOTDOJO_AUTH_TOKEN')
    || '';
}

function localHttpsDispatcher(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') return undefined;
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return undefined;
  return new Agent({ connect: { rejectUnauthorized: false } });
}

export function sanitizeForOutput(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeForOutput(item));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = sanitizeForOutput(child);
    }
  }
  return out;
}

export function resultPasses(result) {
  if (!result?.ok) return false;
  const required = Array.isArray(result.required_boundaries) ? result.required_boundaries : [];
  return required.every((name) => result.boundaries?.[name]?.ok === true);
}

export async function runLiveDataPlaneProof({
  baseUrl = DEFAULT_BASE_URL,
  cleanup = true,
  timeoutMs = 30000,
  token = readAuthToken(),
  fetchImpl = undiciFetch,
} = {}) {
  if (!token) {
    throw new Error('missing ROBOTDOJO_AUTH_TOKEN; set QA_AUTH_TOKEN or store robotdojo-ROBOTDOJO_AUTH_TOKEN in Keychain');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = localHttpsDispatcher(baseUrl);
  try {
    const url = new URL('/api/admin/data-plane-proof', baseUrl);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ cleanup }),
      signal: controller.signal,
      dispatcher,
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { ok: false, error: 'invalid_json_response', status: res.status };
    }
    return {
      status: res.status,
      ok: res.ok && resultPasses(body),
      response: sanitizeForOutput(body),
    };
  } finally {
    clearTimeout(timer);
    if (dispatcher) await dispatcher.close().catch(() => {});
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs();
  } catch (err) {
    console.error(`[live-data-plane-proof] ${err.message}`);
    console.error(usage());
    process.exit(2);
  }

  if (opts.help) {
    console.log(usage());
    return;
  }

  try {
    const result = await runLiveDataPlaneProof(opts);
    console.log(JSON.stringify(result.response, null, 2));
    if (!result.ok) process.exit(1);
  } catch (err) {
    console.error(`[live-data-plane-proof] ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
