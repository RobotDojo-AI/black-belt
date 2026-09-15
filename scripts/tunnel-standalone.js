/**
 * Standalone tunnel process — runs as com.robotdojo.tunnel LaunchAgent.
 *
 * Self-contained: no DB, no heavy runtime imports. Manages both relay
 * WebSocket connections independently of the server process.
 *
 * Why separate from the server: the server's Background ProcessType causes
 * macOS (via Tailscale Network Extension) to block outbound TCP from it and
 * all its descendants. This process runs with a fresh network context from
 * launchd directly, so connections succeed.
 *
 * Handles:
 *   /tunnel?token=...       — HTTP request forwarding (tunnel-agent role)
 *   /tcp-tunnel?slug=...    — SNI passthrough bytes (tunnel-client role)
 * Control messages (key_issued etc.) are logged and ignored — key state is
 * managed by the server via its own session on subscription events.
 */
import net from 'node:net';
import config from '../lib/config.js';
import { openWebSocket } from '../lib/raw-websocket.js';
import { readKeychainSecret } from '../lib/keychain.js';

export const IDLE_GATED = false;

const LAUNCH_MODE = process.argv.includes('--launch') || process.env.ROBOTDOJO_TUNNEL_LAUNCH_MODE === '1';

function secret(envName, keychainName = envName) {
  const value = process.env[envName];
  if (value) return value;
  try { return readKeychainSecret(keychainName) || null; } catch { return null; }
}

// --- Config from env/Keychain ---
const RELAY_BASE    = (process.env.ROBOTDOJO_GATEWAY || process.env.GATEWAY_URL || secret('GATEWAY_URL') || 'https://relay.robotdojo.ai').replace(/\/+$/, '');
const LOCAL_ORIGIN  = process.env.ROBOTDOJO_LOCAL || 'http://127.0.0.1:4339';
const TOKEN         = secret('ROBOTDOJO_TUNNEL_TOKEN');
const DEVICE_SLUG   = secret('ROBOTDOJO_DEVICE_SLUG');
const DEVICE_SECRET = secret('ROBOTDOJO_DEVICE_SECRET');
const BOOTSTRAP_SECRET = secret('ROBOTDOJO_RELAY_BOOTSTRAP_SECRET');
const PORT_APP      = config.ports.app;

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 60_000;
const HEARTBEAT_MS = Number(process.env.ROBOTDOJO_TUNNEL_HEARTBEAT_MS || 20_000);
const PONG_TIMEOUT_MS = Number(process.env.ROBOTDOJO_TUNNEL_PONG_TIMEOUT_MS || 45_000);
const TCP_CLIENT_CONNECTIONS = Number(process.env.ROBOTDOJO_TUNNEL_CLIENT_CONNECTIONS || 32);
const MAX_TCP_CLIENT_CONNECTIONS = 64;
const TCP_ROTATE_MS = Number(process.env.ROBOTDOJO_TUNNEL_ROTATE_MS || 0);
const TCP_ROTATE_STAGGER_MS = Number(process.env.ROBOTDOJO_TUNNEL_ROTATE_STAGGER_MS || 5_000);
const TCP_ROTATE_BUSY_RETRY_MS = Number(process.env.ROBOTDOJO_TUNNEL_ROTATE_BUSY_RETRY_MS || 10_000);

// ── Tunnel-agent: HTTP request forwarding ────────────────────────────────────

