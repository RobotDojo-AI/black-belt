import { generate, listWriting, resolveOwnerSelector } from '../../writing.js';
import { defineTool, ok, err } from '../registry.js';

defineTool('apply_voice', {
  description:
    'Generate a nested draft in the user\'s writing (something they will send). Miyagi wraps it; this tool writes the sendable body. Use when they want a note, email, post, or memo for someone else. slug "voice" is their live compounded writing.',
  parameters: {
    properties: {
      brief: { type: 'string', description: 'What to write' },
      task: { type: 'string', description: 'Alias for brief' },
      structure: { type: 'string', description: 'Kind of piece: memo, essay, proposal, …' },
      formatting: { type: 'string', description: 'Destination: email, gmail, linkedin, sms, asana' },
      slug: { type: 'string', description: 'Legacy: a structure or formatting slug' },
    },
    required: [],
  },
  async execute({ brief, task, structure, formatting, slug }) {
    const text = String(brief || task || '').trim();
    if (!text) return err('brief is required');
    let struct = structure || null;
    let format = formatting || null;
    if (slug && !struct && !format) {
      const resolved = resolveOwnerSelector(slug);
      if (!resolved) {
        const structs = listWriting('owner', 'structure').map((e) => e.slug).join(', ');
        const formats = listWriting('owner', 'formatting').map((e) => e.slug).join(', ');
        return err(`unknown slug "${slug}". structure: ${structs}. formatting: ${formats}`);
      }
      struct = resolved.structure;
      format = resolved.formatting;
    }
    try {
      const block = await generate({ speaker: 'owner', brief: text, structure: struct, formatting: format });
      return ok({
        speaker: 'owner',
        structure: struct,
        formatting: format,
        draft: block.body,
        sha256: block.sha256,
      });
    } catch (e) {
      return err(e.message || String(e));
    }
  },
});
