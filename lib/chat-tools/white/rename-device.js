// Rename the user's device handle — the slug that appears in public URLs
// (<slug>.robotdojo.ai/...). Atomic across SQLite + the relay + the
// live tunnel connection. See lib/device-rename.js for the full contract.
//
// Consequences users should know before calling:
//   - Old magic-link URLs stop working immediately (they embed the old slug)
//   - Every browser that was signed in has to re-auth (sessions are wiped)
//   - The tunnel briefly drops while it reconnects under the new name
// The tool returns these impacts in its result so the chat layer can
// surface them conversationally.

import { defineTool, ok, err } from '../registry.js';
import { renameDevice, suggestFromHostname } from '../../device-rename.js';
import { execSync } from 'node:child_process';
import db from '../../db.js';

// Mark the setup card 'device-name' complete. The card gates itself on
// this setting so the user has to EXPLICITLY accept the name once —
// otherwise the install wizard would look complete just because a slug
// happens to exist in the users row.
function markDeviceNameConfirmed() {
  db.prepare(
    "INSERT INTO user_settings (key, value, updated_at) VALUES ('device_name_confirmed','1', datetime('now'))" +
    " ON CONFLICT(key) DO UPDATE SET value='1', updated_at=datetime('now')"
  ).run();
}

defineTool('rename_device', {
  description: 'Rename this Mac\'s device handle (the slug in public URLs like <slug>.robotdojo.ai/chat). Short, memorable, lowercase letters/digits/hyphens only — 2 to 32 chars. This invalidates all active sessions; the user will need to sign in again on any other device. Call get_device_name first if the user wants to see the current name.',
  parameters: {
    properties: {
      new_name: {
        type: 'string',
        description: 'The new device handle. Kebab-case ([a-z0-9][a-z0-9-]{1,31}). Not reserved (api, static, chat, me, admin, etc).',
      },
    },
    required: ['new_name'],
  },
  async execute({ new_name }) {
    const res = await renameDevice({ userId: 1, newSlug: new_name });
    if (!res.ok) {
      return err(res.message || res.reason || 'rename failed');
    }
    markDeviceNameConfirmed();
    if (res.unchanged) {
      return ok({ slug: res.newSlug, unchanged: true, message: 'Already named that.' });
    }

    // Kick the tunnel-agent to reconnect with a fresh JWT. Cheapest way
    // is to bounce the whole app — launchd will restart it. The user's
    // chat UI will briefly disconnect and reconnect.
    try {
      execSync('launchctl kickstart -k gui/$(id -u)/com.robotdojo.server', { timeout: 3000 });
    } catch (e) {
      console.warn('[rename_device] could not bounce app:', e.message);
    }

    return ok({
      slug: res.newSlug,
      oldSlug: res.oldSlug,
      message: `Renamed to "${res.newSlug}". Old URLs stopped working. All signed-in devices need to log in again.`,
    });
  },
});

defineTool('suggest_device_name', {
  description: 'Suggest a device name from the Mac\'s hostname. Use before rename when the user wants a sensible default. Returns the suggestion (may be empty if the hostname sanitizes to nothing usable).',
  parameters: { properties: {}, required: [] },
  execute() {
    try {
      const hn = execSync('hostname -s', { encoding: 'utf8', timeout: 500 }).trim();
      return ok({ suggestion: suggestFromHostname(hn), hostname: hn });
    } catch (e) {
      return ok({ suggestion: '', hostname: null });
    }
  },
});
