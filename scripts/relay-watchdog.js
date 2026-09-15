#!/usr/bin/env node
/**
 * Relay watchdog — verifies the public SNI path and ALERTS when it is down.
 *
 * st_63b59bda: the relay now runs as a single systemd-supervised process on one
 * VPS. systemd owns process-level restart (Restart=always, no crash-loop
 * circuit breaker), and there is no ECS/ALB/NLB topology left to repair — so the
 * watchdog's old repair actions (refresh the NLB target, kickstart the local
 * tunnel) are gone. Its job shrinks from repair-and-log to probe-and-alert: on a
 * sustained SNI/relay outage it fires a macOS notification (the same best-effort
 * notify() pattern login-probe.js uses) so a human sees a stopped relay, rather
 * than logging silently to a file nobody watches.
 */
export const IDLE_GATED = false;

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIG_DIR = process.env.ROBOTDOJO_CONFIG || resolve(homedir(), '.robotdojo');
const STATE_PATH = process.env.ROBOTDOJO_RELAY_WATCHDOG_STATE || resolve(CONFIG_DIR, 'state/relay-watchdog.json');
const RELAY_HEALTH_URL = process.env.ROBOTDOJO_RELAY_HEALTH_URL || 'https://relay.robotdojo.ai/health';
const PROBE_TIMEOUT_MS = Number(process.env.ROBOTDOJO_RELAY_WATCHDOG_TIMEOUT_MS || 10_000);
const REPAIR_COOLDOWN_MS = Number(process.env.ROBOTDOJO_RELAY_WATCHDOG_REPAIR_COOLDOWN_MS || 5 * 60_000);
const EXPECTED_TCP_CONNECTIONS = Number(process.env.ROBOTDOJO_RELAY_WATCHDOG_TCP_CONNECTIONS || 2);
const RELAY_HEALTH_SAMPLES = Math.max(1, Number(process.env.ROBOTDOJO_RELAY_WATCHDOG_HEALTH_SAMPLES || 16) || 16);
const SNI_FAILURE_REPAIR_THRESHOLD = Math.max(1, Number(process.env.ROBOTDOJO_RELAY_WATCHDOG_SNI_FAILURES || 3) || 3);
const AUTO_REPAIR = process.env.ROBOTDOJO_RELAY_WATCHDOG_AUTOREPAIR !== '0';

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => process.stderr.write(`[${ts()}] ${m}\n`);

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

