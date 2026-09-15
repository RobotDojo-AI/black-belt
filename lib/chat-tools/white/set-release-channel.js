import { defineTool, ok, err } from '../registry.js';
import { requireUserFromCtx } from './_session.js';
import { VALID_RELEASE_CHANNELS, updatePreferences } from '../../account-prefs.js';

defineTool('set_release_channel', {
  description: 'Update the user\'s release channel and/or auto-update preference. Use when the user asks to switch between stable and beta releases, or to turn auto-updates on/off. At least one of auto_update or channel must be provided. Returns the resulting state.',
  parameters: {
    properties: {
      auto_update: {
        type: 'boolean',
        description: 'Whether Robot Dojo should automatically install new releases.',
      },
      channel: {
        type: 'string',
        enum: ['stable', 'beta'],
        description: 'Release channel to track.',
      },
    },
  },
  execute(args, ctx) {
    const { user, error } = requireUserFromCtx(ctx);
    if (error) return error;

    const patch = {};
    if (args?.auto_update !== undefined) {
      if (typeof args.auto_update !== 'boolean') return err('auto_update must be boolean');
      patch.auto_update = args.auto_update;
    }
    if (args?.channel !== undefined) {
      if (!VALID_RELEASE_CHANNELS.has(args.channel)) {
        return err(`channel must be one of: ${[...VALID_RELEASE_CHANNELS].join(', ')}`);
      }
      patch.channel = args.channel;
    }
    if (Object.keys(patch).length === 0) {
      return err('provide at least one of auto_update or channel');
    }

    try {
      const prefs = updatePreferences(user.id, patch);
      return ok({ auto_update: prefs.auto_update, channel: prefs.channel });
    } catch (e) {
      return err(e.message);
    }
  },
});
