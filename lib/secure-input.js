/**
 * secure-input — credential capture that never lets the LLM or the chat
 * transcript see the value.
 *
 * Threat model
 *   Attacker A: a prompt-injection attempt trying to exfiltrate an API key
 *     from chat context. Defense: values never enter the LLM tool result.
 *     The tool returns `{stored: true, service}` only.
 *   Attacker B: someone with read access to conversation logs. Defense:
 *     we never log the value. All persistence is Keychain.
 *   Attacker C: a malicious request with a stolen requestId. Defense:
 *     requestId + session cookie must agree; requests expire after 2 min;
 *     requests are single-use.
 *
 * Keychain write pattern
 *   lib/keychain.js owns the macOS Keychain adapter. The value is passed as an
 *   argv element to a direct syscall path, so it is not subject to shell
 *   expansion, command-echo, or log-line capture.
 *
 *   Writes always use the canonical `robotdojo` account while reads can fall
 *   back across legacy accounts.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { platform } from 'node:os';

import db from './db.js';
import { keychainService, writeKeychainSecret } from './keychain.js';

// --- Constants --------------------------------------------------------------

const TTL_SECONDS = 120; // 2 minutes
const VALID_SERVICE_RE = /^[A-Z][A-Z0-9_]{1,63}$/; // uppercase snake, canonical Keychain style

// --- Prepared statements ----------------------------------------------------

const insertReq = db.prepare(`
  INSERT INTO secure_input_requests (id, session_id, service, label, purpose, expires_at)
  VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'))
`);

const selectReq = db.prepare(`
  SELECT id, session_id, service, label, purpose, created_at, expires_at,
         consumed_at, status
    FROM secure_input_requests
   WHERE id = ?
`);

const markConsumed = db.prepare(`
  UPDATE secure_input_requests
     SET status = 'submitted', consumed_at = datetime('now')
   WHERE id = ? AND status = 'pending'
`);

const markCancelled = db.prepare(`
  UPDATE secure_input_requests
     SET status = 'cancelled', consumed_at = datetime('now')
   WHERE id = ? AND status = 'pending'
`);

const markExpired = db.prepare(`
  UPDATE secure_input_requests
     SET status = 'expired'
   WHERE status = 'pending' AND expires_at < datetime('now')
`);

// --- Helpers ----------------------------------------------------------------

function newRequestId() {
  return randomBytes(32).toString('hex');
}

function timingSafeStringEq(a, b) {
  // Pad-to-equal-length pattern (st_d142f701 AC16) so length is never
  // revealed via a fast-return. Matches lib/auth.js#safeEqual semantics.
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  const max = Math.max(ab.length, bb.length, 1);
  const ap = Buffer.alloc(max);
  const bp = Buffer.alloc(max);
  ab.copy(ap);
  bb.copy(bp);
  return timingSafeEqual(ap, bp) && ab.length === bb.length;
}

/**
 * Timing-safe state-string equality wrapper.
 *
 * st_d142f701 AC16: callers replaced plain `row.status !== 'pending'`
 * checks with `!safeStatusEqual(row.status, 'pending')` so the comparison
 * uses the same constant-time predicate as session and Bearer checks.
 * State strings are not secret material, but using one comparison primitive
 * across every authz-adjacent equality keeps the audit surface flat.
 */
export function safeStatusEqual(a, b) {
  return timingSafeStringEq(a, b);
}

function assertValidService(service) {
  if (typeof service !== 'string' || !VALID_SERVICE_RE.test(service)) {
    const err = new Error('invalid service name');
    err.code = 'invalid_service';
    throw err;
  }
}

function keychainServiceName(service) {
  return keychainService(service);
}

/**
 * Write `value` to the login keychain under `robotdojo-<service>`. Platform-
 * specific: requires macOS. Returns `{ok:true}` on success or throws.
 *
 * Value is passed via argv by lib/keychain.js; never via stdin, never via env,
 * never interpolated into a shell string.
 */
export function writeToKeychain(service, value) {
  if (platform() !== 'darwin') {
    const err = new Error('secure_input requires macOS Keychain');
    err.code = 'unsupported_platform';
    throw err;
  }

  return new Promise((resolve, reject) => {
    const ok = writeKeychainSecret(keychainServiceName(service), value);
    if (ok) resolve({ ok: true });
    else {
      const err = new Error('Keychain write failed');
      err.code = 'keychain_write_failed';
      reject(err);
    }
  });
}

