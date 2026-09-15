#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIPELINE_KANBAN_PATH } from '../lib/robotdojo-paths.js';

const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--story') args.story = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.story) throw new Error('--story is required');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const kanban = readFileSync(PIPELINE_KANBAN_PATH, 'utf8');
const required = [
  'foundation substrate gate closed',
  args.story,
  'active Day 0 gate',
  'active-build',
  'worktree',
  'process substrate',
];

const missing = required.filter((needle) => !kanban.toLowerCase().includes(needle.toLowerCase()));
if (missing.length) {
  console.error('[check-kanban-current-state] FAIL');
  for (const needle of missing) console.error(`  - missing: ${needle}`);
  process.exit(1);
}

console.log(`[check-kanban-current-state] ok — ${args.story} current state asserted`);
