/**
 * Public chat stream client — faq-app copy of the chat-app stream client.
 *
 * Originally extracted in st_74f45a1a Phase 3 for the authed chat surface;
 * duplicated here under apps/faq/modules/ in st_85ca4f3c so the public faq
 * surface doesn't load any code from the middleware-gated /chat/* tree. The
 * only meaningful difference from apps/chat/modules/stream-client.js is the
 * default endpoint: this copy targets the public stream endpoint by default
 * so the faq bundle contains no authed-API string literals.
 *
 * One-call entry point: streamChatTurn(args).
 *
 * Responsibilities:
 *   1. POST to the public-chat streaming endpoint
 *   2. Read the SSE stream via stream-parser
 *   3. Watchdog — if no frame arrives within STALL_MS, call onStall and
 *      rehydrate the persisted assistant message via rehydrateFromDB()
 *   4. Surface fatal errors to onError(error_type, message)
 *
 * All side effects (fetch, rehydrate, callbacks) are injected so the module
 * stays unit-testable without a real network.
 */
import { createStreamParserState, parseSSEChunk } from './stream-parser.js';

// Default watchdog window. Tuned wide enough to clear typical slow-network
// gaps (1–2s) but tight enough to keep the user out of an indefinite spinner.
// Source-of-truth — referenced by tests and the indicator's expectation budget.
export const STALL_MS = 4000;

// st_85ca4f3c — public-chat endpoint as the default in this faq-owned copy.
// The chat-app's copy defaults to the authed endpoint; this copy defaults to
// the public endpoint so the faq bundle contains zero authed-API references.
const DEFAULT_ENDPOINT = '/api/public-chat/stream';
// Public mode has no DB rehydrate path — sessions are anonymous and the
// server doesn't persist a per-conversation transcript. Kept null so the
// streamChatTurn signature stays compatible with the chat-app copy.
const DEFAULT_REHYDRATE_PATH = null;

/**
 * Stream a single public chat turn end-to-end.
 *
 * @param {object} args
 * @param {object} args.body - POST body for /api/public-chat/stream
 * @param {string} [args.endpoint] - override the URL (default /api/public-chat/stream)
 * @param {string} [args.searchParams] - extra query string (e.g., 'simulate=stall')
 * @param {AbortSignal} [args.signal] - cancellation
 * @param {Function} [args.fetch] - injected fetch (default: global)
 * @param {Function} [args.rehydrateFromDB] - async (conversationId) => { assistantContent } | null
 * @param {Function} args.onEvent - (event) => void; fires for every parsed SSE event
 * @param {Function} [args.onStall] - () => void; fires when the watchdog trips
 * @param {Function} [args.onError] - ({error_type, status?, message}) => void
 * @param {Function} [args.onDone] - () => void; fires after the stream closes successfully
 * @param {number} [args.stallMs] - watchdog timeout (default STALL_MS)
 * @returns {Promise<{recovery_path?: string, rehydrated?: object, error?: object}>}
 */
export async function streamChatTurn(args) {
  const {
    body,
    endpoint = DEFAULT_ENDPOINT,
    searchParams = '',
    signal = undefined,
    fetch: injectedFetch = (typeof fetch !== 'undefined' ? fetch : null),
    rehydrateFromDB = null,
    onEvent = () => {},
    onStall = () => {},
    onError = () => {},
    onDone = () => {},
    stallMs = STALL_MS,
  } = args;

  if (!injectedFetch) {
    onError({ error_type: 'no_fetch', message: 'fetch not available' });
    return { error: { error_type: 'no_fetch' } };
  }

  const url = endpoint + (searchParams ? (endpoint.includes('?') ? '&' : '?') + searchParams : '');

  let res;
  try {
    res = await injectedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const info = { error_type: 'network_error', message: err.message };
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
          // Surface server-side error frames as honest errors (still fires after
          // the loop completes, but the route may close before sending one).
          if (ev.type === 'error') {
            onError({ error_type: 'server_error', message: ev.message || 'server error' });
          }
          onEvent(ev);
        }
      }
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }

  // Stall recovery — invoked only if the watchdog fired AND we have a
  // rehydrate function AND a conversationId to look up.
  if (stallFired) {
    onStall();
    if (typeof rehydrateFromDB === 'function' && conversationId) {
      try {
        const rehydrated = await rehydrateFromDB(conversationId);
        if (rehydrated && rehydrated.assistantContent) {
          onDone();
          return { recovery_path: 'db_rehydrate', rehydrated };
        }
      } catch (err) {
        const info = { error_type: 'rehydrate_error', message: err.message };
        onError(info);
        return { error: info };
      }
    }
    // Stall happened but rehydrate produced nothing — surface as an error.
    const info = { error_type: 'stall_no_rehydrate', message: 'stream stalled and no persisted reply found' };
    onError(info);
    return { error: info };
  }

  onDone();
  return {};
}

export { DEFAULT_REHYDRATE_PATH };
