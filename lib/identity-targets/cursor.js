// lib/identity-targets/cursor.js — Cursor IDE.
//
// Writes to ~/.cursor/rules/identity.mdc. Cursor rules use YAML frontmatter
// and are scoped by glob. `alwaysApply: true` + `globs: "**/*"` means the
// identity block is injected on every request regardless of file.

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renderBlock } from './render.js';

const DEFAULT_PATH = resolve(homedir(), '.cursor', 'rules', 'identity.mdc');

const FRONTMATTER = [
  '---',
  'description: Robot Dojo identity — who you are talking to and how they work',
  'globs: "**/*"',
  'alwaysApply: true',
  '---',
  '',
].join('\n');

export default {
  id: 'cursor',
  label: 'Cursor',
  kind: 'auto-sync',
  defaultPath: DEFAULT_PATH,

  async apply(snapshot, { path = DEFAULT_PATH } = {}) {
    const body = renderBlock(snapshot, { targetLabel: 'Cursor' });
    const output = FRONTMATTER + body;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, output);
    const s = await stat(path);
    return { path, action: 'replaced', bytes: s.size };
  },
};
