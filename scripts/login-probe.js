#!/usr/bin/env node
/**
 * Login health probe — verifies the auth path is reachable end-to-end.
 *
 * Hits /api/auth/probe on the target server. Fires a macOS notification
 * and exits non-zero if the probe fails so launchd can track failure state.
 *
 * Run by com.robotdojo.login-probe LaunchAgent every minute.
 *
 * CLI:
 *   node scripts/login-probe.js                        # production (reads slug from Keychain)
 *   node scripts/login-probe.js --target <base-url>    # custom target
 *   node scripts/login-probe.js --dry-run              # probe only, no notification
 */

// st_f6315f0b: login health must be probed during active use — its purpose
// is detecting auth-path breakage before a real user hits it. Single HTTP
// request, ~10ms; CPU is irrelevant.
export const IDLE_GATED = false;

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import config from '../lib/config.js';

const DRY_RUN = process.argv.includes('--dry-run');
const targetIdx = process.argv.indexOf('--target');
const TARGET_BASE = targetIdx !== -1 ? process.argv[targetIdx + 1] : null;
const CONFIG_DIR = process.env.ROBOTDOJO_CONFIG || resolve(homedir(), '.robotdojo');
const STATE_PATH = process.env.ROBOTDOJO_LOGIN_PROBE_STATE || resolve(CONFIG_DIR, 'state/login-probe.json');
const APP_PORT = Number(process.env.ROBOTDOJO_APP_PORT || config.ports.app);
export const PROBE_TIMEOUT_MS = Number(process.env.ROBOTDOJO_LOGIN_PROBE_TIMEOUT_MS || 20_000);
const REMOTE_FAILURE_RESTART_THRESHOLD = Number(process.env.ROBOTDOJO_LOGIN_PROBE_REMOTE_FAILURES || 1);
const RESTART_COOLDOWN_MS = Number(process.env.ROBOTDOJO_LOGIN_PROBE_RESTART_COOLDOWN_MS || 15 * 60_000);
const AUTO_REPAIR = process.env.ROBOTDOJO_LOGIN_PROBE_AUTOREPAIR !== '0';

// st_fd14cdd4 — local-liveness probe tuning. The restart decision must key off
// real process liveness, NOT a contended DB query. See probeLocalLiveness().
//   - LIVENESS_TIMEOUT_MS: a momentarily slow-but-alive server must not be
//     killed. /api/server-health answers in 7-44ms even under heavy writer
//     contention (it serves a wall-clock-cached body — zero synchronous
//     writer-lock DB work), so 8s is generous headroom for a real liveness
//     signal while still catching a genuinely hung process.
//   - LOCAL_FAILURE_DEBOUNCE: require N CONSECUTIVE liveness failures before a
//     restart. A single contended/slow tick never triggers a restart; a truly
//     dead or event-loop-wedged server fails N ticks in a row and still
//     self-heals. The counters are persisted in state and reset on the first
//     responsive liveness success.
const LIVENESS_TIMEOUT_MS = Number(process.env.ROBOTDOJO_LOGIN_PROBE_LIVENESS_TIMEOUT_MS || 8_000);
const LOCAL_FAILURE_DEBOUNCE = Number(process.env.ROBOTDOJO_LOGIN_PROBE_LOCAL_DEBOUNCE || 3);
const RESTART_TCP_ALIVE_UNRESPONSIVE = process.env.ROBOTDOJO_LOGIN_PROBE_RESTART_TCP_ALIVE !== '0';

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => process.stderr.write(`[${ts()}] ${m}\n`);

