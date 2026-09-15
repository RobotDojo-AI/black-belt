#!/usr/bin/env node
import { fail, read } from './frontend-workbench-lib.js';
import { PRODUCT_APP_DEFINITIONS } from '../lib/app-registry.js';

const errors = [];

const sw = read('apps/static/sw.js');
const swRegister = read('apps/static/shared/sw-register.js');
const shell = read('apps/static/shared/shell.js');
const vercel = read('vercel.json');
const appShellToken = sw.match(/APP_SHELL_CACHE_VERSION = '([^']+)'/)?.[1] || null;

if (!sw.includes('APP_SHELL_CACHE_VERSION')) errors.push('sw.js missing versioned app-shell cache');
if (!sw.includes('robotdojo-app-shell-v')) errors.push('sw.js missing app-shell cache prefix');
if (!appShellToken) errors.push('sw.js missing explicit APP_SHELL_CACHE_VERSION token');
if (!sw.includes("request.mode === 'navigate'")) errors.push('sw.js must keep HTML navigations network-owned');
if (!sw.includes("request.headers.has('Authorization')")) errors.push('sw.js must not cache authorized/private requests');
if (!sw.includes("data.type === 'APP_PRECACHE'")) errors.push('sw.js missing APP_PRECACHE message support');
if (!swRegister.includes("serviceWorker.register('/sw.js')")) errors.push('sw-register.js must register root-scoped /sw.js');
if (!vercel.includes('"source": "/sw.js"') || !vercel.includes('"destination": "/static/sw.js"')) {
  errors.push('vercel.json must rewrite /sw.js to /static/sw.js for production service-worker MIME/scope');
}

if (appShellToken) {
  const releaseTokenRefs = [
    ['apps/chat/index.html', `/static/shared/sw-register.js?v=${appShellToken}`],
    ['apps/chat/index.html', `/static/shared/shell.js?v=${appShellToken}`],
    ['apps/chat/index.html', `/chat/app.js?v=${appShellToken}`],
    ['apps/chat/app.js', `./modules/chat.js?v=${appShellToken}`],
    ['apps/chat/app.js', `./modules/input.js?v=${appShellToken}`],
    ['apps/chat/modules/chat.js', `./stream-client.js?v=${appShellToken}`],
    ['apps/chat/modules/input.js', `./chat.js?v=${appShellToken}`],
  ];
  for (const [file, tokenRef] of releaseTokenRefs) {
    if (!read(file).includes(tokenRef)) errors.push(`${file} missing app-shell release token ${tokenRef}`);
  }
}

const precacheBody = sw.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/)?.[1] || '';
for (const forbidden of ['/api/', '/auth/']) {
  if (precacheBody.includes(forbidden)) errors.push(`PRECACHE_URLS must not include private path ${forbidden}`);
}

for (const asset of [
  '/static/shared/app-registry.js',
  '/static/shared/app-components.js',
  '/static/shared/shell.js',
  '/static/shared/sw-register.js',
  '/static/shared/marketing.js',
  '/static/js/public-chat-core.js',
  '/chat/app.js',
  '/chat/modules/chat.js',
  '/account/app.js',
  '/account/components/task-tiles.js',
  '/health/app.js',
  '/health/chart.js',
  '/network/app.js',
]) {
  if (!precacheBody.includes(asset)) errors.push(`PRECACHE_URLS missing ${asset}`);
  if (!swRegister.includes(asset)) errors.push(`sw-register.js missing ${asset}`);
}

for (const app of PRODUCT_APP_DEFINITIONS) {
  if (app.path && !swRegister.includes(app.path)) errors.push(`sw-register.js missing product app route ${app.slug}:${app.path}`);
}
for (const route of ['/', '/login', '/connect', '/faq', '/ask', '/chat', '/health', '/network', '/account', '/account/integrations', '/account/imports']) {
  if (!swRegister.includes(route)) errors.push(`sw-register.js missing route warmup ${route}`);
}
if (!swRegister.includes('warmRoutes')) errors.push('sw-register.js must expose warmRoutes for dynamic topic apps');

for (const token of [
  'rd_warm_apps',
  'data.workbench_apps',
  'rd_acct_cache_',
]) {
  if (!shell.includes(token)) errors.push(`shell.js missing warmup token ${token}`);
}

for (const token of [
  'rd_warm_models',
  'rd_warm_labels',
  'rd_chat_conversations',
  'rd_chat_action_conversations',
  'rd_health_markers',
  'rd_health_ui_config',
  'rd_network_stats_bundle',
  'rd_network_people_personal',
  'rd_network_people_professional',
  'rd_network_companies',
  'rd_network_places',
]) {
  if (shell.includes(token)) errors.push(`shell.js must not warm private app data token ${token}`);
}

const publicFiles = [
  'apps/connect/index.html',
  'apps/privacy.html',
  'apps/terms.html',
  'apps/licensing.html',
  'apps/install-success.html',
  'apps/auth-google-guidance.html',
];
for (const file of publicFiles) {
  if (!read(file).includes('/static/shared/sw-register.js')) errors.push(`${file} missing global app-shell warmup`);
}
for (const file of ['apps/index.html', 'apps/ask.html', 'apps/faq/index.html']) {
  if (read(file).includes('/static/shared/sw-register.js')) {
    errors.push(`${file} must stay self-contained on the public launch hot path`);
  }
}

const authedFiles = ['apps/chat/index.html', 'apps/account/index.html', 'apps/health/index.html', 'apps/network/index.html'];
for (const file of authedFiles) {
  const text = read(file);
  const head = text.slice(0, text.indexOf('</head>'));
  if (!head.includes('/static/shared/sw-register.js')) errors.push(`${file} must register app-shell warmup from <head>`);
}

fail(errors);
