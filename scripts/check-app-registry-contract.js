#!/usr/bin/env node
import { fail, read } from './frontend-workbench-lib.js';
import { PRODUCT_APP_DEFINITIONS, buildAppRegistryPayload, sanitizeAppDescriptor } from '../lib/app-registry.js';

const errors = [];
const requiredProductSlugs = ['website', 'chat', 'network', 'health', 'account'];
const productSlugs = PRODUCT_APP_DEFINITIONS.map(app => app.slug);
for (const slug of requiredProductSlugs) {
  if (!productSlugs.includes(slug)) errors.push(`PRODUCT_APP_DEFINITIONS missing ${slug}`);
}
for (const app of PRODUCT_APP_DEFINITIONS) {
  if (!app.use_case) errors.push(`${app.slug} missing use_case`);
}
if (productSlugs.includes('ask')) errors.push('ask must be a website subflow, not a top-level product app');
const productBySlug = new Map(PRODUCT_APP_DEFINITIONS.map(app => [app.slug, app]));
for (const subflow of ['login', 'faq', 'ask']) {
  if (!productBySlug.get('website')?.subflows?.some(flow => flow.id === subflow)) {
    errors.push(`website app missing ${subflow} subflow`);
  }
}
for (const subflow of ['how-to', 'general', 'integrations', 'agents', 'skills', 'you', 'shortcuts', 'setup', 'imports']) {
  if (!productBySlug.get('account')?.subflows?.some(flow => flow.id === subflow)) {
    errors.push(`account app missing ${subflow} subflow`);
  }
}

const shell = read('apps/static/shared/shell.js');
if (!shell.includes('RobotDojoAppRegistry')) errors.push('shell.js does not consume RobotDojoAppRegistry');
if (!shell.includes('listWaffleApps')) errors.push('shell.js does not call listWaffleApps');
if (/const\s+ALL_APPS\s*=\s*\[\s*[\s\S]*network[\s\S]*health[\s\S]*\]/.test(shell)) {
  errors.push('shell.js still carries the old hard-coded Chat/Network/Health app list');
}

const frontendRegistry = read('apps/static/shared/app-registry.js');
for (const token of ['listProductApps', 'listWaffleApps', 'sanitizeDescriptor']) {
  if (!frontendRegistry.includes(token)) errors.push(`frontend app registry missing ${token}`);
}
for (const forbidden of ['user/workbenches/', '/Users/', 'root_path', 'resume_path']) {
  if (frontendRegistry.includes(forbidden)) errors.push(`frontend registry embeds private token: ${forbidden}`);
}

const route = read('routes/apps.js');
if (!route.includes('/api/apps')) errors.push('routes/apps.js missing /api/apps');
if (!read('index.js').includes("from './routes/apps.js'")) errors.push('index.js does not import app registry route');

const sample = sanitizeAppDescriptor({ id: 'wk_sample', title: 'Sample', root_path: 'private', resume_path: 'private' });
if ('root_path' in sample || 'resume_path' in sample) errors.push('sanitizeAppDescriptor leaks private path fields');
const payload = buildAppRegistryPayload({ prepare: () => ({ all: () => [] }) }, { founder: false, env: {} });
if (!Array.isArray(payload.product_apps) || !Array.isArray(payload.waffle_apps) || !Array.isArray(payload.workbench_apps)) {
  errors.push('registry payload shape is invalid');
}
if (payload.waffle_apps.map(app => app.slug).join(',') !== 'chat') {
  errors.push('launch waffle must be Chat only');
}

fail(errors);
