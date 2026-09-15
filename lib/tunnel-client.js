/**
 * SNI passthrough tunnel client — outbound WebSocket to relay.robotdojo.ai.
 *
 * This implements the NEW architecture where TLS terminates on the user's Mac
 * (not at the relay). The relay is a blind TCP forwarder; it knows nothing
 * about the HTTP traffic passing through it.
 *
 * Flow:
 *   1. Connect via WSS to relay.robotdojo.ai/tcp-tunnel?slug=<slug>&secret=<secret>
 *   2. Gateway sends { type: 'tcp_open', connId } for each new inbound TCP connection.
 *   3. Device responds { type: 'tcp_ready', connId } and opens a TCP socket to
 *      127.0.0.1:PORT_APP (the local HTTPS app server).
 *   4. Bytes flow bidirectionally: gateway → device (base64 data frames) →
 *      local TCP; and local TCP → device → gateway.
 *   5. Either side sends { type: 'tcp_close', connId } to tear down.
 *
 * Message protocol (matches gateway/lib/tcp-registry.js):
 *   Gateway → device: { type: 'tcp_open',  connId }
 *   Device → gateway: { type: 'tcp_ready', connId }
 *   Device → gateway: { type: 'tcp_data',  connId, data: base64 }
 *   Gateway → device: { type: 'tcp_data',  connId, data: base64 }
 *   Either side:      { type: 'tcp_close', connId }
 *
 * Uses Node 20's built-in WebSocket — no external dependencies.
 */

import net from 'node:net';
import config from './config.js';

const DEFAULT_MIN_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

/**
 * Start the SNI passthrough tunnel client.
 *
 * Only starts if config.gatewayUrl, config.deviceSlug, and config.deviceSecret
 * are all set. Returns { stop() } — call stop() to shut down cleanly.
 */
export function startTunnelClient(opts = {}) {
  const {
    gatewayUrl  = config.gatewayUrl,
    deviceSlug  = config.deviceSlug,
    deviceSecret = config.deviceSecret,
    portApp     = config.ports?.app ?? config.port,
    minBackoffMs = DEFAULT_MIN_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    onConnect   = null, // called each time the WebSocket connection (re)opens
  } = opts;

  if (!gatewayUrl || !deviceSlug || !deviceSecret) {
    console.info('[tunnel-client] missing gatewayUrl/deviceSlug/deviceSecret — not starting');
    return { stop() {} };
  }

  // Convert https:// → wss://, http:// → ws:// for the WebSocket URL.
  // st_63b59bda AC-5: the upgrade carries only slug + secret. The relay
  // authenticates the device by its secret; no email is transmitted.
  const wsBase = gatewayUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
  const baseUrl = `${wsBase.replace(/\/+$/, '')}/tcp-tunnel?slug=${encodeURIComponent(deviceSlug)}&secret=${encodeURIComponent(deviceSecret)}`;

  const state = {
    ws: null,
    backoff: minBackoffMs,
    stopped: false,
    timer: null,
    heartbeatTimer: null,
    // Active TCP connections keyed by connId
    connections: new Map(), // connId → net.Socket
  };

  function connect() {
    if (state.stopped) return;

    const ws = new WebSocket(baseUrl);
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.backoff = minBackoffMs;
      console.info('[tunnel-client] connected to relay');
      startHeartbeat(ws, state, heartbeatMs);
      if (onConnect) onConnect();
    });

    ws.addEventListener('message', (ev) => {
      handleMessage(ws, ev.data, state, portApp);
    });

    ws.addEventListener('close', (ev) => {
      console.warn(`[tunnel-client] disconnected code=${ev.code} — reconnecting in ${state.backoff}ms`);
      stopHeartbeat(state);
      // Tear down all open TCP connections
      for (const [connId, sock] of state.connections) {
        try { sock.destroy(); } catch {}
        state.connections.delete(connId);
      }
      state.ws = null;
      if (state.stopped) return;
      state.timer = setTimeout(connect, state.backoff);
      state.backoff = Math.min(state.backoff * 2, maxBackoffMs);
    });

    ws.addEventListener('error', (e) => {
      console.warn('[tunnel-client] WS error:', e.message || String(e));
    });
  }

  connect();

  const stop = () => {
    state.stopped = true;
    clearTimeout(state.timer);
    stopHeartbeat(state);
    for (const [, sock] of state.connections) {
      try { sock.destroy(); } catch {}
    }
    state.connections.clear();
    try { state.ws?.close(1000, 'shutdown'); } catch {}
  };

  process.on('SIGTERM', stop);
  return { stop };
}

