#!/usr/bin/env node
import { fail, routeScripts } from './frontend-workbench-lib.js';

const errors = [];
const routes = {
  'apps/chat/index.html': routeScripts('apps/chat/index.html'),
  'apps/ask.html': routeScripts('apps/ask.html'),
  'apps/account/index.html': routeScripts('apps/account/index.html'),
  'apps/health/index.html': routeScripts('apps/health/index.html'),
};

for (const [file, scripts] of Object.entries(routes)) {
  const hasChart = scripts.some((s) => /chart/.test(s));
  const hasSortable = scripts.some((s) => /sortable/.test(s));
  const hasShellSearch = scripts.some((s) => /shell-search/.test(s));
  const hasNotifications = scripts.some((s) => /shell-notifications/.test(s));
  if (file !== 'apps/health/index.html' && hasChart) errors.push(`${file} loads chart vendor`);
  if (file !== 'apps/chat/index.html' && hasSortable) errors.push(`${file} loads sortable vendor`);
  if (file === 'apps/ask.html' && (hasShellSearch || hasNotifications)) errors.push('Public Ask loads authenticated shell search/notifications');
}

for (const file of ['apps/index.html', 'apps/privacy.html', 'apps/terms.html', 'apps/licensing.html', 'apps/install-success.html', 'apps/auth-google-guidance.html']) {
  if (routeScripts(file).some((s) => /shell|chart|sortable|marked|purify|highlight/.test(s))) errors.push(`${file} loads app/authenticated/heavy vendor script`);
}

fail(errors);
