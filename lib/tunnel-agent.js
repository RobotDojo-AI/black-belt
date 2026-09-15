/**
 * Tunnel agent — outbound WebSocket to relay.robotdojo.ai.
 *
 * Runs when belt === 'black' and a tunnel token is provisioned. Maintains a
 * single persistent WebSocket; reconnects with exponential backoff on drop.
 * Receives HTTP requests from the gateway, forwards them to localhost:4338,
 * returns the response. Also receives control events (key_issued,
 * key_revoked) from the billing backend.
 *
 * Why outbound-from-user-Mac: users don't need to open a port, configure a
 * router, or run Tailscale. The Mac makes one outbound TLS/WSS call; all
 * subsequent RPC multiplexes through that single connection.
 *
 * Uses Node 20's built-in WebSocket — zero new dependencies.
 */
import { saveKey, deleteKey, setGraceUntil } from './key-store.js';
import { loadModules, unloadModules, markRevoked, getLoadedBelt } from './module-loader.js';
import config from './config.js';

// st_bc949e7c Pass B Phase 3: post-consolidation. key_issued no longer writes
// an encrypted bundle to ~/.robotdojo/modules/ — the BB code is in the repo
// as ungated source, gated only by isBBActive() at the route boundary. The
// payload's `bundle` field is ignored if the gateway still sends one (legacy
// shape). The remaining handler work is local key state + cache flip.

const activeRequests = new Map(); // id -> AbortController

const DEFAULT_OPTS = {
  // Default is the production relay hostname. Why `relay.*` and not
  // `gateway.*`: see the note in lib/config.js — CA blacklisted the earlier
  // hostname after repeated failed ACM validations during 2026-04-19 setup.
  gateway: process.env.ROBOTDOJO_GATEWAY || 'wss://relay.robotdojo.ai',
  localOrigin: process.env.ROBOTDOJO_LOCAL || `http://127.0.0.1:${config.ports.app}`,
  minBackoffMs: 1000,
  maxBackoffMs: 60000,
};

