// lib/device-rename.js — cosmetic device slug rename.
//
// Renames user_slug (the server name / SNI subdomain prefix).
// Purely cosmetic after the st_7495acc0 URL overhaul:
//   validate + UPDATE users.user_slug + macOS scutil names only.
//
// No relay calls. No session deletion. The relay routes by handle/uuid now;
// slug is just a display name in the URL.
//
// For identity handle rename (user_handle, relay claim/release, session
// deletion), see lib/handle-rename.js. Re-exported here for backward compat.

export { renameHandle } from './handle-rename.js';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

import db from './db.js';
import { validateSlug, RESERVED_SLUGS, SLUG_REGEX } from './reserved-slugs.js';

/**
 * Rename the device slug (user_slug). Purely cosmetic — validates the new
 * name, updates the DB, and syncs macOS computer names.
 *
 * @param {object} opts
 * @param {number} opts.userId   who to rename. Default: admin user.
 * @param {string} opts.newSlug  desired slug, any casing (normalized inside).
 */
export async function renameDevice({ userId, newSlug }) {
  const desired = String(newSlug || '').trim().toLowerCase();
  const problem = validateSlug(desired);
  if (problem) return { ok: false, reason: 'invalid', message: problem };

  const user = db.prepare('SELECT id, email, user_slug FROM users WHERE id = ?').get(userId);
  if (!user) return { ok: false, reason: 'user_not_found' };
  if (user.user_slug === desired) {
    return { ok: true, newSlug: desired, unchanged: true };
  }

  db.prepare('UPDATE users SET user_slug = ? WHERE id = ?').run(desired, userId);

  // Best-effort: keep macOS computer names in sync with the slug.
  // Non-fatal — scutil may not be available or may lack permissions.
  try {
    await execFileAsync('scutil', ['--set', 'LocalHostName', desired]);
    await execFileAsync('scutil', ['--set', 'ComputerName', desired]);
  } catch {
    // non-fatal
  }

  return { ok: true, newSlug: desired, oldSlug: user.user_slug };
}

/**
 * Normalize an arbitrary hostname ($(hostname -s)) into a valid slug
 * suggestion. Used by the install flow to auto-fill the prompt.
 */
export function suggestFromHostname(hostname) {
  if (!hostname) return '';
  const s = String(hostname)
    .toLowerCase()
    .replace(/\.local$/i, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!SLUG_REGEX.test(s)) return '';
  if (RESERVED_SLUGS.has(s)) return '';
  return s;
}
