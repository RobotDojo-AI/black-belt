#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const groups = [
  {
    label: 'surface recall and replay',
    args: [
      '--test',
      'tests/data-arrival-pipelines.test.js',
      'tests/memory-product-proof.test.js',
      'tests/memory-context.test.js',
      'tests/memory-recall-eval.test.js',
      'tests/workbench-synthesis.test.js',
      'tests/build-memory-wiring.test.js',
      'tests/health-intel-memory.test.js',
      'tests/chat-context-injection.test.js',
    ],
  },
  {
    label: 'entity and enrichment memory',
    args: [
      '--test',
      'tests/entity-enrich-reconciler.test.js',
      'tests/entity-enrich-self-heal.test.js',
      'tests/chat/passive-entities-contract.test.js',
    ],
  },
  {
    label: 'passive memory and foreground safety',
    args: [
      '--test',
      'tests/passive-jobs.test.js',
      'tests/maintenance-routines.test.js',
      'tests/maintenance.test.js',
      'tests/supervisor-maintenance-isolation.test.js',
    ],
  },
  {
    label: 'workspace placement lock',
    args: ['scripts/check-root-lock.js'],
  },
  {
    label: 'runtime writer safety',
    args: ['scripts/check-runtime-writer-safety.js'],
  },
  {
    label: 'SLA coverage',
    args: ['scripts/qa/check-sla-coverage.js'],
  },
];

for (const group of groups) {
  console.log(`\n[memory-magic-audit] ${group.label}`);
  const result = spawnSync(process.execPath, group.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`[memory-magic-audit] ${group.label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[memory-magic-audit] ${group.label} failed`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n[memory-magic-audit] ok');