function startAgentConnection() {
  if (!TOKEN) {
    console.info('[tunnel-agent] no token — skipping');
    return;
  }
  const wsBase = RELAY_BASE.replace(/^https?:\/\//, 'wss://');
  const url = `${wsBase}/tunnel?token=${encodeURIComponent(TOKEN)}`;
  let backoff = MIN_BACKOFF;
  const activeRequests = new Map();

  const connect = () => {
    console.info('[tunnel-agent] connecting');
    let handle = null;

    openWebSocket(url, {
      onOpen(h) {
        handle = h;
        backoff = MIN_BACKOFF;
        console.info('[tunnel-agent] connected');
      },
      onMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ping') { handle?.send({ type: 'pong' }); return; }
        if (msg.type === 'cancel') {
          activeRequests.get(msg.id)?.abort();
          activeRequests.delete(msg.id);
          return;
        }
        if (msg.type === 'control') {
          console.info('[tunnel-agent] control:', msg.event || msg.type);
          return;
        }
        if (msg.type === 'request') {
          forwardRequest(handle, msg).catch(() => {});
          return;
        }
      },
      onClose(code, reason) {
        console.warn(`[tunnel-agent] closed code=${code} reason=${reason}`);
        for (const ac of activeRequests.values()) { try { ac.abort(); } catch {} }
        activeRequests.clear();
        handle = null;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      },
      onError(e) {
        console.warn('[tunnel-agent] error:', e.message || String(e));
        handle = null;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      },
    });

    async function forwardRequest(ws, msg) {
      const ac = new AbortController();
      activeRequests.set(msg.id, ac);
      const target = LOCAL_ORIGIN + msg.path;
      const init = {
        method: msg.method,
        headers: msg.headers || {},
        body: msg.body ? Buffer.from(msg.body, 'base64') : undefined,
        redirect: 'manual',
        signal: ac.signal,
      };
      if (init.method === 'GET' || init.method === 'HEAD') delete init.body;

      try {
        const resp = await fetch(target, init);
        const headers = Object.fromEntries(resp.headers);

        if (msg.stream && resp.body) {
          ws.send({ type: 'response_start', id: msg.id, status: resp.status, headers });
          const reader = resp.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || ac.signal.aborted) break;
              ws.send({ type: 'response_chunk', id: msg.id, data: Buffer.from(value).toString('base64') });
            }
          } finally { reader.releaseLock(); }
          if (!ac.signal.aborted) ws.send({ type: 'response_end', id: msg.id });
        } else {
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length > 16 * 1024) {
            ws.send({ type: 'response_start', id: msg.id, status: resp.status, headers });
            const CHUNK = 16 * 1024;
            for (let off = 0; off < buf.length; off += CHUNK) {
              ws.send({ type: 'response_chunk', id: msg.id, data: buf.slice(off, off + CHUNK).toString('base64') });
            }
            ws.send({ type: 'response_end', id: msg.id });
          } else {
            ws.send({ type: 'response', id: msg.id, status: resp.status, headers, body: buf.length ? buf.toString('base64') : null });
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (msg.stream) {
          ws.send({ type: 'response_error', id: msg.id, error: e.message });
        } else {
          ws.send({ type: 'response', id: msg.id, status: 502, headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ error: 'local_unreachable', detail: e.message })).toString('base64') });
        }
      } finally {
        activeRequests.delete(msg.id);
      }
    }
  };

  connect();
}

// ── Tunnel-client: SNI passthrough ───────────────────────────────────────────

export function tcpClientConnectionSlots(count = TCP_CLIENT_CONNECTIONS) {
  const n = Math.max(1, Math.min(MAX_TCP_CLIENT_CONNECTIONS, Number.isFinite(count) ? Math.trunc(count) : 1));
  return Array.from({ length: n }, (_, i) => i + 1);
}

export function tcpClientRotationDelayMs(slot = 1, {
  baseMs = TCP_ROTATE_MS,
  staggerMs = TCP_ROTATE_STAGGER_MS,
} = {}) {
  const base = Number.isFinite(baseMs) ? Math.trunc(baseMs) : 0;
  if (base <= 0) return 0;
  const stagger = Math.max(0, Number.isFinite(staggerMs) ? Math.trunc(staggerMs) : 0);
  const slotIndex = Math.max(0, Math.trunc(Number(slot) || 1) - 1);
  return base + (slotIndex * stagger);
}

