import { defineTool, ok } from '../registry.js';
import { requireUserFromCtx } from './_session.js';
import { listFeatureRequests } from '../../account-prefs.js';

defineTool('list_my_feature_requests', {
  description: 'List feature requests the user has previously submitted, newest first. Use when the user asks "what have I requested?" or wants to review their prior submissions.',
  parameters: {
    properties: {},
  },
  execute(_args, ctx) {
    const { user, error } = requireUserFromCtx(ctx);
    if (error) return error;

    return ok({ requests: listFeatureRequests(user.id) });
  },
});
