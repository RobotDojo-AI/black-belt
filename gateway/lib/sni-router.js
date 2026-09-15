/**
 * sni-router.js — TCP server for port 443 SNI passthrough.
 *
 * Reads the SNI hostname from the first TLS ClientHello chunk, extracts the
 * slug (e.g. "laptop" from "laptop.robotdojo.ai"), looks up the device in
 * tcp-registry, and forwards raw bytes bidirectionally without ever
 * decrypting the TLS session.
 *
 * The gateway is completely blind to user traffic — it only sees an opaque
 * byte stream.
 */
import net from 'net';
import { parseSNIResult } from './sni.js';
import { openTcpChannel } from './tcp-registry.js';

const DOMAIN_SUFFIX = '.robotdojo.ai';

// Control-plane hostname handling (st_63b59bda hardening). Two things want :443
// on a single VPS: the blind tenant splice, and the relay's own control channel
// (register / provision-cert / tunnel). Keeping the control channel on a side
// port meant every new install had to be told about it. Instead, the splice
// recognises its OWN control hostname and forwards those raw bytes to a local
// terminator (nginx on loopback, holding the relay's own cert) — so clients use
// the standard :443 for everything, no special config. This does NOT weaken
// blindness: only the relay's own control hostname is forwarded to a terminator,
// and that terminator holds the relay's own cert, never a tenant key. Tenant
// hostnames still splice through raw, undecrypted.
const CONTROL_HOST = (process.env.GATEWAY_CONTROL_HOST || `relay${DOMAIN_SUFFIX}`).toLowerCase();
const CONTROL_LOCAL_HOST = process.env.GATEWAY_CONTROL_LOCAL_HOST || '127.0.0.1';
const CONTROL_LOCAL_PORT = parseInt(process.env.GATEWAY_CONTROL_LOCAL_PORT || '9443', 10);

const DEFAULT_HANDSHAKE_TIMEOUT_MS = parseInt(process.env.SNI_HANDSHAKE_TIMEOUT_MS || '5000', 10);
const DEFAULT_MAX_CLIENT_HELLO_BYTES = parseInt(process.env.SNI_MAX_CLIENT_HELLO_BYTES || '32768', 10);

// Per-IP connection-rate limit (st_63b59bda, owner-approved: "yes build
// connection flooding protection"). Going DNS-only (unproxied A record) removes
// Cloudflare's network-layer DDoS shield from every subdomain's front door — the
// VPS IP is now directly exposed. This caps how many new TCP connections one
// source IP may open per window before it is dropped at accept, closing the
// single-source-flood case. Threshold sits well above the Mac tunnel client's
// own 1s–60s reconnect backoff so a legitimate device (or a modest shared NAT)
// never trips it. A distributed flood across many source IPs is out of scope for
// a per-IP limiter — the same bound lib/server.js's chatRateBuckets carries.
const DEFAULT_CONN_RATE_LIMIT = parseInt(process.env.SNI_CONN_RATE_LIMIT || '60', 10);
const DEFAULT_CONN_RATE_WINDOW_MS = parseInt(process.env.SNI_CONN_RATE_WINDOW_MS || '60000', 10);

/**
 * Build a per-IP connection-rate limiter. Mirrors the shape of lib/server.js's
 * chatRateBuckets (a bounded in-memory Map with a lazy per-key reset), not its
 * code — different file, different transport (raw TCP, no proxy in front, so
 * `socket.remoteAddress` is the true source and no X-Forwarded-For trust logic
 * is needed).
 *
 * @param {number} limit     max new connections per window per IP
 * @param {number} windowMs  window length
 * @returns {{ check(ip:string):boolean, buckets: Map<string,{count:number,resetAt:number}>, sweep():void }}
 */
