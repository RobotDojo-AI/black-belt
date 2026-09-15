#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const env = {
  ...process.env,
  ROBOTDOJO_ALLOW_PLAINTEXT: process.env.ROBOTDOJO_ALLOW_PLAINTEXT || '1',
  ROBOTDOJO_DB: process.env.ROBOTDOJO_DB || resolve(homedir(), '.robotdojo', 'robotdojo.db'),
};

const maxOrphans = process.env.ROBOTDOJO_CONTEXT_MAX_ORPHANS || '1000';

const groups = [
  {
    label: 'context file pointers',
    args: ['scripts/qa/context-pointer-audit.js', '--max-orphans', maxOrphans],
  },
  {
    label: 'context file consolidation',
    args: ['scripts/qa/context-consolidation-audit.js'],
  },
];

for (const group of groups) {
  console.log(`\n[memory-live-context-audit] ${group.label}`);
  const result = spawnSync(process.execPath, group.args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`[memory-live-context-audit] ${group.label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[memory-live-context-audit] ${group.label} failed`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n[memory-live-context-audit] ok');
