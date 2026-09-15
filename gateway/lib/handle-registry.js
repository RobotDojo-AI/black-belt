/**
 * Handle registry — email ↔ handle ↔ uuid uniqueness for the relay namespace.
 *
 * Unlike slug-registry (in-memory only), this is Redis-backed with in-memory
 * fallback. Handles are permanent until explicitly released, so no TTL.
 *
 * Redis keys:
 *   gw:handle:<h>  → JSON { uuid, email, claimedAt }
 *   gw:email:<e>   → JSON { handle, uuid }
 *   gw:uuid:<u>    → JSON { handle, email }
 *
 * Claim semantics: first-write-wins by email.
 *   - Same email re-claiming their own handle: idempotent (ok: true).
 *   - Different email trying to claim a taken handle: { ok: false, reason: 'taken' }.
 *
 * Lazy Redis population: on startup we don't pre-load. First access checks
 * in-memory, then Redis. This mirrors session-registry.js design.
 */

import Redis from 'ioredis';

const PREFIX_H = 'gw:handle:';
const PREFIX_E = 'gw:email:';
const PREFIX_U = 'gw:uuid:';

const byHandle = new Map();
const byEmail = new Map();
const byUuid = new Map();

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      connectTimeout: 3000,
      retryStrategy: (t) => t > 3 ? null : Math.min(t * 200, 2000),
      enableOfflineQueue: false,
    })
  : null;

if (redis) redis.on('error', (e) => console.error('[handle-registry] redis:', e.message));

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
  catch (e) { console.error('[handle-registry] set:', e.message); }
}

async function redisDel(...keys) {
  if (!redis) return;
  try { await redis.del(...keys); } catch {}
}

/**
 * Claim a handle for an email + uuid. Idempotent for same email. Rejects if
 * a different email already owns the handle.
 *
 * @returns { ok: true } on success
 * @returns { ok: false, reason: 'taken', takenBy: email } on conflict
 */
export async function claim(handle, email, uuid) {
  if (!handle || !email) return { ok: false, reason: 'missing_fields' };
  // Check in-memory first, then Redis
  const existing = byHandle.get(handle) || await redisGet(PREFIX_H + handle);
  if (existing) {
    if (existing.email === email) return { ok: true }; // idempotent re-claim
    return { ok: false, reason: 'taken', takenBy: existing.email };
  }
  const row = { uuid, email, claimedAt: Date.now() };
  byHandle.set(handle, row);
  byEmail.set(email, { handle, uuid });
  byUuid.set(uuid, { handle, email });
  await Promise.all([
    redisSet(PREFIX_H + handle, row),
    redisSet(PREFIX_E + email, { handle, uuid }),
    redisSet(PREFIX_U + uuid, { handle, email }),
  ]);
  return { ok: true };
}

/**
 * Release a handle. Only the owning email can release.
 *
 * @returns { ok: true } on success (or already absent)
 * @returns { ok: false, reason: 'not_owner' } if wrong email
 */
export async function release(handle, email) {
  const existing = byHandle.get(handle) || await redisGet(PREFIX_H + handle);
  if (!existing) return { ok: true }; // already gone
  if (existing.email !== email) return { ok: false, reason: 'not_owner' };
  byHandle.delete(handle);
  byEmail.delete(email);
  if (existing.uuid) byUuid.delete(existing.uuid);
  await redisDel(
    PREFIX_H + handle,
    PREFIX_E + email,
    ...(existing.uuid ? [PREFIX_U + existing.uuid] : []),
  );
  return { ok: true };
}

/**
 * Look up a handle record. Returns { uuid, email, claimedAt } or null.
 */
export async function getByHandle(handle) {
  return byHandle.get(handle) || await redisGet(PREFIX_H + handle);
}

/**
 * Look up by UUID. Returns { handle, email } or null.
 */
export async function getByUuid(uuid) {
  return byUuid.get(uuid) || await redisGet(PREFIX_U + uuid);
}

/**
 * Resolve an email to its handle + uuid. Returns { handle, uuid } or null.
 */
export async function resolveEmail(email) {
  return byEmail.get(email) || await redisGet(PREFIX_E + email);
}

/**
 * Return the email that owns this handle, or null.
 */
export async function ownerOf(handle) {
  const row = await getByHandle(handle);
  return row ? row.email : null;
}

export function size() {
  return byHandle.size;
}

/** For testing: clear in-memory maps (does NOT clear Redis). */
export function clear() {
  byHandle.clear();
  byEmail.clear();
  byUuid.clear();
}

// Namespace export for done-criteria checks and gateway index.js
export const handleRegistry = { claim, release, getByHandle, getByUuid, resolveEmail, ownerOf, size, clear };
export function handlesSize() { return size(); }
