#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadMaintenanceRegistry } from '../lib/maintenance.js';

const packagedOnly = process.argv.includes('--packaged-only') || process.argv.includes('--templates-only');
const root = process.env.ROBOTDOJO_REPO_ROOT || resolve(import.meta.dirname, '..');
const home = process.env.HOME || homedir();
const configDir = process.env.ROBOTDOJO_CONFIG || resolve(home, '.robotdojo');
const launchDir = process.env.ROBOTDOJO_LAUNCH_AGENTS_DIR || resolve(home, 'Library/LaunchAgents');
const permissionApp = process.env.ROBOTDOJO_PERMISSION_APP || resolve(home, 'Applications', 'Robot Dojo.app');
const permissionLauncher = process.env.ROBOTDOJO_PERMISSION_LAUNCHER || resolve(configDir, 'bin', 'Robot Dojo');
const appRuntime = resolve(permissionApp, 'Contents', 'MacOS', 'Robot Dojo');
const runtimeBin = process.env.ROBOTDOJO_RUNTIME_BIN || (existsSync(appRuntime) ? appRuntime : process.execPath);
const manifest = JSON.parse(readFileSync(resolve(root, 'config/launch-agents.json'), 'utf8'));
const registry = loadMaintenanceRegistry(root);
const allowedDeprecated = new Set((registry.deprecated_launch_agents || []).map(x => x.label));

function expand(text) {
  return text
    .replaceAll('__HOME__', home)
    .replaceAll('__USER__', process.env.USER || 'robotdojo')
    .replaceAll('__CONFIG__', configDir)
    .replaceAll('__NODE__', process.execPath)
    .replaceAll('__ROBOTDOJO_RUNTIME__', runtimeBin)
    .replaceAll('__PATH__', process.env.PATH || '')
    .replaceAll('__ROBOTDOJO_APP__', permissionApp)
    .replaceAll('__ROBOTDOJO_LAUNCHER__', permissionLauncher)
    .replaceAll('__ROBOTDOJO_HOME__', root);
}

function stringsFor(xml, key) {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`));
  if (!m) return [];
  return [...m[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(x => x[1]);
}

function scalarFor(xml, key) {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<(?:string|integer)>([\\s\\S]*?)</(?:string|integer)>`));
  if (m) return m[1].trim();
  if (new RegExp(`<key>${key}</key>\\s*<true\\s*/>`).test(xml)) return true;
  if (new RegExp(`<key>${key}</key>\\s*<false\\s*/>`).test(xml)) return false;
  return null;
}

function requireScalar(failures, label, name, xml, key, expected) {
  const actual = scalarFor(xml, key);
  if (actual !== expected) failures.push(`${label}: ${name} plist ${key}=${actual} expected=${expected}`);
}

function requireEnv(failures, label, name, env, key, expected) {
  if (env[key] !== expected) failures.push(`${label}: ${name} plist env ${key}=${env[key] ?? 'missing'} expected=${expected}`);
}

function requireArg(failures, label, name, xml, pattern, description) {
  const args = stringsFor(xml, 'ProgramArguments');
  if (!args.some(arg => pattern.test(arg))) failures.push(`${label}: ${name} plist ProgramArguments missing ${description}`);
}