export function startTunnelAgent({ token, onKeyChange } = {}, opts = {}) {
  if (!token) {
    console.info('[tunnel-agent] no token; not starting');
    return { stop() {} };
  }
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const state = { ws: null, backoff: cfg.minBackoffMs, stopped: false, timer: null };

  const connect = () => {
    if (state.stopped) return;
    const url = `${cfg.gateway.replace(/^http/, 'ws')}/tunnel?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.backoff = cfg.minBackoffMs;
      console.info('[tunnel-agent] connected');
    });
    ws.addEventListener('message', (ev) => handleMessage(ws, ev.data, cfg, onKeyChange));
    ws.addEventListener('close', (ev) => {
      console.warn(`[tunnel-agent] closed code=${ev.code} reason=${ev.reason}`);
      // Abort all in-flight requests so their fetch calls don't linger.
      for (const [, ac] of activeRequests) { try { ac.abort(); } catch {} }
      activeRequests.clear();
      state.ws = null;
      if (state.stopped) return;
      state.timer = setTimeout(connect, state.backoff);
      state.backoff = Math.min(state.backoff * 2, cfg.maxBackoffMs);
    });
    ws.addEventListener('error', (e) => console.warn('[tunnel-agent] error:', e.message || e));
  };

  connect();

  const stop = () => {
    state.stopped = true;
    clearTimeout(state.timer);
    try { state.ws?.close(1000, 'shutdown'); } catch {}
  };
  process.on('SIGTERM', stop);
  return { stop };
}

async function handleMessage(ws, raw, cfg, onKeyChange) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  if (msg.type === 'cancel') {
    const ac = activeRequests.get(msg.id);
    if (ac) {
      ac.abort();
      activeRequests.delete(msg.id);
    }
    return;
  }

  if (msg.type === 'control') {
    await handleControl(msg, onKeyChange);
    return;
  }

  if (msg.type === 'request') {
    await forwardRequest(ws, msg, cfg);
    return;
  }
}

async function forwardRequest(ws, msg, cfg) {
  const ac = new AbortController();
  activeRequests.set(msg.id, ac);

  const target = cfg.localOrigin + msg.path;
  const init = {
    method: msg.method,
    headers: msg.headers || {},
    body: msg.body ? Buffer.from(msg.body, 'base64') : undefined,
    // CRITICAL: do NOT follow redirects. This agent is a dumb HTTP
    // forwarder — the BROWSER at the other end of the tunnel is the one
    // that should follow 302s (so it can also pick up Set-Cookie and
    // use its own cookie jar). If fetch followed redirects here, the
    // login flow's 302 → /me/<slug>/chat/ would be chased server-side,
    // returning 404 from the Mac (no such route — /me/<slug>/ is a
    // relay-level prefix, not a Mac-level route) AND silently dropping
    // the Set-Cookie that was supposed to establish the session.
    redirect: 'manual',
    signal: ac.signal,
  };
  if (init.method === 'GET' || init.method === 'HEAD') delete init.body;

  try {
    const resp = await fetch(target, init);
    const headers = Object.fromEntries(resp.headers);

    if (msg.stream && resp.body) {
      // Streaming mode: send headers immediately, then pipe body chunks.
      // Eliminates the buffering that caused gateway timeouts on long SSE streams.
      ws.send(JSON.stringify({ type: 'response_start', id: msg.id, status: resp.status, headers }));
      const reader = resp.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (ac.signal.aborted) break;
          ws.send(JSON.stringify({
            type: 'response_chunk',
            id: msg.id,
            data: Buffer.from(value).toString('base64'),
          }));
        }
      } finally {
        reader.releaseLock();
        activeRequests.delete(msg.id);
      }
      if (!ac.signal.aborted) {
        ws.send(JSON.stringify({ type: 'response_end', id: msg.id }));
      }
    } else {
      // Buffered mode: read the full response body, then send.
      // Large bodies (>16 KB) are sent via the streaming protocol to avoid
      // single-frame WebSocket messages that the built-in Node WebSocket
      // occasionally truncates at 32 KB / 64 KB boundaries.
      const buf = Buffer.from(await resp.arrayBuffer());
      activeRequests.delete(msg.id);
      if (buf.length > 16 * 1024 && resp.body) {
        // Stream large responses in 16 KB base64 chunks.
        ws.send(JSON.stringify({ type: 'response_start', id: msg.id, status: resp.status, headers }));
        const CHUNK = 16 * 1024;
        for (let off = 0; off < buf.length; off += CHUNK) {
          ws.send(JSON.stringify({
            type: 'response_chunk',
            id: msg.id,
            data: buf.slice(off, off + CHUNK).toString('base64'),
          }));
        }
        ws.send(JSON.stringify({ type: 'response_end', id: msg.id }));
      } else {
        ws.send(JSON.stringify({
          type: 'response', id: msg.id,
          status: resp.status, headers,
          body: buf.length ? buf.toString('base64') : null,
        }));
      }
    }
  } catch (e) {
    activeRequests.delete(msg.id);
    if (e.name === 'AbortError') return; // client cancelled — no reply needed
    if (msg.stream) {
      ws.send(JSON.stringify({ type: 'response_error', id: msg.id, error: e.message }));
    } else {
      ws.send(JSON.stringify({
        type: 'response', id: msg.id,
        status: 502, headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ error: 'local_unreachable', detail: e.message })).toString('base64'),
      }));
    }
  }
}

async function handleControl(msg, onKeyChange) {
  // Accept either the gateway envelope shape {event, payload} or the
  // simplified {type, key, modules_url} shape described in the spec.
  const event = msg.event || msg.type;
  const payload = msg.payload || msg;

  if (event === 'key_issued') {
    const belt = payload.belt || 'black';
    try {
      // Post-consolidation: bundle field (if present in payload) is ignored —
      // BB source is ungated in the repo, gated only by isBBActive() checks.
      await saveKey({ key: payload.key, belt });
      // Expires on the same calendar day next month — matches Stripe's billing cycle.
      // Renewal payment issues a fresh key which resets this window.
      const nextBilling = new Date();
      nextBilling.setMonth(nextBilling.getMonth() + 1);
      await setGraceUntil(nextBilling);
      // Flip the module-loader cache so getBBModule() / getLoadedBelt() reflect
      // the new key without waiting for the next route handler to trigger a check.
      const result = await loadModules();
      console.info(`[tunnel-agent] key_issued → belt=${result.belt}`);
      if (onKeyChange) await onKeyChange({ state: 'issued', belt: result.belt });
    } catch (e) {
      console.error('[tunnel-agent] key_issued handling failed:', e.message);
    }
    return;
  }

  if (event === 'key_revoked') {
    try {
      await markRevoked();
      console.info('[tunnel-agent] key_revoked — modules unloaded immediately');
      if (onKeyChange) await onKeyChange({ state: 'revoked' });
    } catch (e) {
      console.error('[tunnel-agent] key_revoked handling failed:', e.message);
      try { await deleteKey(); unloadModules(); } catch {}
    }
    return;
  }

  if (event === 'belt_check') {
    // Periodic liveness/sync from the gateway. Respond with current belt.
    // We don't have ws here; caller logs and a future refactor can bubble
    // a reply up via onKeyChange. For now, just log.
    console.info(`[tunnel-agent] belt_check → ${getLoadedBelt()}`);
    if (onKeyChange) await onKeyChange({ state: 'belt_check', belt: getLoadedBelt() });
    return;
  }
}
