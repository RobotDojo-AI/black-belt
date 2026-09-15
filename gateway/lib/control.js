/**
 * Control plane — pushes subscription events to the user's tunnel agent.
 *
 * The robotdojo.ai backend calls POST /internal/push-key when Stripe/USDC
 * confirms payment, and POST /internal/revoke-key on cancellation. We look
 * up the user's live WebSocket and send a control event. If the agent is
 * offline it will receive the state on its next reconnect — the backend is
 * the source of truth, not us.
 */
import { getByEmail } from './ws-registry.js';

/**
 * WHY bundle: per-user ciphertext — each subscriber receives a bundle
 * uniquely encrypted with their key. A leaked key exposes only that user's
 * copy; the master key never leaves the billing backend.
 */
export function pushKey(email, key, modulesUrl, bundle) {
  const conn = getByEmail(email);
  if (!conn) return { delivered: false, reason: 'offline' };
  const ok = conn.sendControl('key_issued', { key, modules_url: modulesUrl, bundle });
  return { delivered: ok };
}

export function revokeKey(email) {
  const conn = getByEmail(email);
  if (!conn) return { delivered: false, reason: 'offline' };
  conn.sendControl('key_revoked', {});
  // Close after control message — agent is expected to have removed the key
  // by the time the socket drops.
  setTimeout(() => { try { conn.socket.close(4001, 'revoked'); } catch {} }, 500);
  return { delivered: true };
}
