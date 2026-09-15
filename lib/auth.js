/**
 * Authentication middleware — Bearer token validation.
 * Token comes from macOS Keychain (ROBOTDOJO_AUTH_TOKEN; legacy
 * MIYAGI_AUTH_TOKEN still read for back-compat on existing installs).
 */
import crypto from 'node:crypto';
import config from './config.js';

// Constant-time string compare.
//
// st_d142f701 AC16: removed the early length-mismatch fast-path that
// short-circuited before timingSafeEqual. The early return revealed
// whether the two buffers had matching lengths before timingSafeEqual
// ran — a length-timing leak in the strict
// cryptographic sense, even though not practically exploitable against a
// 32-byte hex token.
//
// New implementation:
//   1. Reject non-string inputs.
//   2. Pad both buffers to max(ab.length, bb.length) with zeros via
//      Buffer.alloc + copy.
//   3. timingSafeEqual on the padded buffers.
//   4. AND with `(ab.length === bb.length)` so a real length mismatch
//      still returns false even when the padded bytes happen to match.
//
// Correctness:
//   - Same-content, same-length tokens → buffers identical → returns true.
//   - Different-content, same-length tokens → timingSafeEqual returns false.
//   - Different-length tokens → length check forces false even if the
//     padded comparison would have returned true on a token whose bytes
//     happen to be all-zero (legitimate tokens cannot be all-zero — they
//     are 32 random hex bytes).
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const max = Math.max(ab.length, bb.length, 1);
  const ap = Buffer.alloc(max);
  const bp = Buffer.alloc(max);
  ab.copy(ap);
  bb.copy(bp);
  const equalContent = crypto.timingSafeEqual(ap, bp);
  // Length comparison is intentionally last and ANDed: timingSafeEqual
  // always runs first, on equal-size buffers, so its execution time
  // reveals nothing about either input length.
  return equalContent && ab.length === bb.length;
}

/**
 * Hono middleware: validates Bearer token on /api/* routes.
 * Splash page and static assets are public.
 */
export function requireAuth() {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Authorization required' }, 401);
    }
    const token = authHeader.slice(7);
    if (!config.authToken || !safeEqual(token, config.authToken)) {
      return c.json({ error: 'Invalid token' }, 403);
    }
    if (typeof c.set === 'function') {
      c.set('session', { id: 'bearer', belt_override: null });
    }
    await next();
  };
}

/**
 * Validate a token string directly (for WebSocket or SSE auth).
 */
export function validateToken(token) {
  return !!config.authToken && safeEqual(token, config.authToken);
}

// Mint a new pasted bearer access token. Single source of truth for the
// token shape (st_96bb626f AC16): the `rdj-` prefix plus 24 random bytes of
// base64url entropy. Every JS mint site — the server-boot self-heal
// (index.js), the token CLI (scripts/token.js), and the Account rotate action
// (routes/accounts.js) — routes through this one function so the prefix cannot
// drift across sites. install.sh mints its own (bash/openssl, before Node is
// relied on) and lib/key-issuance.js is the separate hashed-key credential
// path. The prefix is auth-transparent: validateToken() exact-matches the full
// string, so the stored value equals the pasted value regardless of prefix.
export function mintAuthToken() {
  return `rdj-${crypto.randomBytes(24).toString('base64url')}`;
}
