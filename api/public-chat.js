/**
 * Vercel Edge function — /api/public-chat/stream + /api/public-chat/onboarding-share.
 *
 * Edge runtime (V8 isolates, <50ms cold start) avoids the serverless cold-start
 * that was blowing the 10s timeout on @anthropic-ai/sdk. Shared pipeline and
 * context loading live in lib/public-chat/*.
 */

import { streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';

import {
  MODEL, MAX_TOKENS, MAX_TRANSCRIPT_MESSAGES, MAX_SOURCE_LEN, DAILY_LIMIT,
  sanitizeMessages,
  truthVersion,
} from '../lib/public-chat/core.js';
import { hashIp } from '../lib/public-chat/hash.js';
import {
  neonConfig, checkAndIncrementRate, logTranscript,
} from '../lib/public-chat/adapters/neon.js';
import { runStream, jsonResponse } from '../lib/public-chat/handler.js';
import { ipFromFetchRequest } from '../lib/ip.js';

export const config = { runtime: 'edge' };

// Body byte cap mirrors routes/public-chat.js MAX_BODY_BYTES (AC11).
const MAX_BODY_BYTES = 1024 * 1024;

const newSessionId = () => globalThis.crypto.randomUUID();

function handleHealth() {
  return jsonResponse({
    ok: true,
    route: 'public-chat',
    anthropic_configured: !!process.env.ANTHROPIC_API_KEY,
    neon_configured: !!neonConfig(),
    daily_limit: DAILY_LIMIT,
    truthVersion,
  });
}

async function handleStream(request, body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return jsonResponse({ error: 'api_key_not_configured' }, 500);
  const cfg = neonConfig();
  if (!cfg) return jsonResponse({ error: 'neon_not_configured' }, 500);

  const anthropic = createAnthropic({ apiKey });
  return runStream({
    body,
    ip: ipFromFetchRequest(request),
    userAgent: request.headers.get('user-agent') || null,
    referrer: request.headers.get('referer') || request.headers.get('referrer') || null,
    hashIpFn: hashIp,
    newSessionId,
    rateCheck: (ipHash, day) => checkAndIncrementRate(cfg, ipHash, day),
    log: (payload) => logTranscript(cfg, payload),
    streamFn: ({ system, messages }) => streamText({
      model: anthropic(MODEL),
      system,
      messages,
      maxOutputTokens: MAX_TOKENS,
    }),
  });
}

async function handleOnboardingShare(request, body) {
  const cfg = neonConfig();
  if (!cfg) return jsonResponse({ error: 'neon_not_configured' }, 500);

  const messages = sanitizeMessages(body.messages);
  if (!messages || messages.length === 0) return jsonResponse({ error: 'messages required' }, 400);
  if (messages.length > MAX_TRANSCRIPT_MESSAGES) {
    return jsonResponse({ error: `too many messages (max ${MAX_TRANSCRIPT_MESSAGES})` }, 413);
  }

  const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : newSessionId();
  const rawSource = typeof body.source === 'string' && body.source ? body.source : 'onboarding_share';
  const source = rawSource.slice(0, MAX_SOURCE_LEN);
  const ipHash = await hashIp(ipFromFetchRequest(request));

  try {
    await logTranscript(cfg, {
      sessionId, ipHash,
      userAgent: request.headers.get('user-agent') || null,
      referrer: request.headers.get('referer') || request.headers.get('referrer') || null,
      messages, source,
    });
  } catch (err) {
    console.error('[public-chat] onboarding log failed:', err.message);
    return jsonResponse({ error: 'log_failed' }, 502);
  }
  return jsonResponse({ ok: true, sessionId });
}

export default async function handler(request) {
  try {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname.endsWith('/health')) {
      return handleHealth();
    }
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return jsonResponse({ error: 'request_too_large' }, 413);
    // content-length is dropped on the apex->function rewrite on some edge routes,
    // so the header guard can be bypassed. Read the body incrementally and abort at
    // the cap WITHOUT buffering an oversize payload — a full read of an oversize body
    // crashes the isolate (FUNCTION_INVOCATION_FAILED) instead of a clean 413.
    let raw;
    if (request.body) {
      const reader = request.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      raw = '';
      while (true) {
        let chunk;
        try { chunk = await reader.read(); }
        catch { return jsonResponse({ error: 'invalid_json' }, 400); }
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          try { await reader.cancel(); } catch {}
          return jsonResponse({ error: 'request_too_large' }, 413);
        }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    } else {
      try { raw = await request.text(); }
      catch { return jsonResponse({ error: 'invalid_json' }, 400); }
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return jsonResponse({ error: 'request_too_large' }, 413);
    }
    let body;
    try { body = JSON.parse(raw); }
    catch { return jsonResponse({ error: 'invalid_json' }, 400); }

    if (url.pathname.endsWith('/onboarding-share')) return handleOnboardingShare(request, body);
    return await handleStream(request, body);
  } catch (err) {
    // Diagnostic wrapper: surface real errors rather than FUNCTION_INVOCATION_FAILED.
    console.error('[public-chat] top-level crash:', err?.stack || err?.message || err);
    return jsonResponse({
      error: 'internal_error',
      message: err?.message || 'unknown',
      name: err?.name || 'Error',
    }, 500);
  }
}
