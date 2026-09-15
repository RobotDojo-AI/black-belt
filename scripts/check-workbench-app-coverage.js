#!/usr/bin/env node
import { fail, read } from './frontend-workbench-lib.js';

const errors = [];
const inventory = JSON.parse(read('config/app-inventory.json'));
const rows = new Map((inventory.workbench_apps || []).map(row => [row.id, row]));
const expected = {
  wk_coaching: 'descriptor',
  wk_ecede903: 'private-generated',
  wk_cedar: 'descriptor',
  wk_health: 'private-generated',
  wk_robot_dojo: 'descriptor',
  wk_project_maple: 'private-generated',
};

for (const [id, status] of Object.entries(expected)) {
  const row = rows.get(id);
  if (!row) errors.push(`missing workbench app ${id}`);
  else if (row.status !== status) errors.push(`${id} expected ${status}, got ${row.status}`);
}

const registry = read('lib/app-registry.js');
for (const token of ['listWorkbenchAppDescriptors', 'sanitizeAppDescriptor', "surface: 'topic'"]) {
  if (!registry.includes(token)) errors.push(`lib/app-registry.js missing ${token}`);
}

const discovery = read('lib/workbench-files.js');
for (const seed of ['project-maple', 'robot-dojo', 'cedar', 'career', 'health', 'coaching-deep-context']) {
  if (!discovery.includes(seed)) errors.push(`workbench discovery missing ${seed}`);
}

for (const forbidden of ['user/workbenches/', '/Users/', 'root_path', 'resume_path']) {
  if (JSON.stringify(inventory).includes(forbidden)) errors.push(`inventory leaks private path token: ${forbidden}`);
}

fail(errors);
