#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AGENT_NAMES,
  REQUIRED_SKILLS,
  copyTrackedTree,
  failOrPass,
  listTrackedFiles,
  parseArgs,
  repoPath,
} from './check-final-structure-lib.js';

const { repoRoot } = parseArgs();
const errors = [];
const tracked = new Set(listTrackedFiles(repoRoot));

for (const relPath of [
  'agents/agents.md',
  'agents/default-quality.md',
  'agents/build-conventions.md',
  'scripts/generate-identity.js',
  'lib/agent-personas.js',
  'lib/robotdojo-paths.js',
]) {
  if (!tracked.has(relPath)) errors.push(`fresh clone would miss required tracked file: ${relPath}`);
}

for (const name of AGENT_NAMES) {
  const relPath = `agents/personas/${name}.md`;
  if (!tracked.has(relPath)) errors.push(`fresh clone would miss persona: ${relPath}`);
}

for (const name of REQUIRED_SKILLS) {
  const relPath = `agents/skills/${name}/SKILL.md`;
  if (!tracked.has(relPath)) errors.push(`fresh clone would miss skill: ${relPath}`);
}

const userTracked = [...tracked].filter((relPath) => relPath.startsWith('user/'));
const invalidUserTracked = userTracked.filter((relPath) => relPath !== 'user/.gitignore');
if (invalidUserTracked.length > 0) {
  errors.push(`fresh clone includes private user content: ${invalidUserTracked.slice(0, 8).join(', ')}`);
}

const distTracked = [...tracked].filter((relPath) => relPath.startsWith('agents/dist/'));
if (distTracked.length > 0) {
  errors.push(`agents/dist/ must be regenerable, not tracked: ${distTracked.slice(0, 8).join(', ')}`);
}

if (errors.length === 0) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'robotdojo-fresh-clone-'));
  try {
    copyTrackedTree(repoRoot, tempRoot);
    const result = spawnSync(process.execPath, ['scripts/generate-identity.js'], {
      cwd: tempRoot,
      env: {
        ...process.env,
        ROBOTDOJO_REPO_ROOT: tempRoot,
        ROBOTDOJO_AGENTS_ROOT: join(tempRoot, 'agents'),
        ROBOTDOJO_USER_ROOT: join(tempRoot, 'user'),
      },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      errors.push(`fresh tracked-only generate-identity failed: ${(result.stderr || result.stdout || '').trim()}`);
    } else {
      for (const relPath of [
        'agents/dist/claude.md',
        'agents/dist/AGENTS.md',
        'agents/dist/cursor-identity.mdc',
        'agents/dist/cursor-memory.mdc',
      ]) {
        if (!existsSync(repoPath(tempRoot, relPath))) {
          errors.push(`fresh tracked-only generation did not produce ${relPath}`);
        }
      }
      for (const name of AGENT_NAMES) {
        const relPath = `agents/dist/claude-agents/${name}.md`;
        if (!existsSync(repoPath(tempRoot, relPath))) {
          errors.push(`fresh tracked-only generation did not produce ${relPath}`);
        }
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

failOrPass('check-agent-os-fresh-clone', errors, 'ok - tracked files can regenerate Agent OS adapters without user/');

