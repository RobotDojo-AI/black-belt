// lib/identity-targets/codex.js — OpenAI Codex CLI.
//
// Codex reads ~/.codex/AGENTS.md at session start for agent behavior and
// user preferences. Path is stable across versions as of early 2026.

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { renderBlock } from './render.js';
import { writeFencedBlock } from './fenced-file.js';

const DEFAULT_PATH = resolve(homedir(), '.codex', 'AGENTS.md');

export default {
  id: 'codex',
  label: 'OpenAI Codex CLI',
  kind: 'auto-sync',
  defaultPath: DEFAULT_PATH,

  async apply(snapshot, { path = DEFAULT_PATH } = {}) {
    const body = renderBlock(snapshot, { targetLabel: 'Codex' });
    return writeFencedBlock(path, body);
  },
};
