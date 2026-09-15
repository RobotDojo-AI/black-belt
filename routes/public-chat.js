/**
 * Public chat — local Hono mount for /api/public-chat/stream + /onboarding-share.
 *
 * Mirrors the Edge function in api/public-chat.js. Both consume the same
 * shared pipeline (lib/public-chat/handler.js) and core (lib/public-chat/core.js)
 * so there is exactly one place that knows about the prompt contract, context
 * packs, rate limit, and SSE frame format. The only difference is the adapter:
 * Hono uses SQLite; Edge uses Supabase REST.
 */

import crypto from 'node:crypto';

import { Hono } from 'hono';
import config from '../lib/config.js';
// st_74f45a1a R2 — Anthropic streaming now flows through lib/llm/anthropic.
import { getProvider } from '../lib/llm/index.js';
import { ipFromHonoContext } from '../lib/ip.js';

const routes = new Hono();

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — rejects oversized bodies before LLM spend

let publicChatModulesPromise = null;
async function publicChatModules() {
  if (!publicChatModulesPromise) {
    publicChatModulesPromise = Promise.all([
      import('../lib/public-chat/core.js'),
      import('../lib/public-chat/hash.js'),
      import('../lib/public-chat/adapters/sqlite.js'),
      import('../lib/public-chat/handler.js'),
      // Node-only owner FAQ notes. Local server path only; the Edge function
      // (api/public-chat.js) MUST NOT import this module (st_85ca4f3c AC 15).
      import('../lib/public-chat/owner-notes.js'),
    ]).then(([core, hash, sqlite, handler, ownerNotes]) => ({
      ...core,
      hashIp: hash.hashIp,
      checkAndIncrementRate: sqlite.checkAndIncrementRate,
      logTranscript: sqlite.logTranscript,
      runStream: handler.runStream,
      ownerFaqNotes: ownerNotes.ownerFaqNotes,
    }));
  }
  return publicChatModulesPromise;
}

// Health probe — lightweight readiness check, safe to poll without hitting rate limit.
routes.get('/api/public-chat/health', async (c) => {
  const { DAILY_LIMIT, truthVersion } = await publicChatModules();
  return c.json({
    ok: true,
    route: 'public-chat',
    anthropic_configured: !!config.anthropicKey,
    daily_limit: DAILY_LIMIT,
    truthVersion,
  });
});

routes.post('/api/public-chat/stream', async (c) => {
  if (!config.anthropicKey) return c.json({ error: 'service_unavailable' }, 500);
  if (Number(c.req.header('content-length') || 0) > MAX_BODY_BYTES) {
    return c.json({ error: 'request_too_large' }, 413);
  }

  const {
    MODEL,
    MAX_TOKENS,
    sanitizeMessages,
    hashIp,
    checkAndIncrementRate,
    logTranscript,
    runStream,
    ownerFaqNotes,
  } = await publicChatModules();
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  // st_85ca4f3c AC 13 — TTFT instrumentation for the public FAQ stream.
  // requestStart is captured at handler entry; firstDeltaLogged guards the
  // single first-delta log line so subsequent deltas do not spam the log.
  // This is the machine-observable proof point for the warm-path latency
  // target (≤ 2.5s); the actual number is read from the server log.
  const requestStart = Date.now();
  let firstDeltaLogged = false;

  const provider = await getProvider('anthropic');
  return runStream({
    body,
    ip: ipFromHonoContext(c),
    userAgent: c.req.header('user-agent') || null,
    referrer: c.req.header('referer') || c.req.header('referrer') || null,
    hashIpFn: hashIp,
    newSessionId: () => crypto.randomUUID(),
    rateCheck: checkAndIncrementRate,
    log: logTranscript,
    // Local-only Layer 2 of the cached system prompt. Edge path passes nothing.
    ownerNotes: ownerFaqNotes,
    // Adapt the provider's streamChat() generator to the {textStream}
    // shape runStream expects. Concrete model id passes through.
    // st_85ca4f3c AC 13 — `cache: 'system'` enables prompt caching on the
    // canonical corpus block authored by buildSystemPrompt(); the array shape
    // makes Anthropic's ephemeral cache hold the prefix across requests.
    streamFn: ({ system, messages }) => ({
      textStream: (async function* () {
        for await (const ev of provider.streamChat({
          model: MODEL, max_tokens: MAX_TOKENS, system, messages, cache: 'system',
        })) {
          if (ev.type === 'delta') {
            if (!firstDeltaLogged) {
              const ttft = Date.now() - requestStart;
              console.info(`[public-chat] faq ttft_ms: ${ttft}`);
              firstDeltaLogged = true;
            }
            yield ev.text;
          }
        }
      })(),
    }),
  });
});

routes.post('/api/public-chat/onboarding-share', async (c) => {
  const {
    MAX_TRANSCRIPT_MESSAGES,
    MAX_SOURCE_LEN,
    sanitizeMessages,
    hashIp,
    logTranscript,
  } = await publicChatModules();
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const messages = sanitizeMessages(body.messages);
  if (!messages || messages.length === 0) return c.json({ error: 'messages_required' }, 400);
  if (messages.length > MAX_TRANSCRIPT_MESSAGES) {
    return c.json({ error: `too many messages (max ${MAX_TRANSCRIPT_MESSAGES})` }, 413);
  }

  const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : crypto.randomUUID();
  const source = typeof body.source === 'string' && body.source
    ? body.source.slice(0, MAX_SOURCE_LEN)
    : 'onboarding_share';
  const ipHash = await hashIp(ipFromHonoContext(c));

  logTranscript({
    sessionId, ipHash,
    userAgent: c.req.header('user-agent') || null,
    referrer: c.req.header('referer') || c.req.header('referrer') || null,
    messages, source,
  });
  return c.json({ ok: true, sessionId });
});
export default routes;
