/**
 * HTTP → WebSocket proxy. Reads a Hono Context, forwards the request over the
 * user's tunnel connection, reconstructs the response.
 *
 * Two modes:
 *   Streaming — used for SSE endpoints (Accept: text/event-stream or path
 *     ends in /stream). The gateway starts returning headers to the caller
 *     as soon as the agent sends response_start, then pipes body chunks
 *     through a ReadableStream. No timeout after headers arrive.
 *
 *   Buffered  — used for everything else. Response is buffered in full before
 *     returning. MAX_RESPONSE_BYTES protects the Fargate task from OOM.
 *
 * timeoutMs applies to: (a) start of a streaming response; (b) complete
 * buffered response. It is NOT applied to the ongoing body of a stream.
 */
import { getBySlug } from './ws-registry.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
]);

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function wantsStream(req, path) {
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/event-stream') || path.endsWith('/stream');
}

function isUploadPath(path) {
  const base = path.split('?')[0];
  return base === '/api/upload' || base === '/api/files/download';
}

export async function proxy(c, slug, remainder, timeoutMs, uploadTimeoutMs) {
  const conn = getBySlug(slug);
  if (!conn) return c.json({ error: 'offline', slug }, 502);

  const req = c.req.raw;
  const headersIn = Object.fromEntries(req.headers);
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
  const path = `/${remainder}${new URL(req.url).search}`;
  const filteredHeaders = filterHeaders(headersIn);
  const effectiveTimeout = (uploadTimeoutMs && isUploadPath(path)) ? uploadTimeoutMs : timeoutMs;

  // --- Streaming path ---
  if (wantsStream(req, path)) {
    const { startPromise, bodyStream } = conn.requestStream(
      { method: req.method, path, headers: filteredHeaders, body },
      effectiveTimeout,
    );
    let status, headers;
    try {
      ({ status, headers } = await startPromise);
    } catch (e) {
      const code = e.message === 'timeout' ? 504 : 502;
      return c.json({ error: e.message }, code);
    }
    return new Response(bodyStream, { status, headers: filterHeaders(headers) });
  }

  // --- Buffered path ---
  let resp;
  try {
    resp = await conn.request(
      { method: req.method, path, headers: filteredHeaders, body },
      effectiveTimeout,
    );
  } catch (e) {
    const code = e.message === 'timeout' ? 504 : 502;
    return c.json({ error: e.message }, code);
  }

  const headersOut = filterHeaders(resp.headers || {});
  const bytes = resp.body ? Buffer.from(resp.body, 'base64') : null;
  if (bytes && bytes.length > MAX_RESPONSE_BYTES) {
    return c.json({
      error: 'response_too_large',
      limit_bytes: MAX_RESPONSE_BYTES,
      got_bytes: bytes.length,
    }, 413);
  }
  return new Response(bytes, { status: resp.status || 200, headers: headersOut });
}