function readKeychain(name) {
  return execFileSync('security', ['find-generic-password', '-s', `robotdojo-${name}`, '-w'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function directSniProbeUrl() {
  if (process.env.ROBOTDOJO_RELAY_WATCHDOG_SNI_URL) return process.env.ROBOTDOJO_RELAY_WATCHDOG_SNI_URL;
  const server = process.env.ROBOTDOJO_RELAY_WATCHDOG_SERVER || readKeychain('ROBOTDOJO_DEVICE_SLUG');
  return `https://${server}.robotdojo.ai/api/auth/probe`;
}

async function fetchJson(url, { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    const text = await res.text();
    clearTimeout(timer);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: res.ok, status: res.status, json, text: text.slice(0, 200) };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: err?.name === 'AbortError' ? 'timeout' : (err?.message || String(err)) };
  }
}

function relayHealthSample(result, index) {
  const json = result.json || {};
  return {
    index,
    ok: result.ok,
    status: result.status,
    error: result.error || null,
    instanceId: json.instance_id || null,
    startedAt: json.started_at || json.sni?.startedAt || null,
    healthy: Boolean(result.ok && json.status === 'ok' && json.sni?.listening),
    tcpDevices: Number(json.tcp_devices || 0),
    tcpConnections: Number(json.tcp_connections ?? json.tcp_devices ?? 0),
    tcpConnectionsKnown: Object.hasOwn(json, 'tcp_connections'),
    sniListening: Boolean(json.sni?.listening),
  };
}

function summarizeGatewayTasks(samples) {
  const byId = new Map();
  for (const sample of samples) {
    const id = sample.instanceId || sample.startedAt || `sample-${sample.index}`;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, {
        id,
        instanceId: sample.instanceId,
        startedAt: sample.startedAt,
        samples: 1,
        healthy: sample.healthy,
        tcpDevices: sample.tcpDevices,
        tcpConnections: sample.tcpConnections,
        tcpConnectionsKnown: sample.tcpConnectionsKnown,
      });
      continue;
    }
    prev.samples += 1;
    prev.healthy = prev.healthy && sample.healthy;
    prev.tcpDevices = Math.min(prev.tcpDevices, sample.tcpDevices);
    prev.tcpConnections = Math.min(prev.tcpConnections, sample.tcpConnections);
    prev.tcpConnectionsKnown = prev.tcpConnectionsKnown && sample.tcpConnectionsKnown;
  }
  return [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export async function probeRelayHealth({ url = RELAY_HEALTH_URL, timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = globalThis.fetch, samples = 1 } = {}) {
  const sampleCount = Math.max(1, Math.trunc(Number(samples) || 1));
  const raw = [];
  for (let i = 0; i < sampleCount; i += 1) {
    raw.push(await fetchJson(url, { timeoutMs, fetchImpl }));
  }
  const healthSamples = raw.map((result, index) => relayHealthSample(result, index));
  const gatewayTasks = summarizeGatewayTasks(healthSamples);
  const first = raw[0] || {};
  const healthy = healthSamples.length > 0 && healthSamples.every((sample) => sample.healthy);
  const tcpDevices = healthSamples.length
    ? Math.min(...healthSamples.map((sample) => sample.tcpDevices))
    : 0;
  const tcpConnections = healthSamples.length
    ? Math.min(...healthSamples.map((sample) => sample.tcpConnections))
    : 0;
  const tcpConnectionsKnown = healthSamples.length > 0 && healthSamples.every((sample) => sample.tcpConnectionsKnown);
  const sniListening = healthSamples.length > 0 && healthSamples.every((sample) => sample.sniListening);
  return {
    ...first,
    healthy,
    tcpDevices,
    tcpConnections,
    tcpConnectionsKnown,
    sniListening,
    healthSamples,
    sampleCount,
    gatewayTasks,
    observedGatewayTasks: gatewayTasks.length,
  };
}

export async function probeDirectSni({ url, timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const result = await fetchJson(url, { timeoutMs, fetchImpl });
  const json = result.json || {};
  return {
    ...result,
    healthy: Boolean(result.ok && json.ok && json.db),
  };
}

export function decideRelayWatchdogRepair({
  relayHealthy,
  sniHealthy,
  tcpDevices = 0,
  tcpConnections = tcpDevices,
  tcpConnectionsKnown = false,
  expectedTcpConnections = EXPECTED_TCP_CONNECTIONS,
  sniFailureCount = 1,
  sniFailureRepairThreshold = 1,
  lastRepairAt = null,
  now = Date.now(),
  cooldownMs = REPAIR_COOLDOWN_MS,
} = {}) {
  if (sniHealthy && tcpDevices >= 1 && (!tcpConnectionsKnown || tcpConnections >= expectedTcpConnections)) {
    return { repair: false, reason: 'healthy' };
  }

  const lastRepairMs = lastRepairAt ? Date.parse(lastRepairAt) : 0;
  const inCooldown = Number.isFinite(lastRepairMs) && lastRepairMs > 0 && now - lastRepairMs < cooldownMs;
  if (inCooldown) return { repair: false, reason: 'repair_cooldown' };

  if (!sniHealthy) {
    const relayHotSpareHealthy = relayHealthy
      && tcpDevices >= 1
      && (!tcpConnectionsKnown || tcpConnections >= expectedTcpConnections);
    if (relayHotSpareHealthy && sniFailureCount < sniFailureRepairThreshold) {
      return {
        repair: false,
        reason: 'sni_failure_threshold',
        sniFailures: sniFailureCount,
        threshold: sniFailureRepairThreshold,
      };
    }
    return {
      repair: true,
      reason: relayHealthy ? 'sni_unreachable' : 'relay_and_sni_unreachable',
    };
  }

  if (tcpDevices < 1) {
    return {
      repair: true,
      reason: 'tcp_device_missing',
    };
  }

  if (tcpConnectionsKnown && tcpConnections < expectedTcpConnections) {
    return {
      repair: true,
      reason: 'tcp_connection_redundancy_degraded',
    };
  }

  return { repair: false, reason: 'no_repair_needed' };
}

// Best-effort macOS notification — the same pattern login-probe.js uses. Screen
// lock or Focus mode may suppress it; a failure is logged, never thrown. This is
// the entire "alerts if it isn't [healthy]" half of AC-3: systemd keeps the
// process alive, this makes a sustained outage visible to a human.
function notify(title, msg) {
  try {
    const t = String(title).replace(/"/g, '\\"');
    const m = String(msg).replace(/"/g, '\\"');
    execSync(`osascript -e 'display notification "${m}" with title "${t}"'`, {
      timeout: 5000,
      stdio: 'ignore',
    });
    log(`alert sent: ${title}`);
  } catch {
    log('alert: osascript failed (screen locked or Focus mode)');
  }
}

async function main() {
  log('relay-watchdog start');
  let sniUrl;
  try {
    sniUrl = directSniProbeUrl();
  } catch (err) {
    log(`config error: ${err?.message || String(err)}`);
    process.exit(1);
  }

  const previous = readState();
  const [relay, sni] = await Promise.all([
    probeRelayHealth({ samples: RELAY_HEALTH_SAMPLES }),
    probeDirectSni({ url: sniUrl }),
  ]);
  const now = Date.now();
  const sniFailureCount = sni.healthy ? 0 : Number(previous.sni_failure_count || 0) + 1;
  const decision = decideRelayWatchdogRepair({
    relayHealthy: relay.healthy,
    sniHealthy: sni.healthy,
    tcpDevices: relay.tcpDevices,
    tcpConnections: relay.tcpConnections,
    tcpConnectionsKnown: relay.tcpConnectionsKnown,
    sniFailureCount,
    sniFailureRepairThreshold: SNI_FAILURE_REPAIR_THRESHOLD,
    lastRepairAt: previous.last_repair_at || null,
    now,
  });

  const nextState = {
    last_check_at: new Date(now).toISOString(),
    relay_ok: relay.healthy,
    relay_status: relay.status,
    tcp_devices: relay.tcpDevices,
    tcp_connections: relay.tcpConnections,
    tcp_connections_known: relay.tcpConnectionsKnown,
    relay_health_samples: relay.sampleCount,
    gateway_tasks_seen: relay.observedGatewayTasks,
    gateway_tasks: relay.gatewayTasks,
    sni_ok: sni.healthy,
    sni_status: sni.status,
    sni_url: sniUrl,
    sni_failure_count: sniFailureCount,
    sni_failure_repair_threshold: SNI_FAILURE_REPAIR_THRESHOLD,
    decision,
    last_repair_at: previous.last_repair_at || null,
  };

  if (decision.repair && AUTO_REPAIR && !DRY_RUN) {
    // Alert-only. There is nothing left for the Mac to repair — systemd owns the
    // relay's restart on the VPS. Fire a notification (cooldown-gated by
    // last_repair_at above) so a sustained outage reaches a human.
    notify('Robot Dojo — Relay Down', `${decision.reason.replace(/_/g, ' ')}: the blind relay is not answering. systemd should be restarting it on the VPS — check it.`);
    nextState.last_repair_at = new Date().toISOString();
    log(`alert: ${decision.reason}`);
  } else {
    log(`alert: skipped (${decision.reason})`);
  }

  writeState(nextState);
  process.exit(sni.healthy ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
