// lib/handle-rename.js — rename the user's identity handle (user_handle).
//
// The handle is the globally-unique identity alias in two-segment URLs:
//   robotdojo.ai/<servername>/<handle>/<app>
//
// Unlike device rename (user_slug), handle rename:
//   - Claims the new handle at the relay BEFORE touching the DB
//   - Deletes all sessions after the DB update (handle change invalidates cookies)
//   - Releases the old handle at the relay after DB commit (best-effort)
//
// This is the only rename operation that interacts with the relay registry.

import db from './db.js';
import { callRelay } from './relay-client.js';
import { validateSlug } from './reserved-slugs.js';

/**
 * Rename the identity handle. Returns { ok, newHandle, oldHandle? } on success,
 * or { ok: false, reason, message? } on failure.
 *
 * @param {object} opts
 * @param {number} opts.userId           who to rename
 * @param {string} opts.newHandle        desired handle, any casing (normalized inside)
 * @param {boolean} [opts.skipRelay]     bypass relay round-trip (tests / offline)
 * @param {string|null} [opts.currentSessionId]  session to preserve after rename (others wiped)
 */
export async function renameHandle({ userId, newHandle, skipRelay = false, currentSessionId = null }) {
  const desired = String(newHandle || '').trim().toLowerCase();
  const problem = validateSlug(desired);
  if (problem) return { ok: false, reason: 'invalid', message: problem };

  const user = db.prepare('SELECT id, email, user_slug, user_handle, uuid FROM users WHERE id = ?').get(userId);
  if (!user) return { ok: false, reason: 'user_not_found' };
  if (user.user_handle === desired) {
    return { ok: true, newHandle: desired, unchanged: true };
  }

  // Claim the new handle at the relay BEFORE touching the DB.
  if (!skipRelay) {
    const claim = await callRelay('/internal/claim-handle', 'POST', {
      handle: desired,
      email: user.email,
      ...(user.uuid ? { uuid: user.uuid } : {}),
    });
    if (!claim.ok) {
      if (claim.status === 409) {
        return {
          ok: false, reason: 'taken',
          message: `"${desired}" is already in use by another user.`,
        };
      }
      return { ok: false, reason: 'relay_error', message: claim.error || 'relay rejected handle claim' };
    }
  }

  const oldHandle = user.user_handle;

  // Update DB atomically: new handle + wipe sessions.
  // When currentSessionId is provided, preserve that session so the caller
  // stays logged in after the rename. All other sessions are still invalidated.
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET user_handle = ? WHERE id = ?').run(desired, userId);
    if (currentSessionId) {
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, currentSessionId);
    } else {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  });
  tx();

  // Release old handle at relay (best-effort).
  if (!skipRelay && oldHandle) {
    try {
      await callRelay('/internal/release-handle', 'POST', {
        handle: oldHandle,
        email: user.email,
      });
    } catch (err) {
      console.warn('[handle-rename] old-handle release failed (non-fatal):', err.message);
    }
  }

  return { ok: true, newHandle: desired, oldHandle };
}
