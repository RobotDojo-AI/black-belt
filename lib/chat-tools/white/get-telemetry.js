import { defineTool, ok } from '../registry.js';
import { requireUserFromCtx } from './_session.js';
import { getPreferences } from '../../account-prefs.js';

defineTool('get_telemetry', {
  description: 'Return the user\'s current telemetry opt-ins: usage, error_reporting, include_screenshots, include_chat_sessions. Use when the user asks what telemetry is currently enabled, or to audit what data is being shared.',
  parameters: {
    properties: {},
  },
  execute(_args, ctx) {
    const { user, error } = requireUserFromCtx(ctx);
    if (error) return error;

    const prefs = getPreferences(user.id);
    return ok({
      usage:                 prefs.telemetry_usage,
      error_reporting:       prefs.telemetry_error_reporting,
      include_screenshots:   prefs.telemetry_include_screenshots,
      include_chat_sessions: prefs.telemetry_include_chat_sessions,
    });
  },
});