function assertLaunchContract(failures, label, name, xml) {
  const env = envFor(xml);
  if (label === 'com.robotdojo.keychain-bridge') {
    if (!hasKeepAlive(xml)) failures.push(`${label}: ${name} plist missing KeepAlive`);
    requireScalar(failures, label, name, xml, 'RunAtLoad', true);
    requireScalar(failures, label, name, xml, 'ProcessType', 'Background');
    requireArg(failures, label, name, xml, /scripts\/keychain-bridge\.js$/, 'scripts/keychain-bridge.js');
  } else if (label === 'com.robotdojo.server') {
    if (!hasKeepAlive(xml)) failures.push(`${label}: ${name} plist missing KeepAlive`);
    requireScalar(failures, label, name, xml, 'RunAtLoad', true);
    if (scalarFor(xml, 'ProcessType') === 'Background') {
      failures.push(`${label}: ${name} plist must not be ProcessType=Background (Tailscale blocks its outbound LLM TCP)`);
    }
    requireEnv(failures, label, name, env, 'ROBOTDOJO_SERVER_DB_BUSY_TIMEOUT_MS', '100');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_SKIP_TUNNEL', '1');
  } else if (label === 'com.robotdojo.tunnel') {
    if (!hasKeepAlive(xml)) failures.push(`${label}: ${name} plist missing KeepAlive`);
    requireScalar(failures, label, name, xml, 'RunAtLoad', true);
    requireArg(failures, label, name, xml, /scripts\/tunnel-standalone\.js$/, 'scripts/tunnel-standalone.js');
    requireArg(failures, label, name, xml, /^--launch$/, '--launch');
    if (scalarFor(xml, 'ProcessType') === 'Background') failures.push(`${label}: ${name} plist must not be ProcessType=Background`);
    requireEnv(failures, label, name, env, 'ROBOTDOJO_TUNNEL_LAUNCH_MODE', '1');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_TUNNEL_CLIENT_CONNECTIONS', '32');
  } else if (label === 'com.robotdojo.keepawake') {
    if (!hasKeepAlive(xml)) failures.push(`${label}: ${name} plist missing KeepAlive`);
    requireScalar(failures, label, name, xml, 'RunAtLoad', true);
    requireArg(failures, label, name, xml, /^\/usr\/bin\/caffeinate$/, '/usr/bin/caffeinate');
    requireArg(failures, label, name, xml, /^-i$/, '-i');
    requireArg(failures, label, name, xml, /^-m$/, '-m');
    requireArg(failures, label, name, xml, /^-s$/, '-s');
    if (stringsFor(xml, 'ProgramArguments').includes('-d')) failures.push(`${label}: ${name} plist must not prevent display sleep`);
  } else if (label === 'com.robotdojo.chunk-embed-daemon') {
    if (!hasKeepAlive(xml)) failures.push(`${label}: ${name} plist missing KeepAlive`);
    requireScalar(failures, label, name, xml, 'ProcessType', 'Background');
    requireScalar(failures, label, name, xml, 'LowPriorityIO', true);
    requireScalar(failures, label, name, xml, 'Nice', '10');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_ACTIVITY_PAUSE_MS', '60000');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_DAEMON_STARTUP_GRACE_MS', '90000');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_MMAP_SIZE', '0');
  } else if (label === 'com.robotdojo.sync') {
    requireScalar(failures, label, name, xml, 'StartInterval', '300');
    requireScalar(failures, label, name, xml, 'ProcessType', 'Background');
    requireScalar(failures, label, name, xml, 'Nice', '10');
  } else if (label === 'com.robotdojo.login-probe') {
    requireScalar(failures, label, name, xml, 'StartInterval', '60');
    requireScalar(failures, label, name, xml, 'Nice', '10');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_LOGIN_PROBE_REMOTE_FAILURES', '1');
  } else if (label === 'com.robotdojo.relay-watchdog') {
    requireScalar(failures, label, name, xml, 'StartInterval', '60');
    requireScalar(failures, label, name, xml, 'Nice', '10');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_HOME', root);
    requireEnv(failures, label, name, env, 'ROBOTDOJO_CONFIG', configDir);
    requireEnv(failures, label, name, env, 'ROBOTDOJO_RELAY_WATCHDOG_TCP_CONNECTIONS', '2');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_RELAY_WATCHDOG_HEALTH_SAMPLES', '16');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_RELAY_WATCHDOG_SNI_FAILURES', '3');
  } else if (label === 'com.robotdojo.disk-watchdog') {
    requireScalar(failures, label, name, xml, 'StartInterval', '300');
    requireScalar(failures, label, name, xml, 'Nice', '10');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_CONFIG', configDir);
    requireEnv(failures, label, name, env, 'ROBOTDOJO_DISK_WATCHDOG_MAX_LOG_BYTES', '10485760');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_DISK_WATCHDOG_KEEP_LOG_BYTES', '1048576');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_DISK_WATCHDOG_FLOOR_GB', '8');
  } else if (label === 'com.robotdojo.chunk-worker') {
    if (!hasKeepAlive(xml)) failures.push(`${label}: ${name} plist missing KeepAlive (jetsam -9 would not respawn)`);
    requireScalar(failures, label, name, xml, 'LowPriorityIO', true);
  } else if (label === 'com.robotdojo.topic-edit-watcher') {
    requireScalar(failures, label, name, xml, 'LowPriorityIO', true);
    requireEnv(failures, label, name, env, 'ROBOTDOJO_TOPIC_WATCHER_SLICE_LIMIT', '1');
    requireEnv(failures, label, name, env, 'ROBOTDOJO_TOPIC_WATCHER_RECLASSIFY_MAX_SECONDS', '120');
  }
}

