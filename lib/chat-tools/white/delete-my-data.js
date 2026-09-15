import { defineTool, ok, err } from '../registry.js';
import { requireUserFromCtx } from './_session.js';
import { logAudit } from '../../account-prefs.js';
import { deleteUserData } from '../../account-deletion.js';

defineTool('delete_my_data', {
  description: 'DESTRUCTIVE. Hard-wipe all imported personal data (emails, messages, calendar, contacts, RAG chunks, timeline) for the current user. Before calling this tool, ask the user to type the word DELETE in chat to confirm. Pass their literal response as `confirm`. Never infer or fabricate the confirmation. If the user does not type DELETE, do not call this tool.',
  parameters: {
    properties: {
      confirm: {
        type: 'string',
        description: 'Must be the literal string "DELETE" — captured from the user\'s own message. Any other value rejects the call.',
      },
    },
    required: ['confirm'],
  },
  execute({ confirm }, ctx) {
    const { user, error } = requireUserFromCtx(ctx);
    if (error) return error;

    if (confirm !== 'DELETE') {
      return err('confirm required — user must type DELETE to proceed');
    }

    try {
      const result = deleteUserData(user.id);
      logAudit(user.id, 'delete_data', { at: result.at, via: 'chat' });
      return ok(result);
    } catch (e) {
      console.error('[chat-tools] delete_my_data failed:', e.message);
      return err(`delete_failed: ${e.message}`);
    }
  },
});
