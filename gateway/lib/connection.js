/**
 * Wraps a tunnel-agent WebSocket with request/response multiplexing.
 *
 * Wire format (JSON messages):
 *   gateway -> agent: { type: 'request',  id, method, path, headers, body, stream? }
 *   gateway -> agent: { type: 'cancel',   id }                                  (abort inflight stream)
 *   agent  -> gateway: { type: 'response', id, status, headers, body }          (buffered)
 *   agent  -> gateway: { type: 'response_start', id, status, headers }          (stream)
 *   agent  -> gateway: { type: 'response_chunk', id, data }                     (stream)
 *   agent  -> gateway: { type: 'response_end',   id }                           (stream)
 *   agent  -> gateway: { type: 'response_error', id, error }                    (stream)
 *   gateway -> agent: { type: 'control',  event, payload }
 *   agent  -> gateway: { type: 'pong' }
 *
 * Bodies are base64-encoded bytes. Keeps the protocol binary-safe without
 * upgrading to framed binary frames (which would complicate the agent).
 *
 * Streaming protocol: when the gateway sends stream:true the agent streams
 * response_start → response_chunk* → response_end instead of one buffered
 * response message. The gateway constructs a ReadableStream from these and
 * starts returning HTTP headers to the caller as soon as response_start
 * arrives — eliminating the buffering that caused 504s on long chat streams.
 */
import { randomUUID } from 'node:crypto';

export class Connection {
  constructor(socket, { email, slug, handle, uuid, belt }) {
    this.socket = socket;
    this.email = email;
    this.slug = slug || handle;   // backward compat — slug used for /me/:slug proxy
    this.handle = handle || slug; // new identity handle
    this.uuid = uuid || null;     // permanent routing key
    this.belt = belt;
    this.pending = new Map();         // id -> { resolve, reject, timer }
    this.pendingStreams = new Map();   // id -> { start, chunk, end, fail }
    this.pendingChunks = new Map();   // id -> { status, headers, chunks[] } (chunked buffered)
    this.alive = true;
    socket.on('message', (raw) => this._onMessage(raw));
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }

    if (msg.type === 'pong') { this.alive = true; return; }

    // Streaming protocol messages
    if (msg.type === 'response_start') {
      const ps = this.pendingStreams.get(msg.id);
      if (ps) { ps.start(msg.status ?? 200, msg.headers ?? {}); return; }
      // Chunked buffered: agent is streaming a response for a buffered request.
      const p = this.pending.get(msg.id);
      if (p) this.pendingChunks.set(msg.id, { status: msg.status ?? 200, headers: msg.headers ?? {}, chunks: [] });
      return;
    }
    if (msg.type === 'response_chunk') {
      const ps = this.pendingStreams.get(msg.id);
      if (ps && msg.data) { ps.chunk(Buffer.from(msg.data, 'base64')); return; }
      // Accumulate chunk for chunked buffered mode.
      const acc = this.pendingChunks.get(msg.id);
      if (acc && msg.data) acc.chunks.push(Buffer.from(msg.data, 'base64'));
      return;
    }
    if (msg.type === 'response_end') {
      const ps = this.pendingStreams.get(msg.id);
      if (ps) { ps.end(); this.pendingStreams.delete(msg.id); return; }
      // Resolve the buffered pending with the reassembled body.
      const acc = this.pendingChunks.get(msg.id);
      const p = acc ? this.pending.get(msg.id) : null;
      if (acc && p) {
        this.pendingChunks.delete(msg.id);
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        const body = Buffer.concat(acc.chunks).toString('base64') || null;
        p.resolve({ type: 'response', id: msg.id, status: acc.status, headers: acc.headers, body });
      }
      return;
    }
    if (msg.type === 'response_error') {
      const ps = this.pendingStreams.get(msg.id);
      if (ps) { ps.fail(new Error(msg.error || 'stream_error')); this.pendingStreams.delete(msg.id); return; }
      const p = this.pending.get(msg.id);
      if (p) { this.pendingChunks.delete(msg.id); clearTimeout(p.timer); this.pending.delete(msg.id); p.reject(new Error(msg.error || 'stream_error')); }
      return;
    }

