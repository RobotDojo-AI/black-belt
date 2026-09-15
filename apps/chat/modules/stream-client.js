/**
 * Chat stream client (st_74f45a1a Phase 3).
 *
 * One-call entry point: streamChatTurn(args).
 *
 * Responsibilities:
 *   1. POST /api/chat/stream
 *   2. Read the SSE stream via stream-parser
 *   3. Watchdog — if no frame arrives within STALL_MS, call onStall and
 *      rehydrate the persisted assistant message via rehydrateFromDB()
 *   4. Surface fatal errors to onError(error_type, message)
 *
 * All side effects (fetch, rehydrate, callbacks) are injected so the module
 * stays unit-testable without a real network.
 */
import { createStreamParserState, parseSSEChunk } from './stream-parser.js';

// Default watchdog window. This is a dead-stream detector, not a first-token
// SLA. Real authed chat can spend 10–20s inside retrieval/model work after
// progress frames; aborting at 4s causes duplicate turns while the server is
// still producing the original answer.
export const STALL_MS = 30000;
export const REHYDRATE_GRACE_MS = 15000;
export const REHYDRATE_POLL_MS = 750;

const DEFAULT_ENDPOINT = '/api/chat/stream';
const DEFAULT_REHYDRATE_PATH = (convId) => `/api/conversations/${convId}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rehydrateWithGrace(rehydrateFromDB, conversationId, { graceMs, pollMs }) {
  const deadline = Date.now() + Math.max(0, graceMs);
  let lastError = null;
  while (true) {
    try {
      const rehydrated = await rehydrateFromDB(conversationId);
      if (rehydrated && rehydrated.assistantContent) return { rehydrated };
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(Math.max(50, pollMs), remaining));
  }
  if (lastError) return { error: lastError };
  return { rehydrated: null };
}

/**
 * Stream a single chat turn end-to-end.
 *
 * @param {object} args
 * @param {object} args.body - POST body for /api/chat/stream
 * @param {string} [args.endpoint] - override the URL (default /api/chat/stream)
 * @param {string} [args.searchParams] - extra query string (e.g., 'simulate=stall')
 * @param {AbortSignal} [args.signal] - cancellation
 * @param {string} [args.authToken] - optional local bearer token for remote relay hot path
 * @param {Function} [args.fetch] - injected fetch (default: global)
 * @param {Function} [args.rehydrateFromDB] - async (conversationId) => { assistantContent } | null
 * @param {Function} args.onEvent - (event) => void; fires for every parsed SSE event
 * @param {Function} [args.onStall] - () => void; fires when the watchdog trips
 * @param {Function} [args.onError] - ({error_type, status?, message}) => void
 * @param {Function} [args.onDone] - () => void; fires after the stream closes successfully
 * @param {number} [args.stallMs] - watchdog timeout (default STALL_MS)
 * @param {number} [args.rehydrateGraceMs] - bounded wait for the persisted assistant after a stall
 * @param {number} [args.rehydratePollMs] - poll interval during rehydrateGraceMs
 * @returns {Promise<{recovery_path?: string, rehydrated?: object, error?: object}>}
 */
export async function streamChatTurn(args) {
  const {
    body,
    endpoint = DEFAULT_ENDPOINT,
    searchParams = '',
    signal = undefined,
    authToken = null,
    fetch: injectedFetch = (typeof fetch !== 'undefined' ? fetch : null),
    rehydrateFromDB = null,
    onEvent = () => {},
    onStall = () => {},
    onError = () => {},
    onDone = () => {},
    stallMs = STALL_MS,
    rehydrateGraceMs = REHYDRATE_GRACE_MS,
    rehydratePollMs = REHYDRATE_POLL_MS,
  } = args;

  if (!injectedFetch) {
    onError({ error_type: 'no_fetch', message: 'fetch not available' });
    return { error: { error_type: 'no_fetch' } };
  }

  const url = endpoint + (searchParams ? (endpoint.includes('?') ? '&' : '?') + searchParams : '');
  let bearerToken = authToken;
  if (!bearerToken && typeof window !== 'undefined') {
    try { bearerToken = window.localStorage?.getItem?.('robotdojo_token') || null; } catch {}
  }
  const headers = { 'Content-Type': 'application/json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  let res;
  try {
    res = await injectedFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const info = {
      error_type: err?.name === 'AbortError' ? 'abort_error' : 'network_error',
      message: err.message,
    };
    onError(info);
    return { error: info };
  }

  if (!res.ok) {
    const info = { error_type: 'http_error', status: res.status, message: `HTTP ${res.status}` };
    onError(info);
    return { error: info };
  }

  const reader = res.body.getReader();
  const state = createStreamParserState();
  let conversationId = body?.conversationId || null;
  let stallFired = false;
  let sawDone = false;
  let serverError = null;
  let watchdog = null;

  // Watchdog timer — refreshed on every frame. If it expires, we trip into
  // the rehydrate path. Single-fire — once the watchdog fires we abandon
  // the reader for the rehydrate result.
  const resetWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stallFired = true;
      try { reader.cancel(); } catch { /* already closed */ }
    }, stallMs);
  };
  resetWatchdog();

  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        // Reader was cancelled — most likely by the watchdog.
        break;
      }
      if (chunk.done) break;
      let events;
      try {
        events = parseSSEChunk(chunk.value, state);
      } catch (err) {
        const info = { error_type: 'parse_error', message: err.message };
        onError(info);
        return { error: info };
      }
      if (events.length > 0) {
        resetWatchdog();
        for (const ev of events) {
          // Capture conversationId from status frame so rehydrate can target it.
          if (ev.type === 'status' && ev.conversationId) conversationId = ev.conversationId;
          if (ev.type === 'done') sawDone = true;
          // Surface server-side error frames as honest errors (still fires after
          // the loop completes, but the route may close before sending one).
          if (ev.type === 'error') {
            serverError = { error_type: 'server_error', message: ev.message || 'server error' };
            onError(serverError);
            try { await reader.cancel(); } catch {}
          }
          onEvent(ev);
        }
      }
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }

  if (serverError) return { error: serverError };

  // Recovery — invoked when the watchdog fired OR the stream closed without a
  // done frame. The latter is the simulate=stall/edge-close shape: the server
  // persisted the answer and closed before emitting done, so the browser must
  // rehydrate instead of treating a clean TCP close as a completed turn.
  if (stallFired || !sawDone) {
    onStall();
    if (typeof rehydrateFromDB === 'function' && conversationId) {
      const result = await rehydrateWithGrace(rehydrateFromDB, conversationId, {
        graceMs: rehydrateGraceMs,
        pollMs: rehydratePollMs,
      });
      if (result.rehydrated && result.rehydrated.assistantContent) {
        onDone();
        return { recovery_path: 'db_rehydrate', rehydrated: result.rehydrated };
      }
      if (result.error) {
        const err = result.error;
        const info = { error_type: 'rehydrate_error', message: err.message };
        onError(info);
        return { error: info };
      }
    }
    // Stall happened but rehydrate produced nothing — surface as an error.
    const errorType = stallFired ? 'stall_no_rehydrate' : 'closed_without_done';
    const info = {
      error_type: errorType,
      message: stallFired
        ? 'stream stalled and no persisted reply found'
        : 'stream closed without done and no persisted reply found',
    };
    onError(info);
    return { error: info };
  }

  onDone();
  return {};
}

export { DEFAULT_REHYDRATE_PATH };
