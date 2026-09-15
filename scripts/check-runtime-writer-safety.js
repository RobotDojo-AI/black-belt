#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');

const checks = [
  {
    name: 'launch-state ownership',
    command: process.execPath,
    args: [resolve(REPO_ROOT, 'scripts/check-launch-state-ownership.js')],
  },
  {
    name: 'direct DB writers',
    command: process.execPath,
    args: [resolve(REPO_ROOT, 'scripts/check-direct-db-writers.js')],
  },
  {
    name: 'installer parity',
    command: process.execPath,
    args: [resolve(REPO_ROOT, 'scripts/check-installer-parity.js'), '--root', REPO_ROOT],
  },
  {
    name: 'background routines',
    command: process.execPath,
    args: [resolve(REPO_ROOT, 'scripts/check-background-routines.js')],
  },
];

const failures = [];
for (const check of checks) {
  process.stdout.write(`[check-runtime-writer-safety] running ${check.name}\n`);
  const result = spawnSync(check.command, check.args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ROBOTDOJO_REPO_ROOT: REPO_ROOT },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) failures.push(`${check.name} exited ${result.status}`);
}

if (failures.length) {
  process.stderr.write('[check-runtime-writer-safety] FAIL\n');
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write('[check-runtime-writer-safety] ok\n');