function notify(title, msg) {
  // Best-effort — screen lock or Focus mode may suppress it.
  try {
    const t = title.replace(/"/g, '\\"');
    const m = msg.replace(/"/g, '\\"');
    execSync(`osascript -e 'display notification "${m}" with title "${t}"'`, {
      timeout: 5000,
      stdio: 'ignore',
    });
    log(`alert sent: ${title}`);
  } catch {
    log('alert: osascript failed (screen locked or Focus mode)');
  }
}

async function getProbeUrl() {
  if (TARGET_BASE) return TARGET_BASE.replace(/\/$/, '') + '/api/auth/probe';

  // Read device slug from Keychain to build the production probe URL.
  const slug = execSync('security find-generic-password -s robotdojo-ROBOTDOJO_DEVICE_SLUG -w', {
    encoding: 'utf8',
    timeout: 5000,
    stdio: 'pipe',
  }).trim();
  return `https://robotdojo.ai/me/${slug}/api/auth/probe`;
}

export async function probe(url, { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
    }
    const data = await res.json();
    if (!data.ok || !data.db) throw new Error(`unhealthy: ${JSON.stringify(data)}`);
    return data;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export async function probeLocalServer({
  timeoutMs = 2500,
  fetchImpl = globalThis.fetch,
  urls = [
    `http://127.0.0.1:${APP_PORT + 1}/api/auth/probe`,
    `http://127.0.0.1:${APP_PORT}/api/auth/probe`,
  ],
} = {}) {
  const attempts = [];
  for (const url of urls) {
    const started = Date.now();
    try {
      const result = await probe(url, { timeoutMs, fetchImpl });
      attempts.push({ url, ok: true, duration_ms: Date.now() - started });
      return { ok: true, url, result, attempts };
    } catch (err) {
      attempts.push({
        url,
        ok: false,
        error: err?.name === 'AbortError' ? 'timeout' : (err?.message || String(err)),
        duration_ms: Date.now() - started,
      });
    }
  }
  return { ok: false, url: null, attempts };
}

// st_fd14cdd4 — raw TCP-connect liveness check. WHY this exists alongside the
// HTTP probe: under SUSTAINED extreme contention the event loop itself is
// blocked for tens of seconds (live ctx-trace measured chat context builds at
// 50-110s, model_ttft alone 30-70s), so even the wall-clock-cached
// /api/server-health handler cannot get a turn on the event loop to respond
// within the HTTP timeout. But a process whose event loop is momentarily wedged
// is STILL ALIVE — the OS-level TCP listener accepts the connection (SYN/ACK is
// handled by the kernel, not the JS event loop). A pure connect() therefore
// distinguishes the only two states that matter for a RESTART decision:
//   - connection ACCEPTED  → the process exists and holds the listening socket
//                            → ALIVE (event-loop-blocked at worst; restart can't help).
//   - connection REFUSED   → no listener → the process is gone/crashed → DEAD.
// Returns true on accept, false on refused/timeout/error.
export function probeTcpAlive(port, host = '127.0.0.1', { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host });
    let settled = false;
    const done = (alive) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));    // listener accepted → alive
    socket.once('timeout', () => done(false));   // SYN got no response in time
    socket.once('error', () => done(false));     // ECONNREFUSED etc. → dead
  });
}

