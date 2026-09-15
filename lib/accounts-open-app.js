// lib/accounts-open-app.js — opens a Mac app or a System Settings pane via
// macOS `open` based on a server-side allowlist. Thin facade so the
// Accounts route stays HTTP plumbing.
//
// st_4e7e3aaf AC11 — replaces the Granola click-through and the Apple FDA
// terminal command:
//   - openApp('Granola')        → `open -a Granola`
//   - openSettingsPane('full-disk-access') → `open <x-apple settings url>`
// All values are resolved from these allowlists; client input is never
// interpolated into the argv passed to execFileSync.

import { execFileSync } from 'node:child_process';

// Apps the Accounts page is allowed to launch. Keep this list minimal —
// every entry is a click-target somewhere in the UI.
const ALLOWED_APPS = new Set(['Granola']);

// Apes Apple System Settings panes the account page may deep-link to.
// Mapping is allowlist-key → deeplink URL so the URL is server-controlled.
const SETTINGS_PANES = Object.freeze({
  'full-disk-access': 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
});

/**
 * Open a Mac app by display name.
 * @param {string} name — must be in ALLOWED_APPS
 * @returns {{ok: true} | {error: 'unknown_app'} | {error: 'open_failed', detail: string}}
 */
export function openApp(name) {
  if (!ALLOWED_APPS.has(name)) return { error: 'unknown_app' };
  try {
    execFileSync('open', ['-a', name], { timeout: 3000, stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (err) {
    return { error: 'open_failed', detail: err?.message || 'open failed' };
  }
}

/**
 * Open a System Settings pane by allowlist key.
 * @param {string} pane — must be a key in SETTINGS_PANES
 * @returns {{ok: true} | {error: 'unknown_pane'} | {error: 'open_failed', detail: string}}
 */
export function openSettingsPane(pane) {
  const url = SETTINGS_PANES[pane];
  if (!url) return { error: 'unknown_pane' };
  try {
    execFileSync('open', [url], { timeout: 3000, stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (err) {
    return { error: 'open_failed', detail: err?.message || 'open failed' };
  }
}

export { ALLOWED_APPS, SETTINGS_PANES };
