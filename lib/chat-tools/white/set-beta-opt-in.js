import { defineTool, ok, err } from '../registry.js';
import { requireUserFromCtx } from './_session.js';
import { VALID_BETA_APPS, setBetaOptIn } from '../../account-prefs.js';

defineTool('set_beta_opt_in', {
  description: 'Opt the user in or out of beta testing for a specific launch app. Use when the user asks to beta-test an app, try an upcoming app, or leave a beta they previously joined.',
  parameters: {
    properties: {
      app: {
        type: 'string',
        enum: ['health'],
        description: 'Which app to change the beta opt-in state for.',
      },
      opt_in: {
        type: 'boolean',
        description: 'true to opt in, false to opt out.',
      },
    },
    required: ['app', 'opt_in'],
  },
  execute({ app, opt_in }, ctx) {
    const { user, error } = requireUserFromCtx(ctx);
    if (error) return error;

    if (!VALID_BETA_APPS.has(app)) {
      return err(`app must be one of: ${[...VALID_BETA_APPS].join(', ')}`);
    }
    if (typeof opt_in !== 'boolean') {
      return err('opt_in must be boolean');
    }

    try {
      return ok(setBetaOptIn(user.id, app, opt_in));
    } catch (e) {
      return err(e.message);
    }
  },
});
