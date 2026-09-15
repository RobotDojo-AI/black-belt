/**
 * Cohort revocation list — fetched hourly from
 * https://robotdojo.ai/api/bb-revocation.json, verified against the embedded
 * public key, cached to ~/.robotdojo/cohort-revocation.json.
 *
 * Cache shape:
 *   {
 *     revoked: ["2026-W01", ...],          // signed by the build server
 *     generated_at: ISO8601,                // server timestamp on response
 *     sig: base64-encoded signature,        // ECDSA over JSON.stringify({revoked, generated_at})
 *     last_successful_poll_at: ISO8601,     // local clock, updated only on verified success
 *     last_failed_poll_at: ISO8601 | null,  // local clock, updated only on attempted-but-failed poll
 *   }
 *
 * The two timestamps are how isBBActive() distinguishes a machine that
 * was asleep (no recent failed polls) from one whose network is broken
 * (last_failed_poll_at - last_successful_poll_at > 48h grace).
 *
 * st_5a63545d AC 18, AC 19.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createVerify } from 'node:crypto';
import { readFileSync as fsRead } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicKey } from 'node:crypto';

const _DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_KEY_PATH = resolve(_DIR, 'public-key.pem');
// CACHE_PATH defaults to ~/.robotdojo/cohort-revocation.json. Env override
// exists for test isolation — each test file may point at its own tmp file
// so concurrent test runs don't share state through this on-disk cache.
const CACHE_PATH = process.env.ROBOTDOJO_COHORT_CACHE_PATH ||
  resolve(homedir(), '.robotdojo', 'cohort-revocation.json');
const REVOCATION_URL = process.env.ROBOTDOJO_REVOCATION_URL || 'https://robotdojo.ai/api/bb-revocation.json';

let _pubKey = null;
function loadPubKey() {
  if (_pubKey) return _pubKey;
  _pubKey = createPublicKey(fsRead(PUBLIC_KEY_PATH, 'utf8'));
  return _pubKey;
}

/**
 * Read the cached revocation list. Returns the parsed cache object or
 * `null` if the file is missing/unreadable/corrupt. Never throws.
 */
export function readRevocationCache() {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(obj) {
  const dir = dirname(CACHE_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * Get the current list of revoked cohort weeks. Returns the array from
 * the cache or [] when the cache is missing.
 */
export function getRevokedWeeks() {
  const c = readRevocationCache();
  return Array.isArray(c?.revoked) ? c.revoked : [];
}

/**
 * Verify the revocation document signature against the embedded public key.
 * Signature is over `JSON.stringify({revoked, generated_at})` — fields in
 * insertion order. Returns true iff signature verifies.
 */
function verifyDoc({ revoked, generated_at, sig }) {
  if (!Array.isArray(revoked) || !generated_at || typeof sig !== 'string') return false;
  try {
    const payload = JSON.stringify({ revoked, generated_at });
    const v = createVerify('SHA256');
    v.update(payload);
    v.end();
    return v.verify(loadPubKey(), Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Poll the revocation endpoint, verify the signature, and update the cache
 * on success. Touches `last_failed_poll_at` (only) on any failure so the
 * 48h-grace machinery can distinguish asleep-machine from broken-network.
 *
 * Returns { ok: boolean, reason?: string, weeks?: string[] }.
 *
 * Network and parse errors are NOT thrown — the function is called by a
 * launchd timer that must never crash on transient outages.
 */
export async function pollRevocation() {
  let res;
  try {
    res = await fetch(REVOCATION_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    touchFailedPoll();
    return { ok: false, reason: `network: ${err.message}` };
  }
  if (!res.ok) {
    touchFailedPoll();
    return { ok: false, reason: `http ${res.status}` };
  }
  let body;
  try { body = await res.json(); }
  catch (err) { touchFailedPoll(); return { ok: false, reason: `parse: ${err.message}` }; }

  if (!verifyDoc(body)) {
    touchFailedPoll();
    return { ok: false, reason: 'sig_mismatch' };
  }

  const existing = readRevocationCache() || {};
  const next = {
    ...existing,
    revoked: body.revoked,
    generated_at: body.generated_at,
    sig: body.sig,
    last_successful_poll_at: new Date().toISOString(),
    last_failed_poll_at: null,
  };
  try { writeCache(next); }
  catch (err) { return { ok: false, reason: `write: ${err.message}` }; }
  return { ok: true, weeks: body.revoked };
}

function touchFailedPoll() {
  const existing = readRevocationCache() || {};
  try {
    writeCache({ ...existing, last_failed_poll_at: new Date().toISOString() });
  } catch {
    /* best-effort */
  }
}
