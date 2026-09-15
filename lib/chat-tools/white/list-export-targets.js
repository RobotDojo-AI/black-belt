// List every possible export target and the user's current config
// (enabled? path override? last-installed version?). Powers the
// "My AI Tools" experience in chat.

import { defineTool, ok } from '../registry.js';
import { statusForUi } from '../../identity-export.js';

defineTool('list_export_targets', {
  description: 'List every AI tool Robot Dojo can propagate your identity to — Claude Code, Cursor, Codex, Copilot, ChatGPT, Claude.ai, Gemini, Perplexity, plus a Custom file path. Shows which are currently enabled and whether any guided target needs to be re-pasted (contentHash mismatch).',
  parameters: { properties: {}, required: [] },
  async execute() {
    const status = await statusForUi();
    return ok({
      currentHash: status.currentHash,
      adapters: status.adapters.map((a) => ({
        id: a.id,
        label: a.label,
        kind: a.kind,
        url: a.url,
        defaultPath: a.defaultPath,
        enabled: a.enabled ?? false,
        path: a.path || null,
        installedVersion: a.installedVersion || null,
        needsInstall: a.needsInstall || false,
        setupHint: a.setupHint || null,
      })),
    });
  },
});
