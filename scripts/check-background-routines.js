#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMaintenanceRegistry, validateMaintenanceRegistry } from '../lib/maintenance.js';

const root = process.env.ROBOTDOJO_REPO_ROOT || resolve(import.meta.dirname, '..');
const registry = loadMaintenanceRegistry(root);
const result = validateMaintenanceRegistry(registry);
const errors = [...result.errors];

for (const routine of registry.routines || []) {
  if (routine.entrypoint && !routine.entrypoint.includes('*') && !existsSync(resolve(root, routine.entrypoint))) {
    errors.push(`${routine.id}: entrypoint missing: ${routine.entrypoint}`);
  }
  if (routine.kind === 'launch-agent' && routine.launch_required !== true) {
    errors.push(`${routine.id}: launch-agent routines must be launch_required`);
  }
  if (routine.canonical_context_writer && !String(routine.failure_policy || '').match(/history|needs_regen|review|retry|leave/i)) {
    errors.push(`${routine.id}: canonical writer must declare retry/history/review policy`);
  }
}

if (errors.length) {
  console.error('[check-background-routines] FAIL');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`[check-background-routines] ok — ${registry.routines.length} routine(s) registered`);