// --- Public API -------------------------------------------------------------

/**
 * Create a request. Returns `{requestId, expiresAt}`.
 * Caller is trusted — do not expose this to the public Internet; it is
 * intended to be called by an authenticated chat tool handler.
 */
export function createRequest({ sessionId, service, label, purpose = null }) {
  if (!sessionId) throw new Error('sessionId required');
  if (!label) throw new Error('label required');
  assertValidService(service);

  // Sweep expired before we hand out a new id so background state stays
  // tidy even without a separate cron.
  markExpired.run();

  const id = newRequestId();
  insertReq.run(id, sessionId, service, label, purpose, TTL_SECONDS);
  const row = selectReq.get(id);
  return { requestId: id, expiresAt: row.expires_at };
}

/**
 * Look up a request (metadata only, never a value — we don't store one).
 */
export function getRequest(requestId) {
  const row = selectReq.get(requestId);
  if (!row) return null;
  // Refresh expired status on read.
  if (row.status === 'pending' && new Date(row.expires_at + 'Z') < new Date()) {
    markExpired.run();
    return { ...row, status: 'expired' };
  }
  return row;
}

/**
 * Submit the value for a pending request. Writes to Keychain, marks the
 * row consumed. Returns `{success: true}` — NEVER returns the value.
 *
 * @param {object} args
 * @param {string} args.requestId
 * @param {string} args.value
 * @param {string} args.sessionId  must match the request's session (bound at creation)
 */
export async function submitValue({ requestId, value, sessionId }) {
  const row = selectReq.get(requestId);
  if (!row) {
    const err = new Error('request not found');
    err.code = 'not_found';
    throw err;
  }

  if (!timingSafeStringEq(row.session_id, sessionId)) {
    const err = new Error('session mismatch');
    err.code = 'forbidden';
    throw err;
  }

  // AC16: timing-safe status comparison
  if (!safeStatusEqual(row.status, 'pending')) {
    const err = new Error(`request ${row.status}`);
    err.code = row.status;
    throw err;
  }

  if (new Date(row.expires_at + 'Z') < new Date()) {
    markExpired.run();
    const err = new Error('request expired');
    err.code = 'expired';
    throw err;
  }

  if (typeof value !== 'string' || !value.length) {
    const err = new Error('value required');
    err.code = 'invalid_value';
    throw err;
  }

  await writeToKeychain(row.service, value);

  const result = markConsumed.run(requestId);
  if (result.changes === 0) {
    // Race — someone else marked the row in between our check and update.
    const err = new Error('already consumed');
    err.code = 'already_consumed';
    throw err;
  }

  return { success: true };
}

/**
 * Cancel a pending request. Idempotent — cancelling a consumed request
 * is a no-op returning `{cancelled:false}`.
 */
export function cancelRequest({ requestId, sessionId }) {
  const row = selectReq.get(requestId);
  if (!row) return { cancelled: false, reason: 'not_found' };
  if (!timingSafeStringEq(row.session_id, sessionId)) {
    return { cancelled: false, reason: 'forbidden' };
  }
  // AC16: timing-safe status comparison
  if (!safeStatusEqual(row.status, 'pending')) return { cancelled: false, reason: row.status };
  const r = markCancelled.run(requestId);
  return { cancelled: r.changes > 0 };
}

/**
 * Sweep expired rows. Call from a scheduler or before lookups.
 */
export function expireStale() {
  return markExpired.run().changes;
}

// --- Internal await-helper for the chat tool handler ------------------------

/**
 * Poll until the request resolves (submitted / cancelled / expired).
 * Returns the final row's status. Times out one tick past `expires_at`.
 */
export async function waitForResolution(requestId, { pollMs = 500 } = {}) {
  const first = selectReq.get(requestId);
  if (!first) return { status: 'not_found' };
  const deadline = new Date(first.expires_at + 'Z').getTime() + 1000;

  while (Date.now() < deadline) {
    const row = selectReq.get(requestId);
    if (!row) return { status: 'not_found' };
    if (row.status !== 'pending') return { status: row.status };
    await new Promise(r => setTimeout(r, pollMs));
  }

  markExpired.run();
  return { status: 'expired' };
}

export const TTL_MS = TTL_SECONDS * 1000;