function startHeartbeat(ws, state, heartbeatMs) {
  stopHeartbeat(state);
  if (!heartbeatMs || heartbeatMs <= 0) return;
  state.heartbeatTimer = setInterval(() => {
    sendMsg(ws, { type: 'ping', ts: Date.now() });
  }, heartbeatMs);
  state.heartbeatTimer.unref?.();
}

function stopHeartbeat(state) {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

/**
 * Handle an incoming WebSocket message from the gateway.
 *
 * @param {WebSocket} ws        - The gateway WebSocket
 * @param {string|Buffer} raw   - Raw message data
 * @param {object} state        - Shared mutable state (connections, stopped)
 * @param {number} portApp      - Local app port to forward to (127.0.0.1:portApp)
 */
function handleMessage(ws, raw, state, portApp) {
  let msg;
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    // Non-JSON control frame — ignore
    return;
  }

  const { type, connId } = msg;

  if (type === 'tcp_open') {
    // New inbound TCP connection — open local socket and send 'tcp_ready'
    if (!connId) return;
    openLocalConnection(ws, connId, state, portApp);
    return;
  }

  if (type === 'tcp_data') {
    // Forward data from relay → local TCP socket
    const sock = state.connections.get(connId);
    if (!sock || sock.destroyed) {
      // Connection already gone — tell relay to close
      sendMsg(ws, { type: 'tcp_close', connId });
      return;
    }
    try {
      const buf = Buffer.from(msg.data, 'base64');
      sock.write(buf);
    } catch (e) {
      console.warn(`[tunnel-client] write error connId=${connId}:`, e.message);
      sock.destroy();
      state.connections.delete(connId);
      sendMsg(ws, { type: 'tcp_close', connId });
    }
    return;
  }

  if (type === 'tcp_close') {
    // Relay closed this connection — tear down the local socket
    const sock = state.connections.get(connId);
    if (sock) {
      try { sock.destroy(); } catch {}
      state.connections.delete(connId);
    }
    return;
  }

  if (type === 'ping') {
    sendMsg(ws, { type: 'pong' });
    return;
  }
}

/**
 * Open a TCP connection to 127.0.0.1:portApp for the given connId, wire
 * bidirectional forwarding, and tell the gateway we're ready.
 */
function openLocalConnection(ws, connId, state, portApp) {
  const sock = net.createConnection({ host: '127.0.0.1', port: portApp });

  // Register immediately so incoming data frames can be queued before the
  // 'connect' event fires (Node buffers writes on a not-yet-connected socket).
  state.connections.set(connId, sock);

  sock.on('connect', () => {
    // Tell relay the local TCP channel is ready to receive bytes
    sendMsg(ws, { type: 'tcp_ready', connId });
    // Clear the 5s setTimeout — that's a CONNECT deadline, not an idle
    // deadline. SSE chat streams sit idle for >5s while Sonnet thinks
    // before emitting deltas; without this clear, tunnel-client kills
    // the local socket mid-stream and the browser sees an aborted load.
    sock.setTimeout(0);
  });

  sock.on('data', (chunk) => {
    // Forward bytes from local app → relay.
    // Split into 16 KB slices before base64-encoding: the built-in Node WebSocket
    // silently truncates outgoing frames at 32 KB / 64 KB power-of-2 boundaries.
    // A 16 KB raw slice → ~21 KB base64 → well under any frame limit.
    if (ws.readyState !== WebSocket.OPEN) {
      sock.destroy();
      state.connections.delete(connId);
      return;
    }
    const MAX = 16 * 1024;
    for (let off = 0; off < chunk.length; off += MAX) {
      sendMsg(ws, {
        type: 'tcp_data',
        connId,
        data: chunk.slice(off, off + MAX).toString('base64'),
      });
    }
  });

  sock.on('end', () => {
    state.connections.delete(connId);
    sendMsg(ws, { type: 'tcp_close', connId });
  });

  sock.on('close', () => {
    state.connections.delete(connId);
  });

  sock.on('error', (e) => {
    console.warn(`[tunnel-client] local TCP error connId=${connId}:`, e.message);
    state.connections.delete(connId);
    sendMsg(ws, { type: 'tcp_close', connId });
  });

  // Timeout — if the local socket doesn't connect in 5s, give up
  sock.setTimeout(5000);
  sock.on('timeout', () => {
    console.warn(`[tunnel-client] local TCP connect timeout connId=${connId}`);
    sock.destroy();
    state.connections.delete(connId);
    sendMsg(ws, { type: 'tcp_close', connId });
  });
}

/**
 * Send a JSON message over the WebSocket. No-ops if the socket is not open.
 */
function sendMsg(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch (e) {
    // Best-effort — the WS 'close' handler will clean up
    console.warn('[tunnel-client] send error:', e.message);
  }
}
