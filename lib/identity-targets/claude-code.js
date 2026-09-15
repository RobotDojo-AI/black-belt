// lib/identity-targets/claude-code.js — Claude Code CLI.
//
// Writes to ~/.claude/CLAUDE.md. Claude Code reads this file at session
// start as the user's global instructions for every project.

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { renderBlock } from './render.js';
import { writeFencedBlock } from './fenced-file.js';

const DEFAULT_PATH = resolve(homedir(), '.claude', 'CLAUDE.md');

export default {
  id: 'claude-code',
  label: 'Claude Code',
  kind: 'auto-sync',
  defaultPath: DEFAULT_PATH,

  async apply(snapshot, { path = DEFAULT_PATH } = {}) {
    const body = renderBlock(snapshot, { targetLabel: 'Claude Code' });
    return writeFencedBlock(path, body);
  },
};
