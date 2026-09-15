/**
 * Monarch session + login secrets live in Keychain (agent vault).
 * 1Password is not on this path. Password/OTP seed are separate keys,
 * never stored inside MONARCH_SESSION.
 */
import { createHmac, randomUUID } from 'node:crypto';
import {
  readKeychainSecret,
  writeKeychainSecret,
} from './keychain.js';
import {
  isJwtShapedToken,
  loginMonarch,
} from './monarch-client.js';

export const MONARCH_SESSION_KEY = 'MONARCH_SESSION';
export const MONARCH_EMAIL_KEY = 'MONARCH_EMAIL';
export const MONARCH_PASSWORD_KEY = 'MONARCH_PASSWORD';
export const MONARCH_OTP_SEED_KEY = 'MONARCH_OTP_SEED';
export const MONARCH_DEVICE_UUID_KEY = 'MONARCH_DEVICE_UUID';

function defaultKeychain() {
  return {
    read: (name) => readKeychainSecret(name),
    write: (name, value) => writeKeychainSecret(name, value),
  };
}

function decodeBase32(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of cleaned) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP from a BASE32 seed. Never uses the 1Password display code. */
export function totpFromSeed(seed, { now = Date.now(), step = 30, digits = 6 } = {}) {
  const key = decodeBase32(seed);
  if (!key.length) throw new Error('Monarch OTP seed is missing');
  const counter = Math.floor(now / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | (hmac[offset + 1] << 16)
    | (hmac[offset + 2] << 8)
    | hmac[offset + 3];
  const otp = bin % (10 ** digits);
  return String(otp).padStart(digits, '0');
}

export function parseMonarchSession(raw) {
  if (!raw) return null;
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  return value;
}

export function sessionHasSecrets(session) {
  const blob = JSON.stringify(session || {});
  if (/password/i.test(blob) && session?.password) return true;
  if (session?.totp || session?.otp || session?.otpSeed) return true;
  if (/op:\/\//.test(blob)) return true;
  return false;
}

export function assertSessionShape(session) {
  if (!session) throw new Error('Monarch session is missing');
  if (sessionHasSecrets(session)) throw new Error('Monarch session must not contain password, totp, or op://');
  if (session.tokenExpiration != null) throw new Error('Monarch returned a short-lived token');
  if (session.token && isJwtShapedToken(session.token)) throw new Error('Monarch returned a JWT-shaped token');
  if (session.kind === 'cookies') {
    if (!session.session_id || !session.csrftoken) throw new Error('Monarch cookie session is incomplete');
    return session;
  }
  if (!session.token) throw new Error('Monarch session has no token');
  return { ...session, kind: session.kind || 'token' };
}

export function readStoredMonarchSession({ keychain = defaultKeychain() } = {}) {
  const raw = keychain.read(MONARCH_SESSION_KEY);
  if (!raw) return null;
  try {
    return assertSessionShape(parseMonarchSession(raw));
  } catch {
    return null;
  }
}

export function writeStoredMonarchSession(session, { keychain = defaultKeychain() } = {}) {
  const safe = assertSessionShape(session);
  const stored = {
    kind: safe.kind,
    token: safe.token || undefined,
    tokenExpiration: null,
    session_id: safe.session_id || undefined,
    csrftoken: safe.csrftoken || undefined,
    obtainedAt: safe.obtainedAt || new Date().toISOString(),
  };
  keychain.write(MONARCH_SESSION_KEY, JSON.stringify(stored));
  return stored;
}

export function readMonarchLoginSecrets({ keychain = defaultKeychain() } = {}) {
  const username = keychain.read(MONARCH_EMAIL_KEY);
  const password = keychain.read(MONARCH_PASSWORD_KEY);
  const otpSeed = keychain.read(MONARCH_OTP_SEED_KEY);
  return {
    username: username ? String(username).trim() : '',
    password: password ? String(password) : '',
    otpSeed: otpSeed ? String(otpSeed).trim() : '',
  };
}

export async function loginViaKeychain({
  fetchImpl = fetch,
  keychain = defaultKeychain(),
  now = Date.now(),
  emailOtp,
} = {}) {
  const creds = readMonarchLoginSecrets({ keychain });
  if (!creds.username || !creds.password) {
    const err = new Error('Monarch Keychain login is missing');
    err.code = 'MONARCH_KEYCHAIN_MISSING';
    throw err;
  }
  let totp;
  if (creds.otpSeed) totp = totpFromSeed(creds.otpSeed, { now });
  let deviceUuid = keychain.read(MONARCH_DEVICE_UUID_KEY);
  if (!deviceUuid) {
    deviceUuid = randomUUID();
    keychain.write(MONARCH_DEVICE_UUID_KEY, deviceUuid);
  }
  const session = await loginMonarch({
    username: creds.username,
    password: creds.password,
    totp,
    emailOtp,
    deviceUuid,
    fetchImpl,
  });
  return writeStoredMonarchSession(session, { keychain });
}

/** @deprecated Use loginViaKeychain. Kept as an alias so older tests still resolve. */
export async function loginViaOnePassword(opts = {}) {
  return loginViaKeychain(opts);
}

/**
 * Resolve a session. Valid Keychain session skips login.
 * Otherwise email + password + OTP seed from Keychain.
 */
export async function resolveMonarchSession({
  keychain = defaultKeychain(),
  fetchImpl = fetch,
  forceLogin = false,
  now = Date.now(),
  emailOtp,
} = {}) {
  if (!forceLogin && !emailOtp) {
    const stored = readStoredMonarchSession({ keychain });
    if (stored) return { session: stored, fromKeychain: true, usedOp: false };
  }
  const session = await loginViaKeychain({ fetchImpl, keychain, now, emailOtp });
  return { session, fromKeychain: false, usedOp: false };
}
