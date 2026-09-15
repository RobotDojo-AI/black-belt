/**
 * Device registry — opaque relay routing credentials.
 *
 * This stores no user content, app sessions, chat history, imports, memory, or
 * local database state. It stores only the minimum needed for the blind relay:
 * a device slug and a SHA-256 hash of that device's tunnel secret.
 *
 * NO OWNER IDENTITY (st_63b59bda AC-5). The relay used to keep an owner address
 * alongside each slug for conflict messages and a never-shipped "connect as a
 * known owner" lookup. Connecting only needs a slug and a token, so that owner
 * field is gone: the device secret hash is the sole credential and the sole
 * conflict key. A slug already claimed by a DIFFERENT secret hash is taken; the
 * same secret hash re-registering is an idempotent no-op (reinstall / restart).
 *
 * The device secret also gates release: a slug can only be given up by the
 * device that can present the secret whose hash claimed it (registerDevice
 * claims, releaseDevice gives up — no bootstrap secret, no owner identity).
 *
 * Redis keys:
 *   gw:device:<slug> → JSON { secretHash, claimedAt }
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Redis from 'ioredis';

const PREFIX_D = 'gw:device:';

const bySlug = new Map();

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      connectTimeout: 3000,
      retryStrategy: (t) => t > 3 ? null : Math.min(t * 200, 2000),
      enableOfflineQueue: false,
    })
  : null;

if (redis) redis.on('error', (e) => console.error('[device-registry] redis:', e.message));

// Durable persistence for the single-VPS (no-Redis) deployment (st_63b59bda
// hardening). The registry holds only slug → SHA-256(secret) — no user content,
// no raw secrets — so persisting it to a local JSON file is safe and is what
// makes per-device identity survive a relay restart. Without this the map is
// in-memory only: every restart wipes all registrations, breaking per-device
// auth (provision-cert, release, renewal) until each device re-registers and
// forcing reliance on a single shared fallback secret that undoes the per-user
// security model. When REDIS_URL is set, Redis is the store and this file layer
// is a no-op. Written atomically (temp + rename) so a crash mid-write can't
// corrupt the state.
const STATE_FILE = process.env.GATEWAY_STATE_FILE || null;

function persistState() {
  if (!STATE_FILE || redis) return;
  try {
    const obj = {};
    for (const [slug, row] of bySlug) obj[slug] = row;
    const tmp = `${STATE_FILE}.tmp`;
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[device-registry] persist:', e.message);
  }
}

function loadState() {
  if (!STATE_FILE || redis) return;
  try {
    const obj = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    for (const [slug, row] of Object.entries(obj)) {
      if (row?.secretHash) bySlug.set(slug, row);
    }
    console.info(`[device-registry] loaded ${bySlug.size} device(s) from ${STATE_FILE}`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[device-registry] load:', e.message);
  }
}

loadState();

function hashSecret(secret) {
  return createHash('sha256').update(String(secret || ''), 'utf8').digest('hex');
}

function safeEqualHex(a, b) {
  const ab = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

async function redisGet(key) {
  if (!redis) return null;
  try {
    const v = await redis.get(key);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}

async function redisSet(key, val) {
  if (!redis) return;
  try { await redis.set(key, JSON.stringify(val)); }
  catch (e) { console.error('[device-registry] set:', e.message); }
}

async function redisDel(key) {
  if (!redis) return;
  try { await redis.del(key); }
  catch (e) { console.error('[device-registry] del:', e.message); }
}

/**
 * Claim (or re-claim) a slug for the device that owns `deviceSecret`.
 *
 * @param {string} slug
 * @param {string} deviceSecret  — the raw tunnel secret; only its hash is stored
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 *   `taken` when the slug is already claimed by a different secret hash.
 */
export async function registerDevice(slug, deviceSecret) {
  if (!slug || !deviceSecret) return { ok: false, reason: 'missing_fields' };

  const secretHash = hashSecret(deviceSecret);
  const existing = bySlug.get(slug) || await redisGet(PREFIX_D + slug);
  if (existing?.secretHash && !safeEqualHex(existing.secretHash, secretHash)) {
    return { ok: false, reason: 'taken' };
  }

  const row = { secretHash, claimedAt: Date.now() };
  bySlug.set(slug, row);
  await redisSet(PREFIX_D + slug, row);
  persistState();
  return { ok: true };
}

/**
 * Release a slug. Only the device that owns it — proven by presenting the raw
 * secret whose SHA-256 hash claimed the slug — may remove the entry. There is
 * no bootstrap secret and no owner identity in this path; the device secret is
 * the sole proof of ownership.
 *
 * @param {string} slug
 * @param {string} deviceSecret  — the raw tunnel secret; its hash must match the stored one
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'not_found' | 'forbidden' }>}
 *   `not_found` when no device holds the slug; `forbidden` when the presented
 *   secret does not match the hash that claimed it.
 */
export async function releaseDevice(slug, deviceSecret) {
  if (!slug || !deviceSecret) return { ok: false, reason: 'not_found' };
  const row = bySlug.get(slug) || await redisGet(PREFIX_D + slug);
  if (!row?.secretHash) return { ok: false, reason: 'not_found' };
  if (!safeEqualHex(row.secretHash, hashSecret(deviceSecret))) {
    return { ok: false, reason: 'forbidden' };
  }
  bySlug.delete(slug);
  await redisDel(PREFIX_D + slug);
  persistState();
  return { ok: true };
}

export function validateBootstrapProof(proof, bootstrapSecret) {
  if (!bootstrapSecret) return { ok: false, reason: 'bootstrap_not_configured' };
  if (!proof) return { ok: false, reason: 'bootstrap_required' };
  if (!safeEqualHex(hashSecret(proof), hashSecret(bootstrapSecret))) {
    return { ok: false, reason: 'bootstrap_invalid' };
  }
  return { ok: true };
}

export async function validateDevice(slug, deviceSecret) {
  if (!slug || !deviceSecret) return { ok: false, reason: 'missing_fields' };
  const row = bySlug.get(slug) || await redisGet(PREFIX_D + slug);
  if (!row?.secretHash) return { ok: false, reason: 'not_registered' };
  if (!safeEqualHex(row.secretHash, hashSecret(deviceSecret))) {
    return { ok: false, reason: 'unauthorized' };
  }
  return { ok: true };
}

export function size() {
  return bySlug.size;
}

export function clear() {
  bySlug.clear();
}
