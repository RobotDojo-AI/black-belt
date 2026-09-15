/**
 * macOS Keychain access.
 *
 * Canonical service: robotdojo-<NAME>
 * Canonical account: robotdojo
 *
 * Reads are intentionally tolerant because older installs and early scripts
 * wrote some secrets under the macOS username or `miyagi`. Writes always land
 * on the canonical account so the product converges instead of drifting.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEYCHAIN_ACCOUNT = 'robotdojo';

// Hardened coding-agent hosts (Grok Developer ID + runtime) cannot decrypt
// Keychain secrets (security status 36). A launchd Aqua process can. Only the
// local DB key is bridged — provider keys stay dark.
export const KEYCHAIN_BRIDGE_SERVICE = 'robotdojo-LOCAL_DB_KEY';
export const KEYCHAIN_BRIDGE_SERVICES = Object.freeze([KEYCHAIN_BRIDGE_SERVICE]);

const BRIDGE_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'keychain-bridge.js');

function isMac() {
  return process.platform === 'darwin';
}

export function keychainService(nameOrService, { rawService = false } = {}) {
  let service = String(nameOrService || '').trim();
  if (!service) throw new Error('keychainService: service required');
  if (rawService) return service;

  const prefix = process.env.ROBOTDOJO_KEYCHAIN_PREFIX || '';
  if (prefix && service.startsWith(prefix)) return service;
  if (!service.startsWith('robotdojo-')) service = `robotdojo-${service}`;
  if (prefix && !service.startsWith(prefix)) service = `${prefix}${service}`;
  return service;
}

export function keychainAccounts() {
  const username = (() => {
    try { return userInfo().username; } catch { return process.env.USER || ''; }
  })();
  return [...new Set([KEYCHAIN_ACCOUNT, username, process.env.USER, 'miyagi'].filter(Boolean))];
}

function runSecurity(args, timeout = 5000) {
  if (!isMac()) return { status: 1, stdout: '', stderr: '' };
  return spawnSync('/usr/bin/security', args, { encoding: 'utf8', timeout });
}

export function keychainBridgeSocketPath(configDir = process.env.ROBOTDOJO_CONFIG) {
  if (process.env.ROBOTDOJO_KEYCHAIN_BRIDGE_SOCK) return process.env.ROBOTDOJO_KEYCHAIN_BRIDGE_SOCK;
  const dir = configDir || join(homedir(), '.robotdojo');
  return join(dir, 'runtime', 'keychain-bridge.sock');
}

export function isKeychainBridgeService(service) {
  return KEYCHAIN_BRIDGE_SERVICES.includes(String(service || ''));
}

function readViaBridge(service, { timeout = 2000, socketPath } = {}) {
  if (!isKeychainBridgeService(service)) return null;
  const sock = socketPath || keychainBridgeSocketPath();
  if (!existsSync(sock) || !existsSync(BRIDGE_BIN)) return null;
  const r = spawnSync(process.execPath, [BRIDGE_BIN, '--get', service], {
    encoding: 'utf8',
    timeout: timeout + 250,
    env: { ...process.env, ROBOTDOJO_KEYCHAIN_BRIDGE_SOCK: sock },
  });
  if (r.status !== 0) return null;
  const value = String(r.stdout || '').trim();
  return value || null;
}

/**
 * Read a secret via `/usr/bin/security` only. No launchd bridge. The bridge
 * process uses this so a blocked host cannot recurse into itself.
 */
export function readKeychainSecretViaSecurity(nameOrService, { timeout = 5000, rawService = false } = {}) {
  const service = keychainService(nameOrService, { rawService });
  for (const account of keychainAccounts()) {
    const r = runSecurity(['find-generic-password', '-s', service, '-a', account, '-w'], timeout);
    const value = r.status === 0 ? String(r.stdout || '').trim() : '';
    if (value) {
      if (!rawService && account !== KEYCHAIN_ACCOUNT) {
        writeKeychainSecret(service, value, { account: KEYCHAIN_ACCOUNT, timeout });
      }
      return value;
    }
  }

  const fallback = runSecurity(['find-generic-password', '-s', service, '-w'], timeout);
  const value = fallback.status === 0 ? String(fallback.stdout || '').trim() : '';
  if (value && !rawService) writeKeychainSecret(service, value, { account: KEYCHAIN_ACCOUNT, timeout });
  return value || null;
}

export function readKeychainSecret(nameOrService, {
  timeout = 5000,
  rawService = false,
  bridge = true,
} = {}) {
  const value = readKeychainSecretViaSecurity(nameOrService, { timeout, rawService });
  if (value) return value;
  if (!bridge) return null;
  const service = keychainService(nameOrService, { rawService });
  return readViaBridge(service, { timeout: Math.min(timeout, 2000) });
}

export function writeKeychainSecret(nameOrService, value, { account = KEYCHAIN_ACCOUNT, timeout = 5000, rawService = false } = {}) {
  const service = keychainService(nameOrService, { rawService });
  if (!isMac()) return false;
  if (value == null || value === '') return false;
  const r = runSecurity([
    'add-generic-password',
    '-s', service,
    '-a', account,
    '-w', String(value),
    '-U',
  ], timeout);
  return r.status === 0;
}

export function deleteKeychainSecret(nameOrService, { timeout = 5000, rawService = false } = {}) {
  const service = keychainService(nameOrService, { rawService });
  if (!isMac()) return true;

  let ok = true;
  for (const account of keychainAccounts()) {
    const r = runSecurity(['delete-generic-password', '-s', service, '-a', account], timeout);
    ok = ok && (r.status === 0 || r.status === 44);
  }
  const serviceOnly = runSecurity(['delete-generic-password', '-s', service], timeout);
  return ok && (serviceOnly.status === 0 || serviceOnly.status === 44);
}

/**
 * Enumerate keychain service names by prefix (df_355651ca Key decision 2).
 *
 * Attributes-only `security dump-keychain` — WITHOUT `-d`, so secret data is
 * never decrypted and no per-item ACL prompt can fire (SecItemCopyMatching
 * attribute reads are non-secret by contract). This makes the keychain itself
 * the integration registry: a `robotdojo-*` token that exists can be
 * discovered without touching its value.
 *
 * 15s timeout for this call only: dump-keychain walks the whole login
 * keychain (hundreds of items), unlike the single-item reads above.
 *
 * Returns a sorted, deduped array of matching service names; [] on ANY
 * failure (non-mac, spawn error, parse mismatch). Callers treat [] as
 * "enumeration unavailable" — the reconciler's zero-enumeration failsafe
 * prevents an empty result from mass-flagging stored credentials.
 */
export function listKeychainServices(prefix = 'robotdojo-') {
  try {
    const r = runSecurity(['dump-keychain'], 15_000);
    if (!r || r.status !== 0 || !r.stdout) return [];
    const services = new Set();
    for (const match of String(r.stdout).matchAll(/"svce"<blob>="([^"]+)"/g)) {
      if (match[1].startsWith(prefix)) services.add(match[1]);
    }
    return [...services].sort();
  } catch {
    return [];
  }
}

export function ensureKeychainSecret(nameOrService, makeValue, { timeout = 5000, rawService = false } = {}) {
  const existing = readKeychainSecret(nameOrService, { timeout, rawService });
  if (existing) return { value: existing, created: false };

  const value = makeValue();
  const ok = writeKeychainSecret(nameOrService, value, { timeout, rawService });
  return ok ? { value, created: true } : { value: null, created: false };
}
