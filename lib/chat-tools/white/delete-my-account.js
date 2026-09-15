import { defineTool, ok, err } from '../registry.js';
import { requireUserFromCtx } from './_session.js';
import { logAudit } from '../../account-prefs.js';
import { deleteUserFull } from '../../account-deletion.js';

defineTool('delete_my_account', {
  description: 'DESTRUCTIVE and irreversible. Cascade-delete the user: cancel subscription → delete model → wipe imported data → kill sessions → tombstone the users row. After this, the user is logged out everywhere and cannot sign back in. Before calling this tool, ask the user to type the word DELETE in chat to confirm. Pass their literal response as `confirm`. Never infer or fabricate the confirmation.',
  parameters: {
    properties: {
      confirm: {
        type: 'string',
        description: 'Must be the literal string "DELETE" — captured from the user\'s own message. Any other value rejects the call.',
      },
    },
    required: ['confirm'],
  },
  async execute({ confirm }, ctx) {
    const { user, error } = requireUserFromCtx(ctx);
    if (error) return error;

    if (confirm !== 'DELETE') {
      return err('confirm required — user must type DELETE to proceed');
    }

    try {
      const result = await deleteUserFull(user);
      // deleteUserFull tombstones the user but keeps the row + FKs intact,
      // so the audit insert below still references a valid account_id.
      logAudit(user.id, 'delete_full', { at: result.at, via: 'chat' });
      return ok(result);
    } catch (e) {
      console.error('[chat-tools] delete_my_account failed:', e.message);
      return err(`delete_failed: ${e.message}`);
    }
  },
});