export function tcpClientReconnectDelayMs(slot = 1, backoff = MIN_BACKOFF, {
  staggerMs = 250,
} = {}) {
  const base = Math.max(0, Number.isFinite(backoff) ? Math.trunc(backoff) : MIN_BACKOFF);
  const stagger = Math.max(0, Number.isFinite(staggerMs) ? Math.trunc(staggerMs) : 0);
  const slotIndex = Math.max(0, Math.trunc(Number(slot) || 1) - 1);
  return base + (slotIndex * stagger);
}

export function shouldRotateIdleTunnel({ activeTcpConns = 0 } = {}) {
  return activeTcpConns <= 0;
}

function startClientConnection(slot = 1) {
  if (!DEVICE_SLUG || !DEVICE_SECRET) {
    console.info(`[tunnel-client:${slot}] missing slug/secret — skipping`);
    return;
  }
  const wsBase = RELAY_BASE.replace(/^https?:\/\//, 'wss://');
  // st_63b59bda AC-5: the upgrade carries only slug + secret + connection slot.
  // The relay authenticates the device by its secret; no email is transmitted.
  const url = `${wsBase}/tcp-tunnel?slug=${encodeURIComponent(DEVICE_SLUG)}&secret=${encodeURIComponent(DEVICE_SECRET)}` +
    `&connection=${slot}`;
  let backoff = MIN_BACKOFF;
  const tcpConns = new Map();
  let heartbeatTimer = null;
  let rotationTimer = null;
  let lastPongAt = 0;
  let pongWatchdogArmed = false;

  const connect = () => {
    console.info(`[tunnel-client:${slot}] connecting`);
    let handle = null;

    const closeTcpConns = () => {
      for (const s of tcpConns.values()) { try { s.destroy(); } catch {} }
      tcpConns.clear();
    };

    const recycle = (reason) => {
      console.warn(`[tunnel-client:${slot}] reconnecting (${reason})`);
      clearInterval(heartbeatTimer);
      clearTimeout(rotationTimer);
      closeTcpConns();
      try { handle?.destroy(); } catch {}
      handle = null;
      setTimeout(connect, tcpClientReconnectDelayMs(slot, backoff));
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };

    const scheduleRotation = (delayMs = tcpClientRotationDelayMs(slot)) => {
      clearTimeout(rotationTimer);
      if (!delayMs || delayMs <= 0) return;
      rotationTimer = setTimeout(() => {
        if (!handle) return;
        if (!shouldRotateIdleTunnel({ activeTcpConns: tcpConns.size })) {
          scheduleRotation(TCP_ROTATE_BUSY_RETRY_MS);
          return;
        }
        recycle('scheduled rotation');
      }, delayMs);
      rotationTimer.unref?.();
    };

    openWebSocket(url, {
      onOpen(h) {
        handle = h;
        backoff = MIN_BACKOFF;
        lastPongAt = 0;
        pongWatchdogArmed = false;
        console.info(`[tunnel-client:${slot}] connected`);
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (shouldRecycleForMissingPong({
            pongWatchdogArmed,
            now: Date.now(),
            lastPongAt,
            timeoutMs: PONG_TIMEOUT_MS,
          })) {
            recycle('pong timeout');
            return;
          }
          handle?.send({ type: 'ping', ts: Date.now() });
        }, HEARTBEAT_MS);
        scheduleRotation();
      },
      onMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'pong') {
          lastPongAt = Date.now();
          pongWatchdogArmed = true;
          return;
        }
        if (msg.type === 'ping') { handle?.send({ type: 'pong' }); return; }
        if (msg.type === 'tcp_open') {
          openTcpConn(handle, msg.connId);
          return;
        }
        if (msg.type === 'tcp_data') {
          const sock = tcpConns.get(msg.connId);
          if (sock) sock.write(Buffer.from(msg.data, 'base64'));
          return;
        }
        if (msg.type === 'tcp_close') {
          const sock = tcpConns.get(msg.connId);
          if (sock) { try { sock.destroy(); } catch {} tcpConns.delete(msg.connId); }
          return;
        }
      },
      onClose(code, reason) {
        console.warn(`[tunnel-client:${slot}] closed code=${code} reason=${reason}`);
        clearInterval(heartbeatTimer);
        clearTimeout(rotationTimer);
        closeTcpConns();
        handle = null;
        setTimeout(connect, tcpClientReconnectDelayMs(slot, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      },
      onError(e) {
        console.warn(`[tunnel-client:${slot}] error:`, e.message || String(e));
        clearTimeout(rotationTimer);
        handle = null;
        setTimeout(connect, tcpClientReconnectDelayMs(slot, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      },
    });

    function openTcpConn(ws, connId) {
      const sock = net.connect({ host: '127.0.0.1', port: PORT_APP });
      let connected = false;
      const connectTimer = setTimeout(() => {
        if (!connected && tcpConns.has(connId) && !sock.destroyed) {
          try { sock.destroy(); } catch {}
          ws.send({ type: 'tcp_close', connId });
          tcpConns.delete(connId);
        }
      }, 10_000);
      connectTimer.unref?.();
      tcpConns.set(connId, sock);
      sock.on('connect', () => {
        connected = true;
        clearTimeout(connectTimer);
        ws.send({ type: 'tcp_ready', connId });
      });
      sock.on('data', (buf) => {
        const MAX = 16 * 1024;
        for (let off = 0; off < buf.length; off += MAX) {
          ws.send({
            type: 'tcp_data',
            connId,
            data: buf.slice(off, off + MAX).toString('base64'),
          });
        }
      });
      sock.on('close', () => { clearTimeout(connectTimer); ws.send({ type: 'tcp_close', connId }); tcpConns.delete(connId); });
      sock.on('error', () => { clearTimeout(connectTimer); ws.send({ type: 'tcp_close', connId }); tcpConns.delete(connId); });
    }
  };

  connect();
}

export function isPongStale({ now, lastPongAt, timeoutMs }) {
  return Number.isFinite(now)
    && Number.isFinite(lastPongAt)
    && Number.isFinite(timeoutMs)
    && now - lastPongAt > timeoutMs;
}

export function shouldRecycleForMissingPong({ pongWatchdogArmed, now, lastPongAt, timeoutMs }) {
  return Boolean(pongWatchdogArmed)
    && isPongStale({ now, lastPongAt, timeoutMs });
}

// ── Start ─────────────────────────────────────────────────────────────────────

// Self-healing device registration (st_63b59bda hardening). Register this
// device's slug → secret with the relay before opening the tunnel, so per-device
// auth works even if the relay lost its registry (fresh box, restore, redeploy).
// Idempotent: the same secret re-registering is a no-op. Best-effort with a few
// retries — a failure here is not fatal (the tunnel still attempts to connect and
// the periodic cert-renewal agent also re-registers), it just self-heals faster.
async function ensureRegistered() {
  if (!DEVICE_SLUG || !DEVICE_SECRET || !BOOTSTRAP_SECRET) return;
  const url = `${RELAY_BASE}/api/register-device`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-robotdojo-bootstrap': BOOTSTRAP_SECRET },
        body: JSON.stringify({ slug: DEVICE_SLUG, deviceSecret: DEVICE_SECRET }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) { console.info('[tunnel] device registered at relay'); return; }
      if (res.status === 409) { console.error('[tunnel] slug taken by a different device — cannot register'); return; }
      console.warn(`[tunnel] register attempt ${attempt} -> HTTP ${res.status}`);
    } catch (e) {
      console.warn(`[tunnel] register attempt ${attempt} failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}

export async function startStandaloneTunnel() {
  await ensureRegistered();
  if (!LAUNCH_MODE || process.env.ROBOTDOJO_TUNNEL_ENABLE_HTTP === '1') {
    startAgentConnection();
  } else {
    console.info('[tunnel-agent] launch mode — HTTP tunnel disabled; standalone-sni owns remote access');
  }
  for (const slot of tcpClientConnectionSlots()) startClientConnection(slot);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startStandaloneTunnel();
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}
