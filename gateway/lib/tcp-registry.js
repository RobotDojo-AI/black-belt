/**
 * tcp-registry.js — In-memory registry for TCP-tunnel WebSocket connections.
 *
 * Separate from ws-registry.js (which handles JWT-auth HTTP-proxy connections).
 * Used by sni-router.js to find which WebSocket to forward raw TCP bytes through.
 *
 * SINGLE-PROCESS ONLY. The relay runs as one systemd-supervised process on one
 * VPS (st_63b59bda). The old ECS/Redis cross-instance backplane — pub/sub,
 * per-slug presence, remote channel open/splice — was dead weight the moment the
 * fleet collapsed to a single box, and is removed: a TCP connection and the
 * device tunnel that answers it now always land on the same process, so there is
 * never a remote owner to reach. What remains is the local slug→sockets map plus
 * the local hot-spare race (a device may hold more than one tunnel socket for
 * redundancy, all on THIS process), which is not cross-instance and stays.
 *
 * Wire protocol (JSON messages over WebSocket):
 *   gateway → device: { type: 'tcp_open',  connId }           — new incoming TCP connection
 *   device → gateway: { type: 'tcp_ready', connId }           — accepted
 *   gateway → device: { type: 'tcp_data',  connId, data }     — base64 bytes
 *   device → gateway: { type: 'tcp_data',  connId, data }     — base64 bytes
 *   either side:      { type: 'tcp_close', connId }           — close connection
 */

const registry = new Map(); // slug → Set<ws>
const pending  = new Map(); // connId → { resolve, reject, timer }
const channels = new Map(); // connId → { dataCallback, closeCallback }
const roundRobin = new Map(); // slug → next candidate index

const OPEN_TIMEOUT_MS = parseInt(process.env.TCP_OPEN_TIMEOUT_MS || '3000', 10);
const OPEN_RACE_WIDTH = parseInt(process.env.TCP_OPEN_RACE_WIDTH || '2', 10);
const OPEN_FAILURE_QUARANTINE_MS = parseInt(process.env.TCP_OPEN_FAILURE_QUARANTINE_MS || '15000', 10);
const OPEN_EVICT_FAILURES = parseInt(process.env.TCP_OPEN_EVICT_FAILURES || '10', 10);

