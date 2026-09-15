// lib/accounts-open-target.js — opens an account edit-target in the user's
// default editor for `.md` files via macOS `open`. Thin facade so the
// Accounts route is HTTP plumbing only.
//
// st_4e7e3aaf AC10 — the Edit button on the You and Skills pages fires
// GET /api/accounts/open-target?id=<targetId>. The route resolves the
// absolute path from a server-side allowlist (editTargetMap()); the client
// never supplies a path. execFileSync uses an argv array — no shell
// interpolation, so a malicious `id` parameter cannot inject shell syntax.

import { execFileSync } from 'node:child_process';

/**
 * Open the file backing an account edit-target in the registered default
 * app for `.md`.
 *
 * @param {string} id — edit-target id (e.g. 'you:user', 'skill:asana')
 * @param {Map}    map — result of editTargetMap()
 * @returns {{ok: true} | {error: 'unknown_target'} | {error: 'open_failed', detail: string}}
 */
export function openEditTarget(id, map) {
  if (!map?.has?.(id)) return { error: 'unknown_target' };
  const target = map.get(id);
  const path = target?.path;
  if (!path) return { error: 'unknown_target' };
  try {
    execFileSync('open', [path], { timeout: 3000, stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (err) {
    return { error: 'open_failed', detail: err?.message || 'open failed' };
  }
}

export default openEditTarget;
