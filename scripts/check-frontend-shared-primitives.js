#!/usr/bin/env node
import { assertIncludes, fail, read } from './frontend-workbench-lib.js';

const errors = [];
errors.push(...assertIncludes('apps/static/shared/app-layout.css', [
  '.rd-workbench-shell',
  '.rd-workbench-layout',
  '.rd-toolbar',
  '.rd-action-row',
  '.rd-panel',
  '.rd-card',
  '.rd-list',
  '.right-pane[data-visible="true"]',
  '.rd-tabs',
  '.rd-segmented',
  '.rd-tab',
  '.rd-status-pill',
  '.rd-app-state',
  '.rd-sidebar-section',
  '.rd-data-table',
  '.rd-pagination',
  '.rd-chart-panel',
  '.rd-loading',
  '.rd-empty',
  '.rd-error',
  '.rd-field',
  '.rd-dialog',
  '.rd-prose',
]));
errors.push(...assertIncludes('apps/static/shared/layout-manager.js', ['function initLayout', 'function setLayoutView', 'dual', 'getLayoutState']));
errors.push(...assertIncludes('apps/static/shared/right-pane.js', ['function initRightPane', 'async function openInRightPane', 'function closeRightPane']));
errors.push(...assertIncludes('apps/static/shared/app-registry.js', ['RobotDojoAppRegistry', 'listWaffleApps', 'sanitizeDescriptor']));

for (const file of ['apps/chat/index.html', 'apps/account/index.html', 'apps/health/index.html', 'apps/network/index.html', 'apps/ask.html']) {
  const src = read(file);
  if (!src.includes('/static/shared/app-layout.css')) errors.push(`${file} does not load shared app-layout.css`);
  if (!src.includes('/static/shared/app-registry.js')) errors.push(`${file} does not load shared app-registry.js`);
}

const genericPrimitivePattern = /^\s*\.(toolbar|panel|card|tabs|segmented|loading|empty|error)\s*\{/gm;
for (const file of ['apps/chat/style.css', 'apps/account/style.css', 'apps/health/style.css', 'apps/network/style.css']) {
  const matches = [...read(file).matchAll(genericPrimitivePattern)].map((m) => m[0]);
  if (matches.length) errors.push(`${file} defines generic primitive selectors: ${matches.join(', ')}`);
}

fail(errors);
