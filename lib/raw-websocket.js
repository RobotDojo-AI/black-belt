/**
 * WebSocket client that runs in a child process.
 *
 * The long-running server process has TCP connections that get stuck in
 * SYN_SENT when connecting to external hosts (tls.connect, https.request).
 * Fresh child processes are not affected. This module spawns ws-worker.mjs
 * in a fresh process, bridges messages over stdin/stdout (newline-delimited
 * JSON), and exposes the same { onOpen, onMessage, onClose, onError } API.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ws-worker.mjs');

// Prefer the system node over the app binary — the app binary's child processes
// can get SYN_SENT hangs when spawned from the long-running server process.
// System node (Homebrew) doesn't have this issue.
const SYSTEM_NODE_PATHS = [
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/node',
];
const NODE_BIN = SYSTEM_NODE_PATHS.find(p => existsSync(p)) || process.execPath;

/**
 * Open a WebSocket connection to `url` (wss://...) via a child process.
 *
 * Returns a handle { send(obj), close(code, reason), destroy() }.
 * Callbacks: onOpen(handle), onMessage(parsedObj), onClose(code, reason), onError(err).
 */
export function openWebSocket(url, { onOpen, onMessage, onClose, onError }) {
  let closed = false;
  let child = null;
  let stdinBuf = '';

  function closeFromWorkerFailure(reason) {
    if (closed) return;
    closed = true;
    try { child?.kill(); } catch {}
    onClose(1006, reason);
  }

  const handle = {
    send(obj) {
      if (closed || !child || child.killed) return;
      try { child.stdin.write(JSON.stringify({ type: 'send', payload: obj }) + '\n'); } catch {}
    },
    close(code = 1000, reason = '') {
      if (closed) return;
      if (child && !child.killed) {
        try { child.stdin.write(JSON.stringify({ type: 'close', code, reason }) + '\n'); } catch {}
        setTimeout(() => { try { child.kill(); } catch {} }, 500);
      }
      closed = true;
    },
    destroy() {
      closed = true;
      try { child?.kill(); } catch {}
    },
  };

  try {
    child = spawn(NODE_BIN, [WORKER_PATH, url], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    process.nextTick(() => { if (!closed) { closed = true; onError(e); } });
    return handle;
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdinBuf += chunk;
    const lines = stdinBuf.split('\n');
    stdinBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'open') {
          onOpen(handle);
        } else if (msg.type === 'message') {
          onMessage(msg.payload);
        } else if (msg.type === 'close') {
          if (!closed) { closed = true; onClose(msg.code ?? 1006, msg.reason ?? ''); }
        } else if (msg.type === 'error') {
          // error is informational; close event will follow
        }
      } catch {}
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  child.stdin.on('error', (e) => {
    closeFromWorkerFailure(`worker stdin error: ${e?.code || e?.message || 'unknown'}`);
  });

  child.on('exit', (code) => {
    if (!closed) { closed = true; onClose(1006, `worker exited: ${code}`); }
  });

  child.on('error', (e) => {
    if (!closed) { closed = true; onError(e); }
  });

  return handle;
}
