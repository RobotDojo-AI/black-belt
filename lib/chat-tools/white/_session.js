/**
 * Shared helper for account-scoped White Belt tools.
 *
 * The chat loop passes `{ belt, sessionId }` in the tool ctx. Account
 * preference / deletion / admin tools need the user (and therefore the
 * account_id = users.id) behind that session. This resolves it in one place
 * so each per-tool file stays focused on its domain.
 *
 * Not prefixed `_` purely for style — the leading underscore signals to
 * anyone reading lib/chat-tools/index.js's import block that this is NOT a
 * tool registration file, just plumbing. index.js never imports it.
 */
import db from '../../db.js';

const selectSessionUser = db.prepare(`
  SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
   WHERE s.id = ?
     AND s.expires_at > datetime('now')
`);

/**
 * Resolve the caller's user row from ctx.sessionId.
 * Returns the full `users` row, or null if no valid session.
 */
export function getUserFromCtx(ctx) {
  const sessionId = ctx?.sessionId;
  if (!sessionId) return null;
  return selectSessionUser.get(sessionId) || null;
}

/**
 * Convenience: resolve user, or return a structured error result if missing.
 * Mirrors the `err()` shape from registry.js so callers can early-return it.
 */
export function requireUserFromCtx(ctx) {
  const user = getUserFromCtx(ctx);
  if (!user) {
    return { user: null, error: { ok: false, error: 'authentication required' } };
  }
  return { user, error: null };
}
