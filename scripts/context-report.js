#!/usr/bin/env node
/**
 * Reports char counts vs budgets for the four @-include always-loaded files.
 * These files are injected into every conversation turn's system prompt via
 * ~/.claude/CLAUDE.md @-includes. The 40K per-file ceiling exists because
 * exceeding it causes a single file to dominate the context window.
 *
 * AGENTS.md is NOT reported here — it's spawn-time read only, guarded by
 * build-agents.js at 50K. SITEMAP.md and ARCHITECTURE.md are on-demand reads
 * with no context budget constraint.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { PIPELINE_KANBAN_PATH } from '../lib/robotdojo-paths.js';

const HOME = homedir();

const FILES = [
  { path: join(HOME, 'robotdojo/agents/dist/claude.md'), budget: 38_000, label: 'dist/claude.md' },
  { path: join(HOME, 'robotdojo/CLAUDE.md'),               budget: 38_000, label: 'CLAUDE.md' },
  { path: join(HOME, 'robotdojo/user/memory/MEMORY.md'),        budget: 15_000, label: 'MEMORY.md' },
  { path: PIPELINE_KANBAN_PATH,                            budget:  3_000, label: 'kanban.md' },
];

let anyExceeded = false;
let total = 0;

for (const f of FILES) {
  let size = 0;
  try {
    size = readFileSync(f.path, 'utf8').length;
  } catch {
    console.log(`  MISSING  ${f.label} (${f.path})`);
    continue;
  }
  total += size;
  const pct = Math.round((size / f.budget) * 100);
  const status = size > f.budget ? 'OVER ' : size > f.budget * 0.9 ? 'WARN ' : 'OK   ';
  if (size > f.budget) anyExceeded = true;
  console.log(`  ${status} ${f.label}: ${size.toLocaleString()} chars (${pct}% of ${f.budget.toLocaleString()} budget)`);
}

console.log(`  ─────`);
console.log(`  TOTAL always-loaded: ${total.toLocaleString()} chars`);

if (anyExceeded) {
  console.error('\ncontext-report: one or more files exceed budget. Trim before proceeding.');
  process.exit(1);
}
