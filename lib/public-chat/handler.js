/**
 * Shared request-handling pipeline for both runtimes.
 *
 * The Edge function and the local Hono route each wire their own transport
 * (Request/Response vs Hono context) but share the actual pipeline:
 *   sanitize → rate-check → pre-log → stream → post-log.
 *
 * Kept deliberately small: no LLM call in here — the caller passes in a
 * `streamFn` that returns `{ textStream, textPromise }` so we can support
 * both the Vercel AI SDK (Edge) and the raw Anthropic SDK (Node) with the
 * same SSE frame format.
 */

import {
  MAX_HISTORY,
  DAILY_LIMIT,
  DEFAULT_CONTEXT,
  sanitizeMessages,
  loadContext,
  buildSystemPromptString,
  truthVersion,
  utcDay,
} from './core.js';

/**
 * Run the full public-chat pipeline and return a Response with the SSE stream.
 *
 * @param {Object} args
 * @param {Request|Object} args.request - Fetch Request or Hono-ish shim
 * @param {Object} args.body - parsed JSON body
 * @param {string} args.ip - already-extracted client IP
 * @param {string} args.userAgent
 * @param {string|null} args.referrer
 * @param {Function} args.hashIpFn - (ip) => Promise<string>
 * @param {Function} args.newSessionId - () => string
 * @param {Function} args.rateCheck - (ipHash, dayUtc) => Promise<boolean>|boolean
 * @param {Function} args.log - (payload) => void|Promise<void>
 * @param {Function} args.streamFn - ({ system, messages }) => { textStream, done: Promise<string> }
 * @param {string|null} [args.ownerNotes] - optional operator FAQ notes string to
 *   inject as Layer 2 of the cached system prompt. Local Node path only — the
 *   Edge function never passes notes (Edge cannot read local disk). See
 *   `lib/public-chat/owner-notes.js` for the Node-only loader (st_85ca4f3c AC 15).
 * @returns {Promise<Response>}
 */
export async function runStream({
  body,
  ip,
  userAgent,
  referrer,
  hashIpFn,
  newSessionId,
  rateCheck,
  log,
  streamFn,
  ownerNotes = null,
}) {
  const messages = sanitizeMessages(body?.messages);
  if (!messages || messages.length === 0) {
    return jsonResponse({ error: 'messages required' }, 400);
  }
  if (messages[messages.length - 1].role !== 'user') {
    return jsonResponse({ error: 'last message must be from user' }, 400);
  }

  const ipHash = await hashIpFn(ip);
  try {
    const allowed = await rateCheck(ipHash, utcDay());
    if (!allowed) return jsonResponse({ error: `Daily limit reached (${DAILY_LIMIT} messages)` }, 429);
  } catch (err) {
    console.error('[public-chat] rate-limit lookup failed:', err.message);
    return jsonResponse({ error: 'rate_limit_unavailable' }, 503);
  }

  const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : newSessionId();
  const contextName = typeof body.context === 'string' ? body.context : DEFAULT_CONTEXT;
  const ctx = loadContext(contextName);
  // System prompt is a plain STRING for both transports: the Edge path
  // (ai-sdk streamText) requires a string; the local path (lib/llm) wraps it
  // into a cached block via `cache: 'system'`. Owner notes (local-only, Edge
  // passes null) append as a final section. (st_85ca4f3c — fixes a prod LLM
  // failure where a SystemBlock[] array was passed to ai-sdk's `system`.)
  const baseSystem = buildSystemPromptString(ctx);
  const trimmedNotes = typeof ownerNotes === 'string' ? ownerNotes.trim() : '';
  const systemPrompt = trimmedNotes
    ? `${baseSystem}\n\n## Owner notes (supplemental)\n\n${trimmedNotes}`
    : baseSystem;
  const history = messages.slice(-MAX_HISTORY);

  // Pre-log so the user's prompt survives a downstream failure.
  try {
    await log({ sessionId, ipHash, userAgent, referrer, messages, source: 'public_chat' });
  } catch (err) {
    console.error('[public-chat] initial log failed:', err.message);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let assistantText = '';
      try {
        send({ type: 'status', sessionId, truthVersion });
        // Always answer from the LLM over the correct FAQ context — no
        // deterministic single-FAQ shortcut (st_7b4a0abb AC15). The system
        // prompt already carries the full FAQ projection via buildSystemPrompt.
        const { textStream } = streamFn({ system: systemPrompt, messages: history });
        for await (const chunk of textStream) {
          if (!chunk) continue;
          assistantText += chunk;
          send({ type: 'delta', text: chunk });
        }
        // Surface a silent empty stream as an error instead of a clean 'done'
        // that leaves the UI hanging on the loading indicator. The AI SDK can
        // end textStream with no chunks and no throw when the upstream call
        // fails (e.g. an invalid API key), so an empty answer is treated as a
        // failure for this always-LLM public chat (st_7b4a0abb).
        if (!assistantText.trim()) {
          send({ type: 'error', message: 'The assistant is temporarily unavailable. Please try again in a moment.' });
          send({ type: 'done', sessionId, truthVersion });
          return;
        }
        try {
          await log({
            sessionId, ipHash, userAgent, referrer,
            messages: [...messages, { role: 'assistant', content: assistantText }],
            source: 'public_chat',
          });
        } catch (err) {
          console.error('[public-chat] final log failed:', err.message);
        }
        send({ type: 'done', sessionId, truthVersion });
      } catch (err) {
        console.error('[public-chat] stream error:', err?.message || err);
        send({ type: 'error', message: err?.message || 'stream error' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

/** JSON response helper — used by both runtimes' error paths. */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