    // Buffered response — handle both pending (normal) and pendingStreams
    // (backward compat: old agent replies to stream:true with a buffered message).
    if (msg.type === 'response' && msg.id) {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg);
        return;
      }
      // Old agent sent buffered response to a streaming request — synthesize stream events.
      const ps = this.pendingStreams.get(msg.id);
      if (ps) {
        ps.start(msg.status ?? 200, msg.headers ?? {});
        if (msg.body) ps.chunk(Buffer.from(msg.body, 'base64'));
        ps.end();
        this.pendingStreams.delete(msg.id);
      }
    }
  }

  /** Send a control event (key_issued, key_revoked). Fire and forget. */
  sendControl(event, payload = {}) {
    if (this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify({ type: 'control', event, payload }));
    return true;
  }

  /** Send a ping. Agent replies with 'pong'; next heartbeat tick reads alive. */
  ping() {
    if (this.socket.readyState !== 1) return;
    this.alive = false;
    this.socket.send(JSON.stringify({ type: 'ping' }));
  }

  /**
   * Forward an HTTP request to the agent and await its complete buffered response.
   * Rejects on timeout. Rejects all pending on socket close.
   */
  request({ method, path, headers, body }, timeoutMs) {
    if (this.socket.readyState !== 1) {
      return Promise.reject(new Error('offline'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({
        type: 'request', id, method, path,
        headers, body: body ? body.toString('base64') : null,
      }));
    });
  }

  /**
   * Forward a streaming HTTP request to the agent.
   *
   * Returns { startPromise, bodyStream }:
   *   startPromise — resolves with { status, headers } when response_start arrives.
   *                  Rejects with Error('timeout') if startTimeoutMs elapses first.
   *   bodyStream   — ReadableStream<Uint8Array> of response body chunks.
   *
   * The caller can return `new Response(bodyStream, { status, headers })` to the
   * HTTP client immediately after startPromise resolves, enabling true streaming
   * to the browser without waiting for the full body.
   */
  requestStream({ method, path, headers, body }, startTimeoutMs) {
    if (this.socket.readyState !== 1) {
      const err = new Error('offline');
      return {
        startPromise: Promise.reject(err),
        bodyStream: new ReadableStream({ start(c) { c.error(err); } }),
      };
    }

    const id = randomUUID();
    const pendingStreams = this.pendingStreams;

    let resolveStart, rejectStart;
    const startPromise = new Promise((res, rej) => { resolveStart = res; rejectStart = rej; });

    const startTimer = setTimeout(() => {
      pendingStreams.delete(id);
      rejectStart(new Error('timeout'));
    }, startTimeoutMs);

    const socket = this.socket;
    let streamController;
    const bodyStream = new ReadableStream({
      start(c) { streamController = c; },
      cancel() {
        pendingStreams.delete(id);
        if (socket.readyState === 1) {
          try { socket.send(JSON.stringify({ type: 'cancel', id })); } catch {}
        }
      },
    });

    pendingStreams.set(id, {
      start(status, hdrs) {
        clearTimeout(startTimer);
        resolveStart({ status, headers: hdrs });
      },
      chunk(data) {
        try { streamController.enqueue(data); } catch {}
      },
      end() {
        try { streamController.close(); } catch {}
      },
      fail(e) {
        clearTimeout(startTimer);
        rejectStart(e);
        try { streamController.error(e); } catch {}
      },
    });

    this.socket.send(JSON.stringify({
      type: 'request', id, method, path,
      headers, body: body ? body.toString('base64') : null,
      stream: true,
    }));

    return { startPromise, bodyStream };
  }

  /** Fail all pending requests and streams — called on socket close. */
  abort(reason = 'disconnect') {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.pendingChunks.clear();

    for (const [, p] of this.pendingStreams) {
      p.fail(new Error(reason));
    }
    this.pendingStreams.clear();
  }
}
