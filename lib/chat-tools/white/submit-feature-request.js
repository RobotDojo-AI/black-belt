import { defineTool, ok, err } from '../registry.js';
import { requireUserFromCtx } from './_session.js';
import { submitFeatureRequest } from '../../account-prefs.js';

defineTool('submit_feature_request', {
  description: 'Submit a feature request to the Robot Dojo team. Use when the user asks for a new feature, improvement, or change they want the team to consider. Title is 1-120 chars, body is 10-4000 chars. Returns { id, submitted_at }.',
  parameters: {
    properties: {
      title: {
        type: 'string',
        description: 'Short one-line summary (1-120 characters).',
      },
      body: {
        type: 'string',
        description: 'Full description of the request, why it matters, and any relevant context (10-4000 characters).',
      },
    },
    required: ['title', 'body'],
  },
  execute({ title, body }, ctx) {
    const { user, error } = requireUserFromCtx(ctx);
    if (error) return error;

    try {
      const row = submitFeatureRequest(user.id, { title, body });
      return ok(row);
    } catch (e) {
      return err(e.message);
    }
  },
});
