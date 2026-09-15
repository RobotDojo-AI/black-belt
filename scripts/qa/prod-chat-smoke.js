#!/usr/bin/env node
/**
 * Production chat smoke.
 *
 * Authenticates at the apex with the local Keychain token, lets Vercel
 * middleware route through the installed device slug, then verifies:
 *   - session handoff works
 *   - authenticated API calls proxy to the Mac
 *   - a real chat-sync turn returns assistant content (and exercises inline
 *     entity recognition server-side via the entity-naming prompt)
 *
 * The script never prints tokens, cookies, the device slug, or chat content.
 */
import crypto from 'node:crypto';
import { readKeychainSecret } from '../../lib/keychain.js';
import { loadProofFixtures } from './proof-fixtures.js';

const DEFAULT_BASE_URL = 'https://robotdojo.ai';
// Synthetic placeholder. The real proof prompt names a live owner entity and
// lives ONLY in the gitignored config/qa-proof-fixtures.user.json override;
// a fresh clone exercises the auth+chat path with this public-figure prompt.
const DEFAULT_CHAT_PROMPT = loadProofFixtures().prodChatPrompt
  || 'For QA only, answer in one short sentence: who was Ada Lovelace?';
const DEFAULT_TIMEOUT_MS = 45_000;

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    chatPrompt: DEFAULT_CHAT_PROMPT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skipChat: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url' || arg === '--base') args.baseUrl = argv[++i];
    else if (arg === '--server' || arg === '--slug') args.server = argv[++i];
    else if (arg === '--chat-prompt') args.chatPrompt = argv[++i];
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--skip-chat') args.skipChat = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/qa/prod-chat-smoke.js [options]

Options:
  --base-url <url>       Production base URL. Default: ${DEFAULT_BASE_URL}
  --server <slug>        Device/server slug. Default: env or Keychain
  --chat-prompt <text>   Prompt for the authenticated chat turn
  --timeout-ms <ms>      Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --skip-chat            Verify auth path without calling the LLM
