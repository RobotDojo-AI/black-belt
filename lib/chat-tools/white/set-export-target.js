// Enable / disable / reconfigure an identity export target.
// Use list_export_targets first to see valid adapter ids.

import { defineTool, ok, err } from '../registry.js';
import { updateTarget } from '../../identity-export.js';
import { getAdapter } from '../../identity-targets/index.js';

defineTool('set_export_target', {
  description: 'Turn an export target on/off, or set a custom file path. Use to activate propagation to Claude Code / Cursor / Codex / Copilot / ChatGPT / etc. After enabling, call run_identity_export to push the current identity.',
  parameters: {
    properties: {
      id: {
        type: 'string',
        description: 'Adapter id: claude-code | cursor | codex | copilot | chatgpt | claude-ai | gemini | perplexity | generic',
      },
      enabled: { type: 'boolean', description: 'Turn on or off.' },
      path: {
        type: 'string',
        description: 'Optional file-path override (only for auto-sync adapters or the generic one).',
      },
    },
    required: ['id'],
  },
  async execute({ id, enabled, path }) {
    if (!getAdapter(id)) return err(`unknown adapter "${id}" — use list_export_targets to see valid ids`);
    const patch = {};
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (path !== undefined) patch.path = path;
    if (Object.keys(patch).length === 0) return err('provide enabled and/or path');
    try {
      const updated = updateTarget(id, patch);
      return ok({ target: updated });
    } catch (e) {
      return err(e.message);
    }
  },
});
