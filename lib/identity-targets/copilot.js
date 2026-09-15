// lib/identity-targets/copilot.js — GitHub Copilot (VS Code + JetBrains).
//
// Copilot reads ~/.config/github-copilot/intellij/global-instructions.md on
// JetBrains and respects `github.copilot.chat.codeGeneration.instructions`
// from a file path in VS Code. We write a global instructions file and the
// user points their IDE at it once.

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { renderBlock } from './render.js';
import { writeFencedBlock } from './fenced-file.js';

const DEFAULT_PATH = resolve(homedir(), '.github-copilot', 'global-instructions.md');

export default {
  id: 'copilot',
  label: 'GitHub Copilot',
  kind: 'auto-sync',
  defaultPath: DEFAULT_PATH,
  setupHint: 'Point VS Code setting `github.copilot.chat.codeGeneration.instructions` (or JetBrains Copilot global instructions) at this file.',

  async apply(snapshot, { path = DEFAULT_PATH } = {}) {
    const body = renderBlock(snapshot, { targetLabel: 'Copilot' });
    return writeFencedBlock(path, body);
  },
};
