import { defineTool, ok, err } from '../registry.js';
import { requireUserFromCtx } from './_session.js';
import { getPreferences, updatePreferences } from '../../account-prefs.js';

const TELEMETRY_KEYS = ['usage', 'error_reporting', 'include_screenshots', 'include_chat_sessions'];

function telemetryView(prefs) {
  return {
    usage:                 prefs.telemetry_usage,
    error_reporting:       prefs.telemetry_error_reporting,
    include_screenshots:   prefs.telemetry_include_screenshots,
    include_chat_sessions: prefs.telemetry_include_chat_sessions,
  };
}

defineTool('set_telemetry', {
  description: 'Update any subset of the user\'s telemetry opt-ins: usage, error_reporting, include_screenshots, include_chat_sessions. Merge-update — keys you omit keep their current value. Use when the user asks to turn telemetry on or off, share error reports, or adjust what gets included in telemetry.',
  parameters: {
    properties: {
      usage: { type: 'boolean', description: 'Share anonymous product usage metrics.' },
      error_reporting: { type: 'boolean', description: 'Share crash and error reports.' },
      include_screenshots: { type: 'boolean', description: 'Include screenshots in error reports.' },
      include_chat_sessions: { type: 'boolean', description: 'Include chat transcripts in telemetry payloads.' },
    },
  },
  execute(args, ctx) {
    const { user, error } = requireUserFromCtx(ctx);
    if (error) return error;

    const patch = {};
    for (const key of TELEMETRY_KEYS) {
      if (args?.[key] !== undefined) {
        if (typeof args[key] !== 'boolean') return err(`${key} must be boolean`);
        patch[`telemetry_${key}`] = args[key];
      }
    }
    if (Object.keys(patch).length === 0) {
      return err('provide at least one telemetry field');
    }

    try {
      const prefs = updatePreferences(user.id, patch);
      return ok(telemetryView(prefs));
    } catch (e) {
      return err(e.message);
    }
  },
});