export function createConnRateLimiter(limit = DEFAULT_CONN_RATE_LIMIT, windowMs = DEFAULT_CONN_RATE_WINDOW_MS) {
  const buckets = new Map(); // ip → { count, resetAt }
  return {
    buckets,
    check(ip) {
      const now = Date.now();
      const bucket = buckets.get(ip);
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(ip, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (bucket.count >= limit) return false;
      bucket.count += 1;
      return true;
    },
    sweep() {
      const now = Date.now();
      for (const [ip, b] of buckets) if (b.resetAt <= now) buckets.delete(ip);
    },
  };
}

/**
 * Start the TCP SNI-routing server.
 *
 * @param {number} port  — typically 443
 * @param {{
 *   fatalOnError?: boolean,
 *   host?: string,
 *   handshakeTimeoutMs?: number,
 *   maxClientHelloBytes?: number
 * }} opts
 * @returns {net.Server}
 */
export function startSniRouter(port, opts = {}) {
  const state = {
    status: 'starting',
    port,
    listening: false,
    error: null,
    startedAt: new Date().toISOString(),
  };
  const options = {
    fatalOnError: opts.fatalOnError !== false,
    host: opts.host || null,
    handshakeTimeoutMs: opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    maxClientHelloBytes: opts.maxClientHelloBytes ?? DEFAULT_MAX_CLIENT_HELLO_BYTES,
  };

  const connRateLimiter = opts.connRateLimiter
    ?? createConnRateLimiter(
      opts.connRateLimit ?? DEFAULT_CONN_RATE_LIMIT,
      opts.connRateWindowMs ?? DEFAULT_CONN_RATE_WINDOW_MS,
    );
  // Bounded-memory hygiene: drop expired IP buckets on an interval that never
  // holds the process open.
  const sweepTimer = setInterval(() => connRateLimiter.sweep(), 10 * 60 * 1000);
  sweepTimer.unref?.();

  const server = net.createServer(
    { allowHalfOpen: true },
    (socket) => handleConnection(socket, options, connRateLimiter),
  );
  server.connRateLimiter = connRateLimiter;
  server.on('close', () => clearInterval(sweepTimer));
  server.sniHealth = () => ({ ...state });
  const listenArgs = options.host ? { port, host: options.host } : port;
  server.listen(listenArgs, () => {
    state.status = 'listening';
    state.listening = true;
    state.port = server.address()?.port ?? port;
    state.error = null;
    console.info(`[sni-router] TCP listener on :${state.port}`);
  });
  server.on('error', (e) => {
    state.status = 'error';
    state.listening = false;
    state.error = {
      code: e.code || 'SNI_LISTENER_ERROR',
      message: e.message,
    };
    console.error('[sni-router] server error:', e.message);
    if (options.fatalOnError) {
      setImmediate(() => process.exit(1));
    }
  });
  return server;
}

// ── Per-connection handler ────────────────────────────────────────────────────

function handleConnection(clientSocket, options, connRateLimiter) {
  // Per-IP flood gate — checked at accept, BEFORE a single byte is buffered or
  // parsed. An over-limit source is dropped here so a flood costs no parse work.
  const sourceIp = clientSocket.remoteAddress || 'unknown';
  if (connRateLimiter && !connRateLimiter.check(sourceIp)) {
    clientSocket.destroy();
    return;
  }

  const buffered = [];
  let handled = false;
  let bufferedBytes = 0;

  const timeout = setTimeout(() => {
    if (!handled) {
      clientSocket.destroy();
    }
  }, options.handshakeTimeoutMs);

  clientSocket.on('data', async (chunk) => {
    if (handled) return;
    buffered.push(chunk);
    bufferedBytes += chunk.length;

    if (bufferedBytes > options.maxClientHelloBytes) {
      clearTimeout(timeout);
      clientSocket.destroy();
      return;
    }

    const result = parseSNIResult(Buffer.concat(buffered, bufferedBytes));
    if (!result.ok) {
      if (result.reason === 'incomplete') return;
      clearTimeout(timeout);
      clientSocket.destroy();
      return;
    }

    const sni = result.hostname;

    // Control-plane hostname → forward raw to the local terminator (nginx on
    // loopback with the relay's own cert), not the tenant splice. Keeps the
    // control channel on the standard :443 so installs need no special port.
    if (sni.toLowerCase() === CONTROL_HOST) {
      clearTimeout(timeout);
      handled = true;
      clientSocket.removeAllListeners('data');
      clientSocket.pause();
      const upstream = net.connect(CONTROL_LOCAL_PORT, CONTROL_LOCAL_HOST);
      upstream.on('connect', () => {
        for (const buf of buffered) upstream.write(buf);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
        clientSocket.resume();
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
      return;
    }

    // Extract slug: laptop.robotdojo.ai -> "laptop"
    if (!sni.endsWith(DOMAIN_SUFFIX)) {
      clearTimeout(timeout);
      clientSocket.destroy();
      return;
    }
    const slug = sni.slice(0, sni.length - DOMAIN_SUFFIX.length);
    if (!slug || slug.includes('.')) {
      clearTimeout(timeout);
      clientSocket.destroy();
      return;
    }

    let channel;
    try {
      channel = await openTcpChannel(
        slug,
        (data) => { if (!clientSocket.destroyed) clientSocket.write(data); },
        ()     => { if (!clientSocket.destroyed) clientSocket.destroy(); },
      );
    } catch (e) {
      console.warn(`[sni-router] openTcpChannel failed slug=${slug}:`, e.message);
      clearTimeout(timeout);
      clientSocket.destroy();
      return;
    }

    if (!channel) {
      clearTimeout(timeout);
      clientSocket.destroy();
      return;
    }

    clearTimeout(timeout);
    handled = true;
    clientSocket.removeAllListeners('data');

    // Forward the buffered ClientHello bytes to the device first.
    for (const buf of buffered) channel.write(buf);

    // Pipe client → device for the rest of the session.
    clientSocket.on('data',  (d) => channel.write(d));
    clientSocket.on('close', ()  => channel.close());
    clientSocket.on('error', ()  => channel.close());
  });

  clientSocket.on('error', () => clearTimeout(timeout));
}
