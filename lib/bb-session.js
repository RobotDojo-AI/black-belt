/**
 * Server-assisted BB session key derivation.
 *
 * session_key = HKDF(BUNDLE_MASTER_KEY, info)
 *   info = 'robotdojo:bb:v1:' + emailHash + '|' + billingPeriodStart
 *
 * IKM is ROBOTDOJO_BUNDLE_MASTER_KEY_BLACK — a server-side env var that
 * never leaves the server. The derived key is unique per user per billing
 * period and can be re-derived at any time without storage.
 *
 * RFC 5869 §3.3: empty salt is correct when IKM is already a uniform
 * random 32-byte key (the key-splitting use case).
 *
 * hkdfSync returns ArrayBuffer — always wrap with Buffer.from().
 */
import { hkdfSync } from 'node:crypto';
import config from './config.js';

const INFO_PREFIX = 'robotdojo:bb:v1:';

/**
 * Derive a 32-byte session key for a subscriber.
 *
 * @param {string} emailHash   - users.email (HMAC of actual email)
 * @param {string} billingPeriodStart - ISO date string, e.g. '2026-04-01'
 * @param {string} [belt]      - 'black' (default 'black')
 * @returns {Buffer|null}      - 32-byte key, or null if master key not configured
 */
export function deriveSessionKey(emailHash, billingPeriodStart, belt = 'black') {
  const masterKeyB64 = config.bundleMasterKeyForBelt(belt);
  if (!masterKeyB64) {
    console.warn(`[bb-session] ROBOTDOJO_BUNDLE_MASTER_KEY_${belt.toUpperCase()} not set — cannot derive session key`);
    return null;
  }

  const ikm = Buffer.from(masterKeyB64, 'base64');
  if (ikm.length !== 32) {
    console.warn(`[bb-session] master key for ${belt} must be 32 bytes, got ${ikm.length}`);
    return null;
  }

  const info = Buffer.from(`${INFO_PREFIX}${emailHash}|${billingPeriodStart}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
}