// st_fd14cdd4 — LIGHTWEIGHT local-liveness probe for the RESTART decision.
//
// WHY a separate probe from probeLocalServer():
//   probeLocalServer hits /api/auth/probe, which runs a DB query (pingDb →
//   `SELECT 1`). On the 13GB SQLCipher DB under writer contention (the embedder
//   draining its backlog holds the single SQLite writer), even `SELECT 1` blocks
//   on the writer lock and exceeds the timeout → AbortError → looks "unhealthy".
//   A server that is SLOW UNDER LOAD is not DEAD; restarting it is exactly wrong
//   and is the confirmed cause of the 6-7-minute restart cycle (484 restarts in
//   the live err log, each one a `local_unhealthy` false positive while the
//   process was alive).
//
// Two-stage liveness:
//   1. HTTP /api/server-health (wall-clock-cached, no writer-lock DB work):
//      ANY HTTP status (incl. 503) within the timeout = alive. This is the
//      normal, informative signal (it also tells us the process is serving).
//   2. If the HTTP probe times out on EVERY port (the event loop is wedged by a
//      heavy in-flight build), fall back to a raw TCP connect(): if the listener
//      still accepts, the process is ALIVE but NOT RESPONSIVE. One TCP-only
//      tick can be a transient heavy build; repeated TCP-only ticks mean public
//      relay requests cannot be served and the server must self-heal through the
//      same debounce + cooldown gate as a dead listener.
export async function probeLocalLiveness({
  timeoutMs = LIVENESS_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  tcpProbe = probeTcpAlive,
  ports = [APP_PORT + 1, APP_PORT],
  urls = [
    `http://127.0.0.1:${APP_PORT + 1}/api/server-health`,
    `http://127.0.0.1:${APP_PORT}/api/server-health`,
  ],
} = {}) {
  const attempts = [];
  for (const url of urls) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      clearTimeout(timer);
      // ANY HTTP response = the process is alive and answering. A 503 from a
      // server under DB stress is alive; restarting it cannot help and only
      // inflicts the cold-warmup window. We record the status for reporting.
      attempts.push({ url, alive: true, via: 'http', status: res.status, duration_ms: Date.now() - started });
      return { alive: true, responsive: true, url, via: 'http', status: res.status, attempts };
    } catch (err) {
      clearTimeout(timer);
      attempts.push({
        url,
        alive: false,
        via: 'http',
        error: err?.name === 'AbortError' ? 'timeout' : (err?.message || String(err)),
        duration_ms: Date.now() - started,
      });
    }
  }
  // HTTP timed out on every port → the event loop may be wedged by a heavy
  // in-flight build. Fall back to a raw TCP connect: if the listener still
  // accepts, the process is ALIVE but unresponsive to app traffic. Debounce
  // decides whether it is a transient slow tick or a real repair condition.
  for (const port of ports) {
    const started = Date.now();
    const accepted = await tcpProbe(port);
    attempts.push({ port, alive: accepted, via: 'tcp', duration_ms: Date.now() - started });
    if (accepted) {
      return { alive: true, responsive: false, url: `tcp://127.0.0.1:${port}`, via: 'tcp', attempts };
    }
  }
  // Neither HTTP nor a raw TCP connect succeeded on any port → genuinely
  // dead/crashed (no process holding the listening socket).
  return { alive: false, responsive: false, url: null, via: null, attempts };
}

function readState(path = STATE_PATH) {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state, path = STATE_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
  } catch (err) {
    log(`state write skipped: ${err?.message || String(err)}`);
  }
}

