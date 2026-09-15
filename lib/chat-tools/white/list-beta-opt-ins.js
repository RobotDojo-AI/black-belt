import { defineTool, ok } from '../registry.js';
import { requireUserFromCtx } from './_session.js';
import { listBetaOptIns } from '../../account-prefs.js';

defineTool('list_beta_opt_ins', {
  description: 'List the apps the user is currently opted into for beta testing. Use when the user asks "which betas am I in?" or wants to review their current beta enrollments.',
  parameters: {
    properties: {},
  },
  execute(_args, ctx) {
    const { user, error } = requireUserFromCtx(ctx);
    if (error) return error;

    return ok({ apps: listBetaOptIns(user.id) });
  },
});
