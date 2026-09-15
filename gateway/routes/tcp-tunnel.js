/**
 * tcp-tunnel.js — WebSocket endpoint for TCP-passthrough device connections.
 *
 * Devices connect to /tcp-tunnel?slug=<slug>&secret=<device secret>.
 * Fresh installs register their own device secret with /api/register-device.
 * The legacy shared gateway secret remains as a migration fallback only.
 */
import { WebSocketServer } from 'ws';
import {
  registerTcpDevice,
  unregisterTcpDevice,
  handleTcpDeviceMessage,
} from '../lib/tcp-registry.js';
import { validateDevice } from '../lib/device-registry.js';

const SERVER_HEARTBEAT_MS = parseInt(process.env.TCP_TUNNEL_SERVER_HEARTBEAT_MS || '10000', 10);

/**
 * Attaches the /tcp-tunnel upgrade handler to an existing HTTP server.
 *
 * @param {import('http').Server} httpServer
 * @param {{ deviceSecret?: string }} opts
 */
export function attachTcpTunnelServer(httpServer, { deviceSecret }) {
  const wss = new WebSocketServer({ noServer: true });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.__tcpAlive === false) {
        try { ws.terminate(); } catch {}
        continue;
      }
      ws.__tcpAlive = false;
      try {
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch {
        try { ws.terminate(); } catch {}
      }
    }
  }, SERVER_HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  httpServer.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/tcp-tunnel') return; // leave /tunnel for tunnel.js

    const slug   = url.searchParams.get('slug');
    const secret = url.searchParams.get('secret');

    let authorized = false;
    if (deviceSecret && secret === deviceSecret) {
      authorized = true;
    } else {
      const device = await validateDevice(slug, secret);
      authorized = !!device.ok;
    }

    if (!slug || !secret || !authorized) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.__tcpAlive = true;
      registerTcpDevice(slug, ws);
      console.info(`[tcp-tunnel] connect slug=${slug}`);

      // Ownership was already established by validateDevice(slug, secret) above
      // (st_63b59bda AC-5). The device secret hash is the sole credential and
      // conflict key — there is no separate owner-keyed slug claim to make.

      ws.on('message', (raw) => handleTcpTunnelMessage(slug, ws, raw));

      ws.on('close', () => {
        unregisterTcpDevice(slug, ws);
        console.info(`[tcp-tunnel] disconnect slug=${slug}`);
      });

      ws.on('error', (e) => {
        console.warn(`[tcp-tunnel] error slug=${slug}:`, e.message);
      });
    });
  });
}

export function handleTcpTunnelMessage(slug, ws, raw) {
  try {
    ws.__tcpAlive = true;
    const msg = JSON.parse(raw.toString('utf8'));
    if (msg.type === 'pong') return;
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: msg.ts || Date.now() }));
      return;
    }
    handleTcpDeviceMessage(slug, msg);
  } catch {
    // Malformed message — ignore.
  }
}