let _connIdSeq = 0;
function nextConnId() {
  _connIdSeq = (_connIdSeq + 1) & 0x7fffffff;
  return `c${_connIdSeq}`;
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerTcpDevice(slug, ws) {
  const set = registry.get(slug) || new Set();
  socketHealth(ws);
  set.add(ws);
  registry.set(slug, set);
}

export function unregisterTcpDevice(slug, ws = null) {
  const set = registry.get(slug);
  if (set && ws) {
    set.delete(ws);
    if (set.size === 0) {
      registry.delete(slug);
      roundRobin.delete(slug);
    }
  } else {
    registry.delete(slug);
    roundRobin.delete(slug);
  }
  // Close open channels owned by this socket so callers aren't left hanging.
  // If `ws` is null, close every channel for the slug.
  for (const [connId, ch] of channels) {
    if (connId.startsWith(`${slug}:`) && (!ws || ch.ws === ws)) {
      try { ch.closeCallback(); } catch {}
      channels.delete(connId);
    }
  }
  // Reject pending opens owned by this socket.
  for (const [connId, p] of pending) {
    if (connId.startsWith(`${slug}:`) && (!ws || p.ws === ws)) {
      clearTimeout(p.timer);
      p.reject(new Error('device disconnected'));
      pending.delete(connId);
    }
  }
}

export function getTcpDeviceWs(slug) {
  const set = registry.get(slug);
  return set ? [...set][0] ?? null : null;
}

export function hasTcpDevice(slug) {
  return Boolean(registry.get(slug)?.size);
}

export function size() {
  return registry.size;
}

export function connectionSize() {
  let count = 0;
  for (const set of registry.values()) count += set.size;
  return count;
}

function evictTcpDeviceSocket(slug, ws, reason) {
  if (!registry.get(slug)?.has(ws)) return;
  console.warn(`[tcp-registry] evicting tcp tunnel slug=${slug} reason=${reason}`);
  unregisterTcpDevice(slug, ws);
  try {
    ws.close?.(1011, reason);
  } catch {
    try { ws.terminate?.(); } catch {}
  }
}

function socketHealth(ws) {
  if (!ws.__tcpOpenHealth) {
    ws.__tcpOpenHealth = {
      failures: 0,
      quarantineUntil: 0,
      inflight: 0,
      lastReadyAt: 0,
    };
  }
  return ws.__tcpOpenHealth;
}

function markTcpOpenStart(ws) {
  const health = socketHealth(ws);
  health.inflight += 1;
}

function markTcpOpenSuccess(ws) {
  const health = socketHealth(ws);
  health.failures = 0;
  health.quarantineUntil = 0;
  health.inflight = Math.max(0, health.inflight - 1);
  health.lastReadyAt = Date.now();
}

function markTcpOpenCancelled(ws) {
  const health = socketHealth(ws);
  health.inflight = Math.max(0, health.inflight - 1);
}

function markTcpOpenFailure(slug, ws, reason) {
  const health = socketHealth(ws);
  health.inflight = Math.max(0, health.inflight - 1);
  health.failures += 1;
  health.quarantineUntil = Date.now() + Math.max(0, OPEN_FAILURE_QUARANTINE_MS);
  if (health.failures >= OPEN_EVICT_FAILURES) {
    evictTcpDeviceSocket(slug, ws, reason);
    return;
  }
  console.warn(`[tcp-registry] quarantining tcp tunnel slug=${slug} reason=${reason} failures=${health.failures}`);
}

function tcpDeviceCandidates(slug) {
  const set = registry.get(slug);
  if (!set?.size) return [];
  const sockets = [...set];
  const start = roundRobin.get(slug) || 0;
  roundRobin.set(slug, (start + 1) % sockets.length);
  const ordered = sockets.slice(start).concat(sockets.slice(0, start));
  const now = Date.now();
  const healthy = ordered.filter((ws) => socketHealth(ws).quarantineUntil <= now);
  return healthy.length ? healthy : ordered;
}

// ── Channel open ─────────────────────────────────────────────────────────────

/**
 * Opens a virtual TCP channel through a device WebSocket registered on THIS
 * process. When a device holds more than one tunnel socket, races a bounded set
 * of them so one stale socket cannot stall the SNI splice.
 *
 * @param {string} slug
 * @param {(buf: Buffer) => void} onData  — called when device sends data
 * @param {() => void}            onClose — called when device closes the channel
 * @returns {Promise<{write(buf:Buffer):void, close():void} | null>}
 *   null if no device is connected for this slug.
 */
export async function openTcpChannel(slug, onData, onClose) {
  const candidates = tcpDeviceCandidates(slug);
  if (!candidates.length) return null;
  if (candidates.length === 1) {
    return openTcpChannelOnSocket(slug, candidates[0], onData, onClose);
  }

  return openTcpChannelOnFirstReadySocket(
    slug,
    candidates.slice(0, Math.max(2, Math.min(candidates.length, OPEN_RACE_WIDTH))),
    onData,
    onClose,
  );
}

async function openTcpChannelOnSocket(slug, ws, onData, onClose) {
  return beginTcpOpenAttempt(slug, ws, onData, onClose).promise;
}

function openTcpChannelOnFirstReadySocket(slug, candidates, onData, onClose) {
  let winner = null;
  const attempts = candidates.map((ws) => {
    let attempt;
    attempt = beginTcpOpenAttempt(
      slug,
      ws,
      (data) => { if (winner === attempt) onData(data); },
      () => { if (winner === attempt) onClose(); },
    );
    return attempt;
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let failures = 0;
    let lastErr = null;

    for (const attempt of attempts) {
      attempt.promise.then((channel) => {
        if (settled) {
          channel.close();
          return;
        }
        settled = true;
        winner = attempt;
        for (const other of attempts) {
          if (other !== attempt) other.cancel();
        }
        resolve(channel);
      }).catch((err) => {
        if (settled) return;
        failures += 1;
        lastErr = err;
        if (failures === attempts.length) {
          settled = true;
          reject(lastErr || new Error(`no tcp device for ${slug}`));
        }
      });
    }
  });
}

function beginTcpOpenAttempt(slug, ws, onData, onClose) {
  const connId = `${slug}:${nextConnId()}`;
  let timer;
  let rejectAttempt;
  let settled = false;

  const promise = new Promise((resolve, reject) => {
    rejectAttempt = reject;
    timer = setTimeout(() => {
      settled = true;
      pending.delete(connId);
      channels.delete(connId);
      markTcpOpenFailure(slug, ws, 'tcp_open_timeout');
      reject(new Error(`tcp_open timeout for ${connId}`));
    }, OPEN_TIMEOUT_MS);

    markTcpOpenStart(ws);
    pending.set(connId, { resolve, reject, timer, ws });
    channels.set(connId, { dataCallback: onData, closeCallback: onClose, ws });

    try {
      ws.send(JSON.stringify({ type: 'tcp_open', connId }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(connId);
      channels.delete(connId);
      markTcpOpenFailure(slug, ws, 'tcp_open_send_error');
      reject(e);
    }
  }).then(() => {
    // Resolved by handleTcpDeviceMessage when tcp_ready arrives.
    settled = true;
    markTcpOpenSuccess(ws);
    return {
      write(buf) {
        if (!registry.get(slug)?.has(ws)) return;
        ws.send(JSON.stringify({ type: 'tcp_data', connId, data: buf.toString('base64') }));
      },
      close() {
        channels.delete(connId);
        if (!registry.get(slug)?.has(ws)) return;
        try { ws.send(JSON.stringify({ type: 'tcp_close', connId })); } catch {}
      },
    };
  });

  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hadPending = pending.delete(connId);
      const hadChannel = channels.delete(connId);
      if (hadPending || hadChannel) markTcpOpenCancelled(ws);
      if (registry.get(slug)?.has(ws)) {
        try { ws.send(JSON.stringify({ type: 'tcp_close', connId })); } catch {}
      }
      rejectAttempt?.(new Error(`tcp_open superseded for ${connId}`));
    },
  };
}

// ── Message dispatch ─────────────────────────────────────────────────────────

/**
 * Called by the tcp-tunnel WebSocket message handler for every message
 * received from a device.
 *
 * @param {string} slug
 * @param {{ type: string, connId: string, data?: string }} msg
 */
export function handleTcpDeviceMessage(slug, msg) {
  const { type, connId, data } = msg;
  if (!connId) return;

  switch (type) {
    case 'tcp_ready': {
      const p = pending.get(connId);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(connId);
      p.resolve();
      break;
    }

    case 'tcp_data': {
      const ch = channels.get(connId);
      if (!ch || !data) return;
      try { ch.dataCallback(Buffer.from(data, 'base64')); } catch {}
      break;
    }

    case 'tcp_close': {
      const p = pending.get(connId);
      const ch = channels.get(connId);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(connId);
        channels.delete(connId);
        markTcpOpenFailure(slug, p.ws, 'tcp_open_closed');
        p.reject(new Error(`tcp_open closed for ${connId}`));
        return;
      }
      if (!ch) return;
      channels.delete(connId);
      try { ch.closeCallback(); } catch {}
      break;
    }

    default:
      // Unknown message type — ignore.
      break;
  }
}
