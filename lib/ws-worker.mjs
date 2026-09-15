/**
 * WebSocket worker — runs as a child process.
 *
 * Takes a WSS URL as argv[2], opens the connection, and bridges
 * messages over stdin/stdout using newline-delimited JSON.
 *
 * Parent → child (stdin): { type: 'send', payload: <obj> }
 *                         { type: 'close', code: N, reason: '' }
 * Child → parent (stdout): { type: 'open' }
 *                          { type: 'message', payload: <obj> }
 *                          { type: 'close', code: N, reason: '' }
 *                          { type: 'error', message: '' }
 *
 * Running as a fresh process avoids the SYN_SENT hang that occurs
 * in the long-running server process (root cause: unknown, likely
 * network extension or Happy Eyeballs interaction in long-lived process).
 */
import tls from 'node:tls';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';

const url = process.argv[2];
if (!url) { process.stderr.write('usage: ws-worker.mjs <wss-url>\n'); process.exit(1); }

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ----- WebSocket framing -----
function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset], b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let headerLen = 2 + (masked ? 4 : 0);
    if (payloadLen === 126) { if (offset + 4 > buf.length) break; payloadLen = buf.readUInt16BE(offset + 2); headerLen += 2; }
    else if (payloadLen === 127) { if (offset + 10 > buf.length) break; payloadLen = Number(buf.readBigUInt64BE(offset + 2)); headerLen += 8; }
    if (offset + headerLen + payloadLen > buf.length) break;
    let payload = buf.slice(offset + (headerLen - (masked ? 4 : 0)), offset + headerLen + payloadLen);
    if (masked) {
      const m = buf.slice(offset + headerLen - 4, offset + headerLen);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= m[i % 4];
    }
    frames.push({ opcode, payload });
    offset += headerLen + payloadLen;
  }
  return { frames, remaining: buf.slice(offset) };
}

function encodeFrame(opcode, data, masked = true) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const len = payload.length;
  let hdrSize = 2 + (masked ? 4 : 0) + (len < 126 ? 0 : len < 65536 ? 2 : 8);
  const header = Buffer.alloc(hdrSize);
  header[0] = 0x80 | opcode;
  const mb = masked ? 0x80 : 0;
  let off = 2;
  if (len < 126) { header[1] = mb | len; }
  else if (len < 65536) { header[1] = mb | 126; header.writeUInt16BE(len, off); off += 2; }
  else { header[1] = mb | 127; header.writeBigUInt64BE(BigInt(len), off); off += 8; }
  if (!masked) return Buffer.concat([header, payload]);
  const mk = crypto.randomBytes(4); mk.copy(header, off);
  const mp = Buffer.from(payload);
  for (let i = 0; i < mp.length; i++) mp[i] ^= mk[i % 4];
  return Buffer.concat([header, mp]);
}

// ----- Connection -----
const parsed = new URL(url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://'));
const host = parsed.hostname;
const port = parseInt(parsed.port || '443', 10);
const path = parsed.pathname + parsed.search;
const wsKey = crypto.randomBytes(16).toString('base64');

let socket = null;
let recvBuf = Buffer.alloc(0);
let upgraded = false;
let done = false;

function finish(code, reason) {
  if (done) return;
  done = true;
  send({ type: 'close', code, reason });
  try { socket?.destroy(); } catch {}
  process.exit(0);
}

// Resolve DNS in the worker and connect by IP — avoids Happy Eyeballs v2 SYN_SENT hang
// that occurs when hostname is passed to tls.connect() from processes spawned by the server.
// Using the resolved IP for TCP while keeping the hostname as servername for TLS SNI.
let connectHost = host;
try {
  const addrs = await dns.resolve4(host);
  if (addrs.length) connectHost = addrs[Math.floor(Math.random() * addrs.length)];
} catch {}
if (process.env.ROBOTDOJO_WS_CONNECT_HOST) {
  connectHost = process.env.ROBOTDOJO_WS_CONNECT_HOST;
}
socket = tls.connect({ host: connectHost, port, servername: host });

const connectTimeout = setTimeout(() => {
  if (!upgraded) {
    process.stderr.write(`[ws-worker] connect timeout after 10s\n`);
    send({ type: 'error', message: 'connect timeout' });
    finish(1006, 'connect timeout');
  }
}, 10000);
connectTimeout.unref?.();

socket.on('secureConnect', () => {
  clearTimeout(connectTimeout);
  const req = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${wsKey}`,
    'Sec-WebSocket-Version: 13',
    '', '',
  ].join('\r\n');
  socket.write(req);
});

socket.on('data', (chunk) => {
  recvBuf = Buffer.concat([recvBuf, chunk]);
  if (!upgraded) {
    const headerEnd = recvBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const headerStr = recvBuf.slice(0, headerEnd).toString('ascii');
    recvBuf = recvBuf.slice(headerEnd + 4);
    const firstLine = headerStr.split('\r\n')[0];
    if (!firstLine.includes('101')) {
      send({ type: 'error', message: `upgrade rejected: ${firstLine}` });
      finish(1006, 'rejected');
      return;
    }
    upgraded = true;
    send({ type: 'open' });
  }
  const { frames, remaining } = decodeFrames(recvBuf);
  recvBuf = remaining;
  for (const { opcode, payload } of frames) {
    if (opcode === 9) { try { socket.write(encodeFrame(10, payload)); } catch {} }
    else if (opcode === 8) { const c = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; finish(c, ''); }
    else if (opcode === 1) {
      try { const msg = JSON.parse(payload.toString('utf8')); send({ type: 'message', payload: msg }); } catch {}
    }
  }
});

socket.on('close', () => finish(1006, ''));
socket.on('error', (e) => {
  send({ type: 'error', message: e.message || String(e) });
  finish(1006, e.message || '');
});

// ----- Stdin commands from parent -----
let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  const lines = stdinBuf.split('\n');
  stdinBuf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const cmd = JSON.parse(line);
      if (cmd.type === 'send' && socket && !socket.destroyed) {
        socket.write(encodeFrame(1, JSON.stringify(cmd.payload)));
      } else if (cmd.type === 'close') {
        const payload = Buffer.alloc(2); payload.writeUInt16BE(cmd.code || 1000, 0);
        try { socket.write(encodeFrame(8, payload)); } catch {}
        setTimeout(() => finish(cmd.code || 1000, cmd.reason || ''), 100);
      }
    } catch {}
  }
});
process.stdin.on('close', () => finish(1000, 'stdin closed'));
