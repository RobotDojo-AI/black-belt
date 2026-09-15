import fs from 'node:fs';
import path from 'node:path';
import { defineTool, ok, err } from '../registry.js';
import { requireUserFromCtx } from './_session.js';
import { getPreferences, logAudit } from '../../account-prefs.js';

/**
 * Mirrors POST /api/account/release/pull — today a stub that reports the
 * installed version as both "current" and "available". A future update
 * pipeline will diff against a release manifest here.
 */
defineTool('check_for_updates', {
  description: 'Check whether a new Robot Dojo release is available on the user\'s channel. Use when the user asks if there is a new version, wants to check for updates, or is troubleshooting an out-of-date install. Returns { status, current_version, available_version }.',
  parameters: {
    properties: {},
  },
  execute(_args, ctx) {
    const { user, error } = requireUserFromCtx(ctx);
    if (error) return error;

    const prefs = getPreferences(user.id);

    let currentVersion = 'unknown';
    try {
      const pkgPath = path.resolve(import.meta.dirname, '..', '..', '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      currentVersion = pkg.version || 'unknown';
    } catch {
      // keep 'unknown' — package.json read failure isn't fatal here
    }

    try {
      logAudit(user.id, 'release_pull_check', { channel: prefs.channel, via: 'chat' });
    } catch { /* audit is best-effort */ }

    return ok({
      status: 'up_to_date',
      current_version: currentVersion,
      available_version: currentVersion,
      channel: prefs.channel,
    });
  },
});
