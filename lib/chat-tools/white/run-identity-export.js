// Run identity export across all enabled targets. Auto-sync targets
// (filesystem) get their fenced blocks written. Guided targets (web AIs)
// return copy-paste payloads that the chat UI can render.

import { defineTool, ok, err } from '../registry.js';
import { exportAll, exportOne } from '../../identity-export.js';

defineTool('run_identity_export', {
  description: 'Push the current identity to every enabled export target. Writes fenced blocks to ~/.claude/CLAUDE.md, ~/.cursor/rules/identity.mdc, etc for local tools. Returns copy-paste payloads for web tools (ChatGPT, Claude.ai, etc). Call after any identity section update to keep every AI you use in sync.',
  parameters: {
    properties: {
      only: {
        type: 'string',
        description: 'Optional — export to just one target by id instead of all enabled targets.',
      },
    },
    required: [],
  },
  async execute({ only }) {
    try {
      if (only) {
        const res = await exportOne(only);
        return ok({ targets: 1, results: [res] });
      }
      const { results } = await exportAll();
      return ok({
        targets: results.length,
        autoSynced: results.filter((r) => r.kind === 'auto-sync' && r.ok).length,
        guidedPending: results.filter((r) => r.kind === 'guided' && r.ok).length,
        results,
      });
    } catch (e) {
      return err(e.message);
    }
  },
});
