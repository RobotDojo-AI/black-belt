/**
 * lib/neon/edge-auth.js — Shared crypto + Neon helpers for Vercel Edge auth functions.
 *
 * MUST run on Vercel Edge Runtime (V8 isolate). Zero Node.js built-ins.
 * Web Crypto API (crypto.subtle) only. No crypto.createHmac, no crypto.createHash.
 *
 * Exports:
 *   hashEmail(email, secret)           → hex string (HMAC-SHA256 of normalized email)
 *   generateCode()                     → 6-digit zero-padded string
 *   signPayload(payloadB64, secret)    → base64url HMAC
 *   buildCookiePayload(data)           → base64url-encoded JSON
 *   buildCookie(data, secret)          → "payload_b64.hmac_b64"
 *   neonQuery(connectionString, query, params) → {rows, rowCount}
 *   cookieHeader(value, maxAgeSeconds) → Set-Cookie header string
 */

const NEON_HOST = 'ep-polished-math-a4p01zbw-pooler.us-east-1.aws.neon.tech';

// ─── Encoding helpers ──────────────────────────────────────────────────────

const enc = new TextEncoder();

function toBase64url(bytes) {
  // bytes: Uint8Array → base64url string
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Hash email ───────────────────────────────────────────────────────────

/**
 * Hash email for storage: HMAC-SHA256(normalized_email, SESSION_SECRET) → hex string.
 * Normalized: trimmed + lowercased. HMAC (not plain SHA-256) so the hash is
 * not reversible without the secret — protects hashed emails at rest.
 */
export async function hashEmail(email, secret) {
  const normalized = email.trim().toLowerCase();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(normalized));
  return toHex(new Uint8Array(sig));
}

// ─── Generate 6-digit code ────────────────────────────────────────────────

/**
 * Generate a 6-digit numeric code, zero-padded.
 * Uses crypto.getRandomValues for cryptographic quality.
 */
export function generateCode() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  // Map to [0, 999999]
  return String(arr[0] % 1_000_000).padStart(6, '0');
}

// ─── Cookie payload helpers ───────────────────────────────────────────────

/**
 * Encode cookie payload as base64url JSON.
 * payload = JSON.stringify({sessionId, userId, slug, belt, expiresAt})
 */
export function buildCookiePayload(data) {
  const json = JSON.stringify(data);
  return toBase64url(enc.encode(json));
}

/**
 * HMAC-SHA256(payload_base64url, SESSION_SECRET) → base64url string.
 */
export async function signPayload(payloadB64, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  return toBase64url(new Uint8Array(sig));
}

/**
 * Build the full cookie value: payload_b64.hmac_b64
 */
export async function buildCookie(data, secret) {
  const payloadB64 = buildCookiePayload(data);
  const hmac = await signPayload(payloadB64, secret);
  return `${payloadB64}.${hmac}`;
}

// ─── Neon query helper ────────────────────────────────────────────────────

/**
 * Execute a SQL query via the Neon HTTP API.
 * Throws on HTTP error. Returns the parsed JSON response.
 */
export async function neonQuery(connectionString, query, params = []) {
  const res = await fetch(`https://${NEON_HOST}/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': connectionString,
    },
    body: JSON.stringify({ query, params }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`neon ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Cookie header builder ────────────────────────────────────────────────

/**
 * Build a Set-Cookie header string for the session cookie.
 * Domain=.robotdojo.ai so it covers apex + all subdomains.
 */
export function cookieHeader(value, maxAgeSeconds = 60 * 60 * 24 * 30) {
  return [
    `rdj_session=${value}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    'Domain=.robotdojo.ai',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}
