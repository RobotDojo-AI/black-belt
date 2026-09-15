// lib/relay-client.js — HTTP helper for relay control-plane calls.
//
// Wraps fetch with auth, timeout, and JSON parse. Used by device-rename.js
// (handle claims) and routes/identity.js (slug prepare/confirm flow).

import config from './config.js';

/**
 * Send an authenticated JSON request to the relay internal API.
 * Returns { ok, status, data?, error?, takenBy? }.
 * Never throws — all errors are returned in the result object.
 */
export async function callRelay(path, method, body) {
  const url = new URL(path, config.gatewayUrl).toString();
  const secret = config.gatewayInternalSecret;
  if (!secret) return { ok: false, status: 0, error: 'GATEWAY_INTERNAL_SECRET not configured' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, status: res.status, error: data.reason || data.error || res.statusText, takenBy: data.takenBy };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Claim a device slug at the relay (two-step device rename — prepare step).
 *
 * st_63b59bda AC-5: the slug is claimed on the device-secret-keyed
 * /api/register-device endpoint — the same path a fresh install uses — with NO
 * email. Re-claiming the caller's own slug is idempotent; a slug held by a
 * DIFFERENT device secret comes back 409 (routes/identity maps that to
 * slug_taken). Returns { ok, status, error?, takenBy? }.
 */
export async function claimSlugAtRelay(slug) {
  return registerDeviceAtRelay({ slug, deviceSecret: config.deviceSecret });
}

/**
 * Release a device slug at the relay (device rename — confirm step). Best-effort:
 * failures are non-fatal, a stranded slug is reclaimed by its next registration.
 *
 * st_63b59bda AC-5: authenticated by the device secret in the body (proving this
 * Mac owns the slug), not the internal secret and not an email.
 */
export async function releaseSlugAtRelay(slug) {
  const deviceSecret = config.deviceSecret;
  if (!deviceSecret) return { ok: false, status: 0, error: 'ROBOTDOJO_DEVICE_SECRET not configured' };
  const url = new URL('/api/release-device', config.gatewayUrl).toString();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, deviceSecret }),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: data.reason || data.error || res.statusText };
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Public bootstrap registration for the blind SNI relay.
 *
 * st_63b59bda AC-5: sends only the slug and the per-device tunnel secret — no
 * owner email, ever. It does not send local data, app sessions, chats, imports,
 * memories, RAG, API keys, or database content.
 */
export async function registerDeviceAtRelay({ slug, deviceSecret, gatewayUrl = config.gatewayUrl }) {
  const url = new URL('/api/register-device', gatewayUrl).toString();
  const bootstrapSecret = config.relayBootstrapSecret;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  if (!bootstrapSecret) {
    return { ok: false, status: 0, error: 'ROBOTDOJO_RELAY_BOOTSTRAP_SECRET not configured' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-robotdojo-bootstrap': bootstrapSecret,
      },
      body: JSON.stringify({ slug, deviceSecret }),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, error: data.reason || data.error || res.statusText, takenBy: data.takenBy };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}