// st_fd14cdd4: the restart decision keys off REAL process liveness with a
// debounce — never off a single contended DB query. Two false-positive paths
// have now been closed:
//
//   1. RELAY/TUNNEL-ONLY: a remote probe fails while the local server is fine.
//      Restarting the app cannot fix this and only inflicts a cold-warmup
//      window, so a locally-alive server is never restarted on remote failures.
//      The standalone tunnel is cheap and isolated, though; repeated remote
//      failures restart only com.robotdojo.tunnel.
//
//   2. SLOW-BUT-ALIVE (this fix): the OLD local check hit /api/auth/probe, a
//      DB-touching query that times out under writer contention even though the
//      process is alive and answering /api/server-health in tens of ms. The
//      confirmed failure mode: that 2500ms DB-query timeout flipped localOk=false
//      → local_unhealthy restart every ~12 min (484 restarts in the live log),
//      each one cold-resetting the Anthropic socket. So `localAlive` now comes
//      from probeLocalLiveness() (cheap /api/server-health, ANY HTTP status =
//      alive), AND a restart requires `consecutiveLocalFailures >= debounce`
//      consecutive dead ticks so one slow/contended tick never restarts.
//      The same debounce applies to TCP-only liveness: a listener that accepts
//      sockets but cannot answer HTTP for several probe intervals is broken for
//      login users and must repair under the normal cooldown gate.
//
// Decision table:
//   - localAlive && remote >= threshold              → restart tunnel only, unless in cooldown.
//   - localAlive && remote <  threshold              → no restart (single-blip grace).
//   - localAlive && !localResponsive, < debounce     → no restart (transient event-loop block).
//   - localAlive && !localResponsive, >= debounce    → restart server, unless disabled/cooldown.
//   - !localAlive && consecutive < debounce          → no restart (debounce; slow-but-alive grace).
//   - !localAlive && consecutive >= debounce         → restart server, unless in cooldown.
//
// A genuinely hung/dead process fails liveness `debounce` ticks in a row and
// still self-heals; the cooldown gates that only-remaining restart path.
export function decideRepair({
  localAlive,
  localResponsive = localAlive,
  consecutiveLocalFailures = 0,
  consecutiveLocalUnresponsive = 0,
  remoteFailures,
  lastRestartAt = null,
  lastTunnelRestartAt = null,
  now = Date.now(),
  threshold = REMOTE_FAILURE_RESTART_THRESHOLD,
  debounce = LOCAL_FAILURE_DEBOUNCE,
  cooldownMs = RESTART_COOLDOWN_MS,
} = {}) {
  const lastRestartMs = lastRestartAt ? Date.parse(lastRestartAt) : 0;
  const inCooldown = Number.isFinite(lastRestartMs) && lastRestartMs > 0 && now - lastRestartMs < cooldownMs;
  if (!localAlive) {
    // Debounce: a single slow/contended tick is not a dead server. Only restart
    // once liveness has failed `debounce` consecutive ticks.
    if (consecutiveLocalFailures < debounce) {
      return { restart: false, reason: 'local_slow_debounce' };
    }
    return { restart: !inCooldown, target: 'server', reason: inCooldown ? 'restart_cooldown' : 'local_unhealthy' };
  }
  if (!localResponsive) {
    if (consecutiveLocalUnresponsive < debounce) {
      return { restart: false, reason: 'local_unresponsive_debounce' };
    }
    if (!RESTART_TCP_ALIVE_UNRESPONSIVE) {
      return { restart: false, target: 'server', reason: 'local_unresponsive_alive_no_restart' };
    }
    return { restart: !inCooldown, target: 'server', reason: inCooldown ? 'restart_cooldown' : 'local_unresponsive' };
  }
  if (remoteFailures >= threshold) {
    // Local server is alive; the failure is remote/relay/tunnel-only. Do not
    // restart the healthy app. Restart the isolated tunnel process so stale
    // WebSockets, ALB drift, and missed reconnects self-heal.
    const lastTunnelRestartMs = lastTunnelRestartAt
      ? Date.parse(lastTunnelRestartAt)
      : lastRestartMs;
    const tunnelInCooldown = Number.isFinite(lastTunnelRestartMs)
      && lastTunnelRestartMs > 0
      && now - lastTunnelRestartMs < cooldownMs;
    return {
      restart: !tunnelInCooldown,
      target: 'tunnel',
      reason: tunnelInCooldown ? 'tunnel_restart_cooldown' : 'remote_unhealthy_tunnel_restart',
    };
  }
  return { restart: false, reason: 'remote_unhealthy_single' };
}

function restartLaunchAgent(label) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : Number(execSync('id -u', { encoding: 'utf8', timeout: 2000 }).trim());
  execSync(`launchctl kickstart -k gui/${uid}/${label}`, {
    timeout: 10_000,
    stdio: 'ignore',
  });
}

function restartServer() {
  restartLaunchAgent('com.robotdojo.server');
}

function restartTunnel() {
  restartLaunchAgent('com.robotdojo.tunnel');
}

