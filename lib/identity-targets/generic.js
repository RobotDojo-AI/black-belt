// lib/identity-targets/generic.js — catch-all auto-sync adapter.
//
// For AI tools we don't have a specific adapter for. User supplies a file
// path; we write the fenced block to it. Useful for Aider, Continue,
// Zed Assistant, Cline, and anything else that reads a local markdown file.

import { renderBlock } from './render.js';
import { writeFencedBlock } from './fenced-file.js';

export default {
  id: 'generic',
  label: 'Custom file path',
  kind: 'auto-sync',
  defaultPath: null, // user must supply

  async apply(snapshot, { path, label = 'your AI tool' } = {}) {
    if (!path) throw new Error('generic target requires `path`');
    const body = renderBlock(snapshot, { targetLabel: label });
    return writeFencedBlock(path, body);
  },
};
