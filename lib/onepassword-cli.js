/**
 * 1Password CLI reader — `op item get --vault <required>` only.
 *
 * Desktop-app CLI integration sees every vault the owner can. That is not a
 * limit. The hard limit is a service-account token that can only read the
 * Robot Dojo vault, injected into this child process and never left on
 * process.env. Our code refuses to call `op` without --vault.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKeychainSecret } from './keychain.js';

const _REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadMonarchOpDefaults() {
  let item = 'Monarch';
  let vault = null;
  try {
    const raw = JSON.parse(readFileSync(join(_REPO_ROOT, 'config', 'defaults.json'), 'utf8'));
    item = raw.monarch?.opItem || item;
    vault = raw.monarch?.opVault ?? vault;
  } catch { /* defaults.json absent */ }
  try {
    const userPath = join(_REPO_ROOT, 'config', 'monarch.user.json');
    if (existsSync(userPath)) {
      const user = JSON.parse(readFileSync(userPath, 'utf8'));
      if (user.opItem) item = user.opItem;
      if (user.opVault !== undefined) vault = user.opVault;
    }
  } catch { /* override optional */ }
  return {
    item: process.env.MONARCH_OP_ITEM || item,
    vault: process.env.MONARCH_OP_VAULT || vault || null,
  };
}

export const MONARCH_OP_SA_TOKEN_KEY = 'MONARCH_OP_SA_TOKEN';

export function assertVaultScopedOpArgs(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  if (list[0] !== 'item' || list[1] !== 'get') {
    failClosed('1Password CLI is limited to item get');
  }
  const vaultIdx = list.indexOf('--vault');
  if (vaultIdx < 0 || !list[vaultIdx + 1]) failClosed('1Password vault is required');
  return list;
}

function childEnvForOp({ serviceAccountToken } = {}) {
  const env = { ...process.env };
  // Do not let a leftover Connect/session env broaden access.
  for (const key of Object.keys(env)) {
    if (key === 'OP_CONNECT_HOST' || key === 'OP_CONNECT_TOKEN' || key.startsWith('OP_SESSION')) {
      delete env[key];
    }
  }
  if (serviceAccountToken) env.OP_SERVICE_ACCOUNT_TOKEN = serviceAccountToken;
  else delete env.OP_SERVICE_ACCOUNT_TOKEN;
  return env;
}

function defaultOpRunner(args, timeoutMs, env) {
  try {
    return spawnSync('op', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch (err) {
    return { status: 1, stdout: '', stderr: '', error: err };
  }
}

function failClosed(reason) {
  const err = new Error(reason);
  err.code = 'OP_UNAVAILABLE';
  throw err;
}

function fieldValue(fields, testers) {
  for (const field of fields) {
    for (const test of testers) {
      if (test(field) && field.value) return String(field.value);
    }
  }
  return '';
}

function extractOtpSeed(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const fromUri = value.match(/[?&]secret=([A-Z2-7=]+)/i);
  if (fromUri) return fromUri[1].replace(/=+$/g, '').toUpperCase();
  // A 6-digit display code is not the seed.
  if (/^\d{6}$/.test(value)) return '';
  if (/^[A-Z2-7]{8,}$/i.test(value.replace(/\s+/g, ''))) {
    return value.replace(/\s+/g, '').toUpperCase();
  }
  return '';
}

/**
 * Read one 1Password item via `op item get`.
 *
 * @param {object} [opts]
 * @param {string} [opts.item]
 * @param {string|null} [opts.vault]
 * @param {(args: string[], timeoutMs: number) => {status:number, stdout:string, stderr:string, error?:Error}} [opts.op]
 * @param {number} [opts.timeoutMs]
 * @returns {{ username: string, password: string, otpSeed: string, item: string }}
 */
export function getOpItem({ item, vault, op, timeoutMs, keychain } = {}) {
  const defaults = loadMonarchOpDefaults();
  const title = item || defaults.item;
  const vaultName = vault !== undefined ? vault : defaults.vault;
  if (!vaultName) failClosed('1Password vault is required');
  const runner = typeof op === 'function' ? op : defaultOpRunner;
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15_000;

  const args = assertVaultScopedOpArgs(['item', 'get', title, '--format', 'json', '--vault', String(vaultName)]);
  let serviceAccountToken = null;
  try {
    serviceAccountToken = keychain?.read
      ? (keychain.read(MONARCH_OP_SA_TOKEN_KEY) || null)
      : (readKeychainSecret(MONARCH_OP_SA_TOKEN_KEY) || null);
  } catch { serviceAccountToken = null; }
  const env = childEnvForOp({ serviceAccountToken });
  const result = runner.length >= 3 ? runner(args, budget, env) : runner(args, budget);
  const stderr = String(result?.stderr || result?.error?.message || '');
  if (result?.error?.code === 'ENOENT' || /not found|ENOENT|command not found/i.test(stderr)) {
    failClosed('1Password CLI is not available');
  }
  if (result?.status !== 0) {
    if (/not currently signed in|not signed in|session expired|locked/i.test(stderr)) {
      failClosed('1Password session is locked');
    }
    failClosed('1Password item is unavailable');
  }

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout || ''));
  } catch {
    failClosed('1Password item is unavailable');
  }

  const fields = Array.isArray(parsed?.fields) ? parsed.fields : [];
  const username = fieldValue(fields, [
    (f) => /^(username|email)$/i.test(String(f.id || '')),
    (f) => /^(username|email|e-mail)$/i.test(String(f.label || '')),
    (f) => /email/i.test(String(f.purpose || '')),
    (f) => String(f.purpose || '').toUpperCase() === 'USERNAME',
  ]);
  const password = fieldValue(fields, [
    (f) => String(f.id || '').toLowerCase() === 'password',
    (f) => /password/i.test(String(f.label || '')),
    (f) => String(f.purpose || '').toUpperCase() === 'PASSWORD',
  ]);
  const otpRaw = fieldValue(fields, [
    (f) => String(f.type || '').toUpperCase() === 'OTP',
    (f) => /^(otp|totp|one-time password|one time password)$/i.test(String(f.label || '')),
    (f) => /otp|totp/i.test(String(f.id || '')),
  ]);
  const otpSeed = extractOtpSeed(otpRaw);

  if (!username || !password) failClosed('1Password item is missing login fields');

  return { username, password, otpSeed, item: title };
}

export function opItemGetArgs({ item, vault } = {}) {
  const defaults = loadMonarchOpDefaults();
  const title = item || defaults.item;
  const vaultName = vault !== undefined ? vault : defaults.vault;
  if (!vaultName) failClosed('1Password vault is required');
  return assertVaultScopedOpArgs(['item', 'get', title, '--format', 'json', '--vault', String(vaultName)]);
}
