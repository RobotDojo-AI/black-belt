/**
 * ECDSA P-256 (ES256) JWT verifier for cohort entitlement.
 *
 * Format: base64url(header).base64url(payload).base64url(signature)
 *   header  = {"alg":"ES256","typ":"JWT"}
 *   payload = {"week":"YYYY-Www","exp":unix_seconds}
 *   sig     = ECDSA-SHA256 over `${header}.${payload}` using lib/cohort/cohort-priv.pem
 *
 * Verification uses node's built-in crypto — no JWT library needed.
 * The public key is embedded at lib/cohort/public-key.pem and read once.
 *
 * st_5a63545d AC 17.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVerify, createPublicKey } from 'node:crypto';

const _DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_KEY_PATH = resolve(_DIR, 'public-key.pem');

let _pubKey = null;
function loadPubKey() {
  if (_pubKey) return _pubKey;
  const pem = readFileSync(PUBLIC_KEY_PATH, 'utf8');
  _pubKey = createPublicKey(pem);
  return _pubKey;
}

/**
 * ECDSA signatures from `openssl dgst -sign` are emitted in DER form.
 * JWT ES256 expects a raw 64-byte r||s concatenation. The decode below
 * accepts EITHER form — if the signature looks like a DER SEQUENCE we use
 * it verbatim with createVerify; if it's 64 raw bytes we wrap it as DER
 * before passing to createVerify.
 */
function rawToDerEcdsa(raw) {
  if (raw.length !== 64) return raw; // already DER
  const r = raw.slice(0, 32);
  const s = raw.slice(32, 64);
  function trim(buf) {
    let i = 0;
    while (i < buf.length - 1 && buf[i] === 0) i++;
    let out = buf.slice(i);
    // Prepend 0x00 if high bit set so it parses as positive integer.
    if (out[0] & 0x80) out = Buffer.concat([Buffer.from([0x00]), out]);
    return out;
  }
  const rTrim = trim(r);
  const sTrim = trim(s);
  const seqLen = 2 + rTrim.length + 2 + sTrim.length;
  return Buffer.concat([
    Buffer.from([0x30, seqLen]),
    Buffer.from([0x02, rTrim.length]), rTrim,
    Buffer.from([0x02, sTrim.length]), sTrim,
  ]);
}

/**
 * Verify a JWT against the embedded public key.
 * Returns { valid: boolean, payload?: object, reason?: string }.
 *
 * WHY return shape (not throw): callers chain into isBBActive() which
 * needs to distinguish "expired" from "bad sig" without try/catch noise.
 */
export function verifyJwt(jwt) {
  if (!jwt || typeof jwt !== 'string') return { valid: false, reason: 'no_jwt' };
  const parts = jwt.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'bad_json' };
  }
  if (header.alg !== 'ES256') return { valid: false, reason: 'bad_alg' };

  let sig;
  try { sig = Buffer.from(sigB64, 'base64url'); }
  catch { return { valid: false, reason: 'bad_sig_format' }; }

  const signingInput = `${headerB64}.${payloadB64}`;
  let pubKey;
  try { pubKey = loadPubKey(); }
  catch (err) { return { valid: false, reason: 'no_pubkey', error: err.message }; }

  const v = createVerify('SHA256');
  v.update(signingInput);
  v.end();
  const ok = v.verify(pubKey, rawToDerEcdsa(sig));
  if (!ok) return { valid: false, reason: 'sig_mismatch' };
  return { valid: true, payload };
}
