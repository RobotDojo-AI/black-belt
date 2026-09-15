#!/usr/bin/env node
import {
  assertIncludes,
  assertNotIncludes,
  exists,
  fail,
  read,
  routeScripts,
  routeStyles,
} from './frontend-workbench-lib.js';

const errors = [];

const sharedOwners = [
  'apps/static/shared/theme.css',
  'apps/static/shared/shell.css',
  'apps/static/shared/app-layout.css',
  'apps/static/shared/app-registry.js',
  'apps/static/shared/app-components.js',
  'apps/static/shared/layout-manager.js',
  'apps/static/shared/right-pane.js',
  'apps/static/shared/pane-renderers.js',
  'apps/static/shared/llm.js',
  'apps/static/shared/utils.js',
  'apps/static/shared/marketing.css',
  'apps/static/shared/marketing.js',
  'apps/static/shared/sw-register.js',
];
for (const file of sharedOwners) if (!exists(file)) errors.push(`missing shared owner ${file}`);

errors.push(...assertIncludes('apps/static/shared/theme.css', ['--md-primary', '--md-surface', '--radius', '--font']));
errors.push(...assertIncludes('apps/static/shared/app-layout.css', [
  '.rd-workbench-layout',
  '.rd-toolbar',
  '.rd-panel',
  '.rd-tabs',
  '.rd-tab',
  '.rd-app-state',
  '.rd-sidebar-section',
  '.rd-data-table',
  '.rd-pagination',
  '.rd-chart-panel',
  '.rd-loading',
  '.rd-prose',
  '.rd-table-scroll',
]));
errors.push(...assertIncludes('apps/static/shared/app-components.js', ['RobotDojoComponents', 'renderProseMarkdown', 'statusPill', 'emptyState', 'prose', 'tabBar', 'dataTable', 'pagination', 'chartPanel', 'fileChip', 'toolTrace', 'setAppReady']));
errors.push(...assertIncludes('apps/static/shared/app-registry.js', ['RobotDojoAppRegistry', 'listProductApps', 'listWaffleApps']));
errors.push(...assertIncludes('apps/static/shared/layout-manager.js', ['dual', 'layout-view-changed']));
errors.push(...assertIncludes('apps/static/shared/right-pane.js', ['openInRightPane', 'closeRightPane']));

const authRoutes = {
  'apps/chat/index.html': ['/static/shared/theme.css', '/static/shared/shell.css', '/static/shared/app-layout.css', '/static/shared/app-components.js', '/static/shared/sw-register.js'],
  'apps/account/index.html': ['/static/shared/theme.css', '/static/shared/shell.css', '/static/shared/app-layout.css', '/static/shared/app-components.js', '/static/shared/sw-register.js'],
  'apps/health/index.html': ['/static/shared/theme.css', '/static/shared/shell.css', '/static/shared/app-layout.css', '/static/shared/app-components.js', '/static/shared/sw-register.js'],
  'apps/network/index.html': ['/static/shared/theme.css', '/static/shared/shell.css', '/static/shared/app-layout.css', '/static/shared/app-registry.js', '/static/shared/sw-register.js'],
};
for (const [file, required] of Object.entries(authRoutes)) {
  const assets = [...routeStyles(file), ...routeScripts(file)];
  for (const asset of required) {
    if (!assets.some((item) => item.startsWith(asset))) errors.push(`${file} missing ${asset}`);
  }
  errors.push(...assertIncludes(file, ['RobotDojoBootFallback']));
  errors.push(...assertIncludes(file, ['data-app=']));
}

// The homepage inlines critical (above-fold) CSS for LCP and loads the full sheet
// async. Both are required: dropping marketing.css leaves every below-fold section
// unstyled (belt icons rendered full-container-width until this was restored).
errors.push(...assertIncludes('apps/index.html', ['data-app="website"', 'm-modal-install', 'curl -fsSL https://robotdojo.ai/install.sh | bash', '/static/shared/marketing.css']));
errors.push(...assertNotIncludes('apps/index.html', ['/static/shared/app-registry.js', '/static/shared/sw-register.js', '/static/shared/shell.js', 'shell-search.js', 'shell-notifications.js', 'fonts.googleapis.com']));

const staticPublicFiles = ['apps/privacy.html', 'apps/terms.html', 'apps/licensing.html', 'apps/install-success.html', 'apps/auth-google-guidance.html'];
for (const file of staticPublicFiles) {
  errors.push(...assertIncludes(file, ['/static/shared/marketing.css', '/static/shared/sw-register.js', 'data-app="website"']));
  errors.push(...assertNotIncludes(file, ['/static/shared/app-registry.js', 'initMarketing', '/static/shared/shell.js', 'shell-search.js', 'shell-notifications.js', 'fonts.googleapis.com']));
}
const publicFiles = ['apps/connect/index.html'];
for (const file of publicFiles) {
  errors.push(...assertIncludes(file, ['/static/shared/marketing.css', '/static/shared/app-registry.js', '/static/shared/sw-register.js', 'data-app="website"']));
  errors.push(...assertNotIncludes(file, ['/static/shared/shell.js', 'shell-search.js', 'shell-notifications.js', 'fonts.googleapis.com']));
}
errors.push(...assertIncludes('apps/ask.html', ['/static/shared/app-layout.css', 'data-app="faq"']));
errors.push(...assertNotIncludes('apps/ask.html', ['/static/shared/sw-register.js', '/static/shared/app-components.js', '/static/shared/app-registry.js']));
errors.push(...assertNotIncludes('apps/ask.html', ['shell-search.js', 'shell-notifications.js', 'fonts.googleapis.com']));

const appComponents = read('apps/static/shared/app-components.js');
if (/fetch\(|XMLHttpRequest|\/api\//.test(appComponents)) errors.push('shared app-components.js must not own API/domain behavior');
const appRegistry = read('apps/static/shared/app-registry.js');
if (/fetch\(|XMLHttpRequest|\/api\/|user\/workbenches|root_path|resume_path/.test(appRegistry)) errors.push('shared app-registry.js must not own private/API behavior');

fail(errors);