`);
      process.exit(0);
    }
  }

  return args;
}

function readSecret(name) {
  return process.env[name] || readKeychainSecret(name);
}

function readServerSlug(explicit) {
  return explicit
    || process.env.QA_SERVER_NAME
    || process.env.ROBOTDOJO_SERVER_SLUG
    || process.env.ROBOTDOJO_DEVICE_SLUG
    || readKeychainSecret('ROBOTDOJO_DEVICE_SLUG');
}

function fail(reason, details = {}) {
  const sanitized = sanitize({ ok: false, reason, ...details });
  console.error(JSON.stringify(sanitized, null, 2));
  process.exit(1);
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|cookie|session|secret|slug/i.test(key)) {
      if (typeof raw === 'boolean' || raw == null) out[key] = raw;
      else if (typeof raw === 'number') out[key] = raw;
      else if (raw && typeof raw === 'object') out[key] = sanitize(raw);
      else out[key] = '[redacted]';
    } else {
      out[key] = sanitize(raw);
    }
  }
  return out;
}

function baseUrl(url) {
  const parsed = new URL(url || DEFAULT_BASE_URL);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function splitSetCookie(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value)
    .split(/,\s*(?=[A-Za-z0-9_%-]+=)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  return splitSetCookie(headers.get('set-cookie'));
}

function cookieHeaderFromSetCookies(setCookies) {
  const pairs = [];
  for (const cookie of setCookies) {
    const first = String(cookie || '').split(';')[0].trim();
    if (first) pairs.push(first);
  }
  return pairs.join('; ');
}

function hasCookie(cookieHeader, name) {
  return new RegExp(`(?:^|;\\s*)${name}=`).test(cookieHeader || '');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { _nonJson: true, textLength: text.length };
  }
}

export async function runProdChatSmoke(options = {}) {
  const started = Date.now();
  const opts = { ...parseArgs([]), ...options };
  const targetBase = baseUrl(opts.baseUrl);
  const token = readSecret('ROBOTDOJO_AUTH_TOKEN');
  const server = readServerSlug(opts.server);

  if (!token) fail('missing_auth_token', { targetBase });
  if (!server) fail('missing_server_slug', { targetBase });

  const loginRes = await fetchWithTimeout(`${targetBase}/api/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server, token, redirect: '/chat' }),
    redirect: 'manual',
  }, opts.timeoutMs);
  const loginBody = await readJson(loginRes);
  const cookieHeader = cookieHeaderFromSetCookies(getSetCookies(loginRes.headers));
  const hasSessionCookie = hasCookie(cookieHeader, 'rdj_session');
  const hasRoutingCookie = hasCookie(cookieHeader, 'rd_server');

  if (loginRes.status !== 200 || loginBody?.ok !== true || !hasSessionCookie || !hasRoutingCookie) {
    fail('login_failed', {
      targetBase,
      status: loginRes.status,
      body: loginBody,
      cookies: { session: hasSessionCookie, routing: hasRoutingCookie },
    });
  }

  const authHeaders = { cookie: cookieHeader, accept: 'application/json' };

  const meRes = await fetchWithTimeout(`${targetBase}/api/auth/me`, {
    headers: authHeaders,
    redirect: 'manual',
  }, opts.timeoutMs);
  const meBody = await readJson(meRes);
  if (meRes.status !== 200 || !meBody?.user) {
    fail('auth_me_failed', { targetBase, status: meRes.status, body: meBody });
  }

  const ttftRes = await fetchWithTimeout(`${targetBase}/api/chat/ttft-estimate`, {
    headers: authHeaders,
    redirect: 'manual',
  }, opts.timeoutMs);
  const ttftBody = await readJson(ttftRes);
  if (ttftRes.status !== 200) {
    fail('ttft_failed', { targetBase, status: ttftRes.status, body: ttftBody });
  }

  // st_fd14cdd4 follow-up (2026-06-13): the @-mention person-search route
  // (/api/entities/search) was removed. Entity recognition is now exercised
  // end-to-end by the chat-sync turn below (the prompt names an entity and the
  // server runs inline recognition over the rolling window).
  let chat = null;
  if (!opts.skipChat) {
    const chatRes = await fetchWithTimeout(`${targetBase}/api/chat/sync`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: opts.chatPrompt }],
        topic: null,
        useTools: false,
        conversation_id: `qa-prod-${crypto.randomUUID()}`,
      }),
      redirect: 'manual',
    }, opts.timeoutMs);
    const chatBody = await readJson(chatRes);
    const content = typeof chatBody?.content === 'string' ? chatBody.content : '';
    if (chatRes.status !== 200 || !content.trim()) {
      fail('chat_sync_failed', {
        targetBase,
        status: chatRes.status,
        bodyError: chatBody?.error || null,
        bodyMessage: chatBody?.message || null,
      });
    }
    chat = {
      status: chatRes.status,
      contentLength: content.length,
      inputTokens: Number(chatBody?.usage?.input_tokens || 0),
      outputTokens: Number(chatBody?.usage?.output_tokens || 0),
    };
  }

  return {
    ok: true,
    targetBase,
    serverSlugPresent: Boolean(server),
    serverSlugLength: String(server).length,
    auth: {
      loginStatus: loginRes.status,
      meStatus: meRes.status,
      userBelt: meBody.user?.belt || null,
      cookies: { session: hasSessionCookie, routing: hasRoutingCookie },
    },
    ttft: {
      status: ttftRes.status,
      estimateMs: ttftBody?.estimate_ms || ttftBody?.p50_ms || null,
    },
    chat,
    durationMs: Date.now() - started,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  runProdChatSmoke(args)
    .then((summary) => {
      console.log(JSON.stringify(sanitize(summary), null, 2));
    })
    .catch((err) => fail('smoke_threw', { error: err?.message || String(err) }));
}
