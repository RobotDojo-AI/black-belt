/**
 * Robot Dojo tunnel gateway — entry point.
 *
 * Accepts outbound WebSocket connections from user tunnel agents and proxies
 * /me/:slug/* HTTP requests to the matching agent. Also exposes internal
 * control endpoints for key issuance / revocation on subscription events.
 *
 * Crash = exit(1). ECS restarts the task. Do not swallow infra errors.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { attachTunnelServer } from './routes/tunnel.js';
import { attachTcpTunnelServer } from './routes/tcp-tunnel.js';
import { startSniRouter } from './lib/sni-router.js';
import { certProvisionRoutes } from './routes/cert-provision.js';
import { connectionSize as tcpConnectionSize, size as tcpSize } from './lib/tcp-registry.js';
import { proxyRoutes } from './routes/proxy.js';
import { controlRoutes } from './routes/control.js';
import { logDrainRoutes } from './routes/log-drain.js';
import { deviceRegistrationRoutes } from './routes/device-registration.js';
import { size } from './lib/ws-registry.js';
import { handleLookupRoutes } from './routes/handle-lookup.js';
import { handlesSize } from './lib/handle-registry.js';
import { size as devicesSize } from './lib/device-registry.js';

// Single-process instance identity (st_63b59bda). The relay runs as one
// systemd-supervised process on one VPS, so identity is just a stable label for
// health output — no ECS task metadata, no Redis backplane keyed off it. Kept in
// index.js (not tcp-registry.js) so the registry stays free of any fleet notion.
const INSTANCE_ID = process.env.ROBOTDOJO_GATEWAY_INSTANCE_ID || randomUUID();

const PORT = parseInt(process.env.PORT || '8080', 10);
const TUNNEL_JWT_SECRET = required('TUNNEL_JWT_SECRET');
const GATEWAY_INTERNAL_SECRET = required('GATEWAY_INTERNAL_SECRET');
const GATEWAY_BOOTSTRAP_SECRET = required('GATEWAY_BOOTSTRAP_SECRET');
const GATEWAY_DEVICE_SECRET = process.env.GATEWAY_DEVICE_SECRET || null;
const LOG_DRAIN_SECRET   = process.env.LOG_DRAIN_SECRET   ?? null;
const LOG_DRAIN_VERIFY   = process.env.LOG_DRAIN_VERIFY   ?? null; // set during Vercel drain registration, remove after
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '30000', 10);
const PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS || '30000', 10);
const UPLOAD_TIMEOUT_MS = parseInt(process.env.UPLOAD_TIMEOUT_MS || '120000', 10);
const SNI_PORT = parseInt(process.env.SNI_PORT || '443', 10);
const SIGTERM_DRAIN_MS = parseInt(process.env.GATEWAY_SIGTERM_DRAIN_MS || '90000', 10);
const STARTED_AT = new Date().toISOString();

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[gateway] missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

const app = new Hono();
const sniRouter = startSniRouter(SNI_PORT, { fatalOnError: true });
app.get('/health', async (c) => {
  const sni = sniRouter.sniHealth();
  const healthy = sni.status === 'listening';
  return c.json({
    status: healthy ? 'ok' : 'degraded',
    instance_id: INSTANCE_ID,
    started_at: STARTED_AT,
    connections: size(),
    handles: handlesSize(),
    devices: devicesSize(),
    tcp_devices: tcpSize(),
    tcp_connections: tcpConnectionSize(),
    sni,
  }, healthy ? 200 : 503);
});
app.route('/', certProvisionRoutes({ bootstrapSecret: GATEWAY_BOOTSTRAP_SECRET }));
app.route('/', deviceRegistrationRoutes({ bootstrapSecret: GATEWAY_BOOTSTRAP_SECRET }));
app.route('/', logDrainRoutes({ drainSecret: LOG_DRAIN_SECRET, verifyToken: LOG_DRAIN_VERIFY, secret: GATEWAY_INTERNAL_SECRET }));
app.route('/', controlRoutes({ secret: GATEWAY_INTERNAL_SECRET }));
app.route('/', handleLookupRoutes({ secret: GATEWAY_INTERNAL_SECRET }));
app.route('/', proxyRoutes()); // must be last — /:servername/:handle/* wildcard would swallow /internal/* routes
app.notFound((c) => c.json({ error: 'not_found' }, 404));

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.info(`[gateway] listening on :${info.port}`);
});

attachTunnelServer(server, {
  secret: TUNNEL_JWT_SECRET,
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
});

attachTcpTunnelServer(server, { deviceSecret: GATEWAY_DEVICE_SECRET });

process.on('uncaughtException', (e) => { console.error('[fatal]', e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('[fatal]', e); process.exit(1); });
let draining = false;
process.on('SIGTERM', () => {
  if (draining) return;
  draining = true;
  console.info(`[gateway] SIGTERM; draining existing SNI/tunnel sockets for ${SIGTERM_DRAIN_MS}ms`);
  console.info('[gateway] keeping HTTP/tunnel server open during SIGTERM drain');
  setTimeout(() => {
    console.info('[gateway] SIGTERM drain complete; exiting');
    process.exit(0);
  }, Math.max(0, SIGTERM_DRAIN_MS));
});
