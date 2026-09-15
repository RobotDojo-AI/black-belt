/**
 * OAuth state param encoder/decoder.
 *
 * The OAuth `state` param is the only OAuth-spec mechanism for carrying
 * caller context across the redirect. We use it to (a) prove the callback
 * came from a flow this server initiated (CSRF prevention) and (b) carry
 * the wizard stage so the callback handler can advance onboarding_stage
 * server-side instead of relying on frontend polling.
 *
 * Format: `${base64url(JSON.stringify(payload))}.${hmacSha256(payload, secret)}`
 *
 * Payload shape: { stage: number, nonce: string }
 *   - stage: the current wizard stage (1..6); callback will advance to stage+1
 *   - nonce: 16-byte random hex, single-use anti-replay
 *
 * Verification: HMAC-SHA256 with SESSION_SECRET in constant time.
 *
 * st_5a63545d AC 7.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Encode a state payload as `base64url(payload).hmac`.
 * Secret is passed explicitly — caller is responsible for sourcing it.
 */
export function encode(payload, secret) {
  if (!secret) throw new Error('encode: secret required');
  if (!payload || typeof payload !== 'object') {
    throw new Error('encode: payload object required');
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${hmac}`;
}

/**
 * Decode + verify a state string. Returns the payload object on success;
 * throws on any failure (bad format, HMAC mismatch, JSON parse error).
 * WHY throw vs return null: callers cleanly route to a 4xx response on
 * any error path; null would require ambiguous `if (!decoded)` checks.
 */
export function decode(state, secret) {
  if (!state || typeof state !== 'string') {
    throw new Error('decode: state string required');
  }
  if (!secret) throw new Error('decode: secret required');
  const dot = state.lastIndexOf('.');
  if (dot <= 0) throw new Error('decode: missing separator');

  const payloadB64 = state.slice(0, dot);
  const providedHmac = state.slice(dot + 1);
  if (!payloadB64 || !providedHmac) throw new Error('decode: empty segments');

  const expectedHmac = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  // Constant-time compare on equal-length buffers; mismatched lengths
  // short-circuit cheaply without leaking via the timingSafeEqual call.
  const a = Buffer.from(providedHmac, 'utf8');
  const b = Buffer.from(expectedHmac, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('decode: HMAC mismatch');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('decode: bad JSON');
  }
  return payload;
}

/**
 * Convenience: build a stage-aware state with a fresh nonce.
 */
export function buildSetupState(stage, secret) {
  return encode({ stage, nonce: randomBytes(16).toString('hex') }, secret);
}
