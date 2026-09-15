/**
 * Key store — legacy compatibility store for Black Belt credential material.
 *
 *   ~/.robotdojo/          dir  (mode 0700)
 *   ~/.robotdojo/key       file (mode 0600, 32 raw bytes base64-encoded, no trailing newline)
 *   ~/.robotdojo/key.meta.json  { belt, issued_at, modules_url, grace_until, permanent? }
 *
 * API surface:
 *   loadKey()           → { key, belt, issuedAt, modulesUrl, graceUntil, permanent } | null
 *   saveKey({key,belt,modulesUrl,permanent,issuer})  atomic write (tmp + rename)
 *   deleteKey()         overwrite then unlink
 *   setGraceUntil(date) sets grace period deadline (for revocation)
 *   isExpired(meta)     pure helper — grace_until past wall clock; permanent→false
 *
 * Permanent flag
 *   `permanent: true` in key.meta.json is an operator/dev escape hatch. When
 *   set, grace_until is ignored and the key is treated as never-expiring.
 *   This is a legacy operator escape hatch; launch entitlement is cohort-key
 *   based and user-facing keys are managed outside this file.
 */
import { mkdir, writeFile, readFile, rename, unlink, chmod, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
// st_bc949e7c Phase 3.9: inlined normalizeKey — lib/encrypt.js deleted in
// belt consolidation. Validates that the key decodes to exactly 32 bytes
// (256-bit AES key). The encrypted-bundle decryption it once gated is gone;
// the key is now a subscription credential validated for shape only.
function normalizeKey(keyB64) {
  if (!keyB64 || typeof keyB64 !== 'string') throw new Error('normalizeKey: empty key');
  const buf = Buffer.from(keyB64, 'base64');
  if (buf.length !== 32) throw new Error(`normalizeKey: expected 32 bytes, got ${buf.length}`);
  return buf;
}
import { safeJsonParse } from './utils.js';

export const KEY_DIR = resolve(homedir(), '.robotdojo');
export const KEY_PATH = resolve(KEY_DIR, 'key');
export const META_PATH = resolve(KEY_DIR, 'key.meta.json');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

async function ensureDir() {
  await mkdir(KEY_DIR, { recursive: true, mode: DIR_MODE });
  // mkdir recursive ignores mode when dir exists; enforce explicitly.
  try { await chmod(KEY_DIR, DIR_MODE); } catch {}
}

async function atomicWrite(path, data, mode) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, data, { mode });
  try { await chmod(tmp, mode); } catch {}
  await rename(tmp, path);
}

async function readIfExists(path) {
  try {
    return await readFile(path);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Load the current key + metadata. Returns null if no key present.
 * Does NOT check expiry. Callers decide whether grace applies.
 */
export async function loadKey() {
  const [keyBuf, metaBuf] = await Promise.all([
    readIfExists(KEY_PATH),
    readIfExists(META_PATH),
  ]);
  if (!keyBuf) return null;

  const keyB64 = keyBuf.toString('utf8').trim();
  // Validate it decodes to 32 bytes.
  try { normalizeKey(keyB64); } catch { return null; }

  const meta = metaBuf ? safeJsonParse(metaBuf.toString('utf8'), {}) : {};

  return {
    key: keyB64,
    belt: meta.belt || 'black',
    issuedAt: meta.issued_at || null,
    modulesUrl: meta.modules_url || null,
    graceUntil: meta.grace_until || null,
    permanent: meta.permanent === true,
  };
}

/**
 * Save a new key + metadata. Atomic via tmp + rename.
 * Overwrites any existing key.
 *
 * Pass `permanent: true` to mark the key as never-expiring.
 */
export async function saveKey({ key, belt = 'black', modulesUrl = null, permanent = false, issuer = null }) {
  if (!key) throw new Error('saveKey: key required');
  // Validate before touching disk.
  normalizeKey(key);

  await ensureDir();

  const keyB64 = typeof key === 'string' ? key : Buffer.from(key).toString('base64');
  const meta = {
    belt,
    issued_at: new Date().toISOString(),
    modules_url: modulesUrl,
    grace_until: null,
  };
  if (permanent === true) meta.permanent = true;
  if (issuer) meta.issuer = issuer;

  await atomicWrite(KEY_PATH, keyB64, FILE_MODE);
  await atomicWrite(META_PATH, JSON.stringify(meta, null, 2), FILE_MODE);
  return meta;
}

/**
 * Update only the grace_until field on existing metadata. No-op if no key.
 *
 * Permanent keys ignore grace windows entirely — setting grace_until on a
 * permanent key is a no-op (we don't even write the file) so a stray
 * gateway revocation can't accidentally pin expiry on an operator key.
 */
export async function setGraceUntil(date) {
  await ensureDir();
  const metaBuf = await readIfExists(META_PATH);
  const meta = metaBuf ? safeJsonParse(metaBuf.toString('utf8'), {}) : {};
  if (meta.permanent === true) {
    console.info('[key-store] setGraceUntil: key is permanent — ignoring');
    return meta;
  }
  const iso = date instanceof Date ? date.toISOString()
    : typeof date === 'number' ? new Date(date).toISOString()
    : String(date);
  meta.grace_until = iso;
  await atomicWrite(META_PATH, JSON.stringify(meta, null, 2), FILE_MODE);
  return meta;
}

/**
 * Delete key + meta. Best-effort overwrite of the key file before unlink
 * so the raw bytes don't linger if the filesystem happens to reuse blocks.
 * (Not a cryptographic guarantee on copy-on-write FS, but cheap and sane.)
 */
export async function deleteKey() {
  try {
    const info = await stat(KEY_PATH);
    const junk = randomBytes(Math.max(info.size, 64));
    await writeFile(KEY_PATH, junk, { mode: FILE_MODE });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await Promise.all([
    unlink(KEY_PATH).catch(e => { if (e.code !== 'ENOENT') throw e; }),
    unlink(META_PATH).catch(e => { if (e.code !== 'ENOENT') throw e; }),
  ]);
}

/**
 * Pure predicate — is this key past its grace window?
 *
 *   - `permanent: true` ⇒ never expired (operator/dev keys).
 *   - No grace_until set ⇒ not expired.
 *   - grace_until in past ⇒ expired.
 */
export function isExpired(meta, now = Date.now()) {
  if (meta?.permanent === true) return false;
  if (!meta?.graceUntil) return false;
  const t = Date.parse(meta.graceUntil);
  if (Number.isNaN(t)) return false;
  return t <= now;
}

/**
 * Pure predicate — does this key carry the `permanent: true` flag?
 * Callers use this to skip daily-refresh / gateway-presence checks for
 * operator-minted keys.
 */
export function isPermanent(meta) {
  return meta?.permanent === true;
}
