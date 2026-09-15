#!/usr/bin/env node
import { fail, read } from './frontend-workbench-lib.js';

const errors = [];
const sharedJs = [
  'apps/static/shared/app-components.js',
  'apps/static/shared/app-registry.js',
];

for (const file of sharedJs) {
  const src = read(file);
  for (const forbidden of ['fetch(', 'XMLHttpRequest', '/api/', 'user/workbenches/', 'root_path', 'resume_path', '/Users/']) {
    if (src.includes(forbidden)) errors.push(`${file} must not own private data/API behavior: ${forbidden}`);
  }
}

const layout = read('apps/static/shared/app-layout.css');
for (const selector of ['.rd-app-state', '.rd-tab', '.rd-sidebar-section', '.rd-data-table', '.rd-pagination', '.rd-chart-panel']) {
  if (!layout.includes(selector)) errors.push(`shared layout missing ${selector}`);
}

const registry = read('lib/app-registry.js');
if (registry.includes('SELECT *')) errors.push('app registry should select only sanitized fields');
for (const forbidden of ['root_path,', 'resume_path,', 'metadata,']) {
  if (registry.includes(forbidden)) errors.push(`app registry query should not select private field ${forbidden}`);
}

fail(errors);