async function main() {
  log('login-probe start');

  let url;
  try {
    url = await getProbeUrl();
  } catch (err) {
    log(`config error: ${err.message}`);
    if (!DRY_RUN) notify('Robot Dojo — Login Probe Error', `Config error: ${err.message}`);
    process.exit(1);
  }

  log(`probing ${url}`);
  try {
    const result = await probe(url);
    log(`ok: db=${result.db} resend=${result.resendConfigured} ts=${result.ts}`);
    // Remote probe reaching the server proves it is alive — reset BOTH the
    // remote-failure counter and the local-liveness debounce counter.
    writeState({
      remote_failures: 0,
      consecutive_local_failures: 0,
      consecutive_local_unresponsive: 0,
      last_ok_at: new Date().toISOString(),
      last_probe_url: url,
    });
    process.exit(0);
  } catch (err) {
    log(`remote FAILED: ${err.message}`);
    const previous = readState();
    // st_fd14cdd4 — liveness for the RESTART decision uses the cheap
    // /api/server-health probe (no writer-lock DB query), NOT the heavy
    // /api/auth/probe. We still record the richer auth probe for reporting.
    const liveness = await probeLocalLiveness();
    const local = await probeLocalServer();
    const remoteFailures = Number(previous.remote_failures || 0) + 1;
    // Consecutive local-liveness failures: increment on a dead tick, reset to
    // 0 on any alive tick. This debounces a single slow/contended tick so it
    // never triggers a restart.
    const consecutiveLocalFailures = liveness.alive
      ? 0
      : Number(previous.consecutive_local_failures || 0) + 1;
    const consecutiveLocalUnresponsive = liveness.alive && liveness.responsive === false
      ? Number(previous.consecutive_local_unresponsive || 0) + 1
      : 0;
    const now = Date.now();
    const decision = decideRepair({
      localAlive: liveness.alive,
      localResponsive: liveness.responsive !== false,
      consecutiveLocalFailures,
      consecutiveLocalUnresponsive,
      remoteFailures,
      lastRestartAt: previous.last_restart_at || null,
      lastTunnelRestartAt: previous.last_tunnel_restart_at || null,
      now,
    });
    const nextState = {
      remote_failures: remoteFailures,
      consecutive_local_failures: consecutiveLocalFailures,
      last_failure_at: new Date(now).toISOString(),
      last_probe_url: url,
      last_remote_error: err?.message || String(err),
      local_alive: liveness.alive,
      local_responsive: liveness.responsive !== false,
      liveness_attempts: liveness.attempts,
      local_ok: local.ok,
      local_attempts: local.attempts,
      last_restart_at: previous.last_restart_at || null,
      last_tunnel_restart_at: previous.last_tunnel_restart_at || null,
      consecutive_local_unresponsive: consecutiveLocalUnresponsive,
    };

    if (decision.restart && AUTO_REPAIR && !DRY_RUN) {
      try {
        if (decision.target === 'tunnel') {
          restartTunnel();
          nextState.last_tunnel_restart_at = new Date().toISOString();
          log(`repair: restarted com.robotdojo.tunnel (${decision.reason})`);
          notify('Robot Dojo — Login Repair', `Restarted relay tunnel after ${decision.reason.replace(/_/g, ' ')}.`);
        } else {
          restartServer();
          nextState.last_restart_at = new Date().toISOString();
          nextState.consecutive_local_failures = 0; // restart fired — reset the debounce window
          nextState.consecutive_local_unresponsive = 0;
          log(`repair: restarted com.robotdojo.server (${decision.reason})`);
          notify('Robot Dojo — Login Repair', `Restarted local server after ${decision.reason.replace(/_/g, ' ')}.`);
        }
      } catch (restartErr) {
        log(`repair FAILED: ${restartErr.message}`);
        notify('Robot Dojo — Login FAILED', `Login probe failed and repair failed: ${restartErr.message}`);
      }
    } else {
      log(`repair: skipped (${decision.reason}, local_alive=${liveness.alive}, local_responsive=${liveness.responsive !== false}, local_streak=${consecutiveLocalFailures}, local_unresponsive_streak=${consecutiveLocalUnresponsive}, failures=${remoteFailures})`);
      if (!DRY_RUN && decision.reason !== 'remote_unhealthy_single' && decision.reason !== 'local_slow_debounce' && decision.reason !== 'local_unresponsive_debounce') {
        notify('Robot Dojo — Login FAILED', `Login probe failed: ${err.message}`);
      }
    }

    writeState(nextState);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
