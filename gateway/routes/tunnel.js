/**
 * WebSocket endpoint for tunnel agents.
 *
 * Expected: wss://gateway.robotdojo.ai/tunnel?token=<jwt>
 * Token payload carries { email, slug, belt, exp }. On successful upgrade we
 * register the Connection and start a heartbeat. On close we unregister.
 */
import { WebSocketServer } from 'ws';
import { verifyTunnelToken } from '../lib/auth.js';
import { Connection } from '../lib/connection.js';
import { register, unregister } from '../lib/ws-registry.js';

export function attachTunnelServer(httpServer, { secret, heartbeatMs }) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/tunnel') return; // leave other paths for other upgrade handlers
    let payload;
    try {
      payload = verifyTunnelToken(url.searchParams.get('token'), secret);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onUpgrade(ws, payload));
  });

  function onUpgrade(ws, payload) {
    const conn = new Connection(ws, payload);
    register(conn);
    console.info(`[tunnel] connect email=${payload.email} handle=${payload.handle || payload.slug}`);

    let missed = 0;
    const hb = setInterval(() => {
      if (!conn.alive) {
        missed++;
        if (missed >= 2) {
          console.warn(`[tunnel] reap email=${payload.email} (${missed} consecutive missed heartbeats)`);
          try { ws.terminate(); } catch {}
          return;
        }
        console.warn(`[tunnel] missed heartbeat #${missed} email=${payload.email} — retrying`);
      } else {
        missed = 0;
      }
      conn.ping();
    }, heartbeatMs);

    ws.on('close', () => {
      clearInterval(hb);
      conn.abort('disconnect');
      unregister(conn);
      console.info(`[tunnel] disconnect email=${payload.email}`);
    });
    ws.on('error', (e) => console.warn(`[tunnel] error email=${payload.email}:`, e.message));
  }

  return wss;
}