// st_b50005df Phase 3 — KeepAlive may be declared as <true/> (always respawn)
// or as a <dict> of conditions (e.g. SuccessfulExit=false → respawn only on an
// abnormal exit such as a jetsam -9). Both count as "KeepAlive present". An
// explicit <false/> does NOT — that disables respawn.
function hasKeepAlive(xml) {
  if (new RegExp('<key>KeepAlive</key>\\s*<true\\s*/>').test(xml)) return true;
  if (new RegExp('<key>KeepAlive</key>\\s*<dict>').test(xml)) return true;
  return false;
}

function envFor(xml) {
  const m = xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  const out = {};
  if (!m) return out;
  const rx = /<key>(.*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  for (const match of m[1].matchAll(rx)) out[match[1]] = match[2];
  return out;
}

function normalizeEnvValue(key, value) {
  if (key !== 'PATH') return value;
  return String(value || '')
    .split(':')
    .filter(segment => !/\/\.codex\/tmp\/arg0\/codex-[^:]+$/.test(segment))
    .join(':');
}

const failures = [];
const productLabels = new Set((manifest.agents || []).map(a => a.label));
for (const agent of manifest.agents || []) {
  const installedPath = resolve(launchDir, `${agent.label}.plist`);
  const templatePath = resolve(root, agent.template);
  if (!existsSync(templatePath)) {
    failures.push(`${agent.label}: template missing: ${agent.template}`);
    continue;
  }
  const expected = expand(readFileSync(templatePath, 'utf8'));
  assertLaunchContract(failures, agent.label, 'template', expected);
  if (packagedOnly) continue;
  if (!existsSync(installedPath)) {
    failures.push(`${agent.label}: installed plist missing`);
    continue;
  }
  const installed = readFileSync(installedPath, 'utf8');
  assertLaunchContract(failures, agent.label, 'installed', installed);
  for (const key of ['ProgramArguments']) {
    const a = stringsFor(installed, key);
    const b = stringsFor(expected, key);
    if (JSON.stringify(a) !== JSON.stringify(b)) failures.push(`${agent.label}: ${key} drift`);
  }
  for (const key of ['WorkingDirectory', 'RunAtLoad', 'StartInterval', 'ThrottleInterval', 'ProcessType', 'LowPriorityIO', 'Nice', 'StandardOutPath', 'StandardErrorPath']) {
    const a = scalarFor(installed, key);
    const b = scalarFor(expected, key);
    if (a !== b) failures.push(`${agent.label}: ${key} drift installed=${a} expected=${b}`);
  }
  const actualEnv = envFor(installed);
  const expectedEnv = envFor(expected);
  for (const [key, value] of Object.entries(expectedEnv)) {
    if (normalizeEnvValue(key, actualEnv[key]) !== normalizeEnvValue(key, value)) failures.push(`${agent.label}: env ${key} drift`);
  }
  for (const key of Object.keys(actualEnv)) {
    if (!(key in expectedEnv) && key.startsWith('ROBOTDOJO_')) failures.push(`${agent.label}: unexpected env ${key}`);
  }

}

if (!packagedOnly && existsSync(launchDir)) {
  for (const file of readdirSync(launchDir)) {
    if (!/^com\.robotdojo\..*\.plist$/.test(file)) continue;
    const label = basename(file, '.plist');
    if (!productLabels.has(label) && !allowedDeprecated.has(label)) failures.push(`${label}: stale installed plist outside manifest`);
  }
}

const liveLaunchDir = resolve(home, 'Library/LaunchAgents');
const isLiveMachine = !packagedOnly && launchDir === liveLaunchDir;

if (isLiveMachine) {
  // A plist on disk that launchctl never loaded is how spend-watchdog
  // reported $0 while the key was billed. This label must actually run.
  try {
    execFileSync('launchctl', ['print', `gui/${process.getuid()}/com.robotdojo.spend-watchdog`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    failures.push('com.robotdojo.spend-watchdog: not loaded in launchctl — spend alarm is dark');
  }
  try {
    execFileSync('launchctl', ['print', `gui/${process.getuid()}/com.robotdojo.keychain-bridge`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    failures.push('com.robotdojo.keychain-bridge: not loaded in launchctl — hardened hosts cannot open the local DB');
  }
}

if (!packagedOnly && process.argv.includes('--print-loaded')) {
  for (const label of productLabels) {
    try {
      const out = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      process.stdout.write(`${label}: ${/state = running/.test(out) ? 'running' : 'loaded'}\n`);
    } catch {
      failures.push(`${label}: not loaded in launchctl`);
    }
  }
}

if (failures.length) {
  console.error('[check-live-launch-agents] FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const mode = packagedOnly ? 'packaged template' : 'installed';
console.log(`[check-live-launch-agents] ok — ${productLabels.size} product LaunchAgent(s) match ${mode} launch intent`);
